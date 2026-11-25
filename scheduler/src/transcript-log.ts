import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import type { ServerMessage } from "./protocol.js";

export type TranscriptLogRecord = Extract<ServerMessage, {
  type: "segment.start" | "transcript.delta" | "segment.end" | "hotwords";
}>;

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
