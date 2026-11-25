#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const wavPath = args[0];
if (!wavPath) {
  console.error('Usage: node scripts/m0-live-probe.mjs <wav-path> [--port 18488] [--prompt "热词1,热词2"] [--language Chinese] [--realtime]');
  process.exit(2);
}

let port = 18488;
let prompt = '';
let language = 'Chinese';
let realtime = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--prompt') prompt = args[++i];
  else if (args[i] === '--language') language = args[++i];
  else if (args[i] === '--realtime') realtime = true;
}

const raw = fs.readFileSync(wavPath);
// Find 'data' chunk in WAV header
let dataOffset = 44;
for (let i = 12; i < Math.min(raw.length - 8, 512); ) {
  const id = raw.toString('ascii', i, i + 4);
  const size = raw.readUInt32LE(i + 4);
  if (id === 'data') {
    dataOffset = i + 8;
    break;
  }
  i += 8 + size;
}
const pcm = raw.subarray(dataOffset);
const audioSec = pcm.length / 32000;
const CHUNK_BYTES = 10240; // 320ms @ 16kHz/mono/s16le
const TAIL_SILENCE = Buffer.alloc(9600, 0); // 300ms silence

const qs = new URLSearchParams({
  model: 'r2t2-stream',
  sample_rate: '16000',
  channels: '1',
  sample_format: 's16le',
});
if (language) qs.set('language', language);
if (prompt) qs.set('prompt', prompt);

const t0 = performance.now();
let firstDeltaMs = null;
const deltas = [];
let finalText = '';
let serverTiming = null;

console.log(`[probe] wav=${wavPath} pcm=${pcm.length}B (${audioSec.toFixed(2)}s) realtime=${realtime} language=${language} prompt=${JSON.stringify(prompt)}`);

const req = http.request(
  {
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: `/v1/audio/transcriptions/live?${qs.toString()}`,
    headers: {
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'application/octet-stream',
    },
  },
  (res) => {
    if (res.statusCode !== 200) {
      let errBody = '';
      res.on('data', (c) => (errBody += c.toString()));
      res.on('end', () => {
        console.error(`[probe] HTTP ${res.statusCode}: ${errBody}`);
        process.exit(1);
      });
      return;
    }
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          const ev = JSON.parse(payload);
          const nowMs = performance.now() - t0;
          if (ev.type === 'transcript.text.delta') {
            if (firstDeltaMs === null) firstDeltaMs = nowMs;
            deltas.push(ev.delta);
            console.log(`  [${nowMs.toFixed(0)}ms] DELTA: ${JSON.stringify(ev.delta)}`);
          } else if (ev.type === 'transcript.text.done') {
            finalText = ev.text;
            serverTiming = ev.timing ?? null;
            console.log(`  [${nowMs.toFixed(0)}ms] DONE:  ${JSON.stringify(ev.text)} timing=${JSON.stringify(serverTiming)}`);
          } else {
            console.log(`  [${nowMs.toFixed(0)}ms] EVENT: ${payload}`);
          }
        }
      }
    });
    res.on('end', () => {
      const wallMs = performance.now() - t0;
      console.log('--- SUMMARY ---');
      console.log(`audio_duration_s: ${audioSec.toFixed(2)}`);
      console.log(`wall_ms:          ${wallMs.toFixed(1)}`);
      console.log(`first_delta_ms:   ${firstDeltaMs === null ? 'n/a' : firstDeltaMs.toFixed(1)}`);
      console.log(`server_timing:    ${JSON.stringify(serverTiming)}`);
      console.log(`deltas_joined:    ${deltas.join('')}`);
      console.log(`final_text:       ${finalText}`);
    });
  },
);

req.on('error', (err) => {
  console.error('[probe] request error:', err);
  process.exit(1);
});

req.flushHeaders();

async function feed() {
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    const slice = pcm.subarray(off, Math.min(off + CHUNK_BYTES, pcm.length));
    req.write(slice);
    if (realtime) {
      await new Promise((r) => setTimeout(r, 320));
    }
  }
  req.write(TAIL_SILENCE);
  req.end();
}

feed();
