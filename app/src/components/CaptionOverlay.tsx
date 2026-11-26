import { useEffect, useMemo, useState } from "react";
import { splitByHotwords } from "../lib/highlight";
import { sessionStore, useSessionStore } from "../store/session";
import type { SessionStore, TranscriptSegment } from "../store/session";

interface CaptionOverlayProps {
  store?: SessionStore;
  obsMode?: boolean;
  autoConnect?: boolean;
  initialLocked?: boolean;
}

const MAX_CAPTION_CHARS = 60;
const SHORT_SEGMENT_CHARS = 24;
const SILENCE_MS = 5_000;
const READY_HINT_MS = 2_500;

function getCaption(segments: TranscriptSegment[]) {
  let latest: TranscriptSegment | undefined;
  let tail = "";
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    const text = segment.text.trim();
    if (!text) continue;

    const suffix = text.slice(-2 * MAX_CAPTION_CHARS);
    if (latest) {
      tail = `${suffix} ${tail}`;
      break;
    }

    latest = segment;
    tail = suffix;
    if (text.length >= SHORT_SEGMENT_CHARS) break;
  }

  const displayText = Array.from(tail).slice(-MAX_CAPTION_CHARS).join("").trimStart();
  return { latest, displayText };
}

export function CaptionOverlay({
  store = sessionStore,
  obsMode = false,
  autoConnect = true,
  initialLocked,
}: CaptionOverlayProps) {
  const { segments, hotwords } = useSessionStore(store);
  const { latest, displayText } = useMemo(() => getCaption(segments), [segments]);
  const parts = useMemo(() => splitByHotwords(displayText, hotwords), [displayText, hotwords]);
  const [silent, setSilent] = useState(false);
  const [locked, setLocked] = useState(
    () => initialLocked ?? (new URLSearchParams(window.location.search).get("locked") !== "0"),
  );
  const draggable = !locked && !obsMode;

  useEffect(() => {
    function onOverlayLock(event: Event) {
      const { detail } = event as CustomEvent<boolean>;
      if (typeof detail === "boolean") setLocked(detail);
    }

    window.addEventListener("overlay-lock", onOverlayLock);
    return () => window.removeEventListener("overlay-lock", onOverlayLock);
  }, []);

  useEffect(() => {
    if (!autoConnect) return;
    store.connect();
    return () => store.close();
  }, [store, autoConnect]);

  // The untrimmed segment also changes when repeating speech produces an identical visible tail.
  useEffect(() => {
    setSilent(false);
    const timer = window.setTimeout(() => setSilent(true), latest?.text ? SILENCE_MS : READY_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [store, latest?.segmentId, latest?.startedAtMs, latest?.text]);

  const opacity = draggable || (!silent && (!obsMode || displayText)) ? 1 : 0;

  return (
    <div className="fixed inset-0 flex items-end justify-center px-3 pb-2">
      <div
        role="region"
        aria-label="悬浮字幕"
        data-tauri-drag-region={draggable || undefined}
        className={obsMode ? "w-full max-w-[72rem]" : "w-full max-w-[48rem] px-4 py-2"}
        style={{
          opacity,
          transition: "opacity 120ms ease-out",
          color: "#F5F5F7",
          fontSize: 24,
          fontWeight: 500,
          lineHeight: 1.5,
          WebkitTextStroke: "3.5px rgba(0, 0, 0, 0.86)",
          paintOrder: "stroke fill",
          textShadow: "0 2px 8px rgba(0, 0, 0, 0.72)",
          ...(draggable ? {
            border: "1px dashed rgba(255, 255, 255, 0.32)",
            borderRadius: 12,
            backgroundColor: "rgba(0, 0, 0, 0.14)",
          } : {}),
        }}
      >
        <div className="pointer-events-none flex max-h-[3em] flex-col justify-end overflow-hidden text-center">
          <p className="shrink-0 [overflow-wrap:anywhere]">
            {displayText ? parts.map(({ text, hit }, index) => (
              <span
                key={index}
                data-hotword-hit={hit || undefined}
                className={hit ? "rounded-[4px] px-1" : undefined}
                style={hit ? { backgroundColor: "rgba(91, 141, 239, 0.34)" } : undefined}
              >
                {text}
              </span>
            )) : !obsMode && (draggable ? "拖拽此处调整字幕位置" : "字幕已就绪")}
          </p>
        </div>
      </div>
    </div>
  );
}
