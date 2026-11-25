import { memo, useCallback, useEffect, useState } from "react";
import { Segment } from "./components/Segment";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Transcript } from "./components/Transcript";
import { sessionStore, useSessionStore } from "./store/session";
import type { TranscriptSegment } from "./store/session";

const FONT_SIZES = [18, 20, 22, 24] as const;
const MemoTranscript = memo(Transcript);

function transcriptText(): string {
  return sessionStore.getSnapshot().segments
    .map((segment) => segment.text)
    .filter((text) => text.trim())
    .join("\n\n");
}

function downloadTranscript(format: "md" | "txt"): void {
  const text = transcriptText();
  if (!text) return;

  const type = format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `转写.${format}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const exportMarkdown = () => downloadTranscript("md");
const exportTxt = () => downloadTranscript("txt");

export function App() {
  const { hotwords, segments } = useSessionStore();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fontIndex, setFontIndex] = useState(FONT_SIZES.indexOf(20));
  const [copyFailed, setCopyFailed] = useState(false);
  const hasTranscript = segments.some((segment) => segment.text.trim());

  useEffect(() => {
    sessionStore.connect();
    return sessionStore.close;
  }, []);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((collapsed) => !collapsed), []);
  const renderSegment = useCallback((segment: TranscriptSegment) => (
    <Segment segment={segment} hotwords={hotwords} />
  ), [hotwords]);

  const copyAll = useCallback(async () => {
    const text = transcriptText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const { key } = event;
      if (key === "+" || (!event.shiftKey && (key === "=" || key === "-"))) {
        event.preventDefault();
        const step = key === "-" ? -1 : 1;
        setFontIndex((index) => Math.max(0, Math.min(FONT_SIZES.length - 1, index + step)));
      } else if (!event.shiftKey && key.toLowerCase() === "e") {
        event.preventDefault();
        if (!event.repeat) exportMarkdown();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <div className={sidebarCollapsed ? "hidden" : "flex shrink-0"}>
        <Sidebar
          onExportMarkdown={hasTranscript ? exportMarkdown : undefined}
          onExportTxt={hasTranscript ? exportTxt : undefined}
          onCopyAll={hasTranscript ? copyAll : undefined}
        />
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
        <MemoTranscript segments={segments} fontSize={FONT_SIZES[fontIndex]} renderSegment={renderSegment} />
        {copyFailed && <p role="status" className="px-6 py-2 text-sm text-[var(--text-2)]">复制失败，请重试。</p>}
      </main>
    </div>
  );
}
