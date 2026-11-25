import { z } from "zod";
import { FRAME_MS, SHORT_FRAME_MS } from "./config.js";

export const PROTOCOL_VERSION = 1;

const version = z.literal(PROTOCOL_VERSION);
const sessionState = z.enum(["idle", "starting", "running", "stopping", "error"]);
const vadState = z.enum(["idle", "speaking", "pausing", "rotating"]);
const nonNegativeInteger = z.number().int().nonnegative();
const timestamp = z.number().finite().nonnegative();
const hotwordsFields = {
  hotwords: z.array(z.string()),
  background: z.string(),
};
const diagnosticFields = {
  code: z.string(),
  msg: z.string(),
};
const device = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["input", "system"]),
}).strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), v: version }).strict(),
  z.object({ type: z.literal("devices.list") }).strict(),
  z.object({
    type: z.literal("session.start"),
    source: z.enum(["system", "mic"]),
    deviceId: z.string().optional(),
    frameMs: z.union([z.literal(SHORT_FRAME_MS), z.literal(FRAME_MS)]).optional(),
  }).strict(),
  z.object({ type: z.literal("session.stop") }).strict(),
  z.object({ type: z.literal("hotwords.set"), ...hotwordsFields }).strict(),
  z.object({ type: z.literal("hotwords.get") }).strict(),
  z.object({
    type: z.literal("export.request"),
    format: z.enum(["md", "txt"]),
    sessionId: z.string(),
  }).strict(),
]);

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello.ok"),
    v: version,
    engine: z.object({ name: z.string(), quant: z.enum(["F16", "Q8_0"]) }).strict(),
    state: sessionState,
  }).strict(),
  z.object({ type: z.literal("state"), state: sessionState, vad: vadState }).strict(),
  z.object({ type: z.literal("devices"), devices: z.array(device) }).strict(),
  z.object({
    type: z.literal("level"),
    rmsDb: z.number().finite(),
    peakDb: z.number().finite(),
    tsMs: timestamp,
  }).strict(),
  z.object({
    type: z.literal("segment.start"),
    segmentId: nonNegativeInteger,
    tsMs: timestamp,
  }).strict(),
  z.object({
    type: z.literal("transcript.delta"),
    segmentId: nonNegativeInteger,
    seq: nonNegativeInteger,
    text: z.string(),
    tsMs: timestamp,
  }).strict(),
  z.object({
    type: z.literal("segment.end"),
    segmentId: nonNegativeInteger,
    reason: z.enum(["pause", "soft", "force", "watchdog", "stop"]),
    durMs: timestamp,
  }).strict(),
  z.object({
    type: z.literal("hotwords"),
    ...hotwordsFields,
    appliesFromSegment: nonNegativeInteger,
  }).strict(),
  z.object({ type: z.literal("export.ready"), path: z.string() }).strict(),
  z.object({ type: z.literal("warn"), ...diagnosticFields }).strict(),
  z.object({ type: z.literal("error"), ...diagnosticFields }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
