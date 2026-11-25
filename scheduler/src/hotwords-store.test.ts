import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PROMPT_CHARS } from "./config.js";
import { HotwordsStore } from "./hotwords-store.js";
import { TranscriptLog, type TranscriptLogRecord } from "./transcript-log.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "scheduler-persistence-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("HotwordsStore", () => {
  it("persists replacements and immediately exposes an independent snapshot", async () => {
    const path = join(directory, "data", "hotwords.json");
    const store = new HotwordsStore(path);
    expect(store.load()).toEqual({ hotwords: [], background: "" });

    store.set({ hotwords: ["旧词"], background: "旧背景" });
    const input = { hotwords: [" 十五五规划 ", "", "十五五规划", "  ", "新质生产力"], background: "新闻发布会" };
    const expected = { hotwords: ["十五五规划", "新质生产力"], background: "新闻发布会" };
    store.set(input);
    expect(store.get()).toEqual(expected);
    input.hotwords.push("外部修改");
    store.get().hotwords.pop();
    expect(store.get()).toEqual(expected);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
    expect(new HotwordsStore(path).load()).toEqual(expected);
    expect(await readdir(dirname(path))).toEqual(["hotwords.json"]);
  });

  it("rejects invalid persisted data", async () => {
    const path = join(directory, "hotwords.json");
    await writeFile(path, JSON.stringify({ hotwords: [42], background: "" }));
    expect(() => new HotwordsStore(path).load()).toThrow();
  });

  it("normalizes whitespace and truncates the context without splitting an emoji", () => {
    const store = new HotwordsStore(join(directory, "hotwords.json"));
    store.set({ hotwords: ["十五五\r\n规划", "\t新质  生产力"], background: " 新闻\r发布会\n" });
    expect(store.toPromptContext()).toBe("十五五 规划, 新质 生产力, 新闻 发布会");

    const prefix = "字".repeat(MAX_PROMPT_CHARS - 1);
    store.set({ hotwords: [], background: prefix + "😀尾字" });
    expect(store.toPromptContext()).toBe(prefix);

    store.set({ hotwords: [], background: "字".repeat(MAX_PROMPT_CHARS + 1) });
    expect(store.toPromptContext()).toHaveLength(MAX_PROMPT_CHARS);
  });
});

describe("TranscriptLog", () => {
  it("writes concurrent appends in call order and drains on close", async () => {
    const sessions = join(directory, "sessions");
    const log = new TranscriptLog("test-session", sessions);
    const events: TranscriptLogRecord[] = [
      { type: "segment.start", segmentId: 1, tsMs: 100 },
      { type: "transcript.delta", segmentId: 1, seq: 1, text: "第一行\n第二行", tsMs: 101 },
      { type: "hotwords", hotwords: ["规划"], background: "会议", appliesFromSegment: 2 },
      { type: "transcript.delta", segmentId: 1, seq: 2, text: "尾字", tsMs: 102 },
      { type: "segment.end", segmentId: 1, reason: "stop", durMs: 300 },
    ];
    const writes = events.slice(0, 3).map((event) => log.append(event));
    const path = join(sessions, "test-session.jsonl");
    await log.flush();
    const firstBatch = await readFile(path, "utf8");
    const remainingWrites = events.slice(3).map((event) => log.append(event));
    await log.close();
    await Promise.all([...writes, ...remainingWrites]);
    await expect(log.append({ type: "segment.start", segmentId: 2, tsMs: 400 })).rejects.toThrow("closed");

    const contents = await readFile(path, "utf8");
    expect(contents.startsWith(firstBatch)).toBe(true);
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.slice(0, -1).split("\n").map((line) => JSON.parse(line))).toEqual(events);
  });
});
