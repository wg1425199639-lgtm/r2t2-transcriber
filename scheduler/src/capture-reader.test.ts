import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CaptureReader } from "./capture-reader.js";
import { FRAME_BYTES, SHORT_FRAME_BYTES } from "./config.js";

function pcmBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = index % 251;
  }
  return bytes;
}

describe("CaptureReader", () => {
  it.each([1, 17, 333])("reassembles a frame from %i-byte chunks", (chunkBytes) => {
    const pcm = pcmBytes(FRAME_BYTES);
    const reader = new CaptureReader();
    const frames: Buffer[] = [];

    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      frames.push(...reader.push(pcm.subarray(offset, offset + chunkBytes)));
      expect(reader.bufferedBytes).toBeLessThan(FRAME_BYTES);
    }

    expect(frames).toEqual([pcm]);
    expect(reader.bufferedBytes).toBe(0);
  });

  it("emits two independent frames and keeps the remaining half frame", () => {
    const halfFrame = FRAME_BYTES / 2;
    const pcm = pcmBytes(3 * FRAME_BYTES);
    const chunk = Buffer.from(pcm.subarray(0, 2 * FRAME_BYTES + halfFrame));
    const reader = new CaptureReader();

    const frames = reader.push(chunk);
    chunk.fill(0);
    expect(frames).toEqual([
      pcm.subarray(0, FRAME_BYTES),
      pcm.subarray(FRAME_BYTES, 2 * FRAME_BYTES),
    ]);
    expect(reader.bufferedBytes).toBe(halfFrame);
    expect(reader.push(pcm.subarray(2 * FRAME_BYTES + halfFrame)))
      .toEqual([pcm.subarray(2 * FRAME_BYTES)]);
    expect(reader.bufferedBytes).toBe(0);
  });

  it("uses the short frame size and supports resetting a partial frame", () => {
    const reader = new CaptureReader(SHORT_FRAME_BYTES);
    const pcm = pcmBytes(SHORT_FRAME_BYTES);

    expect(reader.push(Buffer.from([255]))).toEqual([]);
    expect(reader.bufferedBytes).toBe(1);
    reader.reset();
    expect(reader.bufferedBytes).toBe(0);
    expect(reader.push(pcm)).toEqual([pcm]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, FRAME_BYTES - 1])(
    "rejects invalid frame size %s",
    (frameBytes) => {
      expect(() => new CaptureReader(frameBytes)).toThrow(RangeError);
    },
  );

  it("reads complete frames from a Readable and discards the tail at EOF", async () => {
    const reader = new CaptureReader();
    const pcm = pcmBytes(FRAME_BYTES + 17);
    const stream = Readable.from([pcm.subarray(0, 333), pcm.subarray(333)]);
    const frames: Buffer[] = [];

    for await (const frame of reader.read(stream)) {
      frames.push(frame);
    }

    expect(frames).toEqual([pcm.subarray(0, FRAME_BYTES)]);
    expect(reader.bufferedBytes).toBe(0);
  });
});
