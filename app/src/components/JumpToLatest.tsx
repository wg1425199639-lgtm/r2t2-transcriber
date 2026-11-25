import { ArrowDown } from "lucide-react";

interface JumpToLatestProps {
  isSticking: boolean;
  unreadCount: number;
  onJump: () => void;
}

export function JumpToLatest({ isSticking, unreadCount, onJump }: JumpToLatestProps) {
  if (isSticking) return null;

  return (
    <button
      type="button"
      aria-keyshortcuts="Meta+ArrowDown"
      onClick={onJump}
      className="append-fade-in absolute right-6 bottom-6 inline-flex h-8 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-sm shadow-[var(--shadow-popover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
    >
      <ArrowDown aria-hidden="true" size={16} strokeWidth={1.5} className="text-[var(--text-2)]" />
      {unreadCount > 0 ? `回到最新 · ${unreadCount} 段新内容` : "回到最新"}
    </button>
  );
}
