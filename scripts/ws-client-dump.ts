import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { WS_HOST, WS_PATH, WS_PORT } from "../scheduler/src/config.js";
import { PROTOCOL_VERSION, type ClientMessage } from "../scheduler/src/protocol.js";

const { WebSocket } = createRequire(__filename)("../scheduler/node_modules/ws") as
  typeof import("../scheduler/node_modules/@types/ws/index.js");
const STOP_TIMEOUT_MS = 5_000;

function integer(flag: string, value: string, min: number, max: number): number {
  const number = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`--${flag} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: String(WS_PORT) },
      hotwords: { type: "string" },
      background: { type: "string" },
      "start-source": { type: "string" },
      "stop-after-ms": { type: "string" },
    },
  });
  const port = integer("port", values.port, 1, 65_535);
  const source = values["start-source"];
  if (source !== undefined && source !== "system" && source !== "mic") {
    throw new Error("--start-source must be system or mic");
  }
  const duration = values["stop-after-ms"];
  const stopAfter = duration === undefined ? undefined : integer("stop-after-ms", duration, 0, 2_147_483_647);

  const socket = new WebSocket(`ws://${WS_HOST}:${port}${WS_PATH}`, { handshakeTimeout: STOP_TIMEOUT_MS });
  let stopTimer: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let stopping = false;
  let closing = false;
  let waitingForStart = source !== undefined;
  let idle = false;

  function send(message: ClientMessage): void {
    socket.send(JSON.stringify(message));
  }

  function finish(): void {
    if (closing) return;
    closing = true;
    socket.close();
  }

  function sendStop(): void {
    socket.send(JSON.stringify({ type: "session.stop" } satisfies ClientMessage), (error) => {
      if (error) socket.terminate();
      else if (idle && !waitingForStart) finish();
    });
  }

  function stop(): void {
    if (stopping) return;
    stopping = true;
    clearTimeout(stopTimer);
    deadline = setTimeout(() => {
      closing = true;
      socket.terminate();
    }, STOP_TIMEOUT_MS);
    if (socket.readyState === WebSocket.OPEN) sendStop();
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  socket.on("open", () => {
    send({ type: "hello", v: PROTOCOL_VERSION });
    if (values.hotwords !== undefined || values.background !== undefined) {
      send({
        type: "hotwords.set",
        hotwords: (values.hotwords ?? "").split(",").map((word) => word.trim()).filter(Boolean),
        background: values.background ?? "",
      });
    }
    if (source) send({ type: "session.start", source });
    if (stopping) sendStop();
    else if (stopAfter !== undefined) stopTimer = setTimeout(stop, stopAfter);
  });

  socket.on("message", (raw) => {
    const line = raw.toString();
    process.stdout.write(line + "\n");
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("[ws-client] Invalid server JSON");
      socket.terminate();
      return;
    }
    if (typeof message !== "object" || message === null || !("type" in message)
      || message.type !== "state" || !("state" in message)) return;
    idle = message.state === "idle";
    if (!idle) waitingForStart = false;
    if (stopping && idle && !waitingForStart) finish();
  });

  socket.on("error", (error) => {
    if (!closing) console.error(`[ws-client] ${error.message}`);
  });
  socket.on("close", (code) => {
    clearTimeout(stopTimer);
    clearTimeout(deadline);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (!closing) {
      console.error(`[ws-client] Unexpected WebSocket closure (${code})`);
      process.exitCode = 1;
    }
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
