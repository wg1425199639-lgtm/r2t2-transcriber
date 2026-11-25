import { useSyncExternalStore } from "react";
import { SchedulerWsClient } from "../lib/ws-client";
import type { ClientMessage, ConnectionStatus, ServerMessage } from "../lib/ws-client";

type Message<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
type StartSession = Extract<ClientMessage, { type: "session.start" }>;
type Diagnostic = Pick<Message<"error">, "code" | "msg">;

export interface TranscriptSegment {
  segmentId: number;
  startedAtMs: number;
  text: string;
  active: boolean;
  reason?: Message<"segment.end">["reason"];
  durMs?: number;
}

export interface SessionSnapshot {
  connectionStatus: ConnectionStatus;
  engine: Message<"hello.ok">["engine"] | null;
  sessionState: Message<"state">["state"];
  vadState: Message<"state">["vad"];
  devices: Message<"devices">["devices"];
  level: Omit<Message<"level">, "type"> & { lastNonSilentTsMs: number | null };
  hotwords: string[];
  background: string;
  appliesFromSegment: number | null;
  segments: TranscriptSegment[];
  warnings: Diagnostic[];
  lastError: Diagnostic | null;
}

interface SegmentProgress {
  index?: number;
  lastSeq: number;
  ended: boolean;
}

const NON_SILENT_RMS_DB = -60;
const MAX_WARNINGS = 100;

export class SessionStore {
  private snapshot: SessionSnapshot = {
    connectionStatus: "disconnected",
    engine: null,
    sessionState: "idle",
    vadState: "idle",
    devices: [],
    level: { rmsDb: -60, peakDb: -60, tsMs: 0, lastNonSilentTsMs: null },
    hotwords: [],
    background: "",
    appliesFromSegment: null,
    segments: [],
    warnings: [],
    lastError: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly segmentProgress = new Map<number, SegmentProgress>();
  private readonly unsubscribeClient: Array<() => void>;

  constructor(private readonly client = new SchedulerWsClient()) {
    this.snapshot.connectionStatus = client.connectionStatus;
    this.unsubscribeClient = [
      client.onStatusChange((connectionStatus) => this.update({ connectionStatus })),
      client.onMessage((message) => this.receive(message)),
      client.onError((error) => this.update({ lastError: { code: "WS_ERROR", msg: error.message } })),
    ];
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  connect = (): void => this.client.connect();
  close = (): void => this.client.close();

  dispose(): void {
    this.close();
    for (const unsubscribe of this.unsubscribeClient) unsubscribe();
    this.listeners.clear();
  }

  startSession = (source: StartSession["source"], deviceId?: string, frameMs?: StartSession["frameMs"]): boolean =>
    this.client.send({ type: "session.start", source, deviceId, frameMs });

  stopSession = (): boolean => this.client.send({ type: "session.stop" });

  setHotwords = (hotwords: string[], background: string): boolean =>
    this.client.send({ type: "hotwords.set", hotwords, background });

  refreshDevices = (): boolean => this.client.send({ type: "devices.list" });

  clearTranscript = (): void => {
    for (const progress of this.segmentProgress.values()) progress.index = undefined;
    this.update({ segments: [] });
  };

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case "hello.ok":
        this.updateSessionState(message.state, { engine: message.engine });
        break;
      case "state":
        this.updateSessionState(message.state, { vadState: message.vad });
        break;
      case "devices":
        this.update({ devices: message.devices });
        break;
      case "level": {
        const { rmsDb, peakDb, tsMs } = message;
        const lastNonSilentTsMs = rmsDb > NON_SILENT_RMS_DB
          ? tsMs
          : this.snapshot.level.lastNonSilentTsMs;
        this.update({ level: { rmsDb, peakDb, tsMs, lastNonSilentTsMs } });
        break;
      }
      case "hotwords": {
        const { hotwords, background, appliesFromSegment } = message;
        this.update({ hotwords, background, appliesFromSegment });
        break;
      }
      case "warn":
        this.update({ warnings: [...this.snapshot.warnings.slice(1 - MAX_WARNINGS), { code: message.code, msg: message.msg }] });
        break;
      case "error":
        this.update({ lastError: { code: message.code, msg: message.msg } });
        break;
      case "segment.start":
      case "transcript.delta":
      case "segment.end":
        this.mergeSegment(message);
        break;
    }
  }

  private updateSessionState(sessionState: SessionSnapshot["sessionState"], patch: Partial<SessionSnapshot>): void {
    if (sessionState === "starting" && this.snapshot.sessionState !== "starting") {
      this.segmentProgress.clear();
      this.update({
        ...patch,
        sessionState,
        segments: this.snapshot.segments
          .filter((segment) => !segment.active || segment.text.trim().length > 0)
          .map((segment) => segment.active ? { ...segment, active: false } : segment),
        level: { ...this.snapshot.level, lastNonSilentTsMs: null },
      });
      return;
    }
    this.update({ ...patch, sessionState });
  }

  private mergeSegment(message: Message<"segment.start" | "transcript.delta" | "segment.end">): void {
    const { segmentId } = message;
    const progress = this.segmentProgress.get(segmentId) ?? { lastSeq: -1, ended: false };
    if (progress.ended) return;

    const index = progress.index;
    const segments = this.snapshot.segments;
    const current = index === undefined ? undefined : segments[index];

    if (message.type === "segment.end") {
      progress.ended = true;
      this.segmentProgress.set(segmentId, progress);
      if (index === undefined || !current) return;
      if (current.text.trim().length === 0) {
        progress.index = undefined;
        for (const entry of this.segmentProgress.values()) {
          if (entry.index !== undefined && entry.index > index) entry.index--;
        }
        this.update({ segments: segments.filter((_, position) => position !== index) });
      } else {
        const { reason, durMs } = message;
        this.update({ segments: segments.map((segment, position) =>
          position === index ? { ...current, active: false, reason, durMs } : segment) });
      }
      return;
    }

    if (message.type === "segment.start" && this.segmentProgress.has(segmentId)) return;
    if (message.type === "transcript.delta" && message.seq <= progress.lastSeq) return;

    const segment = current ?? { segmentId, startedAtMs: message.tsMs, text: "", active: true };
    const next = message.type === "transcript.delta"
      ? { ...segment, text: segment.text + message.text }
      : segment;
    if (message.type === "transcript.delta") progress.lastSeq = message.seq;
    progress.index = index ?? segments.length;
    this.segmentProgress.set(segmentId, progress);
    this.update({ segments: index === undefined ? [...segments, next] : segments.map((segment, position) => position === index ? next : segment) });
  }
}

export const sessionStore = new SessionStore();

export function useSessionStore(store: SessionStore = sessionStore): SessionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
