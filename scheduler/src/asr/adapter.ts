export interface AsrSessionOptions {
  language: "Chinese";
  chunkMs: 160 | 320;
  context: string;
}

export interface AsrSession {
  pushAudio(pcm: Buffer): void;
  finish(): Promise<void>;
  abort(): void;
  onDelta(cb: (text: string) => void): void;
  onFinal(cb: (text: string) => void): void;
  onError(cb: (e: Error) => void): void;
}

export interface AsrAdapter {
  start(): Promise<void>;
  openSession(options: AsrSessionOptions): Promise<AsrSession>;
  stop(): Promise<void>;
}
