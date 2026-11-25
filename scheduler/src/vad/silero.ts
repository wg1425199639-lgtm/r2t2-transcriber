import { InferenceSession, Tensor } from "onnxruntime-node";
import {
  BYTES_PER_SAMPLE,
  FRAME_BYTES,
  SAMPLE_RATE,
  SHORT_FRAME_BYTES,
  VAD_MODEL_PATH,
  VAD_WINDOW_BYTES,
  VAD_WINDOW_SAMPLES,
} from "../config.js";

const CONTEXT_SAMPLES = 64;
const INPUT_SAMPLES = CONTEXT_SAMPLES + VAD_WINDOW_SAMPLES;
const STATE_SHAPE = [2, 1, 128] as const;
const PCM_SCALE = 32768;

export class SileroVad {
  private readonly audio = new Float32Array(INPUT_SAMPLES);
  private readonly state = new Float32Array(STATE_SHAPE[0] * STATE_SHAPE[1] * STATE_SHAPE[2]);
  private readonly nextState = new Float32Array(this.state.length);
  private readonly probability = new Float32Array(1);
  private readonly feeds = {
    input: new Tensor("float32", this.audio, [1, INPUT_SAMPLES]),
    state: new Tensor("float32", this.state, STATE_SHAPE),
    sr: new Tensor("int64", BigInt64Array.of(BigInt(SAMPLE_RATE)), []),
  };
  private readonly outputs = {
    output: new Tensor("float32", this.probability, [1, 1]),
    stateN: new Tensor("float32", this.nextState, STATE_SHAPE),
  };
  private active?: Promise<unknown>;
  private resetPending = false;
  private disposal?: Promise<void>;

  private constructor(private readonly session: InferenceSession) {}

  static async create(modelPath = VAD_MODEL_PATH): Promise<SileroVad> {
    const session = await InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      executionMode: "sequential",
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
    return new SileroVad(session);
  }

  async processWindow(pcmWindow: Buffer): Promise<number> {
    if (pcmWindow.length !== VAD_WINDOW_BYTES) {
      throw new RangeError(`Expected a ${VAD_WINDOW_BYTES}-byte VAD window`);
    }
    return this.process(() => this.infer(pcmWindow, 0));
  }

  async processFrame(pcmFrame: Buffer): Promise<number[]> {
    if (pcmFrame.length !== FRAME_BYTES && pcmFrame.length !== SHORT_FRAME_BYTES) {
      throw new RangeError(`Expected a ${FRAME_BYTES}- or ${SHORT_FRAME_BYTES}-byte VAD frame`);
    }
    return this.process(async () => {
      const probabilities: number[] = [];
      for (let offset = 0; offset < pcmFrame.length; offset += VAD_WINDOW_BYTES) {
        probabilities.push(await this.infer(pcmFrame, offset));
      }
      return probabilities;
    });
  }

  reset(): void {
    if (this.active) {
      this.resetPending = true;
    } else {
      this.clearHistory();
    }
  }

  async dispose(): Promise<void> {
    this.disposal ??= this.releaseSession();
    return this.disposal;
  }

  private async releaseSession(): Promise<void> {
    await this.active?.catch(() => {
      // The inference caller receives the error independently of disposal.
    });
    await this.session.release();
  }

  private async process<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposal) throw new Error("Silero VAD is disposed");
    if (this.active) throw new Error("Silero VAD already has an inference in progress");

    const active = operation();
    this.active = active;
    try {
      return await active;
    } finally {
      this.active = undefined;
      if (this.resetPending) {
        this.clearHistory();
        this.resetPending = false;
      }
    }
  }

  private clearHistory(): void {
    this.audio.fill(0, 0, CONTEXT_SAMPLES);
    this.state.fill(0);
  }

  private async infer(pcm: Buffer, offset: number): Promise<number> {
    for (let i = 0; i < VAD_WINDOW_SAMPLES; i++) {
      this.audio[CONTEXT_SAMPLES + i] = pcm.readInt16LE(offset + i * BYTES_PER_SAMPLE) / PCM_SCALE;
    }

    await this.session.run(this.feeds, this.outputs);
    const [probability] = this.probability;
    if (probability === undefined || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error("Silero VAD returned an invalid probability");
    }
    this.state.set(this.nextState);
    this.audio.copyWithin(0, INPUT_SAMPLES - CONTEXT_SAMPLES);
    return probability;
  }
}
