import { describe, expect, it, vi } from "vitest";
import { BYTES_PER_SAMPLE, FRAME_BYTES, FRAME_MS, TAIL_SILENCE_BYTES } from "../config.js";
import type { AsrSessionOptions } from "./adapter.js";
import { MockAsrAdapter } from "./mock-adapter.js";

const options = {
  language: "Chinese",
  chunkMs: FRAME_MS,
  context: "十五五规划",
} satisfies AsrSessionOptions;

describe("MockAsrAdapter", () => {
  it("records audio and appends Chinese deltas before emitting the full final text", async () => {
    const adapter = new MockAsrAdapter();
    await adapter.start();
    const session = await adapter.openSession({ ...options });
    const deltas: string[] = [];
    const final = vi.fn();
    session.onDelta((text) => deltas.push(text));
    session.onFinal(final);

    session.pushAudio(Buffer.alloc(FRAME_BYTES / 2, 1));
    expect(deltas).toEqual([]);
    session.pushAudio(Buffer.alloc(FRAME_BYTES + FRAME_BYTES / 2, 1));
    expect(deltas).toEqual(["模拟转写", "模拟转写"]);
    session.pushAudio(Buffer.alloc(TAIL_SILENCE_BYTES / 2));
    session.pushAudio(Buffer.alloc(TAIL_SILENCE_BYTES / 2));

    expect(session.options).toEqual(options);
    expect(session.totalAudioBytes).toBe(2 * FRAME_BYTES + TAIL_SILENCE_BYTES);
    expect(session.trailingZeroBytes).toBe(TAIL_SILENCE_BYTES);
    expect(final).not.toHaveBeenCalled();
    await session.finish();
    expect(final).toHaveBeenCalledExactlyOnceWith(deltas.join(""));

    const next = await adapter.openSession({ ...options, context: "新质生产力" });
    expect(next.options.context).toBe("新质生产力");
    expect(next.totalAudioBytes).toBe(0);
    await adapter.stop();
  });

  it.each([0, TAIL_SILENCE_BYTES - BYTES_PER_SAMPLE])(
    "rejects finish with only %i trailing zero bytes",
    async (tailBytes) => {
      const adapter = new MockAsrAdapter();
      const session = await adapter.openSession(options);
      const final = vi.fn();
      const onError = vi.fn();
      session.onFinal(final);
      session.onError(onError);

      session.pushAudio(Buffer.alloc(TAIL_SILENCE_BYTES));
      const lastChunk = Buffer.alloc(BYTES_PER_SAMPLE + tailBytes);
      lastChunk.fill(1, 0, BYTES_PER_SAMPLE);
      session.pushAudio(lastChunk);

      expect(session.trailingZeroBytes).toBe(tailBytes);
      await expect(session.finish()).rejects.toThrow(`received ${tailBytes}`);
      expect(onError).toHaveBeenCalledOnce();
      expect(final).not.toHaveBeenCalled();
      await expect(adapter.openSession(options)).rejects.toThrow("active session");
      session.abort();
    },
  );

  it("rejects concurrent opens and releases the slot on abort without emitting final", async () => {
    const adapter = new MockAsrAdapter();
    const firstOpen = adapter.openSession(options);
    const concurrentOpen = adapter.openSession(options);
    const first = await firstOpen;
    const final = vi.fn();
    first.onFinal(final);
    await expect(concurrentOpen).rejects.toThrow("active session");

    first.abort();
    const next = await adapter.openSession(options);
    first.abort();
    await expect(adapter.openSession(options)).rejects.toThrow("active session");
    await expect(first.finish()).rejects.toThrow("closed");
    expect(final).not.toHaveBeenCalled();
    next.pushAudio(Buffer.alloc(TAIL_SILENCE_BYTES));
    await next.finish();
  });
});
