import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_RATE = 16_000;
export const CHANNELS = 1;
export const SAMPLE_FORMAT = "s16le";
export const BYTES_PER_SAMPLE = 2;

export const FRAME_MS = 320;
export const SHORT_FRAME_MS = 160;
export const VAD_WINDOW_SAMPLES = 512;
export const TAIL_SILENCE_MS = 300;
export const PREROLL_MS = 320;

function samplesForMs(ms: number): number {
  return SAMPLE_RATE * ms / 1000;
}

const BYTES_PER_SAMPLE_FRAME = CHANNELS * BYTES_PER_SAMPLE;

export const FRAME_SAMPLES = samplesForMs(FRAME_MS);
export const SHORT_FRAME_SAMPLES = samplesForMs(SHORT_FRAME_MS);
export const FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE_FRAME;
export const SHORT_FRAME_BYTES = SHORT_FRAME_SAMPLES * BYTES_PER_SAMPLE_FRAME;
export const VAD_WINDOW_BYTES = VAD_WINDOW_SAMPLES * BYTES_PER_SAMPLE_FRAME;
export const VAD_WINDOW_MS = VAD_WINDOW_SAMPLES * 1000 / SAMPLE_RATE;
export const VAD_WINDOWS_PER_FRAME = FRAME_SAMPLES / VAD_WINDOW_SAMPLES;
export const VAD_WINDOWS_PER_SHORT_FRAME = SHORT_FRAME_SAMPLES / VAD_WINDOW_SAMPLES;
export const TAIL_SILENCE_SAMPLES = samplesForMs(TAIL_SILENCE_MS);
export const TAIL_SILENCE_BYTES = TAIL_SILENCE_SAMPLES * BYTES_PER_SAMPLE_FRAME;
export const PREROLL_BYTES = samplesForMs(PREROLL_MS) * BYTES_PER_SAMPLE_FRAME;

export const SOFT_CUT_AT_MS = 60_000;
export const SOFT_CUT_SILENCE_MS = 500;
export const NEAR_CUT_AT_MS = 75_000;
export const NEAR_CUT_SILENCE_MS = 200;
export const FORCE_CUT_AT_MS = 90_000;
export const WATCHDOG_MS = 100_000;
export const ENGINE_HARD_LIMIT_MS = 110_000;
export const IDLE_CLOSE_MS = 1500;
export const VAD_SPEECH_THRESHOLD = 0.5;
export const VAD_SILENCE_THRESHOLD = 0.35;
export const VAD_SPEECH_ONSET_WINDOWS = 2;
export const MAX_PROMPT_CHARS = 250;

export const WS_HOST = "127.0.0.1";
export const WS_PORT = 47800;
export const WS_PATH = "/ws";
export const ASR_HOST = "127.0.0.1";
export const ASR_PORT = 19488;

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const isWindows = process.platform === "win32";

export const CAPTURE_PATH = resolve(process.env.CAPTURE_PATH || resolve(
  PROJECT_ROOT,
  isWindows ? "capture/win/capture-win.exe" : "capture/mac/.build/release/capture-mac",
));
export const ASR_SERVER_PATH = resolve(process.env.ASR_SERVER_PATH || resolve(
  PROJECT_ROOT,
  isWindows
    ? "third_party/audio.cpp/build/bin/audiocpp_server.exe"
    : "third_party/audio.cpp/build/macos-metal-release/bin/audiocpp_server",
));
export const VAD_MODEL_PATH = resolve(
  process.env.VAD_MODEL_PATH || resolve(PROJECT_ROOT, "models/silero_vad.onnx"),
);
export const ASR_MODEL_PATH = resolve(
  process.env.ASR_MODEL_PATH ||
    resolve(PROJECT_ROOT, "models/Confucius4-R2T2-GGUF/r2t2-q8_0.gguf"),
);
export const DATA_DIR = resolve(process.env.DATA_DIR || resolve(PROJECT_ROOT, "data"));
