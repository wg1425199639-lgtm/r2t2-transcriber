// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../lib/ws-client";
import { SessionStore } from "../store/session";
import { CaptionOverlay } from "./CaptionOverlay";

class FakeWebSocket extends EventTarget {
  close = vi.fn();

  constructor() {
    super();
    socket = this;
  }

  receive(message: ServerMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

let socket: FakeWebSocket;
let store: SessionStore;

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  store = new SessionStore();
});

afterEach(() => {
  cleanup();
  store.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function start(segmentId = 1): void {
  socket.receive({ type: "segment.start", segmentId, tsMs: 1 });
}

function delta(text: string, seq = 1, segmentId = 1): void {
  socket.receive({ type: "transcript.delta", segmentId, seq, text, tsMs: seq });
}

function caption(): HTMLElement {
  return screen.getByRole("region", { name: "悬浮字幕" });
}

describe("CaptionOverlay", () => {
  it("uses outlined text on a transparent canvas by default", () => {
    render(<CaptionOverlay store={store} />);
    const { style } = caption();
    expect(style.backgroundColor).toBe("");
    expect(style.border).toBe("");
    expect(style.backdropFilter ?? "").toBe("");
    expect(style.color).toBe("rgb(245, 245, 247)");
    expect(style.fontSize).toBe("24px");
    expect(style.fontWeight).toBe("500");
    expect(style.lineHeight).toBe("1.5");
    expect(style.getPropertyValue("-webkit-text-stroke")).toBe("3.5px rgba(0, 0, 0, 0.86)");
    expect(style.paintOrder).toBe("stroke fill");
    expect(style.textShadow).toBe("0 2px 8px rgba(0, 0, 0, 0.72)");
    expect(caption().hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  it("shows the drag region only while unlocked", () => {
    vi.useFakeTimers();
    render(<CaptionOverlay store={store} />);
    act(() => vi.advanceTimersByTime(2_500));
    act(() => {
      window.dispatchEvent(new CustomEvent("overlay-lock", { detail: false }));
    });
    expect(caption().textContent).toBe("拖拽此处调整字幕位置");
    expect(caption().style.opacity).toBe("1");
    expect(caption().style.border).toBe("1px dashed rgba(255, 255, 255, 0.32)");
    expect(caption().style.borderRadius).toBe("12px");
    expect(caption().style.backgroundColor).toBe("rgba(0, 0, 0, 0.14)");
    expect(caption().hasAttribute("data-tauri-drag-region")).toBe(true);

    act(() => {
      window.dispatchEvent(new CustomEvent("overlay-lock", { detail: true }));
    });
    expect(caption().style.backgroundColor).toBe("");
    expect(caption().style.border).toBe("");
    expect(caption().style.opacity).toBe("0");
    expect(caption().hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  it("renders live text and highlights a hotword split across deltas", () => {
    const { unmount } = render(<CaptionOverlay store={store} />);
    act(() => {
      socket.receive({
        type: "hotwords",
        hotwords: ["新质生产力"],
        background: "",
        appliesFromSegment: 1,
      });
      start();
      delta("推动新质");
    });
    expect(caption().textContent).toBe("推动新质");

    act(() => delta("生产力。", 2));
    expect(caption().textContent).toBe("推动新质生产力。");
    const hit = screen.getByText("新质生产力");
    expect(hit.getAttribute("data-hotword-hit")).toBe("true");
    expect(hit.style.backgroundColor).toBe("rgba(91, 141, 239, 0.34)");
    unmount();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest tail as a long segment grows and the next one begins", () => {
    render(<CaptionOverlay store={store} />);
    const firstTail = "这是当前段落的末尾。";
    const nextTail = "现在公布最新结果。";
    act(() => {
      start();
      delta("段首说明。" + "这是一段很长的转写。".repeat(15) + firstTail);
    });
    expect(caption().textContent).toHaveLength(60);
    expect(caption().textContent).toMatch(new RegExp(`${firstTail}$`));
    expect(caption().textContent).not.toContain("段首说明");

    act(() => delta(nextTail, 2));
    expect(caption().textContent?.endsWith(nextTail)).toBe(true);
    act(() => start(2));
    expect(caption().textContent?.endsWith(nextTail)).toBe(true);
    act(() => delta("请继续。", 1, 2));
    expect(caption().textContent?.endsWith(`${nextTail} 请继续。`)).toBe(true);
    expect(caption().textContent).toHaveLength(60);
  });

  it("hides the ready hint and silent captions, and wakes even if the visible tail repeats", () => {
    vi.useFakeTimers();
    render(<CaptionOverlay store={store} />);
    expect(caption().textContent).toBe("字幕已就绪");
    act(() => vi.advanceTimersByTime(2_499));
    expect(caption().style.opacity).toBe("1");
    act(() => vi.advanceTimersByTime(1));
    expect(caption().style.opacity).toBe("0");

    act(() => {
      start();
      delta("继续讲话".repeat(20));
    });
    expect(caption().style.opacity).toBe("1");
    expect(caption().style.transition).toBe("opacity 120ms ease-out");
    const visibleTail = caption().textContent;
    act(() => vi.advanceTimersByTime(4_999));
    expect(caption().style.opacity).toBe("1");
    act(() => vi.advanceTimersByTime(1));
    expect(caption().style.opacity).toBe("0");
    act(() => delta("继续讲话", 2));
    expect(caption().textContent).toBe(visibleTail);
    expect(caption().style.opacity).toBe("1");
  });

  it("uses a transparent OBS canvas and hides the caption after 5 seconds", () => {
    vi.useFakeTimers();
    render(<CaptionOverlay store={store} obsMode initialLocked={false} />);
    expect(caption().textContent).toBe("");
    expect(caption().style.opacity).toBe("0");
    expect(caption().style.backgroundColor).toBe("");
    expect(caption().style.border).toBe("");
    expect(caption().hasAttribute("data-tauri-drag-region")).toBe(false);

    act(() => {
      start();
      delta("直播字幕。");
    });
    expect(caption().textContent).toBe("直播字幕。");
    expect(caption().style.opacity).toBe("1");
    act(() => vi.advanceTimersByTime(5_001));
    expect(caption().style.opacity).toBe("0");
  });
});
