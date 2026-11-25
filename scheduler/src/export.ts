import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "./config.js";
import { serverMessageSchema } from "./protocol.js";

interface TranscriptSegment {
  segmentId: number;
  tsMs: number;
  text: string;
}

interface ExportOptions {
  sessionId: string;
  format: "md" | "txt";
  sessionsDir?: string;
  exportsDir?: string;
  outputPath?: string;
}

function orderedParagraphs(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter(({ text }) => text.trim()).sort((a, b) => a.segmentId - b.segmentId);
}

export function formatTranscriptMarkdown(
  segments: readonly TranscriptSegment[],
  meta?: { exportedAt?: Date },
): string {
  const exportedAt = meta?.exportedAt?.toISOString() ?? "未指定";
  const paragraphs = orderedParagraphs(segments).map(({ tsMs, text }) => {
    const time = new Date(tsMs).toISOString().split("T")[1]?.slice(0, 8);
    return `## ${time}\n\n${text}`;
  });
  return ["# 实时语音转写记录", `导出时间：${exportedAt}`, ...paragraphs].join("\n\n") + "\n";
}

export function formatTranscriptText(segments: readonly TranscriptSegment[]): string {
  return orderedParagraphs(segments).map(({ text }) => text).join("\n\n");
}

function isSessionId(id: string): boolean {
  return id.trim().length > 0 && id !== "." && id !== ".." && !/[/\\:\0]/.test(id);
}

async function latestSessionId(directory: string): Promise<string> {
  let latest: { id: string; mtimeMs: number } | undefined;
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const id = entry.name.slice(0, -".jsonl".length);
    if (!isSessionId(id)) continue;
    const { mtimeMs } = await lstat(join(directory, entry.name));
    if (!latest || mtimeMs > latest.mtimeMs || (mtimeMs === latest.mtimeMs && id > latest.id)) {
      latest = { id, mtimeMs };
    }
  }
  if (!latest) throw new Error("No transcript sessions found");
  return latest.id;
}

async function readSegments(path: string): Promise<TranscriptSegment[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const segments = new Map<number, TranscriptSegment>();
  const appendLine = (line: string): void => {
    if (!line.trim()) return;
    const record = serverMessageSchema.safeParse(JSON.parse(line));
    if (!record.success || record.data.type !== "transcript.delta") return;
    const { segmentId, tsMs, text } = record.data;
    const segment = segments.get(segmentId);
    if (segment) segment.text += text;
    else segments.set(segmentId, { segmentId, tsMs, text });
  };

  try {
    const { size } = await file.stat();
    if (size === 0) return [];
    let remainder = "";
    const stream = file.createReadStream({ encoding: "utf8", autoClose: false, end: size - 1 });
    for await (const chunk of stream) {
      const lines = (remainder + chunk).split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) appendLine(line);
    }
    try {
      appendLine(remainder);
    } catch (error) {
      // A recording interrupted during append may leave an incomplete final record.
      if (!(error instanceof SyntaxError)) throw error;
    }
    return [...segments.values()];
  } finally {
    await file.close();
  }
}

export async function exportSession({
  sessionId,
  format,
  sessionsDir = join(DATA_DIR, "sessions"),
  exportsDir = join(DATA_DIR, "exports"),
  outputPath,
}: ExportOptions): Promise<{ path: string; content: string }> {
  if (!isSessionId(sessionId)) throw new Error("Invalid transcript session ID");
  const id = sessionId === "latest" ? await latestSessionId(sessionsDir) : sessionId;
  const segments = await readSegments(join(sessionsDir, `${id}.jsonl`));
  const content = format === "md"
    ? formatTranscriptMarkdown(segments, { exportedAt: new Date() })
    : formatTranscriptText(segments);
  const path = resolve(outputPath ?? join(exportsDir, `${id}.${format}`));
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { path, content };
}
