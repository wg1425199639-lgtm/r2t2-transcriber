import { FRAME_BYTES, TAIL_SILENCE_BYTES } from "../config.js";
import type { AsrAdapter, AsrSession, AsrSessionOptions } from "./adapter.js";

const MOCK_DELTA = "模拟转写";

class MockAsrSession implements AsrSession {
  readonly options: Readonly<AsrSessionOptions>;
  private audioBytes = 0;
  private zeroBytes = 0;
  private emittedDeltas = 0;
  private releaseSlot: (() => void) | undefined;
  private deltaCallback?: (text: string) => void;
  private finalCallback?: (text: string) => void;
  private errorCallback?: (error: Error) => void;

  constructor(options: AsrSessionOptions, releaseSlot: () => void) {
    this.options = { ...options };
    this.releaseSlot = releaseSlot;
  }

  get totalAudioBytes(): number {
    return this.audioBytes;
  }

  get trailingZeroBytes(): number {
    return this.zeroBytes;
  }

  pushAudio(pcm: Buffer): void {
    this.assertOpen();
    this.audioBytes += pcm.length;
    let trailingZeros = 0;
    while (trailingZeros < pcm.length && pcm[pcm.length - 1 - trailingZeros] === 0) {
      trailingZeros++;
    }
    this.zeroBytes = trailingZeros === pcm.length
      ? this.zeroBytes + trailingZeros
      : trailingZeros;

    const deltaCount = Math.floor(this.audioBytes / FRAME_BYTES);
    while (this.releaseSlot && this.emittedDeltas < deltaCount) {
      this.emittedDeltas++;
      this.deltaCallback?.(MOCK_DELTA);
    }
  }

  async finish(): Promise<void> {
    this.assertOpen();
    if (this.zeroBytes < TAIL_SILENCE_BYTES) {
      const error = new Error(
        `Mock ASR requires at least ${TAIL_SILENCE_BYTES} trailing zero bytes, received ${this.zeroBytes}`,
      );
      this.errorCallback?.(error);
      throw error;
    }

    const finalCallback = this.finalCallback;
    const releaseSlot = this.close();
    try {
      finalCallback?.(MOCK_DELTA.repeat(this.emittedDeltas));
    } finally {
      releaseSlot?.();
    }
  }

  abort(): void {
    this.close()?.();
  }

  onDelta(cb: (text: string) => void): void {
    this.assertOpen();
    this.deltaCallback = cb;
  }

  onFinal(cb: (text: string) => void): void {
    this.assertOpen();
    this.finalCallback = cb;
  }

  onError(cb: (error: Error) => void): void {
    this.assertOpen();
    this.errorCallback = cb;
  }

  private assertOpen(): void {
    if (!this.releaseSlot) {
      throw new Error("Mock ASR session is closed");
    }
  }

  private close(): (() => void) | undefined {
    const releaseSlot = this.releaseSlot;
    this.releaseSlot = undefined;
    this.deltaCallback = undefined;
    this.finalCallback = undefined;
    this.errorCallback = undefined;
    return releaseSlot;
  }
}

export class MockAsrAdapter implements AsrAdapter {
  private activeSession?: MockAsrSession;

  async start(): Promise<void> {}

  async openSession(options: AsrSessionOptions): Promise<MockAsrSession> {
    if (this.activeSession) {
      throw new Error("Mock ASR already has an active session");
    }

    const session = new MockAsrSession(options, () => {
      this.activeSession = undefined;
    });
    this.activeSession = session;
    return session;
  }

  async stop(): Promise<void> {
    this.activeSession?.abort();
  }
}
