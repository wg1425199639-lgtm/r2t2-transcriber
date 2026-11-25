import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSession, formatTranscriptMarkdown, formatTranscriptText } from "./export.js";

const firstTimestamp = Date.parse("2026-11-25T01:02:03Z");
const segments = [
  { segmentId: 2, tsMs: firstTimestamp + 1000, text: "第二段" },
  { segmentId: 1, tsMs: firstTimestamp, text: "第一段" },
  { segmentId: 3, tsMs: firstTimestamp + 2000, text: " \t\n" },
];

describe("transcript formatting", () => {
  it("formats Markdown with export time and timestamped headings", () => {
    const exportedAt = new Date("2026-11-25T04:05:06Z");
    expect(formatTranscriptMarkdown(segments, { exportedAt })).toBe(
      "# 实时语音转写记录\n\n导出时间：2026-11-25T04:05:06.000Z\n\n" +
      "## 01:02:03\n\n第一段\n\n## 01:02:04\n\n第二段\n",
    );
  });

  it("formats plain text in segment order and drops blank paragraphs", () => {
    expect(formatTranscriptText(segments)).toBe("第一段\n\n第二段");
    expect(formatTranscriptText([])).toBe("");
  });
});

describe("session export", () => {
  let root: string;
  let sessionsDir: string;
  let exportsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "transcript-export-"));
    sessionsDir = join(root, "sessions");
    exportsDir = join(root, "nested", "exports");
    await mkdir(sessionsDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const delta = (segmentId: number, seq: number, text: string, tsMs: number) =>
    JSON.stringify({ type: "transcript.delta", segmentId, seq, text, tsMs }) + "\n";

  it.each(["../escape", "..\\escape", "/tmp/escape", "C:escape", ".", "..", ""])(
    "rejects invalid session ID %j",
    async (sessionId) => {
      await expect(exportSession({ sessionId, format: "txt", sessionsDir, exportsDir }))
        .rejects.toThrow("Invalid transcript session ID");
    },
  );

  it("uses the newest JSONL by modification time and writes joined deltas", async () => {
    const older = join(sessionsDir, "z-old.jsonl");
    const newer = join(sessionsDir, "a-new.jsonl");
    await writeFile(older, delta(1, 1, "旧会话", firstTimestamp));
    await writeFile(newer,
      delta(2, 1, "第二段", firstTimestamp + 1000) +
      delta(1, 1, "第一", firstTimestamp) +
      delta(3, 1, " \t", firstTimestamp) +
      delta(1, 2, "段", firstTimestamp + 5000) +
      JSON.stringify({ type: "segment.start", segmentId: 4, tsMs: firstTimestamp }) + "\n",
    );
    await utimes(older, 1000, 1000);
    await utimes(newer, 2000, 2000);
    await writeFile(join(sessionsDir, "ignore.txt"), "忽略");
    await mkdir(join(sessionsDir, "ignore.jsonl"));

    const result = await exportSession({ sessionId: "latest", format: "txt", sessionsDir, exportsDir });
    expect(result).toEqual({ path: join(exportsDir, "a-new.txt"), content: "第一段\n\n第二段" });
    expect(await readFile(result.path, "utf8")).toBe(result.content);

    const outputPath = join(root, "custom", "report.md");
    const markdown = await exportSession({
      sessionId: "a-new", format: "md", sessionsDir, outputPath: relative(process.cwd(), outputPath),
    });
    expect(markdown.path).toBe(outputPath);
    expect(markdown.content).toMatch(/导出时间：\d{4}-\d{2}-\d{2}T.*Z/);
    expect(markdown.content).toContain("## 01:02:03\n\n第一段\n\n## 01:02:04\n\n第二段\n");
    expect(await readFile(outputPath, "utf8")).toBe(markdown.content);
  });
});
