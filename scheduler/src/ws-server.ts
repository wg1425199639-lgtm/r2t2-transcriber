import { WebSocket, WebSocketServer } from "ws";
import { WS_HOST, WS_PATH, WS_PORT } from "./config.js";
import { clientMessageSchema, type ClientMessage, type ServerMessage } from "./protocol.js";

const LEVEL_BACKPRESSURE_BYTES = 65_536;
const WS_CLOSE_GRACE_MS = 1_000;

export class SchedulerWsServer {
  private server?: WebSocketServer;
  private startup?: Promise<void>;
  private closing?: Promise<void>;

  constructor(
    private readonly onMessage: (ws: WebSocket, message: ClientMessage) => void | Promise<void>,
    private readonly port = WS_PORT,
  ) {}

  start(): Promise<void> {
    if (this.closing) return this.closing.then(() => this.start());
    if (this.startup) return this.startup;

    const server = new WebSocketServer({ host: WS_HOST, port: this.port, path: WS_PATH });
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
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        server.on("error", (error) => console.error(`[ws] ${error.message}`));
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
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
      this.startup = undefined;
      this.closing = undefined;
    });
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await this.startup?.catch(() => {});
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const ws of server.clients) ws.terminate();
      }, WS_CLOSE_GRACE_MS);
      for (const ws of server.clients) ws.close(1001);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
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
