import { sessionStore, useSessionStore } from "../store/session";
import { HotwordEditor } from "./HotwordEditor";
import { Button } from "./ui/button";

interface SidebarProps {
  onExportMarkdown?: () => void;
  onExportTxt?: () => void;
  onCopyAll?: () => void;
}

export function Sidebar({ onExportMarkdown, onExportTxt, onCopyAll }: SidebarProps) {
  const { hotwords, background, appliesFromSegment } = useSessionStore();

  return (
    <aside aria-label="侧边栏" className="flex w-[240px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)] backdrop-blur-[24px] backdrop-saturate-[1.2]">
      <div aria-hidden="true" className="h-[38px] shrink-0" data-tauri-drag-region />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <HotwordEditor
          hotwords={hotwords}
          background={background}
          appliesFromSegment={appliesFromSegment}
          onSave={sessionStore.setHotwords}
        />
      </div>
      <div role="group" aria-label="导出" className="grid shrink-0 grid-cols-2 gap-1 rounded-lg border border-divider p-1 mx-3 mb-3">
        <Button size="sm" variant="ghost" className="col-span-2 bg-elevated" onClick={onExportMarkdown} disabled={!onExportMarkdown}>
          导出 Markdown
        </Button>
        <Button size="sm" variant="ghost" className="bg-elevated" onClick={onExportTxt} disabled={!onExportTxt}>
          导出 TXT
        </Button>
        <Button size="sm" variant="ghost" className="bg-elevated" onClick={onCopyAll} disabled={!onCopyAll}>
          复制全文
        </Button>
      </div>
    </aside>
  );
}
