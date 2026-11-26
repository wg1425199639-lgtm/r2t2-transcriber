import { once } from "node:events";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SchedulerWsServer } from "./ws-server.js";

const pcm = Buffer.from(Array.from({ length: 80 }, (_, index) => index));
const index = {
  sessionId: "current",
  audioStartedAtMs: 123,
  segments: [{ segmentId: 1, startedAtMs: 456, offsetSec: 0.32, durMs: 640 }],
};

describe("scheduler audio and caption HTTP", () => {
  let directory: string;
  let server: SchedulerWsServer;
  let origin: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "scheduler-audio-"));
    server = new SchedulerWsServer((ws, message) => {
      if (message.type === "hello") {
        server.send(ws, { type: "hello.ok", v: 1, engine: { name: "mock", quant: "Q8_0" }, state: "idle" });
      }
    }, 0, directory);
    await server.start();
    expect(server.boundPort).toBeGreaterThan(0);
    origin = `http://127.0.0.1:${server.boundPort}`;
  });

  afterEach(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  function request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(origin + path, init);
  }

  it("returns 404 with CORS when no PCM exists and handles preflight", async () => {
    for (const ext of ["wav", "json"]) {
      const response = await request(`/audio/latest.${ext}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
    const response = await request("/audio/latest.wav", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("Range");
    expect(response.headers.get("access-control-expose-headers")).toBe("Accept-Ranges, Content-Range, Content-Length");
  });

  it("serves aligned snapshots and byte ranges over the virtual WAV", async () => {
    const path = join(directory, "current.pcm");
    await writeFile(path, Buffer.concat([pcm, Buffer.from([0xfe])]));
    const response = await request("/audio/latest.wav");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const wav = Buffer.from(await response.arrayBuffer());
    expect(wav.length).toBe(44 + pcm.length);
    expect(response.headers.get("content-length")).toBe(String(wav.length));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);

    const last = wav.length - 1;
    for (const [range, start, end] of [
      ["0-43", 0, 43], ["20-59", 20, 59], ["44-83", 44, 83], ["44-", 44, last], ["-64", wav.length - 64, last],
    ] as const) {
      const result = await request("/audio/latest.wav", { headers: { Range: `bytes=${range}` } });
      expect(result.status).toBe(206);
      expect(result.headers.get("content-range")).toBe(`bytes ${start}-${end}/${wav.length}`);
      expect(result.headers.get("content-length")).toBe(String(end - start + 1));
      expect(Buffer.from(await result.arrayBuffer())).toEqual(wav.subarray(start, end + 1));
    }
    for (const range of [`bytes=${wav.length}-`, "bytes=0-1,4-8", "bytes=43-20", "bytes=-0"]) {
      const result = await request("/audio/latest.wav", { headers: { Range: range } });
      expect(result.status).toBe(416);
      expect(result.headers.get("content-range")).toBe(`bytes */${wav.length}`);
    }
    const head = await request("/audio/latest.wav", { method: "HEAD", headers: { Range: "bytes=20-59" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("40");
    expect(await head.text()).toBe("");

    await appendFile(path, Buffer.from([0xff]));
    const grown = Buffer.from(await (await request("/audio/latest.wav")).arrayBuffer());
    expect(grown.subarray(44)).toEqual(Buffer.concat([pcm, Buffer.from([0xfe, 0xff])]));
  });

  it("selects the latest PCM by mtime and serves its index or an explicit session", async () => {
    const old = join(directory, "old.pcm");
    await writeFile(old, Buffer.alloc(2));
    await utimes(old, 1, 1);
    await writeFile(join(directory, "current.pcm"), pcm);
    await writeFile(join(directory, "current.audio.json"), JSON.stringify(index));

    const response = await request("/audio/latest.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual(index);
    const older = await request("/audio/latest.json?sessionId=old");
    expect(await older.json()).toEqual({ sessionId: "old", audioStartedAtMs: 0, segments: [] });
    const wave = await request("/audio/latest.wav?sessionId=old");
    expect((await wave.arrayBuffer()).byteLength).toBe(46);
    expect((await request("/audio/latest.wav?sessionId=missing")).status).toBe(404);
    expect((await request("/audio/latest.json?sessionId=..%2Fold")).status).toBe(400);
  });

  it("serves transparent offline caption HTML and validates WS messages on the same port", async () => {
    const response = await request("/caption");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain("background: transparent");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("hotwords.get");

    const wrongPath = new WebSocket(`ws://127.0.0.1:${server.boundPort}/caption`);
    await expect(once(wrongPath, "open")).rejects.toThrow();
    const ws = new WebSocket(`ws://127.0.0.1:${server.boundPort}/ws`);
    try {
      await once(ws, "open");
      const invalid = once(ws, "message");
      ws.send("{");
      expect(JSON.parse((await invalid)[0].toString())).toMatchObject({ code: "INVALID_MESSAGE" });
      const valid = once(ws, "message");
      ws.send(JSON.stringify({ type: "hello", v: 1 }));
      expect(JSON.parse((await valid)[0].toString())).toMatchObject({ type: "hello.ok", v: 1 });
    } finally {
      ws.close();
    }
  });
});
