import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import type { AsrAdapter, AsrSession } from "./asr/adapter.js";
import { MockAsrAdapter } from "./asr/mock-adapter.js";
import { R2T2Adapter } from "./asr/r2t2-adapter.js";
import { CaptureReader } from "./capture-reader.js";
import {
  ASR_CHUNK_MS, ASR_MODEL_PATH, BYTES_PER_SAMPLE, CAPTURE_PATH, CHANNELS, DATA_DIR, FRAME_BYTES, FRAME_MS,
  SAMPLE_RATE, SHORT_FRAME_BYTES, SHORT_FRAME_MS, WS_PORT,
} from "./config.js";
import { exportSession } from "./export.js";
import { HotwordsStore } from "./hotwords-store.js";
import { measureLevel } from "./level-meter.js";
import { ManagedProcess } from "./process-manager.js";
import { PROTOCOL_VERSION, serverMessageSchema, type ClientMessage, type ServerMessage } from "./protocol.js";
import { loadLatestSessionRecords, TranscriptLog, type TranscriptLogRecord } from "./transcript-log.js";
import { Segmenter, type SegmenterAction, type VadState } from "./vad/segmenter.js";
import { SileroVad } from "./vad/silero.js";
import { SchedulerWsServer } from "./ws-server.js";

const LEVEL_INTERVAL_MS = 100;
const MAX_PENDING_MS = 10_000;
const ASR_FINISH_TIMEOUT_MS = 3_000;
const CAPTURE_RESTART_WAIT_MS = 5_000;
const CAPTURE_RESTART_POLL_MS = 50;
const DEVICE_LIST_TIMEOUT_MS = 5_000;
const DEVICE_LIST_MAX_BYTES = 64 * 1024;
const SAMPLE_BYTES = CHANNELS * BYTES_PER_SAMPLE;

const execFileAsync = promisify(execFile);

type StateMessage = Extract<ServerMessage, { type: "state" }>;
type CaptureOptions = Extract<ClientMessage, { type: "session.start" }>;
type FinishAction = Extract<SegmenterAction, { type: "FINISH" }>;
type Source = { kind: "file"; path: string; fast: boolean } | {
  kind: "capture"; source: CaptureOptions["source"]; deviceId?: string;
};
type FrameMs = typeof FRAME_MS | typeof SHORT_FRAME_MS;

interface CliOptions {
  engine: "r2t2" | "mock";
  port: number;
  file?: string;
  fast: boolean;
  exitOnEof: boolean;
  hotwords?: string[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { engine: "r2t2", port: WS_PORT, fast: false, exitOnEof: false };
  const value = (flag: string): string => {
    const next = args.shift();
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
    return next;
  };
  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--engine": {
        const engine = value(flag);
        if (engine !== "r2t2" && engine !== "mock") throw new Error("Expected --engine r2t2|mock");
        options.engine = engine;
        break;
      }
      case "--source": {
        const source = value(flag);
        if (!source.startsWith("file:") || source.length === "file:".length) {
          throw new Error("Expected --source file:<wav>");
        }
        options.file = source.slice("file:".length);
        break;
      }
      case "--port": {
        const port = value(flag);
        if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) {
          throw new Error("--port must be an integer from 1 to 65535");
        }
        options.port = Number(port);
        break;
      }
      case "--hotwords":
        options.hotwords = value(flag).split(",");
        break;
      case "--fast":
        options.fast = true;
        break;
      case "--exit-on-eof":
        options.exitOnEof = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!options.file && (options.fast || options.exitOnEof)) {
    throw new Error("--fast and --exit-on-eof require --source file:<wav>");
  }
  return options;
}

async function readAt(file: FileHandle, size: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, offset, size - offset, position + offset);
    if (!bytesRead) throw new Error("Unexpected end of WAV file");
    offset += bytesRead;
  }
  return buffer;
}

async function wavData(file: FileHandle, signal: AbortSignal): Promise<{ start: number; size: number }> {
  const header = await readAt(file, 12, 0);
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE file");
  }
  const end = header.readUInt32LE(4) + 8;
  if (end > (await file.stat()).size) throw new Error("Truncated WAV file");
  let hasPcmFormat = false;
  for (let offset = header.length; offset + 8 <= end;) {
    signal.throwIfAborted();
    const chunk = await readAt(file, 8, offset);
    const kind = chunk.toString("ascii", 0, 4);
    const size = chunk.readUInt32LE(4);
    const start = offset + chunk.length;
    if (start + size > end) throw new Error("Truncated WAV chunk");
    if (kind === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV format chunk");
      const format = await readAt(file, 16, start);
      hasPcmFormat = format.readUInt16LE(0) === 1
        && format.readUInt16LE(2) === CHANNELS
        && format.readUInt32LE(4) === SAMPLE_RATE
        && format.readUInt16LE(12) === SAMPLE_BYTES
        && format.readUInt16LE(14) === BYTES_PER_SAMPLE * 8;
      if (!hasPcmFormat) throw new Error("WAV must use 16 kHz mono signed 16-bit PCM");
    }
    if (kind === "data") {
      if (!hasPcmFormat || size % SAMPLE_BYTES !== 0) throw new Error("Invalid WAV PCM data chunk");
      return { start, size };
    }
    offset = start + size + size % 2;
  }
  throw new Error("WAV data chunk is missing");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function startAdapter(adapter: AsrAdapter): Promise<void> {
  // The scheduler owns signal shutdown so a managed engine stays alive through the final flush.
  const signals = ["SIGINT", "SIGTERM"] as const;
  const previous = signals.map((name) => new Set(process.listeners(name)));
  try {
    return adapter.start();
  } finally {
    for (const [index, name] of signals.entries()) {
      for (const listener of process.listeners(name)) {
        if (!previous[index]?.has(listener)) process.off(name, listener);
      }
    }
  }
}

interface AudioSegment {
  segmentId: number;
  startedAtMs: number;
  offsetSec: number;
  durMs?: number;
}

interface ActiveSegment {
  id: number;
  session: AsrSession;
  openedAt: number;
  offsetSec: number;
  audioIndex?: AudioSegment;
  nextSeq: number;
  audioBytes: number;
  failed: boolean;
}

class Recording {
  private readonly controller = new AbortController();
  private readonly segmenter = new Segmenter();
  readonly sessionId = randomUUID();
  readonly log = new TranscriptLog(this.sessionId);
  private readonly sessionsDir = join(DATA_DIR, "sessions");
  private readonly audioIndex = { sessionId: this.sessionId, audioStartedAtMs: 0, segments: [] as AudioSegment[] };
  private pcm?: FileHandle;
  private pcmBytesWritten = 0;
  private pcmFailed = false;
  private audioIndexDirty = false;
  private audioIndexWrite?: Promise<void>;
  private readonly pending: Buffer[] = [];
  private readonly frameBytes: number;
  private readonly pendingCapacity: number;
  private vad?: SileroVad;
  private capture?: ManagedProcess;
  private draining?: Promise<void>;
  private active?: ActiveSegment;
  private failure?: Error;
  private overflow = false;
  private lastLevelAt = -Infinity;
  private openedSegmentId = 0;
  private vadState: VadState = "idle";
  private started = false;

  constructor(
    private readonly adapter: AsrAdapter,
    private readonly hotwords: HotwordsStore,
    private readonly emit: (msg: ServerMessage) => void,
    private readonly updateState: (state: "running" | undefined, vad: VadState) => void,
    private readonly frameMs: FrameMs,
  ) {
    this.frameBytes = frameMs === FRAME_MS ? FRAME_BYTES : SHORT_FRAME_BYTES;
    this.pendingCapacity = Math.floor(MAX_PENDING_MS / frameMs);
  }

  get nextSegmentId(): number {
    return this.openedSegmentId + 1;
  }

  stop(): void {
    this.controller.abort();
    void this.capture?.stop();
  }

  async run(source: Source): Promise<void> {
    const { signal } = this.controller;
    try {
      this.vad = await SileroVad.create();
      if (!signal.aborted) await this.startEngine();
      if (!signal.aborted) {
        await this.openAudioCache();
        signal.throwIfAborted();
        if (source.kind === "file") await this.readFile(source);
        else await this.readCapture(source);
      }
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    } finally {
      await this.capture?.stop().catch((error: unknown) => this.fail(error));
      await this.draining;
      try {
        await this.execute(this.segmenter.stop());
      } catch (error) {
        this.fail(error);
      }
      if (this.active) {
        this.active.session.abort();
        this.active = undefined;
      }
      const cleanup = await Promise.allSettled([
        this.flushAudioIndex(),
        this.pcm?.close(),
        this.log.close(),
        this.vad?.dispose(),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") this.fail(result.reason);
      }
    }
    if (this.failure) throw this.failure;
  }

  private async openAudioCache(): Promise<void> {
    try {
      await mkdir(this.sessionsDir, { recursive: true });
      this.pcm = await open(join(this.sessionsDir, `${this.sessionId}.pcm`), "a");
    } catch (error) {
      this.warn("AUDIO_CACHE", errorText(error));
    }
  }

  private async cacheFrame(frame: Buffer): Promise<void> {
    if (!this.pcm || this.pcmFailed) return;
    try {
      let offset = 0;
      while (offset < frame.length) {
        const { bytesWritten } = await this.pcm.write(frame, offset, frame.length - offset);
        if (bytesWritten === 0) throw new Error("PCM append made no progress");
        offset += bytesWritten;
        this.pcmBytesWritten += bytesWritten;
      }
    } catch (error) {
      this.pcmFailed = true;
      this.warn("AUDIO_CACHE", errorText(error));
    }
  }

  private flushAudioIndex(): Promise<void> | undefined {
    if (this.pcm && this.audioIndexDirty) {
      this.audioIndexWrite ??= this.writeAudioIndex().finally(() => {
        this.audioIndexWrite = undefined;
      });
    }
    return this.audioIndexWrite;
  }

  private async writeAudioIndex(): Promise<void> {
    const path = join(this.sessionsDir, `${this.sessionId}.audio.json`);
    while (this.audioIndexDirty) {
      this.audioIndexDirty = false;
      try {
        await writeFile(`${path}.tmp`, JSON.stringify(this.audioIndex));
        await rename(`${path}.tmp`, path);
      } catch (error) {
        this.audioIndexDirty = true;
        this.warn("AUDIO_INDEX", errorText(error));
        return;
      }
    }
  }

  private async startEngine(): Promise<void> {
    const { signal } = this.controller;
    let cancelStartup: (() => void) | undefined;
    const canceled = new Promise<void>((resolve) => {
      cancelStartup = () => resolve();
      signal.addEventListener("abort", cancelStartup, { once: true });
    });
    try {
      await Promise.race([startAdapter(this.adapter), canceled]);
    } finally {
      if (cancelStartup) signal.removeEventListener("abort", cancelStartup);
    }
  }

  private async readFile(source: Extract<Source, { kind: "file" }>): Promise<void> {
    const { signal } = this.controller;
    const file = await open(source.path, "r");
    try {
      const { start, size } = await wavData(file, signal);
      if (size === 0) return;
      const stream = file.createReadStream({
        start, end: start + size - 1, autoClose: false, highWaterMark: this.frameBytes, signal,
      });
      const reader = new CaptureReader(this.frameBytes);
      let nextFrameAt = performance.now();
      const feed = async (frame: Buffer): Promise<void> => {
        if (!source.fast) {
          const wait = nextFrameAt - performance.now();
          if (wait > 0) await delay(wait, undefined, { signal });
          nextFrameAt += this.frameMs;
        }
        signal.throwIfAborted();
        this.enqueue(frame);
        if (source.fast) await this.draining;
      };
      for await (const chunk of stream as AsyncIterable<unknown>) {
        if (!Buffer.isBuffer(chunk)) throw new Error("WAV stream must yield bytes");
        for (const frame of reader.push(chunk)) await feed(frame);
      }
      if (!signal.aborted && reader.bufferedBytes > 0) {
        for (const frame of reader.push(Buffer.alloc(this.frameBytes - reader.bufferedBytes))) {
          await feed(frame);
        }
      }
    } finally {
      await file.close();
    }
  }

  private async readCapture(source: Extract<Source, { kind: "capture" }>): Promise<void> {
    const { signal } = this.controller;
    const args = ["--source", source.source, "--frame-ms", String(this.frameMs)];
    if (source.deviceId !== undefined) args.push("--device-id", source.deviceId);
    let child: ChildProcess | undefined;
    const capture = new ManagedProcess(CAPTURE_PATH, args, { stdio: ["ignore", "pipe", "pipe"] }, {
      onWarn: (msg) => {
        if (!signal.aborted && child?.exitCode !== 2 && child?.exitCode !== 3) {
          this.warn("CAPTURE_RESTARTING", msg);
        }
      },
      onFatal: (msg) => this.fail(new Error(msg)),
    });
    this.capture = capture;
    capture.start();
    child = capture.current;
    while (!signal.aborted && child?.stdout && child.stderr) {
      const current = child;
      const { stdout, stderr } = child;
      const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
        const onError = (error: Error): void => resolve({ code: null, error });
        current.once("error", onError);
        current.once("close", (code) => {
          current.off("error", onError);
          resolve({ code });
        });
      });
      const logs = createInterface({ input: stderr, crlfDelay: Infinity });
      logs.on("line", (line) => this.captureDiagnostic(line));
      logs.on("error", (error) => {
        if (!signal.aborted) this.warn("CAPTURE_STREAM", errorText(error));
      });
      try {
        const reader = new CaptureReader(this.frameBytes);
        for await (const frame of reader.read(stdout)) this.enqueue(frame);
      } catch (error) {
        if (!signal.aborted) this.warn("CAPTURE_STREAM", errorText(error));
      }
      const result = await exit.finally(() => logs.close());
      if (signal.aborted) return;
      if (result.error) throw result.error;
      if (result.code === 3) throw new Error("PERM_DENIED: audio capture permission denied");
      if (result.code === 0 || result.code === 2) {
        throw new Error(`Audio capture exited with code ${result.code}`);
      }
      const deadline = performance.now() + CAPTURE_RESTART_WAIT_MS;
      const previous = child;
      do {
        await delay(CAPTURE_RESTART_POLL_MS, undefined, { signal });
        child = capture.current;
      } while ((!child || child === previous) && performance.now() < deadline);
      if (child === previous || !child) throw new Error("Audio capture restart timed out");
    }
    if (!signal.aborted) throw new Error("Audio capture stdout is unavailable");
  }

  private captureDiagnostic(line: string): void {
    console.error(line);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof value === "object" && value !== null && "lvl" in value && value.lvl === "warn"
      && "code" in value && typeof value.code === "string" && "msg" in value && typeof value.msg === "string") {
      this.emit({ type: "warn", code: value.code, msg: value.msg });
    }
  }

  private enqueue(frame: Buffer): void {
    if (this.failure) return;
    if (this.pending.length >= this.pendingCapacity) {
      if (!this.overflow) this.warn("PENDING_OVERFLOW", "PCM queue reached its limit; incoming frames were dropped");
      this.overflow = true;
      return;
    }
    this.overflow = false;
    this.pending.push(frame);
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      const vad = this.vad;
      if (!vad) throw new Error("VAD is unavailable");
      for (let frame = this.pending.shift(); frame && !this.failure; frame = this.pending.shift()) {
        if (!this.started) {
          this.audioIndex.audioStartedAtMs = Date.now();
          this.audioIndexDirty = true;
        }
        await this.cacheFrame(frame);
        if (!this.started) {
          await this.flushAudioIndex();
          this.started = true;
          this.updateState("running", this.vadState);
        }
        const now = performance.now();
        if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
          this.lastLevelAt = now;
          this.emit({ type: "level", ...measureLevel(frame), tsMs: Date.now() });
        }
        const probabilities = await vad.processFrame(frame);
        if (this.active?.failed) this.resetFailedSegment();
        await this.execute(this.segmenter.processFrame(frame, probabilities), frame);
        this.setVad(this.segmenter.vadState);
        await this.log.flush();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.draining = undefined;
    }
  }

  private async execute(actions: SegmenterAction[], frame?: Buffer): Promise<void> {
    for (const action of actions) {
      if (action.type === "OPEN") {
        const firstPush = actions.find((candidate) => candidate.type === "PUSH" && candidate.segmentId === action.segmentId);
        // The segmenter can start or rotate within a frame it has already cached.
        const frameSuffixBytes = frame && firstPush?.type === "PUSH"
          ? frame.byteOffset + frame.length - firstPush.pcm.byteOffset
          : 0;
        if (!await this.openSegment(action, frameSuffixBytes)) {
          this.resetFailedSegment();
          return;
        }
      } else if (action.type === "WARN") {
        this.warn(action.code, action.msg);
      } else {
        const segment = this.active;
        if (!segment || segment.id !== action.segmentId) throw new Error("ASR segment is out of sequence");
        if (action.type === "FINISH") {
          await this.finishSegment(segment, action);
        } else if (!segment.failed) {
          this.pushSegmentAudio(segment, action.pcm, action.type === "TAIL_SILENCE");
        }
      }
      if (this.active?.failed) {
        this.resetFailedSegment();
        return;
      }
    }
  }

  private async openSegment(
    action: Extract<SegmenterAction, { type: "OPEN" }>, frameSuffixBytes: number,
  ): Promise<boolean> {
    const prerollBytes = action.preroll.reduce((sum, buffer) => sum + buffer.length, 0);
    const startByte = Math.max(0, this.pcmBytesWritten - prerollBytes - frameSuffixBytes);
    const offsetSec = startByte / (SAMPLE_RATE * SAMPLE_BYTES);
    if (this.active) throw new Error("An ASR segment is already open");
    this.openedSegmentId = action.segmentId;
    const context = this.hotwords.toPromptContext();
    let session: AsrSession;
    try {
      session = await this.adapter.openSession({ language: "Chinese", chunkMs: this.frameMs, context });
    } catch (error) {
      this.warn("ASR_SESSION_ERROR", errorText(error));
      return false;
    }
    const segment: ActiveSegment = {
      id: action.segmentId, session, openedAt: Date.now(), offsetSec, nextSeq: 1, audioBytes: 0, failed: false,
    };
    this.active = segment;
    session.onDelta((text) => {
      if (this.active !== segment || segment.failed || !text) return;
      const tsMs = Date.now();
      this.ensureSegmentStart(segment, tsMs);
      this.record({ type: "transcript.delta", segmentId: segment.id, seq: segment.nextSeq++, text, tsMs });
    });
    session.onError((error) => this.abortSegment(segment, error));
    for (const frame of action.preroll) {
      if (segment.failed) break;
      this.pushSegmentAudio(segment, frame);
    }
    return true;
  }

  private pushSegmentAudio(segment: ActiveSegment, pcm: Buffer, tailSilence = false): void {
    try {
      segment.session.pushAudio(pcm);
      if (!tailSilence) segment.audioBytes += pcm.length;
    } catch (error) {
      this.abortSegment(segment, error);
    }
  }

  private abortSegment(segment: ActiveSegment, error: unknown): void {
    if (this.active !== segment || segment.failed) return;
    segment.failed = true;
    segment.session.abort();
    this.warn("ASR_SESSION_ERROR", errorText(error));
  }

  private resetFailedSegment(): void {
    // Reset VAD onset without sending END to a transport that was already aborted.
    this.segmenter.stop();
    const segment = this.active;
    if (segment) {
      this.closeSegment(segment, "stop", segment.audioBytes * 1000 / (SAMPLE_RATE * SAMPLE_BYTES));
    }
  }

  private async finishSegment(segment: ActiveSegment, action: FinishAction): Promise<void> {
    if (action.reason !== "stop") this.setVad(action.reason === "pause" ? "pausing" : "rotating");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        segment.session.finish(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out waiting for final transcription")), ASR_FINISH_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.abortSegment(segment, error);
    } finally {
      clearTimeout(timer);
      this.closeSegment(segment, action.reason, action.durMs);
    }
  }

  private closeSegment(segment: ActiveSegment, reason: FinishAction["reason"], durMs: number): void {
    this.ensureSegmentStart(segment, segment.openedAt);
    if (segment.audioIndex) {
      segment.audioIndex.durMs = durMs;
      this.audioIndexDirty = true;
      void this.flushAudioIndex();
    }
    this.record({ type: "segment.end", segmentId: segment.id, reason, durMs });
    this.active = undefined;
  }

  private ensureSegmentStart(segment: ActiveSegment, tsMs: number): void {
    if (segment.nextSeq !== 1) return;
    if (this.pcm && !this.pcmFailed) {
      segment.audioIndex = { segmentId: segment.id, startedAtMs: tsMs, offsetSec: segment.offsetSec };
      this.audioIndex.segments.push(segment.audioIndex);
      this.audioIndexDirty = true;
      void this.flushAudioIndex();
    }
    this.record({ type: "segment.start", segmentId: segment.id, tsMs });
  }

  private record(record: TranscriptLogRecord): void {
    void this.log.append(record).catch((error: unknown) => this.fail(error));
    this.emit(record);
  }

  private setVad(vad: VadState): void {
    if (vad === this.vadState) return;
    this.vadState = vad;
    this.updateState(undefined, vad);
  }

  private warn(code: string, msg: string): void {
    console.error(`[warn] ${code} ${msg}`);
    this.emit({ type: "warn", code, msg });
  }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.pending.length = 0;
    this.stop();
  }
}

class Scheduler {
  private readonly hotwords = new HotwordsStore();
  private readonly adapter: AsrAdapter;
  private readonly ws: SchedulerWsServer;
  private readonly shutdownSignal = new AbortController();
  private readonly restoredClients = new WeakSet<WebSocket>();
  private recording?: Recording;
  private recordingTask?: Promise<void>;
  private devicesTask?: Promise<Extract<ServerMessage, { type: "devices" }>>;
  private shutdownTask?: Promise<void>;
  private hasTranscript = false;
  private state: StateMessage = { type: "state", state: "idle", vad: "idle" };

  constructor(private readonly options: CliOptions) {
    this.adapter = options.engine === "mock" ? new MockAsrAdapter() : new R2T2Adapter();
    this.ws = new SchedulerWsServer((ws, msg) => this.handle(ws, msg), options.port);
  }

  async start(): Promise<void> {
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
    const { background } = this.hotwords.load();
    if (this.options.hotwords) this.hotwords.set({ hotwords: this.options.hotwords, background });
    await this.ws.start();
    if (this.shutdownSignal.signal.aborted) return;
    console.error(`[scheduler] listening on port ${this.options.port}`);
    if (!this.options.exitOnEof) {
      void startAdapter(this.adapter).catch((error: unknown) => {
        if (!this.shutdownSignal.signal.aborted) {
          console.error(`[scheduler] engine warmup failed: ${errorText(error)}`);
        }
      });
    }
    if (this.options.file) {
      const task = this.startRecording({ kind: "file", path: this.options.file, fast: this.options.fast }, ASR_CHUNK_MS);
      if (this.options.exitOnEof) {
        await task;
        await this.shutdown();
      }
    }
  }

  shutdown(): Promise<void> {
    return this.shutdownTask ??= this.close();
  }

  private async close(): Promise<void> {
    try {
      this.shutdownSignal.abort();
      await this.stopRecording();
      await this.devicesTask?.catch(() => {});
      await this.ws.close();
    } finally {
      await this.adapter.stop().catch(() => {});
      process.off("SIGINT", this.onSignal);
      process.off("SIGTERM", this.onSignal);
    }
  }

  private readonly onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    process.exitCode ??= signal === "SIGINT" ? 130 : 143;
    void this.shutdown().catch(reportFailure);
  };

  private async handle(ws: WebSocket, message: ClientMessage): Promise<void> {
    if (this.shutdownSignal.signal.aborted) return;
    switch (message.type) {
      case "hello":
        this.ws.send(ws, {
          type: "hello.ok",
          v: PROTOCOL_VERSION,
          engine: {
            name: this.options.engine === "mock" ? "mock" : "Confucius4-R2T2",
            quant: this.options.engine === "r2t2" && /f16/i.test(ASR_MODEL_PATH) ? "F16" : "Q8_0",
          },
          state: this.state.state,
        });
        this.ws.send(ws, this.state);
        this.ws.send(ws, this.hotwordsMessage());
        await this.restoreTranscript(ws);
        break;
      case "devices.list":
        this.ws.send(ws, await this.listDevices());
        break;
      case "session.start":
        if (this.recording) {
          this.ws.send(ws, { type: "error", code: "SESSION_ACTIVE", msg: "A recording is already active" });
          break;
        }
        void this.startRecording({
          kind: "capture", source: message.source, deviceId: message.deviceId,
        }, message.frameMs ?? ASR_CHUNK_MS);
        break;
      case "session.stop":
        await this.stopRecording();
        break;
      case "hotwords.get":
        this.ws.send(ws, this.hotwordsMessage());
        break;
      case "hotwords.set":
        this.hotwords.set({ hotwords: message.hotwords, background: message.background });
        this.ws.broadcast(this.hotwordsMessage());
        break;
      case "export.request": {
        const recording = this.recording;
        const sessionId = message.sessionId || "latest";
        try {
          await recording?.log.flush();
          const { path } = await exportSession({
            sessionId: sessionId === "latest" ? recording?.sessionId ?? "latest" : sessionId,
            format: message.format,
          });
          this.ws.send(ws, { type: "export.ready", path });
        } catch (error) {
          this.ws.send(ws, { type: "error", code: "EXPORT_FAILED", msg: errorText(error) });
        }
        break;
      }
    }
  }

  private async restoreTranscript(ws: WebSocket): Promise<void> {
    const canRestore = (): boolean => this.state.state === "idle" && !this.recording && !this.hasTranscript
      && !this.restoredClients.has(ws) && !this.shutdownSignal.signal.aborted;
    if (!canRestore()) return;

    const records = await loadLatestSessionRecords(undefined, join(DATA_DIR, "exports"));
    if (!canRestore()) return;
    this.restoredClients.add(ws);
    for (const record of records) {
      if (record.type !== "hotwords") this.ws.send(ws, record);
    }
  }

  private listDevices(): Promise<Extract<ServerMessage, { type: "devices" }>> {
    return this.devicesTask ??= this.readDevices().finally(() => {
      this.devicesTask = undefined;
    });
  }

  private async readDevices(): Promise<Extract<ServerMessage, { type: "devices" }>> {
    const { stdout } = await execFileAsync(CAPTURE_PATH, ["--list-devices"], {
      signal: this.shutdownSignal.signal,
      timeout: DEVICE_LIST_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: DEVICE_LIST_MAX_BYTES,
    });
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || !("devices" in value)) {
      throw new Error("Invalid capture device list");
    }
    const parsed = serverMessageSchema.safeParse({ type: "devices", devices: value.devices });
    if (!parsed.success || parsed.data.type !== "devices") throw new Error("Invalid capture device list");
    return parsed.data;
  }

  private hotwordsMessage(): ServerMessage {
    return {
      type: "hotwords", ...this.hotwords.get(), appliesFromSegment: this.recording?.nextSegmentId ?? 1,
    };
  }

  private startRecording(source: Source, frameMs: FrameMs): Promise<void> {
    const recording = new Recording(
      this.adapter,
      this.hotwords,
      (message) => {
        if (message.type === "transcript.delta") this.hasTranscript = true;
        this.ws.broadcast(message);
      },
      (state, vad) => {
        if (this.state.state !== "stopping") this.setState(state ?? this.state.state, vad);
      },
      frameMs,
    );
    this.recording = recording;
    this.setState("starting");
    this.recordingTask = recording.run(source).then(() => {
      this.setState("idle");
      if (source.kind === "file") console.error("[scheduler] file processing finished");
    }, (error: unknown) => {
      const msg = errorText(error);
      console.error(`[error] ${msg}`);
      this.ws.broadcast({ type: "error", code: "SESSION_FAILED", msg });
      this.setState("error");
      if (source.kind === "file" && this.options.exitOnEof) process.exitCode ??= 1;
    }).finally(() => {
      this.recording = undefined;
      this.recordingTask = undefined;
    });
    return this.recordingTask;
  }

  private async stopRecording(): Promise<void> {
    if (this.recording) {
      this.setState("stopping", this.state.vad);
      this.recording.stop();
      await this.recordingTask;
    }
    this.setState("idle");
  }

  private setState(state: StateMessage["state"], vad: VadState = "idle"): void {
    if (state === this.state.state && vad === this.state.vad) return;
    this.state = { type: "state", state, vad };
    this.ws.broadcast(this.state);
  }
}

async function main(): Promise<void> {
  const scheduler = new Scheduler(parseArgs(process.argv.slice(2)));
  try {
    await scheduler.start();
  } catch (error) {
    await scheduler.shutdown();
    throw error;
  }
}

function reportFailure(error: unknown): void {
  process.exitCode = 1;
  console.error(`[error] ${errorText(error)}`);
}

void main().catch(reportFailure);
