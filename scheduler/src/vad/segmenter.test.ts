import { describe, expect, it, vi } from "vitest";
import * as config from "../config.js";
import { Segmenter, type SegmenterAction } from "./segmenter.js";

const {
  FORCE_CUT_AT_MS, FRAME_MS, IDLE_CLOSE_MS, NEAR_CUT_AT_MS, NEAR_CUT_SILENCE_MS, PREROLL_BYTES,
  PREROLL_MS, SHORT_FRAME_MS, SOFT_CUT_AT_MS, SOFT_CUT_SILENCE_MS, TAIL_SILENCE_BYTES,
  VAD_SILENCE_THRESHOLD, VAD_SPEECH_THRESHOLD, VAD_WINDOW_BYTES, VAD_WINDOW_MS, WATCHDOG_MS,
} = config;

const speech = VAD_SPEECH_THRESHOLD;
const silence = 0;
const uncertain = VAD_SILENCE_THRESHOLD;
const zeroTail = Buffer.alloc(TAIL_SILENCE_BYTES);

function audio(ms: number, value = 1): Buffer {
  return Buffer.alloc(ms / VAD_WINDOW_MS * VAD_WINDOW_BYTES, value);
}

function feed(segmenter: Segmenter, ms: number, prob: number, value = 1): SegmenterAction[] {
  return segmenter.processFrame(audio(ms, value), Array<number>(ms / VAD_WINDOW_MS).fill(prob));
}

function windowAligned(ms: number): number {
  return Math.ceil(ms / VAD_WINDOW_MS) * VAD_WINDOW_MS;
}

function expectClose(
  actions: SegmenterAction[],
  segmentId: number,
  reason: "pause" | "soft" | "force" | "watchdog" | "stop",
  durMs: number,
): void {
  const finishIndex = actions.findIndex((action) => action.type === "FINISH");
  expect(actions[finishIndex - 1]).toEqual({ type: "TAIL_SILENCE", segmentId, pcm: zeroTail });
  expect(actions[finishIndex]).toEqual({ type: "FINISH", segmentId, reason, durMs });
  if (reason === "soft" || reason === "force" || reason === "watchdog") {
    expect(actions[finishIndex + 1]).toEqual({ type: "OPEN", segmentId: segmentId + 1, preroll: [] });
  }
}

describe("Segmenter", () => {
  it("stays idle through isolated speech windows and opens with recent audio after two consecutive windows", () => {
    const segmenter = new Segmenter();
    expect(feed(segmenter, FRAME_MS, silence)).toEqual([]);
    expect(feed(segmenter, VAD_WINDOW_MS, speech)).toEqual([]);
    expect(feed(segmenter, VAD_WINDOW_MS, uncertain)).toEqual([]);
    expect(feed(segmenter, VAD_WINDOW_MS, speech)).toEqual([]);
    expect(feed(segmenter, FRAME_MS, silence, 2)).toEqual([]);
    expect(segmenter.vadState).toBe("idle");

    const current = audio(FRAME_MS, 3);
    expect(segmenter.processFrame(current, Array<number>(FRAME_MS / VAD_WINDOW_MS).fill(speech))).toEqual([
      { type: "OPEN", segmentId: 1, preroll: [audio(PREROLL_MS, 2)] },
      { type: "PUSH", segmentId: 1, pcm: current },
    ]);
    expect(segmenter.vadState).toBe("speaking");
    expect(segmenter.currentSegmentId).toBe(1);
    expect(segmenter.currentDurationMs).toBe(PREROLL_MS + FRAME_MS);
  });

  it("keeps onset across short frames and limits configured pre-roll to the latest audio", () => {
    const prerollMs = PREROLL_MS + FRAME_MS;
    const segmenter = new Segmenter(prerollMs);
    expect(feed(segmenter, FRAME_MS, silence, 1)).toEqual([]);
    expect(feed(segmenter, FRAME_MS, silence, 2)).toEqual([]);
    const lastIdle = audio(SHORT_FRAME_MS, 3);
    const probabilities = Array<number>(SHORT_FRAME_MS / VAD_WINDOW_MS).fill(silence);
    probabilities[probabilities.length - 1] = speech;
    expect(segmenter.processFrame(lastIdle, probabilities)).toEqual([]);

    expect(feed(segmenter, SHORT_FRAME_MS, speech, 4)).toEqual([
      { type: "OPEN", segmentId: 1, preroll: [audio(FRAME_MS - SHORT_FRAME_MS), audio(FRAME_MS, 2), lastIdle] },
      { type: "PUSH", segmentId: 1, pcm: audio(SHORT_FRAME_MS, 4) },
    ]);
    expect(segmenter.currentDurationMs).toBe(prerollMs + SHORT_FRAME_MS);
  });

  it("limits the idle prefix when a batch contains several frames before onset", () => {
    const segmenter = new Segmenter();
    const idleMs = PREROLL_MS + FRAME_MS + FRAME_MS;
    const onsetMs = config.VAD_SPEECH_ONSET_WINDOWS * VAD_WINDOW_MS;
    const frame = Buffer.concat([audio(idleMs, 2), audio(onsetMs, 3)]);
    const probabilities = [
      ...Array<number>(idleMs / VAD_WINDOW_MS).fill(silence),
      ...Array<number>(onsetMs / VAD_WINDOW_MS).fill(speech),
    ];
    expect(segmenter.processFrame(frame, probabilities)).toEqual([
      { type: "OPEN", segmentId: 1, preroll: [audio(PREROLL_MS, 2)] },
      { type: "PUSH", segmentId: 1, pcm: frame.subarray(-config.FRAME_BYTES) },
    ]);
    expect(segmenter.currentDurationMs).toBe(PREROLL_MS + FRAME_MS);
  });

  it("closes at the first qualifying silence window and returns to idle", () => {
    const segmenter = new Segmenter();
    const closeAt = windowAligned(IDLE_CLOSE_MS);
    feed(segmenter, FRAME_MS, speech);
    feed(segmenter, closeAt - VAD_WINDOW_MS, silence);
    expect(segmenter.vadState).toBe("pausing");
    const actions = feed(segmenter, FRAME_MS, silence);
    expectClose(actions, 1, "pause", FRAME_MS + closeAt);
    expect(actions.map(({ type }) => type)).toEqual(["PUSH", "TAIL_SILENCE", "FINISH"]);
    expect(actions[0]).toEqual({ type: "PUSH", segmentId: 1, pcm: audio(VAD_WINDOW_MS) });
    expect(segmenter.vadState).toBe("idle");
    expect(segmenter.currentSegmentId).toBeUndefined();
    expect(segmenter.currentDurationMs).toBe(0);
    expect(feed(segmenter, FRAME_MS, silence)).toEqual([]);
  });

  it("retains PAUSING in the hysteresis band and resets the silence clock when speech resumes", () => {
    const segmenter = new Segmenter();
    const belowClose = windowAligned(IDLE_CLOSE_MS) - VAD_WINDOW_MS;
    feed(segmenter, FRAME_MS, speech);
    feed(segmenter, belowClose, silence);
    expect(feed(segmenter, FRAME_MS, uncertain).map(({ type }) => type)).toEqual(["PUSH"]);
    expect(segmenter.vadState).toBe("pausing");
    feed(segmenter, VAD_WINDOW_MS, speech);
    expect(segmenter.vadState).toBe("speaking");
    expect(feed(segmenter, belowClose, silence).map(({ type }) => type)).toEqual(["PUSH"]);
  });

  it.each([
    [SOFT_CUT_AT_MS, SOFT_CUT_SILENCE_MS],
    [NEAR_CUT_AT_MS, NEAR_CUT_SILENCE_MS],
  ])("rotates at the %ims soft cut after %ims of silence", (cutAt, silenceAt) => {
    const segmenter = new Segmenter();
    const cutWindow = windowAligned(cutAt);
    const silentWindowsMs = windowAligned(silenceAt);
    feed(segmenter, cutWindow - silentWindowsMs, speech);
    expect(feed(segmenter, silentWindowsMs - VAD_WINDOW_MS, silence).map(({ type }) => type)).toEqual(["PUSH"]);
    const actions = feed(segmenter, VAD_WINDOW_MS, silence);
    expectClose(actions, 1, "soft", cutWindow);
    expect(segmenter.vadState).toBe("pausing");
    expect(segmenter.currentSegmentId).toBe(2);
    expect(segmenter.currentDurationMs).toBe(0);

    const remainingSilence = windowAligned(IDLE_CLOSE_MS) - silentWindowsMs;
    expectClose(feed(segmenter, remainingSilence, silence), 2, "pause", remainingSilence);
  });

  it("forces a cut during continuous speech and routes a straddling frame once in capture order", () => {
    const segmenter = new Segmenter();
    const cutWindow = windowAligned(FORCE_CUT_AT_MS);
    feed(segmenter, cutWindow - VAD_WINDOW_MS, speech);
    const frame = Buffer.concat([audio(VAD_WINDOW_MS, 2), audio(FRAME_MS - VAD_WINDOW_MS, 3)]);
    const actions = segmenter.processFrame(frame, Array<number>(FRAME_MS / VAD_WINDOW_MS).fill(speech));
    expectClose(actions, 1, "force", cutWindow);
    expect(actions.map(({ type }) => type)).toEqual(["PUSH", "TAIL_SILENCE", "FINISH", "OPEN", "PUSH"]);
    expect(actions[0]).toEqual({ type: "PUSH", segmentId: 1, pcm: audio(VAD_WINDOW_MS, 2) });
    expect(actions.at(-1)).toEqual({ type: "PUSH", segmentId: 2, pcm: audio(FRAME_MS - VAD_WINDOW_MS, 3) });
    expect(segmenter.vadState).toBe("speaking");
    expect(segmenter.currentSegmentId).toBe(2);
    expect(segmenter.currentDurationMs).toBe(FRAME_MS - VAD_WINDOW_MS);
  });

  it("warns and caps duration at the watchdog if the earlier force cut is bypassed", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({ ...config, FORCE_CUT_AT_MS: WATCHDOG_MS + FRAME_MS }));
    try {
      const { Segmenter: WatchdogSegmenter } = await import("./segmenter.js");
      const segmenter = new WatchdogSegmenter();
      feed(segmenter, WATCHDOG_MS - VAD_WINDOW_MS, speech);
      const actions = feed(segmenter, VAD_WINDOW_MS, speech);
      expectClose(actions, 1, "watchdog", WATCHDOG_MS);
      expect(actions.at(-1)).toMatchObject({ type: "WARN", code: "SEGMENT_WATCHDOG" });
      expect(segmenter.vadState).toBe("speaking");
      expect(segmenter.currentDurationMs).toBe(0);

      const offsetMs = 1;
      const unaligned = new WatchdogSegmenter(PREROLL_MS + offsetMs);
      feed(unaligned, PREROLL_MS + FRAME_MS, silence);
      feed(unaligned, WATCHDOG_MS - PREROLL_MS - VAD_WINDOW_MS, speech);
      const unalignedActions = feed(unaligned, VAD_WINDOW_MS, speech);
      expectClose(unalignedActions, 1, "watchdog", WATCHDOG_MS - VAD_WINDOW_MS + offsetMs);
      expect(unalignedActions.at(-1)).toEqual({ type: "PUSH", segmentId: 2, pcm: audio(VAD_WINDOW_MS) });
    } finally {
      vi.doUnmock("../config.js");
      vi.resetModules();
    }
  });

  it.each([speech, silence])("flushes on stop when active at probability %s", (prob) => {
    const segmenter = new Segmenter();
    expect(segmenter.stop()).toEqual([]);
    feed(segmenter, FRAME_MS, speech);
    feed(segmenter, FRAME_MS, prob);
    const actions = segmenter.stop();
    expect(actions.map(({ type }) => type)).toEqual(["TAIL_SILENCE", "FINISH"]);
    expectClose(actions, 1, "stop", FRAME_MS + FRAME_MS);
    expect(segmenter.vadState).toBe("idle");
    expect(segmenter.currentSegmentId).toBeUndefined();
    expect(segmenter.currentDurationMs).toBe(0);
    expect(segmenter.stop()).toEqual([]);
  });

  it("clears idle pre-roll and partial onset on stop", () => {
    const segmenter = new Segmenter();
    feed(segmenter, FRAME_MS, silence);
    feed(segmenter, VAD_WINDOW_MS, speech);
    expect(segmenter.stop()).toEqual([]);
    expect(feed(segmenter, VAD_WINDOW_MS, speech)).toEqual([]);
  });

  it("keeps sessions and retained pre-roll bounded over three hours of synthetic input", () => {
    const segmenter = new Segmenter();
    const totalMs = 10_800_000;
    const pcm = audio(FRAME_MS);
    const speaking = Array<number>(FRAME_MS / VAD_WINDOW_MS).fill(speech);
    const silent = speaking.map(() => silence);
    const idleStretch = windowAligned(IDLE_CLOSE_MS) + PREROLL_MS + FRAME_MS;
    const cycleMs = FORCE_CUT_AT_MS + idleStretch + FRAME_MS;
    let activeId: number | undefined;
    let lastOpened = 0;
    let bytes = 0;
    let finishes = 0;

    function consume(actions: SegmenterAction[]): void {
      for (const [index, action] of actions.entries()) {
        switch (action.type) {
          case "OPEN":
            expect(activeId).toBeUndefined();
            expect(action.segmentId).toBe(lastOpened + 1);
            lastOpened = action.segmentId;
            activeId = action.segmentId;
            bytes = action.preroll.reduce((size, frame) => size + frame.length, 0);
            expect(bytes).toBeLessThanOrEqual(PREROLL_BYTES);
            break;
          case "PUSH":
            if (action.segmentId !== activeId) throw new Error("Audio crossed segment ownership");
            bytes += action.pcm.length;
            break;
          case "FINISH":
            expect(action.segmentId).toBe(activeId);
            expect(actions[index - 1]).toEqual({ type: "TAIL_SILENCE", segmentId: activeId, pcm: zeroTail });
            expect(action.durMs).toBe(bytes * VAD_WINDOW_MS / VAD_WINDOW_BYTES);
            expect(action.durMs).toBeLessThanOrEqual(WATCHDOG_MS);
            activeId = undefined;
            finishes++;
            break;
          case "WARN":
            throw new Error(`Unexpected watchdog warning: ${action.msg}`);
        }
      }
    }

    for (let elapsed = 0; elapsed < totalMs; elapsed += FRAME_MS) {
      const idle = elapsed % cycleMs >= FORCE_CUT_AT_MS;
      consume(segmenter.processFrame(pcm, idle ? silent : speaking));
      if (idle) {
        const retained = segmenter["preroll"].reduce((size, frame) => size + frame.length, 0);
        expect(retained).toBeLessThanOrEqual(PREROLL_BYTES);
      }
    }
    consume(segmenter.stop());
    expect(finishes).toBeGreaterThanOrEqual(Math.floor(totalMs / cycleMs));
    expect(finishes).toBe(lastOpened);
    expect(activeId).toBeUndefined();
    expect(segmenter["preroll"]).toEqual([]);
    expect(segmenter.vadState).toBe("idle");
  });
});
