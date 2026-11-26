import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptSegment } from "../store/session";

const AUDIO_URL = "http://127.0.0.1:47800/audio/latest";
const PREVIEW_ERROR = "暂无可回放的会话原声。";
const TIMESTAMP_TOLERANCE_MS = 2000;
const END_PADDING_SEC = 0.2;
const END_CHECK_MS = 100;

interface AudioIndex {
  sessionId: string;
  audioStartedAtMs: number;
  segments: Array<Pick<TranscriptSegment, "segmentId" | "startedAtMs" | "durMs"> & { offsetSec: number }>;
}

export function segmentPreviewKey(segment: Pick<TranscriptSegment, "segmentId" | "startedAtMs">): string {
  return `${segment.segmentId}:${segment.startedAtMs}`;
}

async function fetchAudioIndex(signal: AbortSignal): Promise<AudioIndex | undefined> {
  try {
    const response = await fetch(`${AUDIO_URL}.json`, { signal, cache: "no-store" });
    if (response.ok) return await response.json() as AudioIndex;
  } catch {
    // Older recordings can still use the transcript's timestamps.
  }
}

function firstSegmentInRecording(segment: TranscriptSegment, segments: readonly TranscriptSegment[]): TranscriptSegment {
  let first = segment;
  for (let position = segments.findIndex((item) => segmentPreviewKey(item) === segmentPreviewKey(segment)) - 1;
    position >= 0; position--) {
    const previous = segments[position];
    if (previous.segmentId >= first.segmentId || previous.startedAtMs > first.startedAtMs) break;
    first = previous;
  }
  return first;
}

function waitForMetadata(audio: HTMLAudioElement, signal: AbortSignal): Promise<void> {
  if (audio.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanUp = () => {
      audio.removeEventListener("loadedmetadata", loaded);
      audio.removeEventListener("error", failed);
      signal.removeEventListener("abort", failed);
    };
    const loaded = () => {
      cleanUp();
      resolve();
    };
    const failed = () => {
      cleanUp();
      reject(new Error(PREVIEW_ERROR));
    };
    audio.addEventListener("loadedmetadata", loaded);
    audio.addEventListener("error", failed);
    signal.addEventListener("abort", failed);
  });
}

interface AudioPreviewOptions {
  audioStartedAtMs?: number;
}

export function useAudioPreview({ audioStartedAtMs: fallbackStartedAtMs = 0 }: AudioPreviewOptions = {}) {
  const audioRef = useRef<HTMLAudioElement>();
  const requestRef = useRef<AbortController>();
  const playingRef = useRef<string | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");

  const releasePreview = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = undefined;
    playingRef.current = null;
    const audio = audioRef.current;
    if (audio?.hasAttribute("src")) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }, []);

  useEffect(() => releasePreview, [releasePreview]);

  const stopPreview = useCallback(() => {
    releasePreview();
    setPlayingKey(null);
    setPreviewError("");
  }, [releasePreview]);

  const togglePlay = useCallback(async (segment: TranscriptSegment, segments: readonly TranscriptSegment[] = []) => {
    const key = segmentPreviewKey(segment);
    const wasPlaying = playingRef.current === key;
    stopPreview();
    if (wasPlaying) return;

    const request = new AbortController();
    requestRef.current = request;
    const { signal } = request;

    try {
      const index = await fetchAudioIndex(signal);
      if (signal.aborted) return;

      const candidates = index?.segments?.filter((item) => item.segmentId === segment.segmentId);
      const indexed = candidates?.find((item) => item.startedAtMs === segment.startedAtMs)
        ?? candidates?.find((item) => Math.abs(item.startedAtMs - segment.startedAtMs) < TIMESTAMP_TOLERANCE_MS);
      const indexedStartedAtMs = index?.audioStartedAtMs ?? 0;
      const audioStartedAtMs = indexedStartedAtMs > 0 ? indexedStartedAtMs : fallbackStartedAtMs;
      if (!indexed && audioStartedAtMs > 0 && segment.startedAtMs <= audioStartedAtMs - TIMESTAMP_TOLERANCE_MS) {
        throw new Error(PREVIEW_ERROR);
      }
      const refMs = audioStartedAtMs > 0 ? audioStartedAtMs : firstSegmentInRecording(segment, segments).startedAtMs;
      const offsetSec = indexed?.offsetSec ?? Math.max(0, (segment.startedAtMs - refMs) / 1000);
      const durMs = indexed?.durMs ?? segment.durMs ?? 0;

      const audio = audioRef.current ??= new Audio();
      const query = new URLSearchParams({ t: String(Date.now()) });
      if (index?.sessionId) query.set("sessionId", index.sessionId);
      audio.preload = "metadata";
      audio.src = `${AUDIO_URL}.wav?${query}`;

      // WKWebView can discard seeks made before metadata is available.
      await waitForMetadata(audio, signal);
      if (signal.aborted) return;
      audio.currentTime = offsetSec;

      const endTime = offsetSec + durMs / 1000 + END_PADDING_SEC;
      const checkEnd = () => {
        if (audio.currentTime >= endTime) stopPreview();
      };
      const onError = () => {
        stopPreview();
        setPreviewError(PREVIEW_ERROR);
      };
      const timer = durMs > 0 ? window.setInterval(checkEnd, END_CHECK_MS) : undefined;
      if (durMs > 0) audio.addEventListener("timeupdate", checkEnd);
      audio.addEventListener("ended", stopPreview);
      audio.addEventListener("error", onError);
      signal.addEventListener("abort", () => {
        window.clearInterval(timer);
        audio.removeEventListener("timeupdate", checkEnd);
        audio.removeEventListener("ended", stopPreview);
        audio.removeEventListener("error", onError);
      }, { once: true });

      await audio.play();
      if (signal.aborted) return;
      playingRef.current = key;
      setPlayingKey(key);
    } catch {
      if (!signal.aborted) {
        stopPreview();
        setPreviewError(PREVIEW_ERROR);
      }
    }
  }, [fallbackStartedAtMs, stopPreview]);

  return { playingKey, previewError, togglePlay, stopPreview };
}
