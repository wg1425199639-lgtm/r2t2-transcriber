import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { performance } from "node:perf_hooks";

const STOP_GRACE_MS = 3_000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export class ManagedProcess {
  private child?: ChildProcess;
  private restartTimer?: NodeJS.Timeout;
  private stopPromise?: Promise<void>;
  private enabled = false;
  private restartTimes: number[] = [];

  constructor(
    private readonly command: string,
    private readonly args: readonly string[] = [],
    private readonly options: SpawnOptions = {},
  ) {}

  get current(): ChildProcess | undefined {
    return this.child;
  }

  start(): void {
    if (this.enabled || this.stopPromise) return;
    this.enabled = true;
    this.restartTimes = [];
    process.on("exit", this.onParentExit);
    process.on("SIGINT", this.onInterrupt);
    process.on("SIGTERM", this.onTerminate);
    try {
      this.spawnChild();
    } catch (error) {
      this.disable();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.enabled = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;

    const child = this.child;
    if (!child) {
      this.disable();
      return Promise.resolve();
    }

    this.stopPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        this.disable();
        resolve();
      });
      child.kill("SIGTERM");
    }).finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  private spawnChild(): void {
    const child = spawn(this.command, this.args, this.options);
    this.child = child;
    const onError = (error: Error): void => {
      console.error(`[process] ${this.command}: ${error.message}`);
    };
    child.on("error", onError);
    child.once("close", (code, signal) => {
      child.off("error", onError);
      this.child = undefined;
      if (!this.enabled) return;
      if (code === 0) {
        this.disable();
        return;
      }
      console.error(`[process] ${this.command} exited (${signal ?? code})`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    const now = performance.now();
    this.restartTimes = this.restartTimes.filter((time) => now - time < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS) {
      console.error(`[process] ${this.command} reached its restart limit`);
      this.disable();
      return;
    }

    const delay = RESTART_DELAYS_MS[this.restartTimes.length] ?? RESTART_DELAYS_MS[2];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.restartTimes.push(performance.now());
      this.spawnChild();
    }, delay);
  }

  private disable(): void {
    this.enabled = false;
    process.off("exit", this.onParentExit);
    process.off("SIGINT", this.onInterrupt);
    process.off("SIGTERM", this.onTerminate);
  }

  private readonly onParentExit = (): void => {
    this.child?.kill("SIGKILL");
  };

  private readonly onInterrupt = (): void => {
    process.exitCode = 130;
    void this.stop();
  };

  private readonly onTerminate = (): void => {
    process.exitCode = 143;
    void this.stop();
  };
}
