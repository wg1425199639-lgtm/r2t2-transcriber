/// <reference path="../../../scheduler/node_modules/@types/node/index.d.ts" />

import { z } from "zod";
import type { ClientMessage, ServerMessage } from "../../../scheduler/src/protocol";

// Wire values mirrored from the scheduler protocol for browser validation.
const SHORT_FRAME_MS = 160;
const FRAME_MS = 320;

export const PROTOCOL_VERSION = 1;

const version = z.literal(PROTOCOL_VERSION);
const sessionState = z.enum(["idle", "starting", "running", "stopping", "error"]);
const vadState = z.enum(["idle", "speaking", "pausing", "rotating"]);
const nonNegativeInteger = z.number().int().nonnegative();
const timestamp = z.number().finite().nonnegative();
const hotwordsFields = {
  hotwords: z.array(z.string()),
  background: z.string(),
};
const diagnosticFields = {
  code: z.string(),
  msg: z.string(),
};
const device = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["input", "system"]),
}).strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), v: version }).strict(),
  z.object({ type: z.literal("devices.list") }).strict(),
  z.object({
    type: z.literal("session.start"),
    source: z.enum(["system", "mic"]),
    deviceId: z.string().optional(),
    frameMs: z.union([z.literal(SHORT_FRAME_MS), z.literal(FRAME_MS)]).optional(),
  }).strict(),
  z.object({ type: z.literal("session.stop") }).strict(),
  z.object({ type: z.literal("hotwords.set"), ...hotwordsFields }).strict(),
  z.object({ type: z.literal("hotwords.get") }).strict(),
  z.object({
    type: z.literal("export.request"),
    format: z.enum(["md", "txt"]),
    sessionId: z.string(),
  }).strict(),
]);

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello.ok"),
    v: version,
    engine: z.object({ name: z.string(), quant: z.enum(["F16", "Q8_0"]) }).strict(),
    state: sessionState,
  }).strict(),
  z.object({ type: z.literal("state"), state: sessionState, vad: vadState }).strict(),
  z.object({ type: z.literal("devices"), devices: z.array(device) }).strict(),
  z.object({
    type: z.literal("level"),
    rmsDb: z.number().finite(),
    peakDb: z.number().finite(),
    tsMs: timestamp,
  }).strict(),
  z.object({
    type: z.literal("segment.start"),
    segmentId: nonNegativeInteger,
    tsMs: timestamp,
  }).strict(),
  z.object({
    type: z.literal("transcript.delta"),
    segmentId: nonNegativeInteger,
    seq: nonNegativeInteger,
    text: z.string(),
    tsMs: timestamp,
  }).strict(),
  z.object({
    type: z.literal("segment.end"),
    segmentId: nonNegativeInteger,
    reason: z.enum(["pause", "soft", "force", "watchdog", "stop"]),
    durMs: timestamp,
  }).strict(),
  z.object({
    type: z.literal("hotwords"),
    ...hotwordsFields,
    appliesFromSegment: nonNegativeInteger,
  }).strict(),
  z.object({ type: z.literal("export.ready"), path: z.string() }).strict(),
  z.object({ type: z.literal("warn"), ...diagnosticFields }).strict(),
  z.object({ type: z.literal("error"), ...diagnosticFields }).strict(),
]);

export type { ClientMessage, ServerMessage };

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

const SCHEDULER_URL = "ws://127.0.0.1:47800/ws";
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5_000;

function subscribe<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export class SchedulerWsClient {
  private status: ConnectionStatus = "disconnected";
  private enabled = false;
  private socket?: WebSocket;
  private removeSocketListeners?: () => void;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryMs = INITIAL_RETRY_MS;
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(private readonly url = SCHEDULER_URL) {}

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  onStatusChange = (listener: (status: ConnectionStatus) => void): (() => void) =>
    subscribe(this.statusListeners, listener);

  onMessage = (listener: (message: ServerMessage) => void): (() => void) =>
    subscribe(this.messageListeners, listener);

  onError = (listener: (error: Error) => void): (() => void) =>
    subscribe(this.errorListeners, listener);

  connect(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.setStatus("connecting");
    this.openSocket();
  }

  close(): void {
    this.enabled = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryMs = INITIAL_RETRY_MS;
    const socket = this.socket;
    this.detachSocket();
    socket?.close();
    this.setStatus("disconnected");
  }

  send(message: ClientMessage): boolean {
    const parsed = clientMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.reportError(parsed.error);
      return false;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.reportError(new Error("Scheduler WebSocket is disconnected"));
      return false;
    }

    try {
      this.socket.send(JSON.stringify(parsed.data));
      return true;
    } catch (error) {
      this.reportError(new Error("Unable to send scheduler message", { cause: error }));
      return false;
    }
  }

  private openSocket(): void {
    if (!this.enabled || this.socket) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.reportError(new Error("Unable to open scheduler WebSocket", { cause: error }));
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    const onOpen = () => {
      this.retryMs = INITIAL_RETRY_MS;
      this.send({ type: "hello", v: PROTOCOL_VERSION });
      this.send({ type: "devices.list" });
      this.send({ type: "hotwords.get" });
      if (this.socket === socket) this.setStatus("connected");
    };
    const onMessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    const onError = () => this.reportError(new Error("Scheduler WebSocket failed"));
    const onClose = () => {
      this.detachSocket();
      this.scheduleRetry();
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    this.removeSocketListeners = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
  }

  private detachSocket(): void {
    this.removeSocketListeners?.();
    this.removeSocketListeners = undefined;
    this.socket = undefined;
  }

  private scheduleRetry(): void {
    if (!this.enabled || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.openSocket();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.setStatus("reconnecting");
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") {
      this.reportError(new Error("Scheduler messages must be JSON text"));
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch (error) {
      this.reportError(new Error("Invalid scheduler JSON", { cause: error }));
      return;
    }

    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.reportError(parsed.error);
      return;
    }
    for (const listener of this.messageListeners) listener(parsed.data);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private reportError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
