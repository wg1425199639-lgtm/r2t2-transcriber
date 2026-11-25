import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { serverMessageSchema, type ServerMessage } from "./protocol.js";

export type TranscriptLogRecord = Extract<ServerMessage, {
  type: "segment.start" | "transcript.delta" | "segment.end" | "hotwords";
}>;

function ignoreMissing(error: unknown): undefined {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
  throw error;
}

export async function loadLatestSessionRecords(
  directory = join(DATA_DIR, "sessions"),
  exportsDirectory?: string,
): Promise<TranscriptLogRecord[]> {
  const entries = await opendir(directory).catch(ignoreMissing);
  if (!entries) return [];

  let latest: { name: string; mtimeMs: number } | undefined;
  for await (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const info = await lstat(join(directory, entry.name)).catch(ignoreMissing);
    if (!info?.isFile()) continue;
    const { mtimeMs } = info;
    if (!latest || mtimeMs > latest.mtimeMs || (mtimeMs === latest.mtimeMs && entry.name > latest.name)) {
      latest = { name: entry.name, mtimeMs };
    }
  }
  if (!latest) return [];

  const file = await open(join(directory, latest.name), constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(ignoreMissing);
  if (!file) return [];

  try {
    const { size, mtimeMs } = await file.stat();
    if (size === 0) return [];
    if (exportsDirectory !== undefined) {
      const id = latest.name.slice(0, -".jsonl".length);
      for (const extension of ["md", "txt"]) {
        const exported = await lstat(join(exportsDirectory, `${id}.${extension}`)).catch(ignoreMissing);
        if (exported?.isFile() && exported.mtimeMs >= mtimeMs) return [];
      }
    }

    const records: TranscriptLogRecord[] = [];
    const appendLine = (line: string): void => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = serverMessageSchema.safeParse(value);
      if (!parsed.success) return;
      const record = parsed.data;
      if (record.type === "segment.start" || record.type === "transcript.delta"
        || record.type === "segment.end" || record.type === "hotwords") {
        records.push(record);
      }
    };
    let remainder = "";
    const stream = file.createReadStream({ encoding: "utf8", autoClose: false, end: size - 1 });
    for await (const chunk of stream) {
      const lines = (remainder + chunk).split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) appendLine(line);
    }
    if (remainder) appendLine(remainder);
    return records;
  } finally {
    await file.close();
  }
}

export class TranscriptLog {
  private readonly path: string;
  private tail = Promise.resolve();
  private directoryReady = false;
  private closed = false;

  constructor(sessionId: string, private readonly directory = join(DATA_DIR, "sessions")) {
    if (!sessionId || /[/\\:\0]/.test(sessionId)) {
      throw new Error("Invalid transcript session ID");
    }
    this.path = join(directory, `${sessionId}.jsonl`);
  }

  append(record: TranscriptLogRecord): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Transcript log is closed"));
    }

    const line = JSON.stringify(record) + "\n";
    this.tail = this.tail.then(async () => {
      if (!this.directoryReady) {
        await mkdir(this.directory, { recursive: true });
        this.directoryReady = true;
      }
      await appendFile(this.path, line, "utf8");
    });
    // Keep failures observable through append, flush, and close.
    void this.tail.catch(() => {});
    return this.tail;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.flush();
  }
}
