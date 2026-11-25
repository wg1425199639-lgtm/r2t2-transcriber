import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatExportContent } from "../App";
import { SchedulerWsClient } from "./ws-client";
import type { ServerMessage } from "./ws-client";
import { SessionStore } from "../store/session";

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

let client: SchedulerWsClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
  client = new SchedulerWsClient();
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("Expected a WebSocket");
  return socket;
}

describe("SchedulerWsClient", () => {
  it("reconnects with capped exponential backoff and sends the handshake on every open", () => {
    client = new SchedulerWsClient("ws://127.0.0.1:47801/ws");
    const onStatus = vi.fn();
    client.onStatusChange(onStatus);
    client.connect();
    client.connect();

    for (const delay of [500, 1_000, 2_000, 4_000, 5_000, 5_000]) {
      const count = FakeWebSocket.instances.length;
      latestSocket().close();
      expect(client.connectionStatus).toBe("reconnecting");
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(count + 1);
    }

    const socket = latestSocket();
    expect(socket.url).toBe("ws://127.0.0.1:47801/ws");
    const handshake = [{ type: "hello", v: 1 }, { type: "devices.list" }, { type: "hotwords.get" }];
    socket.open();
    expect(socket.sent).toEqual(handshake);
    expect(onStatus.mock.calls).toEqual([["connecting"], ["reconnecting"], ["connected"]]);

    socket.close();
    vi.advanceTimersByTime(499);
    expect(latestSocket()).toBe(socket);
    vi.advanceTimersByTime(1);
    const reconnected = latestSocket();
    expect(reconnected).not.toBe(socket);
    reconnected.open();
    expect(reconnected.sent).toEqual(handshake);

    reconnected.close();
    client.close();
    expect(client.connectionStatus).toBe("disconnected");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(latestSocket()).toBe(reconnected);
  });

  it("reports malformed JSON, invalid schemas and binary frames while accepting valid messages", () => {
    const onError = vi.fn();
    const onMessage = vi.fn();
    client.onError(onError);
    client.onMessage(onMessage);
    client.connect();
    const socket = latestSocket();
    expect(socket.url).toBe("ws://127.0.0.1:47800/ws");
    socket.open();

    socket.receive("{");
    socket.receive('{"type":"state","state":"idle"}');
    socket.receive('{"type":"devices","devices":[{"id":"1","name":"Mic","kind":"input","extra":true}]}');
    socket.receive(new ArrayBuffer(0));
    expect(onError).toHaveBeenCalledTimes(4);
    expect(onMessage).not.toHaveBeenCalled();

    const valid = { type: "state", state: "running", vad: "speaking" };
    socket.receive(JSON.stringify(valid));
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(valid);

    client.close();
    socket.receive(JSON.stringify(valid));
    socket.open();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(3);
  });
});

describe("SessionStore", () => {
  it("toggles bookmarks on non-empty segments and keeps them through deltas and completion", () => {
    const store = new SessionStore(client);
    store.connect();
    const socket = latestSocket();
    socket.open();
    const emit = (message: ServerMessage) => socket.receive(JSON.stringify(message));
    expect(store.toggleLatestBookmark()).toBe(false);

    emit({ type: "transcript.delta", segmentId: 1, seq: 1, text: "重点", tsMs: 10 });
    emit({ type: "transcript.delta", segmentId: 2, seq: 1, text: " \t", tsMs: 20 });
    const before = store.getSnapshot();
    expect(store.toggleBookmark(2)).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(store.toggleLatestBookmark()).toBe(true);
    expect(store.getSnapshot().segments[1]).toBe(before.segments[1]);
    expect(before.segments[0]).not.toHaveProperty("bookmarked");

    emit({ type: "transcript.delta", segmentId: 1, seq: 2, text: "内容", tsMs: 30 });
    expect(store.getSnapshot().segments[0]).toMatchObject({ text: "重点内容", active: true, bookmarked: true });
    emit({ type: "segment.end", segmentId: 1, reason: "pause", durMs: 100 });
    expect(store.getSnapshot().segments[0]).toMatchObject({ active: false, bookmarked: true });
    expect(store.toggleBookmark(1)).toBe(false);
    expect(store.getSnapshot().segments[0]).not.toHaveProperty("bookmarked");
    store.dispose();
  });

  it("selects the requested recording when segment IDs are reused", () => {
    const store = new SessionStore(client);
    store.connect();
    const socket = latestSocket();
    socket.open();
    const emit = (message: ServerMessage) => socket.receive(JSON.stringify(message));
    emit({ type: "transcript.delta", segmentId: 1, seq: 1, text: "第一轮", tsMs: 10 });
    emit({ type: "state", state: "starting", vad: "idle" });
    emit({ type: "segment.start", segmentId: 1, tsMs: 20 });
    expect(store.toggleBookmark(1)).toBe(true);
    expect(store.getSnapshot().segments.map((segment) => segment.bookmarked)).toEqual([true, undefined]);

    emit({ type: "transcript.delta", segmentId: 1, seq: 1, text: "第二轮", tsMs: 30 });
    expect(store.toggleBookmark(1, 10)).toBe(false);
    expect(store.toggleBookmark(1, 30)).toBe(false);
    expect(store.toggleBookmark(1)).toBe(true);
    expect(store.getSnapshot().segments.map((segment) => segment.bookmarked)).toEqual([undefined, true]);
    expect(store.toggleLatestBookmark()).toBe(false);
    expect(store.toggleBookmark(1, 10)).toBe(true);
    expect(store.getSnapshot().segments.map((segment) => segment.bookmarked)).toEqual([true, undefined]);
    store.dispose();
  });

  it("appends increasing deltas per segment and drops empty completed segments", () => {
    const store = new SessionStore(client);
    store.connect();
    const socket = latestSocket();
    socket.open();
    const emit = (message: ServerMessage) => socket.receive(JSON.stringify(message));
    const delta = (segmentId: number, seq: number, text: string) =>
      emit({ type: "transcript.delta", segmentId, seq, text, tsMs: 20 });

    emit({ type: "segment.start", segmentId: 1, tsMs: 10 });
    delta(1, 2, "首段");
    const firstSnapshot = store.getSnapshot();
    delta(1, 2, "重复");
    delta(1, 1, "乱序");
    expect(store.getSnapshot()).toBe(firstSnapshot);

    emit({ type: "segment.start", segmentId: 2, tsMs: 15 });
    delta(2, 1, " \t");
    delta(3, 1, "次段");
    emit({ type: "segment.start", segmentId: 3, tsMs: 16 });
    emit({ type: "segment.end", segmentId: 2, reason: "pause", durMs: 100 });
    delta(2, 2, "迟到");
    delta(3, 2, "。");
    delta(1, 3, "。");
    emit({ type: "segment.end", segmentId: 1, reason: "soft", durMs: 200 });
    delta(1, 4, "迟到");

    expect(firstSnapshot.segments[0].text).toBe("首段");
    expect(store.getSnapshot().segments).toEqual([
      { segmentId: 1, startedAtMs: 10, text: "首段。", active: false, reason: "soft", durMs: 200 },
      { segmentId: 3, startedAtMs: 20, text: "次段。", active: true },
    ]);

    emit({ type: "segment.end", segmentId: 3, reason: "stop", durMs: 300 });
    emit({ type: "hello.ok", v: 1, engine: { name: "mock", quant: "Q8_0" }, state: "starting" });
    emit({ type: "state", state: "starting", vad: "idle" });
    delta(1, 1, "新录制");
    expect(store.getSnapshot().segments.map(({ text }) => text)).toEqual(["首段。", "次段。", "新录制"]);

    store.clearTranscript();
    delta(1, 1, "重复");
    expect(store.getSnapshot().segments).toEqual([]);
    delta(1, 2, "继续");
    expect(store.getSnapshot().segments[0].text).toBe("继续");
    store.dispose();
  });
});

describe("formatExportContent", () => {
  const first = { segmentId: 1, startedAtMs: new Date(2026, 0, 1, 3, 4, 5).getTime(), text: "第一行\n第二行", active: false };
  const second = { ...first, segmentId: 2, startedAtMs: first.startedAtMs + 1000, text: "普通段落" };
  const blank = { ...first, segmentId: 3, text: " \t\n", bookmarked: true };

  it("summarizes bookmarked paragraphs above the full Markdown transcript", () => {
    const longText = "长".repeat(101);
    const segments = [{ ...first, bookmarked: true }, { ...second, text: longText, bookmarked: true }, blank];
    expect(formatExportContent(segments, "md")).toBe(
      "# 实时语音转写记录\n\n## 重点打点速览\n\n"
      + "- [03:04:05] 第一行 第二行\n"
      + `- [03:04:06] ${"长".repeat(100)}…\n\n## 全文记录\n\n`
      + `[03:04:05] 第一行\n第二行\n\n[03:04:06] ${longText}`,
    );
  });

  it("omits the overview when no non-empty paragraph is bookmarked and preserves plain text", () => {
    expect(formatExportContent([first, second, blank], "md")).toBe(
      "# 实时语音转写记录\n\n[03:04:05] 第一行\n第二行\n\n[03:04:06] 普通段落",
    );
    expect(formatExportContent([{ ...first, bookmarked: true }, second, blank], "txt")).toBe("第一行\n第二行\n\n普通段落");
    expect(formatExportContent([blank], "md")).toBe("");
    expect(formatExportContent([blank], "txt")).toBe("");
  });
});
