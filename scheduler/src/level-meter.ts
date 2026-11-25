import { BYTES_PER_SAMPLE } from "./config.js";

const FULL_SCALE = 32_768;
const MIN_DB = -120;

function toDb(amplitude: number): number {
  return Math.max(MIN_DB, 20 * Math.log10(amplitude));
}

export function measureLevel(pcm: Buffer): { rmsDb: number; peakDb: number } {
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (sampleCount === 0) {
    return { rmsDb: MIN_DB, peakDb: MIN_DB };
  }

  const completeBytes = sampleCount * BYTES_PER_SAMPLE;
  let sumSquares = 0;
  let peak = 0;
  for (let offset = 0; offset < completeBytes; offset += BYTES_PER_SAMPLE) {
    const amplitude = Math.abs(pcm.readInt16LE(offset)) / FULL_SCALE;
    sumSquares += amplitude * amplitude;
    peak = Math.max(peak, amplitude);
  }

  return { rmsDb: toDb(Math.sqrt(sumSquares / sampleCount)), peakDb: toDb(peak) };
}
