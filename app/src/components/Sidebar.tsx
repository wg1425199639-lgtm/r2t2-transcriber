import { sessionStore, useSessionStore } from "../store/session";
import { HotwordEditor } from "./HotwordEditor";
import { Button } from "./ui/button";

const exportButtonClass = "h-8 rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] text-[13px] text-[var(--text)] hover:bg-[var(--bg)] enabled:hover:bg-[var(--bg)]";

interface SidebarProps {
  onExportMarkdown?: () => void;
  onExportTxt?: () => void;
  onCopyAll?: () => void;
}

export function Sidebar({ onExportMarkdown, onExportTxt, onCopyAll }: SidebarProps) {
  const { hotwords, background, appliesFromSegment } = useSessionStore();

  return (
    <aside aria-label="侧边栏" className="relative isolate overflow-hidden shrink-0 w-[240px] select-none flex flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)] backdrop-blur-[24px] backdrop-saturate-[1.2]">
      <div aria-hidden="true" className="h-11 shrink-0" data-tauri-drag-region />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <HotwordEditor
          hotwords={hotwords}
          background={background}
          appliesFromSegment={appliesFromSegment}
          onSave={sessionStore.setHotwords}
        />
      </div>
      <div role="group" aria-label="导出" className="border-t border-[var(--border)] p-3 grid grid-cols-2 gap-2 shrink-0">
        <Button size="sm" variant="outline" className={`col-span-2 ${exportButtonClass}`} onClick={onExportMarkdown} disabled={!onExportMarkdown}>
          导出 Markdown
        </Button>
        <Button size="sm" variant="outline" className={exportButtonClass} onClick={onExportTxt} disabled={!onExportTxt}>
          导出 TXT
        </Button>
        <Button size="sm" variant="outline" className={exportButtonClass} onClick={onCopyAll} disabled={!onCopyAll}>
          复制全文
        </Button>
      </div>
    </aside>
  );
}
