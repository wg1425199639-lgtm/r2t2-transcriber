import { ArrowDown } from "lucide-react";

interface JumpToLatestProps {
  isSticking: boolean;
  unreadCount: number;
  onJump: () => void;
}

export function JumpToLatest({ isSticking, unreadCount, onJump }: JumpToLatestProps) {
  return (
    <div className="sticky bottom-5 col-start-2 flex h-8 justify-end pointer-events-none z-10">
      {!isSticking && (
        <button
          type="button"
          aria-keyshortcuts="Meta+ArrowDown"
          onClick={onJump}
          className="append-fade-in pointer-events-auto inline-flex h-8 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-sm shadow-[var(--shadow-popover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <ArrowDown aria-hidden="true" size={16} strokeWidth={1.5} className="text-[var(--text-2)]" />
          {unreadCount > 0 ? `回到最新 · ${unreadCount} 段新内容` : "回到最新"}
        </button>
      )}
    </div>
  );
}
