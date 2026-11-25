import { Fragment, memo, useLayoutEffect, useMemo, useRef } from "react";
import { splitByHotwords } from "../lib/highlight";
import type { TranscriptSegment } from "../store/session";

interface SegmentProps {
  segment: TranscriptSegment;
  hotwords: readonly string[];
}

function formatTimestamp(tsMs: number): string {
  const date = new Date(tsMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export const Segment = memo(function Segment({ segment, hotwords }: SegmentProps) {
  const { active, startedAtMs, text } = segment;
  const committed = useRef({ active: false, text: "", fadeFrom: 0, hotwords });
  const previous = committed.current;
  const highlightingWords = active ? hotwords : previous.hotwords;
  const isAppending = (active || previous.active) && text.startsWith(previous.text);
  const fadeFrom = text === previous.text ? previous.fadeFrom : isAppending ? previous.text.length : text.length;
  const parts = useMemo(() => splitByHotwords(text, highlightingWords), [text, highlightingWords]);
  const timestamp = formatTimestamp(startedAtMs);

  useLayoutEffect(() => {
    committed.current = { active, text, fadeFrom, hotwords: highlightingWords };
  }, [active, text, fadeFrom, highlightingWords]);

  let offset = 0;
  return (
    <div className={`group grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3${active ? "" : " [content-visibility:auto] [contain-intrinsic-size:auto_1lh]"}`}>
      <time dateTime={timestamp} className="font-mono text-[13px] tabular-nums text-[var(--text-2)] opacity-60 group-hover:opacity-100">
        {timestamp}
      </time>
      <p className="[overflow-wrap:anywhere] [white-space:pre-wrap]">
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
            <span key={start} className="bg-[var(--hit-bg)] rounded-[3px] px-[2px]">{content}</span>
          ) : <Fragment key={start}>{content}</Fragment>;
        })}
        {active && <span aria-hidden="true" className="transcript-caret" />}
      </p>
    </div>
  );
}, (previous, next) =>
  previous.segment === next.segment && (!next.segment.active || previous.hotwords === next.hotwords));
