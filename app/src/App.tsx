import { invoke, isTauri } from "@tauri-apps/api/core";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { formatTimestamp, Segment } from "./components/Segment";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Transcript } from "./components/Transcript";
import { sessionStore, useSessionStore } from "./store/session";
import type { TranscriptSegment } from "./store/session";

const FONT_SIZES = [18, 20, 22, 24] as const;
const MemoTranscript = memo(Transcript);

export function formatExportContent(segments: readonly TranscriptSegment[], format: "md" | "txt"): string {
  const nonEmpty = segments.filter((segment) => segment.text.trim());
  if (nonEmpty.length === 0) return "";
  if (format === "txt") return nonEmpty.map((segment) => segment.text).join("\n\n");

  const sections = ["# 实时语音转写记录"];
  const bookmarks = nonEmpty.filter((segment) => segment.bookmarked);
  if (bookmarks.length > 0) {
    const overview = bookmarks.map(({ startedAtMs, text }) => {
      const characters = Array.from(text.trim().replace(/\s+/g, " "));
      const summary = characters.length > 100 ? characters.slice(0, 100).join("") + "…" : characters.join("");
      return `- [${formatTimestamp(startedAtMs)}] ${summary}`;
    });
    sections.push(`## 重点打点速览\n\n${overview.join("\n")}`, "## 全文记录");
  }
  for (const { startedAtMs, text } of nonEmpty) {
    sections.push(`[${formatTimestamp(startedAtMs)}] ${text}`);
  }
  return sections.join("\n\n");
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
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayClickThrough, setOverlayClickThrough] = useState(true);
  const [overlayNotice, setOverlayNotice] = useState("");
  const overlayPopup = useRef<Window | null>(null);
  const overlayBusy = useRef(false);
  const hasTranscript = segments.some((segment) => segment.text.trim());

  useEffect(() => {
    sessionStore.connect();
    return sessionStore.close;
  }, []);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((collapsed) => !collapsed), []);
  const toggleOverlay = useCallback(async () => {
    if (overlayBusy.current) return;
    overlayBusy.current = true;
    setOverlayNotice("");
    try {
      if (isTauri()) {
        setOverlayOpen(await invoke<boolean>("toggle_overlay_window", { clickThrough: overlayClickThrough }));
      } else if (overlayPopup.current && !overlayPopup.current.closed) {
        overlayPopup.current.close();
        overlayPopup.current = null;
        setOverlayOpen(false);
      } else {
        overlayPopup.current = window.open("?view=overlay", "r2t2-overlay", "width=760,height=116");
        setOverlayOpen(overlayPopup.current !== null);
        if (!overlayPopup.current) setOverlayNotice("浏览器阻止了悬浮字幕窗口。");
      }
    } catch {
      setOverlayNotice("无法切换悬浮字幕，请重试。");
    } finally {
      overlayBusy.current = false;
    }
  }, [overlayClickThrough]);

  const toggleOverlayClickThrough = async () => {
    if (overlayBusy.current) return;
    overlayBusy.current = true;
    const next = !overlayClickThrough;
    setOverlayNotice("");
    try {
      if (isTauri()) await invoke("set_overlay_click_through", { enabled: next });
      setOverlayClickThrough(next);
    } catch {
      setOverlayNotice("无法切换鼠标穿透，请重试。");
    } finally {
      overlayBusy.current = false;
    }
  };

  useEffect(() => {
    const closePopup = () => {
      overlayPopup.current?.close();
      overlayPopup.current = null;
      setOverlayOpen(false);
    };
    window.addEventListener("pagehide", closePopup);
    return () => {
      window.removeEventListener("pagehide", closePopup);
      overlayPopup.current?.close();
    };
  }, []);

  const renderSegment = useCallback((segment: TranscriptSegment) => (
    <Segment segment={segment} hotwords={hotwords} onToggleBookmark={sessionStore.toggleBookmark} />
  ), [hotwords]);

  const exportTranscript = useCallback(async (format: "md" | "txt") => {
    const text = formatExportContent(sessionStore.getSnapshot().segments, format);
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
    const text = formatExportContent(sessionStore.getSnapshot().segments, "txt");
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
      } else if (!event.shiftKey && key.toLowerCase() === "l" && !event.repeat) {
        event.preventDefault();
        void toggleOverlay();
      } else if (!event.shiftKey && key.toLowerCase() === "m" && !event.repeat) {
        event.preventDefault();
        sessionStore.toggleLatestBookmark();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [exportMarkdown, toggleOverlay]);

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
        <TopBar
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          overlayOpen={overlayOpen}
          overlayClickThrough={overlayClickThrough}
          onToggleOverlay={toggleOverlay}
          onToggleOverlayClickThrough={toggleOverlayClickThrough}
        />
        <MemoTranscript segments={segments} fontSize={FONT_SIZES[fontIndex]} renderSegment={renderSegment} />
        {overlayNotice && <p role="status" className="px-6 py-2 text-sm text-[var(--text-2)]">{overlayNotice}</p>}
        {copyFailed && <p role="status" className="px-6 py-2 text-sm text-[var(--text-2)]">复制失败，请重试。</p>}
      </main>
    </div>
  );
}
