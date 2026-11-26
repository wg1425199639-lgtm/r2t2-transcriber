import { Bookmark, Play } from "lucide-react";
import { Fragment, memo, useLayoutEffect, useMemo, useRef } from "react";
import { splitByHotwords } from "../lib/highlight";
import type { TranscriptSegment } from "../store/session";

interface SegmentProps {
  segment: TranscriptSegment;
  hotwords: readonly string[];
  isPlaying?: boolean;
  onTogglePlay?: (segment: TranscriptSegment) => void;
  onToggleBookmark?: (segmentId: number, startedAtMs: number) => void;
}

export function formatTimestamp(tsMs: number): string {
  const date = new Date(tsMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export const Segment = memo(function Segment({ segment, hotwords, isPlaying = false, onTogglePlay, onToggleBookmark }: SegmentProps) {
  const { active, bookmarked = false, segmentId, startedAtMs, text } = segment;
  const committed = useRef({ active: false, text: "", fadeFrom: 0, hotwords });
  const previous = committed.current;
  const highlightingWords = active ? hotwords : previous.hotwords;
  const isAppending = (active || previous.active) && text.startsWith(previous.text);
  const fadeFrom = text === previous.text ? previous.fadeFrom : isAppending ? previous.text.length : text.length;
  const parts = useMemo(() => splitByHotwords(text, highlightingWords), [text, highlightingWords]);
  const timestamp = formatTimestamp(startedAtMs);
  const playLabel = isPlaying ? "停止原声回放" : "播放该段原声";

  useLayoutEffect(() => {
    committed.current = { active, text, fadeFrom, hotwords: highlightingWords };
  }, [active, text, fadeFrom, highlightingWords]);

  let offset = 0;
  return (
    <div className="group contents">
      <div className="relative col-start-1 justify-self-end self-start pr-3 text-[13px] font-mono leading-[1lh] tabular-nums select-none">
        {onTogglePlay ? (
          <button
            type="button"
            aria-label={playLabel}
            title={playLabel}
            aria-pressed={isPlaying}
            onClick={() => onTogglePlay(segment)}
            className={`relative cursor-pointer rounded align-baseline transition-opacity duration-150 ${
              isPlaying
                ? "text-[var(--accent)] opacity-100"
                : "text-[var(--text-2)] opacity-60 group-hover:opacity-100 hover:text-[var(--accent)] focus-visible:opacity-100"
            }`}
          >
            <time dateTime={timestamp}>{timestamp}</time>
            {isPlaying && (
              <Play size={10} strokeWidth={1.5} aria-hidden="true" className="pointer-events-none absolute left-full top-1/2 ml-0.5 -translate-y-1/2" />
            )}
          </button>
        ) : (
          <time
            dateTime={timestamp}
            className="text-[var(--text-2)] opacity-60 group-hover:opacity-100 transition-opacity duration-150"
          >
            {timestamp}
          </time>
        )}
        {onToggleBookmark && (
          <button
            type="button"
            aria-label="重点书签"
            aria-pressed={bookmarked}
            onClick={() => onToggleBookmark(segmentId, startedAtMs)}
            className={`absolute right-full top-1/2 mr-1 flex size-5 -translate-y-1/2 items-center justify-center rounded transition-opacity duration-150 ${
              bookmarked
                ? "text-[var(--accent)] opacity-100"
                : "text-[var(--text-3)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-2)]"
            }`}
          >
            <Bookmark size={14} strokeWidth={1.5} fill={bookmarked ? "currentColor" : "none"} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="relative col-start-2 min-w-0">
        {bookmarked && (
          <span aria-hidden="true" className="absolute -left-2 top-[0.25em] bottom-[0.25em] w-[2px] rounded-full bg-[var(--accent)]" />
        )}
        <p className={`select-text leading-[1.75] [overflow-wrap:anywhere] [white-space:pre-wrap]${active ? "" : " [content-visibility:auto] [contain-intrinsic-size:auto_1lh]"}`}>
          {parts.map((part) => {
            const start = offset;
            offset += part.text.length;
            const steadyLength = Math.max(0, Math.min(fadeFrom - start, part.text.length));
            const appended = part.text.slice(steadyLength);
            const content = (
              <>
                {part.text.slice(0, steadyLength)}
                {appended && <span key={start + steadyLength} className="append-fade-in">{appended}</span>}
              </>
            );
            return part.hit ? (
              <span key={start} className="inline rounded-[3px] px-[2px] bg-[var(--hit-bg)] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">{content}</span>
            ) : <Fragment key={start}>{content}</Fragment>;
          })}
          {active && <span aria-hidden="true" className="transcript-caret" />}
        </p>
      </div>
    </div>
  );
}, (previous, next) =>
  previous.segment === next.segment
  && previous.isPlaying === next.isPlaying
  && previous.onTogglePlay === next.onTogglePlay
  && previous.onToggleBookmark === next.onToggleBookmark
  && (!next.segment.active || previous.hotwords === next.hotwords));
