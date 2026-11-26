// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Segment } from "../components/Segment";
import type { TranscriptSegment } from "../store/session";
import { segmentPreviewKey, useAudioPreview } from "./useAudioPreview";

const first: TranscriptSegment = { segmentId: 1, startedAtMs: 10_000, text: "第一段", active: false };
const segment: TranscriptSegment = { segmentId: 2, startedAtMs: 15_000, text: "第二段", active: false, durMs: 1000 };

class MockAudio extends EventTarget {
  src = "";
  readyState = 0;
  currentTime = 0;
  play = vi.fn(async () => {});
  pause = vi.fn();
  load = vi.fn(() => { this.readyState = 0; });

  hasAttribute(name: string) { return name === "src" && this.src !== ""; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }

  loadMetadata() {
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
}

const response = () => Response.json({
  sessionId: "recording",
  audioStartedAtMs: 9000,
  segments: [
    { segmentId: segment.segmentId, startedAtMs: 14_900, offsetSec: 4 },
    { segmentId: segment.segmentId, startedAtMs: segment.startedAtMs, offsetSec: 5.125, durMs: 2000 },
  ],
});

let audio: MockAudio;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  audio = new MockAudio();
  vi.stubGlobal("Audio", vi.fn(function () { return audio; }));
  fetchMock.mockReset().mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function startPreview(togglePlay: ReturnType<typeof useAudioPreview>["togglePlay"], target = segment) {
  let pending: Promise<void> | undefined;
  act(() => { pending = togglePlay(target, [first, segment]); });
  await waitFor(() => expect(audio.src).toContain("/audio/latest.wav?"));
  return { pending };
}

describe("useAudioPreview", () => {
  it("waits for metadata to seek to the exact offset, then stops on a second click", async () => {
    const { result } = renderHook(useAudioPreview);
    const { pending } = await startPreview(result.current.togglePlay);

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:47800/audio/latest.json", expect.anything());
    expect(new URL(audio.src).searchParams.get("sessionId")).toBe("recording");
    expect(audio.currentTime).toBe(0);
    expect(audio.play).not.toHaveBeenCalled();
    expect(result.current.playingKey).toBeNull();

    await act(async () => {
      audio.loadMetadata();
      await pending;
    });
    expect(audio.currentTime).toBe(5.125);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(result.current.playingKey).toBe("2:15000");

    await act(() => result.current.togglePlay(segment));
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(result.current.playingKey).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["timeupdate", "timer"])("pauses at the indexed segment end via %s", async (trigger) => {
    const { result } = renderHook(useAudioPreview);
    const { pending } = await startPreview(result.current.togglePlay);
    vi.useFakeTimers();
    await act(async () => {
      audio.loadMetadata();
      await pending;
    });

    const checkEnd = () => {
      if (trigger === "timer") vi.advanceTimersByTime(100);
      else audio.dispatchEvent(new Event("timeupdate"));
    };
    audio.currentTime = 7.2;
    act(checkEnd);
    expect(result.current.playingKey).toBe(segmentPreviewKey(segment));
    audio.currentTime = 7.325;
    act(checkEnd);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(result.current.playingKey).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a superseded index response and falls back to the current recording's first segment", async () => {
    let resolveOld: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    fetchMock.mockRejectedValueOnce(new Error("index unavailable"));
    const { result } = renderHook(useAudioPreview);
    let old: Promise<void> | undefined;
    act(() => { old = result.current.togglePlay(first); });
    const { pending } = await startPreview(result.current.togglePlay);

    await act(async () => {
      audio.loadMetadata();
      await pending;
      resolveOld(response());
      await old;
    });
    expect(audio.currentTime).toBe(5);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(result.current.playingKey).toBe(segmentPreviewKey(segment));
  });

  it("reports media errors and cancels a metadata wait when stopped", async () => {
    const { result } = renderHook(useAudioPreview);
    const failed = await startPreview(result.current.togglePlay);
    await act(async () => {
      audio.dispatchEvent(new Event("error"));
      await failed.pending;
    });
    expect(result.current.previewError).toBe("暂无可回放的会话原声。");

    const cancelled = await startPreview(result.current.togglePlay);
    await act(async () => {
      result.current.stopPreview();
      audio.loadMetadata();
      await cancelled.pending;
    });
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.src).toBe("");
    expect(result.current.playingKey).toBeNull();
    expect(result.current.previewError).toBe("");
  });
});

it("exposes the timestamp as a toggle button alongside the bookmark", () => {
  const onTogglePlay = vi.fn();
  const onToggleBookmark = vi.fn();
  const hotwords: string[] = [];
  const { rerender } = render(
    <Segment segment={segment} hotwords={hotwords} onTogglePlay={onTogglePlay} onToggleBookmark={onToggleBookmark} />,
  );
  const button = screen.getByRole("button", { name: "播放该段原声", pressed: false });
  expect(button.querySelector("time")?.dateTime).toBe(button.textContent);
  fireEvent.click(button);
  expect(onTogglePlay).toHaveBeenCalledExactlyOnceWith(segment);
  expect(onToggleBookmark).not.toHaveBeenCalled();

  rerender(<Segment segment={segment} hotwords={hotwords} onTogglePlay={onTogglePlay} onToggleBookmark={onToggleBookmark} isPlaying />);
  expect(screen.getByRole("button", { name: "停止原声回放", pressed: true })).toBe(button);
  expect(screen.getByRole("button", { name: "重点书签", pressed: false })).toBeTruthy();
});
