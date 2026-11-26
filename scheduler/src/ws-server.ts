import { lstat, open, opendir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer } from "ws";
import { BYTES_PER_SAMPLE, CHANNELS, DATA_DIR, SAMPLE_RATE, WS_HOST, WS_PATH, WS_PORT } from "./config.js";
import { PROTOCOL_VERSION, clientMessageSchema, type ClientMessage, type ServerMessage } from "./protocol.js";

const LEVEL_BACKPRESSURE_BYTES = 65_536;
const WS_CLOSE_GRACE_MS = 1_000;

export class SchedulerWsServer {
  private server?: WebSocketServer;
  private httpServer?: Server;
  private startup?: Promise<void>;
  private closing?: Promise<void>;

  constructor(
    private readonly onMessage: (ws: WebSocket, message: ClientMessage) => void | Promise<void>,
    private readonly port = WS_PORT,
    private readonly sessionsDir = join(DATA_DIR, "sessions"),
  ) {}

  get boundPort(): number | undefined {
    const address = this.httpServer?.address();
    return typeof address === "object" ? address?.port : undefined;
  }

  start(): Promise<void> {
    if (this.closing) return this.closing.then(() => this.start());
    if (this.startup) return this.startup;

    const server = new WebSocketServer({ noServer: true });
    const httpServer = createServer((req, res) => {
      void this.handleHttp(req, res).catch((error: unknown) => {
        if (res.destroyed) return;
        if (res.headersSent) {
          res.destroy();
        } else {
          if (!isMissing(error)) console.error("[http]", error);
          res.removeHeader("Content-Length");
          res.removeHeader("Content-Range");
          res.writeHead(isMissing(error) ? 404 : 500).end();
        }
      });
    });
    this.httpServer = httpServer;
    httpServer.on("upgrade", (req, socket, head) => {
      if (this.closing || requestUrl(req)?.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      server.handleUpgrade(req, socket, head, (ws) => server.emit("connection", ws, req));
    });
    this.server = server;
    server.on("connection", (ws) => {
      ws.on("error", (error) => console.error(`[ws] ${error.message}`));
      ws.on("message", (raw, isBinary) => {
        if (this.closing) return;
        let value: unknown;
        try {
          if (!isBinary) value = JSON.parse(raw.toString());
        } catch {
          // The schema rejects malformed JSON along with other invalid messages.
        }
        const message = clientMessageSchema.safeParse(value);
        if (!message.success) {
          this.send(ws, { type: "error", code: "INVALID_MESSAGE", msg: "Invalid scheduler WS message" });
          return;
        }
        void this.dispatch(ws, message.data);
      });
    });

    this.startup = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        httpServer.off("error", onError);
        httpServer.on("error", (error) => console.error(`[http] ${error.message}`));
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(this.port, WS_HOST);
    });
    return this.startup;
  }

  broadcast(msg: ServerMessage): void {
    for (const ws of this.server?.clients ?? []) this.send(ws, msg);
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (msg.type === "level" && ws.bufferedAmount > LEVEL_BACKPRESSURE_BYTES) return;
    ws.send(JSON.stringify(msg));
  }

  close(): Promise<void> {
    return this.closing ??= this.closeServer().finally(() => {
      this.server = undefined;
      this.httpServer = undefined;
      this.startup = undefined;
      this.closing = undefined;
    });
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await this.startup?.catch(() => {});
    const httpServer = this.httpServer;
    const httpClosed = new Promise<void>((resolve) => {
      if (httpServer) httpServer.close(() => resolve());
      else resolve();
    });
    const timer = setTimeout(() => {
      for (const ws of server.clients) ws.terminate();
      httpServer?.closeAllConnections();
    }, WS_CLOSE_GRACE_MS);
    const wsClosed = new Promise<void>((resolve) => {
      for (const ws of server.clients) ws.close(1001);
      server.close(() => resolve());
    });
    await Promise.all([httpClosed, wsClosed]).finally(() => clearTimeout(timer));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    if (!url) {
      res.writeHead(400).end();
      return;
    }
    const audio = url.pathname.startsWith("/audio/");
    if (audio) {
      for (const [name, value] of Object.entries(AUDIO_CORS)) res.setHeader(name, value);
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
    }
    if (!["/caption", "/audio/latest.wav", "/audio/latest.json"].includes(url.pathname)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: audio ? "GET, HEAD, OPTIONS" : "GET, HEAD" }).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/caption") {
      sendBody(req, res, "text/html; charset=utf-8", CAPTION_HTML);
      return;
    }
    const requestedId = url.searchParams.get("sessionId");
    if (requestedId !== null && !validSessionId(requestedId)) {
      res.writeHead(400).end();
      return;
    }
    const id = await this.findSession(requestedId);
    if (id === undefined) {
      res.writeHead(404).end();
      return;
    }
    if (url.pathname.endsWith(".json")) {
      let body: string;
      try {
        body = await readFile(join(this.sessionsDir, `${id}.audio.json`), "utf8");
      } catch (error) {
        if (!isMissing(error)) throw error;
        body = JSON.stringify({ sessionId: id, audioStartedAtMs: 0, segments: [] });
      }
      sendBody(req, res, "application/json; charset=utf-8", body);
    } else {
      await sendWav(req, res, join(this.sessionsDir, `${id}.pcm`));
    }
  }

  private async findSession(requestedId: string | null): Promise<string | undefined> {
    try {
      if (requestedId !== null) {
        return (await lstat(join(this.sessionsDir, `${requestedId}.pcm`))).isFile() ? requestedId : undefined;
      }
      let latest: { id: string; mtimeMs: number } | undefined;
      for await (const entry of await opendir(this.sessionsDir)) {
        if (!entry.isFile() || !entry.name.endsWith(".pcm")) continue;
        const id = entry.name.slice(0, -4);
        if (!validSessionId(id)) continue;
        try {
          const stat = await lstat(join(this.sessionsDir, entry.name));
          if (!stat.isFile()) continue;
          const { mtimeMs } = stat;
          if (!latest || mtimeMs > latest.mtimeMs || (mtimeMs === latest.mtimeMs && id > latest.id)) {
            latest = { id, mtimeMs };
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return latest?.id;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return undefined;
    }
  }

  private async dispatch(ws: WebSocket, message: ClientMessage): Promise<void> {
    try {
      await this.onMessage(ws, message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.send(ws, { type: "error", code: "COMMAND_FAILED", msg });
    }
  }
}

const SAMPLE_BYTES = CHANNELS * BYTES_PER_SAMPLE;
const WAV_HEADER_BYTES = 44;
const AUDIO_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
};

function requestUrl(req: IncomingMessage): URL | undefined {
  if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) return undefined;
  return new URL(req.url, `http://${WS_HOST}`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validSessionId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

function sendBody(req: IncomingMessage, res: ServerResponse, type: string, body: string): void {
  res.writeHead(200, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
}

function wavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + pcmBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * SAMPLE_BYTES, 28);
  header.writeUInt16LE(SAMPLE_BYTES, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

function parseRange(range: string, total: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match) return undefined;
  const [, first, last] = match;
  if (!first && !last) return undefined;
  if (!first) {
    const suffix = Number(last);
    if (suffix === 0) return undefined;
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(first);
  const end = last ? Math.min(Number(last), total - 1) : total - 1;
  return start <= end ? { start, end } : undefined;
}

async function sendWav(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const pcmBytes = size - size % SAMPLE_BYTES;
    const total = WAV_HEADER_BYTES + pcmBytes;
    const { range } = req.headers;
    const span = range === undefined ? { start: 0, end: total - 1 } : parseRange(range, total);
    res.setHeader("Accept-Ranges", "bytes");
    if (!span) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      return;
    }
    if (res.destroyed) return;
    const { start, end } = span;
    const header = wavHeader(pcmBytes).subarray(start, end + 1);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", end - start + 1);
    if (range !== undefined) res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.writeHead(range === undefined ? 200 : 206);
    if (req.method === "HEAD") {
      res.end();
    } else if (end < WAV_HEADER_BYTES) {
      res.end(header);
    } else {
      if (header.length > 0) res.write(header);
      await pipeline(file.createReadStream({
        start: Math.max(0, start - WAV_HEADER_BYTES),
        end: end - WAV_HEADER_BYTES,
        autoClose: false,
      }), res);
    }
  } finally {
    await file.close();
  }
}

const CAPTION_HTML = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>直播字幕</title>
<style>
  html, body { background: transparent; margin: 0; overflow: hidden; }
  #caption {
    position: fixed; inset: auto 16px 12px; margin: auto; max-width: 30em;
    color: #F2F2F5; font: 28px/1.55 "PingFang SC", sans-serif; text-align: center;
    text-shadow: 0 2px 6px rgba(0,0,0,0.9); overflow-wrap: anywhere;
    max-height: 3.1em; overflow: hidden; white-space: pre-wrap;
    opacity: 0; transition: opacity 480ms ease-out;
  }
  #caption.visible { opacity: 1; transition-duration: 120ms; }
  .hit { background: rgba(91,141,239,0.28); border-radius: 3px; }
</style>
<div id="caption"></div>
<script>
  const caption = document.getElementById("caption");
  let tail = "";
  let segment;
  let renderedSegment;
  let sequence = 0;
  let lastDelta;
  let hotwords = [];
  let hideTimer;
  let retryTimer;
  let retryMs = 250;
  let socket;
  let stopped = false;

  function render() {
    const nodes = document.createDocumentFragment();
    let plainStart = 0;
    for (let i = 0; i < tail.length;) {
      const word = hotwords.find((word) => tail.startsWith(word, i));
      if (!word) {
        i++;
        continue;
      }
      nodes.append(document.createTextNode(tail.slice(plainStart, i)));
      const hit = document.createElement("span");
      hit.className = "hit";
      hit.textContent = word;
      nodes.append(hit);
      i += word.length;
      plainStart = i;
    }
    nodes.append(document.createTextNode(tail.slice(plainStart)));
    caption.replaceChildren(nodes);
    caption.scrollTop = caption.scrollHeight;
  }

  function startSegment(id) {
    if (segment === id) return;
    segment = id;
    sequence = 0;
  }

  function connect() {
    socket = new WebSocket("ws://" + location.host + ${JSON.stringify(WS_PATH)});
    socket.addEventListener("open", () => {
      retryMs = 250;
      segment = undefined;
      socket.send(JSON.stringify({ type: "hello", v: ${PROTOCOL_VERSION} }));
      socket.send(JSON.stringify({ type: "hotwords.get" }));
    });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "state" && message.state === "starting") {
        tail = "";
        segment = renderedSegment = lastDelta = undefined;
        render();
      } else if (message.type === "hotwords") {
        hotwords = message.hotwords.filter(Boolean).sort((a, b) => b.length - a.length);
        render();
      } else if (message.type === "segment.start") {
        startSegment(message.segmentId);
      } else if (message.type === "transcript.delta" && message.text) {
        if (lastDelta && (message.tsMs < lastDelta.tsMs ||
            (message.tsMs === lastDelta.tsMs && message.segmentId === lastDelta.segmentId &&
             message.seq <= lastDelta.seq))) return;
        startSegment(message.segmentId);
        if (message.seq <= sequence) return;
        lastDelta = message;
        sequence = message.seq;
        const separator = tail && renderedSegment !== segment ? " " : "";
        tail = Array.from(tail + separator + message.text).slice(-60).join("");
        renderedSegment = segment;
        render();
        caption.classList.add("visible");
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => caption.classList.remove("visible"), 5000);
      }
    });
    socket.addEventListener("close", () => {
      if (stopped) return;
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 5000);
    });
  }

  window.addEventListener("resize", () => { caption.scrollTop = caption.scrollHeight; });
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(retryTimer);
    clearTimeout(hideTimer);
    socket.close();
  });
  connect();
</script>
</html>`;
