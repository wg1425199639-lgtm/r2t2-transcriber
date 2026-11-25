import { useEffect, useMemo, useState } from "react";
import { splitByHotwords } from "../lib/highlight";
import { sessionStore, useSessionStore } from "../store/session";
import type { SessionStore, TranscriptSegment } from "../store/session";

interface CaptionOverlayProps {
  store?: SessionStore;
  obsMode?: boolean;
  autoConnect?: boolean;
}

const MAX_CAPTION_CHARS = 60;
const SHORT_SEGMENT_CHARS = 24;
const SILENCE_MS = 5_000;

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
}: CaptionOverlayProps) {
  const { segments, hotwords } = useSessionStore(store);
  const { latest, displayText } = useMemo(() => getCaption(segments), [segments]);
  const parts = useMemo(() => splitByHotwords(displayText, hotwords), [displayText, hotwords]);
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    if (!autoConnect) return;
    store.connect();
    return () => store.close();
  }, [store, autoConnect]);

  // The untrimmed segment also changes when repeating speech produces an identical visible tail.
  useEffect(() => {
    setSilent(false);
    const timer = window.setTimeout(() => setSilent(true), SILENCE_MS);
    return () => window.clearTimeout(timer);
  }, [store, latest?.segmentId, latest?.startedAtMs, latest?.text]);

  const opacity = obsMode && !displayText ? 0 : silent ? (obsMode ? 0 : 0.18) : 1;

  return (
    <div className="fixed inset-0 flex items-end justify-center px-3 pb-2">
      <div
        role="region"
        aria-label="悬浮字幕"
        data-tauri-drag-region={obsMode ? undefined : true}
        className={obsMode ? "w-full max-w-[72rem]" : "w-full max-w-[48rem] rounded-[14px] px-4 py-2"}
        style={{
          opacity,
          transition: "opacity 120ms ease-out",
          color: "#F2F2F5",
          fontSize: 22,
          lineHeight: 1.55,
          textShadow: obsMode ? "0 1px 3px rgba(0, 0, 0, 0.85)" : "0 1px 2px rgba(0, 0, 0, 0.45)",
          ...(obsMode ? {} : {
            backgroundColor: "rgba(20, 20, 22, 0.78)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            backdropFilter: "blur(20px) saturate(1.2)",
            WebkitBackdropFilter: "blur(20px) saturate(1.2)",
          }),
        }}
      >
        <div className="pointer-events-none flex max-h-[3.1em] flex-col justify-end overflow-hidden text-center">
          <p className="shrink-0 [overflow-wrap:anywhere]">
            {displayText ? parts.map(({ text, hit }, index) => (
              <span
                key={index}
                data-hotword-hit={hit || undefined}
                className={hit ? "rounded-[4px] px-1" : undefined}
                style={hit ? { backgroundColor: "rgba(91, 141, 239, 0.28)" } : undefined}
              >
                {text}
              </span>
            )) : !obsMode && <span className="opacity-60">等待语音输入…</span>}
          </p>
        </div>
      </div>
    </div>
  );
}
