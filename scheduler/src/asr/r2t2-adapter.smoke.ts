import { open, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  BYTES_PER_SAMPLE, CHANNELS, FRAME_BYTES, FRAME_MS, SAMPLE_RATE,
  TAIL_SILENCE_BYTES, WATCHDOG_MS,
} from "../config.js";
import { R2T2Adapter } from "./r2t2-adapter.js";

const SAMPLE_BYTES = CHANNELS * BYTES_PER_SAMPLE;

async function readAt(file: FileHandle, bytes: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < bytes) {
    const { bytesRead } = await file.read(buffer, offset, bytes - offset, position + offset);
    if (bytesRead === 0) throw new Error("Unexpected end of WAV file");
    offset += bytesRead;
  }
  return buffer;
}

async function findPcm(file: FileHandle): Promise<{ offset: number; length: number }> {
  const riff = await readAt(file, 12, 0);
  if (riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE file");
  }
  const end = 8 + riff.readUInt32LE(4);
  if (end > (await file.stat()).size) throw new Error("Truncated WAV file");

  let hasFormat = false;
  let pcm: { offset: number; length: number } | undefined;
  for (let cursor = 12; cursor + 8 <= end;) {
    const header = await readAt(file, 8, cursor);
    const id = header.toString("ascii", 0, 4);
    const length = header.readUInt32LE(4);
    const offset = cursor + 8;
    cursor = offset + length + (length % 2);
    if (cursor > end) throw new Error("Truncated WAV chunk");

    if (id === "fmt ") {
      if (length < 16) throw new Error("Invalid WAV format chunk");
      const format = await readAt(file, 16, offset);
      if (format.readUInt16LE(0) !== 1
        || format.readUInt16LE(2) !== CHANNELS
        || format.readUInt32LE(4) !== SAMPLE_RATE
        || format.readUInt16LE(12) !== SAMPLE_BYTES
        || format.readUInt16LE(14) !== BYTES_PER_SAMPLE * 8) {
        throw new Error("Expected 16 kHz mono signed 16-bit PCM WAV");
      }
      hasFormat = true;
    } else if (id === "data") {
      pcm = { offset, length };
    }
    if (hasFormat && pcm) {
      if (pcm.length === 0 || pcm.length % SAMPLE_BYTES !== 0) {
        throw new Error("Invalid WAV PCM length");
      }
      if ((pcm.length + TAIL_SILENCE_BYTES) * 1000 >= WATCHDOG_MS * SAMPLE_RATE * SAMPLE_BYTES) {
        throw new Error("WAV exceeds the single-session smoke test duration");
      }
      return pcm;
    }
  }
  throw new Error("WAV is missing its format or data chunk");
}

async function main(path: string | undefined): Promise<void> {
  if (!path) throw new Error("Usage: r2t2-adapter.smoke.ts <file.wav>");
  const file = await open(path, "r");
  const adapter = new R2T2Adapter();
  try {
    const pcm = await findPcm(file);
    await adapter.start();
    const session = await adapter.openSession({ language: "Chinese", chunkMs: FRAME_MS, context: "" });
    const stream = new AbortController();
    session.onError((error) => stream.abort(error));
    session.onFinal((text) => console.log(text));
    try {
      const startedAt = performance.now();
      for (let sent = 0; sent < pcm.length; sent += FRAME_BYTES) {
        const frame = await readAt(file, Math.min(FRAME_BYTES, pcm.length - sent), pcm.offset + sent);
        stream.signal.throwIfAborted();
        session.pushAudio(frame);
        const frameEnd = startedAt + (sent + frame.length) * 1000 / (SAMPLE_RATE * SAMPLE_BYTES);
        await delay(Math.max(0, frameEnd - performance.now()), undefined, { signal: stream.signal });
      }
      session.pushAudio(Buffer.alloc(TAIL_SILENCE_BYTES));
      await session.finish();
    } catch (error) {
      session.abort();
      throw stream.signal.reason ?? error;
    }
  } finally {
    try {
      await adapter.stop();
    } finally {
      await file.close();
    }
  }
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
