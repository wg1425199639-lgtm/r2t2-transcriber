import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import {
  ASR_HOST, ASR_MODEL_PATH, ASR_PORT, ASR_SERVER_PATH, BYTES_PER_SAMPLE,
  CHANNELS, FRAME_BYTES, FRAME_MS, MAX_PROMPT_CHARS, SAMPLE_FORMAT, SAMPLE_RATE,
  TAIL_SILENCE_BYTES,
} from "../config.js";
import { ManagedProcess } from "../process-manager.js";
import type { AsrAdapter, AsrSession, AsrSessionOptions } from "./adapter.js";

const MODEL_ID = "r2t2-stream";
const ENGINE_ADDRESS = { hostname: ASR_HOST, port: ASR_PORT, agent: false } as const;
const STARTUP_TIMEOUT_MS = 60_000;
const FINISH_TIMEOUT_MS = 5_000;
const MAX_HEALTH_BYTES = 16 * 1024;
const MAX_SSE_CHARS = 1024 * 1024;
const MAX_QUEUED_PCM_BYTES = FRAME_BYTES * 32;
const PCM_SAMPLE_BYTES = CHANNELS * BYTES_PER_SAMPLE;
const SSE_SEPARATOR = /\r?\n\r?\n/;
const TAIL_SILENCE = Buffer.alloc(TAIL_SILENCE_BYTES);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function checkHealth(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ ...ENGINE_ADDRESS, path: "/health", signal }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > MAX_HEALTH_BYTES) req.destroy();
      });
      res.on("error", () => complete(false));
      res.on("close", () => complete(false));
      res.on("end", () => {
        try {
          const health: unknown = JSON.parse(body);
          complete(res.statusCode === 200 && isObject(health) && health.status === "ok");
        } catch {
          complete(false);
        }
      });
    });
    const timer = setTimeout(() => req.destroy(), timeoutMs);
    function complete(healthy: boolean): void {
      clearTimeout(timer);
      resolve(healthy);
    }
    req.on("error", () => complete(false));
    req.on("close", () => complete(false));
    req.end();
  });
}

class R2T2Session implements AsrSession {
  private request?: http.ClientRequest;
  private response?: http.IncomingMessage;
  private readonly decoder = new StringDecoder("utf8");
  private pendingSse = "";
  private emittedText = "";
  private trailingSilenceBytes = 0;
  private finishTimer?: NodeJS.Timeout;
  private finishing = false;
  private deltaCallback?: (text: string) => void;
  private finalCallback?: (text: string) => void;
  private errorCallback?: (error: Error) => void;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: Error) => void;
  private readonly completion = new Promise<void>((resolve, reject) => {
    this.resolveCompletion = resolve;
    this.rejectCompletion = reject;
  });

  constructor(options: AsrSessionOptions, private releaseSlot: (() => void) | undefined) {
    const query = new URLSearchParams({
      model: MODEL_ID,
      sample_rate: String(SAMPLE_RATE),
      channels: String(CHANNELS),
      sample_format: SAMPLE_FORMAT,
      language: options.language,
    });
    const prompt = options.context.replace(/\s+/gu, " ").trim()
      .slice(0, MAX_PROMPT_CHARS).replace(/[\uD800-\uDBFF]$/u, "");
    if (prompt) query.set("prompt", prompt);

    // Transport accepts either caller frame size. The model chunk size is set at launch.
    const req = http.request({
      ...ENGINE_ADDRESS,
      method: "POST",
      path: `/v1/audio/transcriptions/live?${query}`,
      headers: { "Transfer-Encoding": "chunked", Accept: "text/event-stream" },
    }, (res) => this.receive(res));
    this.request = req;

    // Transport failures can precede the caller's first finish().
    void this.completion.catch(() => {});
    req.once("socket", (socket) => {
      socket.setNoDelay(true);
      socket.setTimeout(0);
    });
    req.on("error", (error) => this.fail(error));
    req.once("close", () => this.fail(new Error("R2T2 connection closed before completion")));
    req.flushHeaders();
  }

  pushAudio(pcm: Buffer): void {
    const req = this.request;
    if (!req || this.finishing) throw new Error("R2T2 session is no longer accepting audio");
    if (pcm.length % PCM_SAMPLE_BYTES !== 0) {
      throw new Error("R2T2 PCM must contain complete samples");
    }
    if (req.writableLength + pcm.length > MAX_QUEUED_PCM_BYTES) {
      const error = new Error("R2T2 PCM write queue exceeded its limit");
      this.fail(error);
      throw error;
    }

    let trailingZeros = 0;
    while (trailingZeros < Math.min(pcm.length, TAIL_SILENCE_BYTES)
      && pcm[pcm.length - trailingZeros - 1] === 0) {
      trailingZeros++;
    }
    if (trailingZeros === pcm.length) trailingZeros += this.trailingSilenceBytes;
    trailingZeros -= trailingZeros % PCM_SAMPLE_BYTES;
    this.trailingSilenceBytes = Math.min(TAIL_SILENCE_BYTES, trailingZeros);
    req.write(pcm);
  }

  finish(): Promise<void> {
    const req = this.request;
    if (req && !this.finishing) {
      this.finishing = true;
      this.finishTimer = setTimeout(() => {
        this.fail(new Error("R2T2 timed out waiting for final transcription"));
      }, FINISH_TIMEOUT_MS);
      const missingSilenceBytes = TAIL_SILENCE_BYTES - this.trailingSilenceBytes;
      if (missingSilenceBytes > 0) {
        req.write(TAIL_SILENCE.subarray(0, missingSilenceBytes));
      }
      req.end();
    }
    return this.completion;
  }

  abort(): void {
    this.fail(new Error("R2T2 session aborted"), false);
  }

  onDelta(cb: (text: string) => void): void {
    if (this.request) this.deltaCallback = cb;
  }

  onFinal(cb: (text: string) => void): void {
    if (this.request) this.finalCallback = cb;
  }

  onError(cb: (error: Error) => void): void {
    if (this.request) this.errorCallback = cb;
  }

  private receive(res: http.IncomingMessage): void {
    res.on("error", (error) => this.fail(error));
    if (!this.request) {
      res.destroy();
      return;
    }
    this.response = res;
    if (res.statusCode !== 200) {
      this.fail(new Error(`R2T2 returned HTTP ${res.statusCode}`));
      return;
    }
    res.on("data", (chunk: Buffer) => this.readSse(this.decoder.write(chunk)));
    res.once("end", () => {
      this.readSse(this.decoder.end());
      this.fail(new Error("R2T2 SSE ended without a completion event"));
    });
  }

  private readSse(chunk: string): void {
    if (!this.request) return;
    this.pendingSse += chunk;
    let separator = SSE_SEPARATOR.exec(this.pendingSse);
    while (separator && this.request) {
      if (separator.index > MAX_SSE_CHARS) break;
      const frame = this.pendingSse.slice(0, separator.index);
      this.pendingSse = this.pendingSse.slice(separator.index + separator[0].length);
      try {
        this.readFrame(frame);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
      separator = SSE_SEPARATOR.exec(this.pendingSse);
    }
    if (this.pendingSse.length > MAX_SSE_CHARS) {
      this.fail(new Error("R2T2 SSE frame exceeded its limit"));
    }
  }

  private readFrame(frame: string): void {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (lines.some((line) => /^event: ?error$/.test(line))) {
      throw new Error(`R2T2 SSE error: ${data}`);
    }
    if (!data) return;
    if (data === "[DONE]") {
      this.complete(this.emittedText);
      return;
    }

    const event: unknown = JSON.parse(data);
    if (!isObject(event)) throw new Error("Invalid R2T2 SSE payload");
    switch (event.type) {
      case "transcript.text.delta":
        if (typeof event.delta !== "string") throw new Error("Invalid R2T2 delta");
        this.emitDelta(event.delta);
        break;
      case "transcript.text.done":
        if (typeof event.text !== "string") throw new Error("Invalid R2T2 final text");
        this.complete(event.text);
        break;
      case "error":
        throw new Error(`R2T2 SSE error: ${data}`);
    }
  }

  private emitDelta(text: string): void {
    if (!text) return;
    if (this.emittedText.length + text.length > MAX_SSE_CHARS) {
      throw new Error("R2T2 transcript exceeded its limit");
    }
    this.emittedText += text;
    this.deltaCallback?.(text);
  }

  private complete(text: string): void {
    if (!this.finishing) throw new Error("R2T2 sent its final transcription before END");
    let prefixLength = this.emittedText.length;
    if (!text.startsWith(this.emittedText)) {
      prefixLength = 0;
      for (const character of text) {
        if (!this.emittedText.startsWith(character, prefixLength)) break;
        prefixLength += character.length;
      }
      console.error(`[warn] R2T2 final text diverged after ${prefixLength} UTF-16 units`);
    }
    this.emitDelta(text.slice(prefixLength));
    this.finalCallback?.(text);
    if (this.close()) this.resolveCompletion();
  }

  private fail(error: Error, notify = true): void {
    const callback = this.errorCallback;
    if (!this.close()) return;
    this.rejectCompletion(error);
    if (notify) callback?.(error);
  }

  private close(): boolean {
    const req = this.request;
    if (!req) return false;
    this.request = undefined;
    clearTimeout(this.finishTimer);
    this.finishTimer = undefined;
    this.pendingSse = "";
    this.emittedText = "";
    this.deltaCallback = undefined;
    this.finalCallback = undefined;
    this.errorCallback = undefined;
    this.response?.destroy();
    this.response = undefined;
    req.destroy();
    this.releaseSlot?.();
    this.releaseSlot = undefined;
    return true;
  }
}

export class R2T2Adapter implements AsrAdapter {
  private server?: ManagedProcess;
  private configDir?: string;
  private activeSession?: R2T2Session;
  private startup?: AbortController;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  start(): Promise<void> {
    if (this.stopPromise) return this.stopPromise.then(() => this.start());
    if (this.startPromise) return this.startPromise;
    this.startup = new AbortController();
    this.startPromise = this.launch(this.startup.signal).catch(async (error: unknown) => {
      try {
        await this.shutdown();
      } finally {
        this.startPromise = undefined;
      }
      throw error;
    });
    return this.startPromise;
  }

  async openSession(options: AsrSessionOptions): Promise<AsrSession> {
    const starting = this.startPromise;
    if (!starting || this.stopPromise) throw new Error("R2T2 adapter is stopped");
    await starting;
    if (this.startPromise !== starting || this.stopPromise || !this.server?.current?.pid) {
      throw new Error("R2T2 server is unavailable");
    }
    if (this.activeSession) throw new Error("R2T2 already has an active session");

    const session = new R2T2Session(options, () => {
      this.activeSession = undefined;
    });
    this.activeSession = session;
    return session;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.startup?.abort();
    this.stopPromise = this.stopStartedServer().finally(() => {
      this.startPromise = undefined;
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  private async launch(signal: AbortSignal): Promise<void> {
    this.configDir = mkdtempSync(join(tmpdir(), "r2t2-"));
    const configPath = join(this.configDir, "server.json");
    writeFileSync(configPath, JSON.stringify({
      host: ASR_HOST,
      port: ASR_PORT,
      backend: process.platform === "win32" ? "vulkan" : "metal",
      device: 0,
      threads: 4,
      lazy_load: false,
      max_loaded_models: 1,
      live_ingest: {
        idle_timeout_ms: 30_000,
        total_timeout_ms: 180_000,
        max_body_bytes: 536_870_912,
        max_chunk_bytes: 8_388_608,
        send_timeout_ms: 30_000,
      },
      models: [{
        id: MODEL_ID,
        family: "confucius4_r2t2",
        path: ASR_MODEL_PATH,
        task: "asr",
        mode: "streaming",
        session_options: { "confucius4_r2t2.chunk_size_ms": FRAME_MS },
      }],
    }));
    const server = new ManagedProcess(ASR_SERVER_PATH, ["--config", configPath, "--no-ui"], {
      stdio: ["ignore", 2, 2],
    });
    this.server = server;
    server.start();
    process.once("exit", this.removeConfig);

    const deadline = performance.now() + STARTUP_TIMEOUT_MS;
    while (performance.now() < deadline) {
      signal.throwIfAborted();
      const child = server.current;
      if (child?.pid && await checkHealth(signal, Math.min(1_000, deadline - performance.now()))
        && server.current === child && child.exitCode === null && child.signalCode === null) {
        signal.throwIfAborted();
        return;
      }
      await delay(Math.min(250, Math.max(0, deadline - performance.now())), undefined, { signal });
    }
    throw new Error("R2T2 server did not report healthy before startup timeout");
  }

  private async stopStartedServer(): Promise<void> {
    try {
      await this.startPromise?.catch(() => {});
      await this.activeSession?.finish();
    } finally {
      await this.shutdown();
    }
  }

  private async shutdown(): Promise<void> {
    this.startup = undefined;
    await this.server?.stop();
    this.server = undefined;
    process.off("exit", this.removeConfig);
    this.removeConfig();
  }

  private readonly removeConfig = (): void => {
    if (this.configDir) {
      rmSync(this.configDir, { recursive: true, force: true });
      this.configDir = undefined;
    }
  };
}
