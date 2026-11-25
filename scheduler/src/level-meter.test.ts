import { describe, expect, it } from "vitest";
import { BYTES_PER_SAMPLE, FRAME_BYTES } from "./config.js";
import { measureLevel } from "./level-meter.js";

describe("measureLevel", () => {
  it("returns the dB floor for silence", () => {
    expect(measureLevel(Buffer.alloc(FRAME_BYTES))).toEqual({ rmsDb: -120, peakDb: -120 });
  });

  it("measures a full-scale square wave", () => {
    const pcm = Buffer.alloc(FRAME_BYTES);
    for (let offset = 0; offset < pcm.length; offset += 2 * BYTES_PER_SAMPLE) {
      pcm.writeInt16LE(32_767, offset);
      pcm.writeInt16LE(-32_768, offset + BYTES_PER_SAMPLE);
    }

    const { rmsDb, peakDb } = measureLevel(pcm);
    expect(rmsDb).toBeCloseTo(0, 3);
    expect(peakDb).toBe(0);
  });

  it("measures a half-scale sine wave", () => {
    const sampleCount = 64;
    const pcm = Buffer.alloc(sampleCount * BYTES_PER_SAMPLE);
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = Math.round(16_384 * Math.sin(2 * Math.PI * index / sampleCount));
      pcm.writeInt16LE(sample, index * BYTES_PER_SAMPLE);
    }

    const { rmsDb, peakDb } = measureLevel(pcm);
    expect(rmsDb).toBeCloseTo(-9.03, 2);
    expect(peakDb).toBeCloseTo(-6.02, 2);
  });

  it("returns the dB floor for empty and single-byte buffers", () => {
    expect(measureLevel(Buffer.alloc(0))).toEqual({ rmsDb: -120, peakDb: -120 });
    expect(measureLevel(Buffer.from([0xff]))).toEqual({ rmsDb: -120, peakDb: -120 });
  });

  it("ignores a trailing byte after complete samples", () => {
    const pcm = Buffer.alloc(2 * BYTES_PER_SAMPLE + 1, 0xff);
    pcm.writeInt16LE(-32_768, 0);
    pcm.writeInt16LE(0, BYTES_PER_SAMPLE);

    const { rmsDb, peakDb } = measureLevel(pcm);
    expect(rmsDb).toBeCloseTo(-3.01, 2);
    expect(peakDb).toBe(0);
  });
});
