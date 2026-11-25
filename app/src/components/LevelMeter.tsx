import { useEffect, useRef, useState } from "react";
import type { SessionSnapshot } from "../store/session";

const BAR_COUNT = 12;
const MIN_DB = -60;
const WARNING_DB = -6;
const CLIP_DB = -0.5;
const DECAY_MS = 300;
const SILENCE_MS = 3000;

interface LevelMeterProps {
  level: SessionSnapshot["level"];
  connectionStatus: SessionSnapshot["connectionStatus"];
  sessionState: SessionSnapshot["sessionState"];
  startedAtMs: number | null;
}

export function LevelMeter({ level, connectionStatus, sessionState, startedAtMs }: LevelMeterProps) {
  const recording = sessionState === "running";
  const interrupted = sessionState !== "idle" &&
    (connectionStatus === "reconnecting" || connectionStatus === "disconnected");
  const hasCurrentLevel = recording && !interrupted &&
    startedAtMs !== null && level.tsMs >= startedAtMs;
  const target = hasCurrentLevel ? Math.max(MIN_DB, Math.min(0, level.rmsDb)) : MIN_DB;
  const clipping = hasCurrentLevel && level.peakDb >= CLIP_DB;
  const silenceSince = recording && !interrupted && startedAtMs !== null
    ? Math.max(startedAtMs, level.lastNonSilentTsMs ?? startedAtMs)
    : null;

  const smoothedDb = useRef(MIN_DB);
  const previousFrame = useRef<number | null>(null);
  const [bars, setBars] = useState(0);
  const [aboveWarning, setAboveWarning] = useState(false);
  const [silentSince, setSilentSince] = useState<number | null>(null);
  const silent = silenceSince !== null && silenceSince === silentSince;

  useEffect(() => {
    let frame = requestAnimationFrame(function animate(now) {
      const elapsed = now - (previousFrame.current ?? now);
      previousFrame.current = now;

      const decayed = target + (smoothedDb.current - target) * Math.exp(-elapsed / DECAY_MS);
      smoothedDb.current = Math.max(target, decayed);
      if (smoothedDb.current - target < 0.1) smoothedDb.current = target;

      const count = Math.ceil((smoothedDb.current - MIN_DB) / -MIN_DB * BAR_COUNT);
      setBars(count);
      setAboveWarning(smoothedDb.current > WARNING_DB);
      if (smoothedDb.current !== target) {
        frame = requestAnimationFrame(animate);
      } else {
        previousFrame.current = null;
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [target]);

  useEffect(() => {
    setSilentSince(null);
    if (silenceSince === null) return;

    const timer = window.setTimeout(
      () => setSilentSince(silenceSince),
      Math.max(0, silenceSince + SILENCE_MS + 1 - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [silenceSince]);

  return (
    <div className="flex shrink-0 items-center gap-2">
      <div
        role="meter"
        aria-label="音频电平"
        aria-valuemin={0}
        aria-valuemax={BAR_COUNT}
        aria-valuenow={hasCurrentLevel ? (clipping ? BAR_COUNT : bars) : 0}
        className={`flex shrink-0 gap-0.5 whitespace-nowrap${silent ? " opacity-60" : ""}`}
      >
        {Array.from({ length: BAR_COUNT }, (_, index) => {
          const upperDb = MIN_DB + (index + 1) * (-MIN_DB / BAR_COUNT);
          let color = "bg-[var(--border)]";
          if (clipping && index === BAR_COUNT - 1) {
            color = "bg-[var(--danger)]";
          } else if (hasCurrentLevel && index < bars) {
            color = aboveWarning && upperDb > WARNING_DB ? "bg-[var(--warn)]" : "bg-[var(--ok)]";
          }
          return <span key={index} aria-hidden="true" className={`h-[8px] w-1.5 rounded-[2px] ${color}`} />;
        })}
      </div>
      <span role="status" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs">
        {interrupted && (
          <>
            <span aria-hidden="true" className="size-2 rounded-full bg-[var(--danger)]" />
            <span className="text-[var(--text-2)]">采集中断，重连中</span>
          </>
        )}
        {silent && <span className="hidden shrink-0 whitespace-nowrap text-[var(--warn)] @[44rem]:inline">未收到声音</span>}
      </span>
    </div>
  );
}
