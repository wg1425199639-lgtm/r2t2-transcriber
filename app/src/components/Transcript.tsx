import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useStickyScroll } from "../hooks/useStickyScroll";
import type { TranscriptSegment } from "../store/session";
import { JumpToLatest } from "./JumpToLatest";

interface TranscriptProps {
  segments: readonly TranscriptSegment[];
  fontSize?: 18 | 20 | 22 | 24;
  renderSegment?: (segment: TranscriptSegment) => ReactNode;
}

function DefaultSegment({ text, active }: TranscriptSegment) {
  const previousText = useRef("");
  const prefix = active && text.startsWith(previousText.current) ? previousText.current : text;
  const suffix = text.slice(prefix.length);

  useLayoutEffect(() => {
    previousText.current = text;
  }, [text]);

  return (
    <p>
      {prefix}
      {suffix && <span key={prefix.length} className="append-fade-in">{suffix}</span>}
      {active && <span aria-hidden="true" className="transcript-caret" />}
    </p>
  );
}

const TranscriptParagraph = memo(function TranscriptParagraph({
  segment,
  renderSegment,
}: {
  segment: TranscriptSegment;
  renderSegment: TranscriptProps["renderSegment"];
}) {
  return (
    <div className={segment.active ? undefined : "[content-visibility:auto] [contain-intrinsic-size:auto_1lh]"}>
      {renderSegment ? renderSegment(segment) : <DefaultSegment {...segment} />}
    </div>
  );
});

export function Transcript({ segments, fontSize = 20, renderSegment }: TranscriptProps) {
  const paragraphs = useMemo(() => segments.filter((segment) => segment.text.trim()), [segments]);
  const { scrollRef, isSticking, unreadCount, jumpToLatest } = useStickyScroll(
    paragraphs.length,
    paragraphs.at(-1)?.text ?? "",
  );

  return (
    <section aria-label="转写" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:auto]">
        <div
          lang="zh"
          style={{ fontSize }}
          className="mx-auto max-w-[42em] space-y-[1.25em] px-6 py-8 text-left font-sans leading-[1.75] font-normal tracking-[0.01em] [line-break:strict] [word-break:normal]"
        >
          {paragraphs.length === 0 ? (
            <p className="text-[var(--text-3)]">选择音源并点击开始</p>
          ) : paragraphs.map((segment) => (
            <TranscriptParagraph
              key={`${segment.segmentId}:${segment.startedAtMs}`}
              segment={segment}
              renderSegment={renderSegment}
            />
          ))}
        </div>
      </div>
      {paragraphs.length > 0 && (
        <JumpToLatest isSticking={isSticking} unreadCount={unreadCount} onJump={jumpToLatest} />
      )}
    </section>
  );
}
