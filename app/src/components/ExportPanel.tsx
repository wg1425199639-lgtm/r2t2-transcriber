import { Button } from "./ui/button";

const exportButtonClass = "h-8 rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] text-[13px] text-[var(--text)] hover:bg-[var(--bg)] enabled:hover:bg-[var(--bg)]";

export interface ExportPanelProps {
  onExportMarkdown?: () => void;
  onExportTxt?: () => void;
  onCopyAll?: () => void;
  copied?: boolean;
  lastExportPath?: string;
  onRevealExport?: () => void;
  notice?: string;
}

export function ExportPanel({
  onExportMarkdown,
  onExportTxt,
  onCopyAll,
  copied,
  lastExportPath,
  onRevealExport,
  notice,
}: ExportPanelProps) {
  const filename = lastExportPath?.split(/[/\\]/).pop();

  return (
    <div role="group" aria-label="导出" className="border-t border-[var(--border)] p-3 grid grid-cols-2 gap-2 shrink-0">
      <Button size="sm" variant="outline" className={`col-span-2 ${exportButtonClass}`} onClick={onExportMarkdown} disabled={!onExportMarkdown}>
        导出 Markdown
      </Button>
      <Button size="sm" variant="outline" className={exportButtonClass} onClick={onExportTxt} disabled={!onExportTxt}>
        导出 TXT
      </Button>
      <Button size="sm" variant="outline" className={exportButtonClass} onClick={onCopyAll} disabled={!onCopyAll}>
        <span aria-live="polite">{copied ? "已复制" : "复制全文"}</span>
      </Button>
      {filename && (
        <div className="col-span-2 flex min-w-0 items-center justify-between gap-2 text-[11px] text-[var(--text-2)]">
          <span className="truncate" title={filename}>{filename}</span>
          {onRevealExport && (
            <button type="button" className="shrink-0 hover:underline" onClick={onRevealExport}>
              打开目录
            </button>
          )}
        </div>
      )}
      {notice && <p role="status" className="col-span-2 text-[11px] text-[var(--text-2)]">{notice}</p>}
    </div>
  );
}
