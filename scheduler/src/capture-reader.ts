import type { Readable } from "node:stream";
import { FRAME_BYTES, SHORT_FRAME_BYTES } from "./config.js";

export class CaptureReader {
  private readonly partial: Buffer;
  private pendingBytes = 0;

  constructor(readonly frameBytes: number = FRAME_BYTES) {
    if (frameBytes !== FRAME_BYTES && frameBytes !== SHORT_FRAME_BYTES) {
      throw new RangeError(`frameBytes must be ${FRAME_BYTES} or ${SHORT_FRAME_BYTES}`);
    }
    this.partial = Buffer.allocUnsafe(frameBytes);
  }

  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  reset(): void {
    this.pendingBytes = 0;
  }

  push(chunk: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;

    if (this.pendingBytes > 0) {
      offset = chunk.copy(this.partial, this.pendingBytes);
      this.pendingBytes += offset;
      if (this.pendingBytes < this.frameBytes) {
        return frames;
      }
      frames.push(Buffer.from(this.partial));
      this.pendingBytes = 0;
    }

    while (chunk.length - offset >= this.frameBytes) {
      const end = offset + this.frameBytes;
      frames.push(Buffer.from(chunk.subarray(offset, end)));
      offset = end;
    }

    this.pendingBytes = chunk.copy(this.partial, 0, offset);
    return frames;
  }

  /** Yield complete frames from a binary stream and discard the tail on exit. */
  async *read(stream: Readable): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of stream as AsyncIterable<unknown>) {
        if (!Buffer.isBuffer(chunk)) {
          throw new TypeError("Capture stream must emit Buffer chunks");
        }
        yield* this.push(chunk);
      }
    } finally {
      this.reset();
    }
  }
}
