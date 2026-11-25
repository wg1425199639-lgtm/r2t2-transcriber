import { sessionStore, useSessionStore } from "../store/session";
import { ExportPanel } from "./ExportPanel";
import type { ExportPanelProps } from "./ExportPanel";
import { HotwordEditor } from "./HotwordEditor";

export function Sidebar(props: ExportPanelProps) {
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
      <ExportPanel {...props} />
    </aside>
  );
}
