import {
  FORCE_CUT_AT_MS,
  FRAME_BYTES,
  FRAME_MS,
  IDLE_CLOSE_MS,
  NEAR_CUT_AT_MS,
  NEAR_CUT_SILENCE_MS,
  PREROLL_BYTES,
  PREROLL_MS,
  SOFT_CUT_AT_MS,
  SOFT_CUT_SILENCE_MS,
  TAIL_SILENCE_BYTES,
  VAD_SILENCE_THRESHOLD,
  VAD_SPEECH_ONSET_WINDOWS,
  VAD_SPEECH_THRESHOLD,
  VAD_WINDOW_BYTES,
  VAD_WINDOW_MS,
  WATCHDOG_MS,
} from "../config.js";

export type VadState = "idle" | "speaking" | "pausing" | "rotating";
type RotationReason = "soft" | "force" | "watchdog";
type FinishReason = RotationReason | "pause" | "stop";

export type SegmenterAction =
  | { type: "OPEN"; segmentId: number; preroll: Buffer[] }
  | { type: "PUSH"; segmentId: number; pcm: Buffer }
  | { type: "TAIL_SILENCE"; segmentId: number; pcm: Buffer }
  | { type: "FINISH"; segmentId: number; reason: FinishReason; durMs: number }
  | { type: "WARN"; code: string; msg: string };

export class Segmenter {
  private state: VadState = "idle";
  private nextSegmentId = 1;
  private segmentId: number | undefined;
  private segmentBytes = 0;
  private silenceMs = 0;
  private onsetWindows = 0;
  private readonly prerollCapacity: number;
  private preroll: Buffer[] = [];
  private prerollBytes = 0;

  constructor(prerollMs: number = PREROLL_MS) {
    const maxPrerollMs = PREROLL_MS + FRAME_MS;
    if (!Number.isInteger(prerollMs) || prerollMs < PREROLL_MS || prerollMs > maxPrerollMs) {
      throw new RangeError(`Pre-roll must be a whole number of milliseconds from ${PREROLL_MS} to ${maxPrerollMs}`);
    }
    this.prerollCapacity = prerollMs * (PREROLL_BYTES / PREROLL_MS);
  }

  get vadState(): VadState {
    return this.state;
  }

  get currentSegmentId(): number | undefined {
    return this.segmentId;
  }

  get currentDurationMs(): number {
    return this.segmentBytes * VAD_WINDOW_MS / VAD_WINDOW_BYTES;
  }

  /** Supply one probability per PCM window, in capture order. */
  processFrame(pcm: Buffer, probabilities: readonly number[]): SegmenterAction[] {
    if (pcm.length === 0 || pcm.length !== probabilities.length * VAD_WINDOW_BYTES) {
      throw new RangeError("Expected one VAD probability per complete PCM window");
    }
    for (const probability of probabilities) {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new RangeError("VAD probabilities must be finite and between 0 and 1");
      }
    }

    const actions: SegmenterAction[] = [];
    let pendingStart = 0;
    for (const [index, probability] of probabilities.entries()) {
      const offset = index * VAD_WINDOW_BYTES;
      const end = offset + VAD_WINDOW_BYTES;
      if (this.state === "idle") {
        this.onsetWindows = probability >= VAD_SPEECH_THRESHOLD ? this.onsetWindows + 1 : 0;
        if (this.onsetWindows < VAD_SPEECH_ONSET_WINDOWS) continue;

        const currentFrameStart = Math.max(pendingStart, end - FRAME_BYTES);
        this.remember(pcm.subarray(pendingStart, currentFrameStart));
        pendingStart = currentFrameStart;
        this.open(actions, this.preroll, this.prerollBytes);
        this.preroll = [];
        this.prerollBytes = 0;
        this.segmentBytes += offset - pendingStart;
      }

      // A configurable pre-roll may leave the segment clock between VAD windows.
      if (this.currentDurationMs + VAD_WINDOW_MS > WATCHDOG_MS) {
        this.push(actions, pcm, pendingStart, offset);
        this.rotate(actions, "watchdog");
        pendingStart = offset;
      }

      this.updateSpeech(probability);
      this.segmentBytes += VAD_WINDOW_BYTES;
      const reason = this.cutReason();
      if (reason === undefined) continue;

      this.push(actions, pcm, pendingStart, end);
      pendingStart = end;
      if (reason === "pause") {
        this.finish(actions, reason);
        this.state = "idle";
        this.onsetWindows = 0;
        this.silenceMs = 0;
      } else {
        this.rotate(actions, reason);
      }
    }

    if (this.state === "idle") {
      this.remember(pcm.subarray(pendingStart));
    } else {
      this.push(actions, pcm, pendingStart, pcm.length);
    }
    return actions;
  }

  stop(): SegmenterAction[] {
    const actions: SegmenterAction[] = [];
    if (this.state !== "idle") this.finish(actions, "stop");
    this.state = "idle";
    this.silenceMs = 0;
    this.onsetWindows = 0;
    this.preroll = [];
    this.prerollBytes = 0;
    return actions;
  }

  private remember(pcm: Buffer): void {
    if (pcm.length === 0) return;
    const frame = Buffer.from(pcm.subarray(-this.prerollCapacity));
    this.preroll.push(frame);
    this.prerollBytes += frame.length;
    while (this.prerollBytes > this.prerollCapacity) {
      const oldest = this.preroll.shift();
      if (oldest === undefined) break;
      const discard = Math.min(oldest.length, this.prerollBytes - this.prerollCapacity);
      this.prerollBytes -= discard;
      if (discard < oldest.length) this.preroll.unshift(oldest.subarray(discard));
    }
  }

  private updateSpeech(probability: number): void {
    if (probability < VAD_SILENCE_THRESHOLD) {
      this.state = "pausing";
      this.silenceMs += VAD_WINDOW_MS;
    } else if (probability >= VAD_SPEECH_THRESHOLD) {
      this.state = "speaking";
      this.silenceMs = 0;
    }
  }

  private cutReason(): RotationReason | "pause" | undefined {
    const durationMs = this.currentDurationMs;
    if (durationMs >= WATCHDOG_MS) return "watchdog";
    if (durationMs >= FORCE_CUT_AT_MS) return "force";
    if (this.state === "pausing" && this.silenceMs >= IDLE_CLOSE_MS) return "pause";
    if (
      (durationMs >= SOFT_CUT_AT_MS && this.silenceMs >= SOFT_CUT_SILENCE_MS) ||
      (durationMs >= NEAR_CUT_AT_MS && this.silenceMs >= NEAR_CUT_SILENCE_MS)
    ) return "soft";
    return undefined;
  }

  private open(actions: SegmenterAction[], preroll: Buffer[], prerollBytes: number): void {
    const segmentId = this.nextSegmentId++;
    this.state = "speaking";
    this.segmentId = segmentId;
    this.segmentBytes = prerollBytes;
    actions.push({ type: "OPEN", segmentId, preroll });
  }

  private push(actions: SegmenterAction[], pcm: Buffer, start: number, end: number): void {
    if (start < end && this.segmentId !== undefined) {
      actions.push({ type: "PUSH", segmentId: this.segmentId, pcm: pcm.subarray(start, end) });
    }
  }

  private finish(actions: SegmenterAction[], reason: FinishReason): void {
    const segmentId = this.segmentId;
    if (segmentId === undefined) return;
    actions.push(
      { type: "TAIL_SILENCE", segmentId, pcm: Buffer.alloc(TAIL_SILENCE_BYTES) },
      { type: "FINISH", segmentId, reason, durMs: this.currentDurationMs },
    );
    this.segmentId = undefined;
    this.segmentBytes = 0;
  }

  private rotate(actions: SegmenterAction[], reason: RotationReason): void {
    const previousState = this.state;
    this.state = "rotating";
    this.finish(actions, reason);
    // The consumer must await FINISH before opening the next stream and draining its audio.
    this.open(actions, [], 0);
    this.state = previousState;
    if (reason === "watchdog") {
      actions.push({ type: "WARN", code: "SEGMENT_WATCHDOG", msg: "Segment reached the watchdog limit" });
    }
  }
}
