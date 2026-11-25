import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DATA_DIR, MAX_PROMPT_CHARS } from "./config.js";

const hotwordsSchema = z.object({
  hotwords: z.array(z.string()),
  background: z.string(),
});

export type HotwordsData = z.infer<typeof hotwordsSchema>;

export class HotwordsStore {
  private data: HotwordsData = { hotwords: [], background: "" };

  constructor(private readonly path = join(DATA_DIR, "hotwords.json")) {}

  load(): HotwordsData {
    let contents: string | undefined;
    try {
      contents = readFileSync(this.path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    this.data = contents === undefined
      ? { hotwords: [], background: "" }
      : hotwordsSchema.parse(JSON.parse(contents));
    return this.get();
  }

  get(): HotwordsData {
    return { hotwords: [...this.data.hotwords], background: this.data.background };
  }

  set(data: HotwordsData): void {
    const next = {
      hotwords: [...new Set(data.hotwords.map((word) => word.trim()).filter(Boolean))],
      background: data.background,
    };

    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = join(directory, `.hotwords-${randomUUID()}.tmp`);
    const fd = openSync(temporaryPath, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(next) + "\n", "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the write or rename error if cleanup also fails.
      }
      throw error;
    }

    this.data = next;
  }

  toPromptContext(): string {
    return [...this.data.hotwords, this.data.background]
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(", ")
      .slice(0, MAX_PROMPT_CHARS)
      .replace(/[\uD800-\uDBFF]$/, "")
      .trimEnd();
  }
}
