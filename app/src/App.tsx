import { invoke, isTauri } from "@tauri-apps/api/core";
import { memo, useCallback, useEffect, useRef, useState } from "react";
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

function downloadTranscript(format: "md" | "txt", text: string, defaultName: string): void {
  const type = format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = defaultName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const { hotwords, segments } = useSessionStore();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fontIndex, setFontIndex] = useState(FONT_SIZES.indexOf(20));
  const [copyFailed, setCopyFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const [lastExportPath, setLastExportPath] = useState<string>();
  const [exportNotice, setExportNotice] = useState("");
  const [exporting, setExporting] = useState(false);
  const hasTranscript = segments.some((segment) => segment.text.trim());

  useEffect(() => {
    sessionStore.connect();
    return sessionStore.close;
  }, []);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((collapsed) => !collapsed), []);
  const renderSegment = useCallback((segment: TranscriptSegment) => (
    <Segment segment={segment} hotwords={hotwords} />
  ), [hotwords]);

  const exportTranscript = useCallback(async (format: "md" | "txt") => {
    const text = transcriptText();
    if (!text || exporting) return;
    const defaultName = `转写.${format}`;
    setExportNotice("");

    if (isTauri()) {
      setExporting(true);
      try {
        setLastExportPath(await invoke<string>("write_export_file", { defaultName, content: text }));
        return;
      } catch {
        setExportNotice("无法写入下载目录，已发起下载。");
      } finally {
        setExporting(false);
      }
    } else {
      setExportNotice("已发起浏览器下载。");
    }

    downloadTranscript(format, text, defaultName);
  }, [exporting]);

  const exportMarkdown = useCallback(() => void exportTranscript("md"), [exportTranscript]);
  const exportTxt = useCallback(() => void exportTranscript("txt"), [exportTranscript]);

  const revealExport = async () => {
    if (!lastExportPath || !isTauri()) return;
    try {
      await invoke("reveal_in_finder", { path: lastExportPath });
      setExportNotice("");
    } catch {
      setExportNotice("无法定位导出文件，请重新导出。");
    }
  };

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyAll = useCallback(async () => {
    const text = transcriptText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyFailed(false);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      window.clearTimeout(copyTimer.current);
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
  }, [exportMarkdown]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <div className={sidebarCollapsed ? "hidden" : "flex shrink-0"}>
        <Sidebar
          onExportMarkdown={hasTranscript && !exporting ? exportMarkdown : undefined}
          onExportTxt={hasTranscript && !exporting ? exportTxt : undefined}
          onCopyAll={hasTranscript ? copyAll : undefined}
          copied={copied}
          lastExportPath={lastExportPath}
          onRevealExport={isTauri() ? revealExport : undefined}
          notice={exportNotice}
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
