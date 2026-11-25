import { PanelLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { sessionStore, useSessionStore } from "../store/session";
import { LevelMeter } from "./LevelMeter";
import { SourcePicker } from "./SourcePicker";
import type { SourceSelection } from "./SourcePicker";
import { Button } from "./ui/button";

interface TopBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

function formatElapsed(seconds: number): string {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function TopBar({ sidebarCollapsed, onToggleSidebar }: TopBarProps) {
  const { connectionStatus, devices, level, sessionState } = useSessionStore();
  const [source, setSource] = useState<SourceSelection>({ source: "system" });
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recording = sessionState === "running";
  const stopping = sessionState === "stopping";
  const captureActive = recording || stopping || sessionState === "starting";
  const actionDisabled = connectionStatus !== "connected" || (captureActive && !recording);
  const stoppingAction = recording || stopping;

  useEffect(() => {
    if (captureActive) {
      const now = Date.now();
      setStartedAtMs((startedAt) => startedAt ?? now);
    } else {
      setStartedAtMs(null);
      setElapsedSeconds(0);
    }
  }, [captureActive]);

  useEffect(() => {
    if (!stoppingAction || startedAtMs === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAtMs, stoppingAction]);

  const toggleRecording = useCallback(() => {
    if (actionDisabled) return;
    if (recording) {
      sessionStore.stopSession();
    } else {
      sessionStore.startSession(source.source, source.deviceId);
    }
  }, [actionDisabled, recording, source]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        if (!event.repeat) toggleRecording();
      } else if (event.key === "\\") {
        event.preventDefault();
        if (!event.repeat) onToggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggleSidebar, toggleRecording]);

  return (
    <header className={`@container flex h-11 shrink-0 select-none items-center gap-3 border-b border-[var(--border)] bg-[var(--bg)] pr-3 ${sidebarCollapsed ? "pl-[84px]" : "pl-3"}`}>
      <Button
        variant="ghost"
        size="icon"
        title={"切换侧边栏 (⌘\\)"}
        aria-label="切换侧边栏"
        aria-expanded={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={16} strokeWidth={1.5} className="text-[var(--text-2)]" />
      </Button>
      <SourcePicker devices={devices} value={source} onChange={setSource} disabled={captureActive} />
      <LevelMeter
        level={level}
        connectionStatus={connectionStatus}
        sessionState={sessionState}
        startedAtMs={startedAtMs}
      />
      <div aria-hidden="true" className="h-full min-w-4 flex-1" data-tauri-drag-region />
      {stoppingAction && (
        <div aria-label="录制时长" className="flex shrink-0 items-center gap-2 whitespace-nowrap font-mono text-sm tabular-nums text-[var(--text-2)]">
          <span aria-hidden="true" className="size-2 rounded-full bg-[var(--danger)]" />
          {formatElapsed(elapsedSeconds)}
        </div>
      )}
      <Button
        size="sm"
        variant={stoppingAction ? "outline" : "default"}
        className={`min-w-16 shrink-0 whitespace-nowrap${stoppingAction ? "" : " bg-[var(--accent)] text-white enabled:hover:bg-[var(--accent)] enabled:hover:opacity-90"}`}
        title={stoppingAction ? "停止 (⌘R)" : "开始 (⌘R)"}
        aria-keyshortcuts="Meta+R"
        onClick={toggleRecording}
        disabled={actionDisabled}
      >
        {stoppingAction ? "停止" : "开始"}
      </Button>
    </header>
  );
}
