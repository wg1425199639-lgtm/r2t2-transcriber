import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";

const PROMPT_LIMIT = 250;
const SAVE_DELAY_MS = 400;
const SEGMENT_NOTICE_MS = 4000;
const SEPARATOR = ", ";
const WORD_DELIMITERS = /[,，、\r\n]+/;
const EMPTY_HOTWORDS: string[] = [];

function normalizePart(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function computePromptBudget(hotwords: string[], background: string, maxChars = PROMPT_LIMIT) {
  const normalizedHotwords = hotwords.map(normalizePart).filter(Boolean).join(SEPARATOR);
  const normalizedBackground = normalizePart(background);
  const separator = normalizedHotwords && normalizedBackground ? SEPARATOR : "";
  const backgroundBudget = Math.max(0, maxChars - normalizedHotwords.length - separator.length);
  const includedBackground = normalizedBackground.slice(0, backgroundBudget).replace(/[\uD800-\uDBFF]$/, "").trimEnd();

  return {
    totalChars: normalizedHotwords.length + separator.length + normalizedBackground.length,
    backgroundBudget,
    includedBackground,
    backgroundTruncated: includedBackground.length < normalizedBackground.length,
  };
}

export interface HotwordEditorProps {
  hotwords?: string[];
  background?: string;
  appliesFromSegment?: number | null;
  onSave: (hotwords: string[], background: string) => void;
}

const fieldClass = "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm placeholder:text-[var(--text-3)] focus-visible:outline-1 focus-visible:outline-[var(--accent)]";

export function HotwordEditor({
  hotwords = EMPTY_HOTWORDS,
  background = "",
  appliesFromSegment = null,
  onSave,
}: HotwordEditorProps) {
  const [words, setWords] = useState(hotwords);
  const [draft, setDraft] = useState(background);
  const [entry, setEntry] = useState("");
  const [search, setSearch] = useState("");
  const [noticeVisible, setNoticeVisible] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backgroundId = useId();

  useEffect(() => setWords(hotwords), [hotwords]);
  useEffect(() => {
    if (saveTimer.current === undefined) setDraft(background);
  }, [background]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  useEffect(() => {
    setNoticeVisible(true);
    if (appliesFromSegment === null) return;
    const timer = setTimeout(() => setNoticeVisible(false), SEGMENT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [appliesFromSegment, hotwords, background]);

  function save(nextWords: string[], nextBackground: string) {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    onSave(nextWords, nextBackground);
  }

  function updateWords(nextWords: string[]) {
    setWords(nextWords);
    save(nextWords, draft);
  }

  function addWords(text: string) {
    const additions = text.split(WORD_DELIMITERS).map((word) => word.trim()).filter(Boolean);
    const nextWords = [...new Set([...words, ...additions])];
    if (nextWords.length > words.length) updateWords(nextWords);
  }

  const query = search.trim().toLowerCase();
  const visibleWords = words.filter((word) => word.toLowerCase().includes(query));
  const budget = computePromptBudget(words, draft);

  return (
    <section aria-label="热词与背景词" className="grid gap-2 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium">会前热词</h2>
        <span className="text-xs text-[var(--text-2)]">{query ? `${visibleWords.length} / ` : ""}{words.length} 条</span>
      </div>
      <input
        className={fieldClass}
        aria-label="添加热词"
        placeholder="输入热词，按回车添加"
        value={entry}
        onChange={(event) => setEntry(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          addWords(entry);
          setEntry("");
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          if (!WORD_DELIMITERS.test(text)) return;
          event.preventDefault();
          addWords(text);
        }}
      />
      <input
        className={fieldClass}
        type="search"
        aria-label="搜索热词"
        placeholder="搜索热词"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {visibleWords.length > 0 && (
        <ul aria-label="热词列表" className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {visibleWords.map((word) => (
            <li key={word} className="inline-flex max-w-full items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--bg-elevated)] py-0.5 pr-0.5 pl-1.5">
              <span className="min-w-0 wrap-anywhere">{word}</span>
              <button
                type="button"
                aria-label={`删除热词 ${word}`}
                className="grid size-6 shrink-0 place-items-center rounded-sm text-[var(--text-2)] hover:text-[var(--text)] focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
                onClick={() => updateWords(words.filter((item) => item !== word))}
              >
                <X aria-hidden="true" size={16} strokeWidth={1.5} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={backgroundId} className="mt-2 font-medium">背景词</label>
      <textarea
        id={backgroundId}
        className={`${fieldClass} resize-y`}
        rows={4}
        placeholder="十五五规划、国务院新闻办……"
        value={draft}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => save(words, value), SAVE_DELAY_MS);
        }}
        onBlur={() => {
          if (saveTimer.current !== undefined) save(words, draft);
        }}
      />
      <div className="grid gap-1 text-xs text-[var(--text-2)]">
        <span className={`numeric ${budget.totalChars > PROMPT_LIMIT ? "text-[var(--warn)]" : ""}`}>
          {budget.totalChars} / {PROMPT_LIMIT}
        </span>
        {budget.backgroundTruncated && <span className="text-[var(--warn)]">背景词将被截断</span>}
        <div role="status">
          {appliesFromSegment !== null && (
            <span
              aria-hidden={!noticeVisible}
              className={`motion-safe:transition-opacity motion-safe:duration-300 ${noticeVisible ? "opacity-100" : "opacity-0"}`}
            >
              将从第 {appliesFromSegment} 段起生效
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
