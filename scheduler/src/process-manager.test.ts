import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedProcess } from "./process-manager.js";

const keepAlive = "setInterval(() => {}, 1_000);";

function currentChild(manager: ManagedProcess): ChildProcess {
  const child = manager.current;
  if (!child?.pid) throw new Error("Expected a running child process");
  return child;
}

function expectExited(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) throw new Error("Expected a child PID");
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

describe("ManagedProcess", () => {
  let manager: ManagedProcess | undefined;

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
  });

  it("warns and restarts with increasing delays, then stops at five restarts", async () => {
    const backoffMs = [30, 60, 120] as const;
    const onWarn = vi.fn(() => performance.now());
    const onFatal = vi.fn();
    const managed = new ManagedProcess(process.execPath, ["-e", keepAlive], { stdio: "ignore" }, {
      backoffMs,
      windowMs: 10_000,
      maxRestartsPerMinute: 5,
      onWarn,
      onFatal,
    });
    manager = managed;
    managed.start();

    for (const [index, backoff] of [...backoffMs, backoffMs[2], backoffMs[2]].entries()) {
      const child = currentChild(managed);
      expect(child.kill("SIGKILL")).toBe(true);

      await vi.waitFor(() => {
        expect(currentChild(managed).pid).not.toBe(child.pid);
      }, { interval: 5 });
      expect(onWarn).toHaveBeenCalledTimes(index + 1);
      expect(onWarn).toHaveBeenLastCalledWith(expect.stringContaining("SIGKILL"));
      const warning = onWarn.mock.results[index];
      if (warning?.type !== "return") throw new Error("Expected a warning timestamp");
      expect(performance.now() - warning.value).toBeGreaterThanOrEqual(backoff - 2);
      expect(onFatal).not.toHaveBeenCalled();
      expectExited(child);
    }

    const last = currentChild(managed);
    expect(last.kill("SIGKILL")).toBe(true);
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining("restart limit"));
    expect(onWarn).toHaveBeenCalledTimes(6);
    await delay(2 * backoffMs[2]);
    expect(managed.current).toBeUndefined();
    expectExited(last);
  });

  it("cancels a pending restart on stop", async () => {
    const backoffMs = 100;
    const managed = new ManagedProcess(process.execPath, ["-e", keepAlive], { stdio: "ignore" }, {
      backoffMs: [backoffMs],
      onWarn: vi.fn(),
    });
    manager = managed;
    managed.start();
    const child = currentChild(managed);
    const closed = once(child, "close");
    expect(child.kill("SIGKILL")).toBe(true);
    await closed;
    await managed.stop();
    await delay(2 * backoffMs);
    expect(managed.current).toBeUndefined();
    expectExited(child);
  });

  it.each([
    { name: "exits on SIGTERM", handler: "process.exit(0)", code: 0, signal: null },
    { name: "escalates to SIGKILL", handler: "", code: null, signal: "SIGKILL" },
  ])("stops and $name without restarting", async ({ handler, code, signal }) => {
    const parentEvents = ["exit", "SIGINT", "SIGTERM"] as const;
    const listenerCounts = parentEvents.map((event) => process.listenerCount(event));
    const onWarn = vi.fn();
    const backoffMs = 30;
    const script = `
      process.on("SIGTERM", () => {
        process.stderr.write("SIGTERM\\n");
        ${handler}
      });
      process.stderr.write("ready\\n");
      ${keepAlive}
    `;
    const managed = new ManagedProcess(process.execPath, ["-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    }, { backoffMs: [backoffMs], onWarn });
    manager = managed;
    managed.start();
    const child = currentChild(managed);
    const stderr = child.stderr;
    if (!stderr) throw new Error("Expected child stderr");
    await once(stderr, "data");

    const terminated = once(stderr, "data");
    const stopped = managed.stop();
    expect(managed.stop()).toBe(stopped);
    await stopped;
    const [message] = await terminated;
    expect(String(message)).toBe("SIGTERM\n");
    expect(child.exitCode).toBe(code);
    expect(child.signalCode).toBe(signal);
    expectExited(child);
    expect(parentEvents.map((event) => process.listenerCount(event))).toEqual(listenerCounts);
    await delay(2 * backoffMs);
    expect(managed.current).toBeUndefined();
    expect(onWarn).not.toHaveBeenCalled();
  }, 10_000);
});
