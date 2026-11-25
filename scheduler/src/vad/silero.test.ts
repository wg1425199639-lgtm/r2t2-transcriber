import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FRAME_BYTES,
  FRAME_MS,
  SHORT_FRAME_BYTES,
  VAD_SPEECH_THRESHOLD,
  VAD_WINDOWS_PER_FRAME,
  VAD_WINDOWS_PER_SHORT_FRAME,
} from "../config.js";
import { SileroVad } from "./silero.js";

const SILENCE_LIMIT = 0.2;
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);

function wavPcm(wav: Buffer): Buffer {
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) break;
    if (wav.toString("ascii", offset, offset + 4) === "data") {
      return wav.subarray(start, end);
    }
    offset = end + size % 2;
  }
  throw new Error("news01.wav has no complete PCM data chunk");
}

async function speechProbabilities(vad: SileroVad): Promise<number[]> {
  const wav = await readFile(new URL("../../../fixtures/news01.wav", import.meta.url));
  const pcm = wavPcm(wav);
  const frameCount = Math.floor(5000 / FRAME_MS);
  const probabilities: number[] = [];
  for (let index = 0; index < frameCount; index++) {
    const offset = index * FRAME_BYTES;
    probabilities.push(...await vad.processFrame(pcm.subarray(offset, offset + FRAME_BYTES)));
  }
  expect(probabilities).toHaveLength(frameCount * VAD_WINDOWS_PER_FRAME);
  return probabilities;
}

function mean(probabilities: number[]): number {
  return probabilities.reduce((sum, probability) => sum + probability, 0) / probabilities.length;
}

describe("SileroVad with the local ONNX model", () => {
  let vad: SileroVad;

  beforeEach(async () => {
    vad = await SileroVad.create();
  });

  afterEach(async () => {
    await vad?.dispose();
  });

  it("keeps every window below 0.2 across consecutive silent frames", async () => {
    for (let i = 0; i < 3; i++) {
      const probabilities = await vad.processFrame(SILENCE_FRAME);
      expect(probabilities).toHaveLength(VAD_WINDOWS_PER_FRAME);
      expect(Math.max(...probabilities)).toBeLessThan(SILENCE_LIMIT);
    }
    const shortFrame = await vad.processFrame(Buffer.alloc(SHORT_FRAME_BYTES));
    expect(shortFrame).toHaveLength(VAD_WINDOWS_PER_SHORT_FRAME);
    expect(Math.max(...shortFrame)).toBeLessThan(SILENCE_LIMIT);
  });

  it("detects sustained speech in the news fixture", async () => {
    const silence = await vad.processFrame(SILENCE_FRAME);
    vad.reset();
    const speech = await speechProbabilities(vad);
    const speechFraction = speech.filter(prob => prob >= VAD_SPEECH_THRESHOLD).length / speech.length;

    expect(Math.max(...speech)).toBeGreaterThan(0.8);
    expect(mean(speech)).toBeGreaterThan(mean(silence) + 0.3);
    expect(speechFraction).toBeGreaterThan(0.5);
  });

  it("restores the fresh silence response after resetting speech history", async () => {
    const freshSilence = await vad.processFrame(SILENCE_FRAME);
    await speechProbabilities(vad);
    vad.reset();
    const resetSilence = await vad.processFrame(SILENCE_FRAME);
    expect(Math.max(...resetSilence)).toBeLessThan(SILENCE_LIMIT);
    expect(resetSilence).toEqual(freshSilence);
  });
});
