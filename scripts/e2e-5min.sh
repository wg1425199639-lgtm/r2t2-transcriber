#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${E2E_MODE:-live}"
hotwords='十五五规划,新质生产力,粤港澳大湾区,雄安新区,成渝地区双城经济圈,国务院新闻办公室'
case "$mode" in
  live) command -v afplay >/dev/null || { echo 'live 模式需要 afplay' >&2; exit 1; } ;;
  file) ;;
  *) echo 'E2E_MODE 必须为 live 或 file' >&2; exit 1 ;;
esac
cd "$root/scheduler"
test -x node_modules/.bin/tsx || { echo 'scheduler/node_modules 缺少 tsx' >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/r2t2-e2e.XXXXXXXX")"
export DATA_DIR="$work/data"
export TMPDIR="$work"
server_log="$work/scheduler.log"
client_log="$work/client.log"
events="$work/ws.jsonl"
wav="$work/news-silence-news.wav"
scheduler_pid=
client_pid=
player_pid=

cleanup() {
  local status=$? pid attempt
  trap - EXIT
  trap '' INT TERM
  for pid in "$player_pid" "$client_pid" "$scheduler_pid"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  for attempt in {1..50}; do
    local active=0
    for pid in "$player_pid" "$client_pid" "$scheduler_pid"; do
      if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then active=1; fi
    done
    if (( ! active )); then break; fi
    sleep 0.1
  done
  for pid in "$player_pid" "$client_pid" "$scheduler_pid"; do
    if [[ -n "$pid" ]]; then
      kill -KILL -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if (( status != 0 )); then
    for log in "$server_log" "$client_log" "$events"; do
      if [[ -s "$log" ]]; then
        printf '\n--- %s ---\n' "${log##*/}" >&2
        tail -n 15 "$log" >&2
      fi
    done
  fi
  rm -rf -- "$work"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Each background job and its descendants share a process group for cleanup.
set -m

config="$(node --import tsx --input-type=module -e '
  import {WS_PORT, SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE, WATCHDOG_MS} from "./src/config.ts";
  console.log(WS_PORT, SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE, WATCHDOG_MS);
')"
read -r default_port sample_rate channels sample_bytes max_segment_ms <<< "$config"
port="${E2E_PORT:-$default_port}"
timing="$(python3 - "$root/fixtures/news01.wav" "$wav" "$sample_rate" "$channels" "$sample_bytes" <<'PY'
import math
import sys
import wave

source, output, rate, channels, sample_bytes = sys.argv[1:]
rate, channels, sample_bytes = map(int, (rate, channels, sample_bytes))
with wave.open(source, "rb") as fixture:
    if (fixture.getframerate(), fixture.getnchannels(), fixture.getsampwidth()) != (rate, channels, sample_bytes):
        sys.exit("news01.wav 必须是 16 kHz / Mono / s16le PCM")
    frames = fixture.getnframes()
    pcm = fixture.readframes(frames)
if len(pcm) != frames * channels * sample_bytes:
    sys.exit("news01.wav PCM 数据不完整")

silence_seconds = 36
# Six fixture copies plus the middle silence total about 177 seconds.
trailing_seconds = 10
with wave.open(output, "wb") as wav:
    wav.setparams((channels, sample_bytes, rate, 0, "NONE", "not compressed"))
    wav.writeframes(pcm * 4)
    wav.writeframes(bytes(silence_seconds * rate * channels * sample_bytes))
    wav.writeframes(pcm * 2)
    wav.writeframes(bytes(trailing_seconds * rate * channels * sample_bytes))

gap_ms = round(4 * frames / rate * 1000)
print(gap_ms, gap_ms + silence_seconds * 1000, math.ceil(6 * frames / rate + silence_seconds + trailing_seconds))
PY
)"
read -r gap_ms resume_ms duration_seconds <<< "$timing"
printf '运行模式 %s，测试 WAV 约 %s 秒\n' "$mode" "$duration_seconds"

scheduler_args=(--engine r2t2 --port "$port")
client_args=(--port "$port")
if [[ "$mode" == live ]]; then
  client_args+=(--hotwords "$hotwords" --start-source system)
else
  scheduler_args+=(--source "file:$wav" --hotwords "$hotwords")
fi

die() { echo "$*" >&2; exit 1; }

wait_for_line() {
  local pattern=$1 log=$2 pid=$3 timeout=$4 deadline=$((SECONDS + $4))
  until grep -Eq "$pattern" "$log"; do
    kill -0 "$pid" 2>/dev/null || die "进程提前退出，未收到 $pattern"
    (( SECONDS < deadline )) || die "等待 $pattern 超过 ${timeout}s"
    sleep 0.1
  done
}

: > "$server_log"
: > "$events"
npx --no-install tsx src/main.ts "${scheduler_args[@]}" </dev/null >"$server_log" 2>&1 &
scheduler_pid=$!
wait_for_line 'listening on port' "$server_log" "$scheduler_pid" 15

node --import tsx ../scripts/ws-client-dump.ts "${client_args[@]}" </dev/null >"$events" 2>"$client_log" &
client_pid=$!
wait_for_line '"type":"hello.ok"' "$events" "$client_pid" 10
wait_for_line '"type":"state","state":"running"|"type":"hello.ok".*"state":"running"' "$events" "$client_pid" 90

playback_start_ms=0
if [[ "$mode" == live ]]; then
  playback_start_ms="$(python3 -c 'import time; print(time.time_ns() // 1_000_000)')"
  afplay "$wav" </dev/null &
  player_pid=$!
  deadline=$((SECONDS + duration_seconds + 20))
  while kill -0 "$player_pid" 2>/dev/null; do
    kill -0 "$client_pid" 2>/dev/null || die '播放期间 WebSocket 已断开'
    (( SECONDS < deadline )) || die '等待 afplay 结束超时'
    sleep 0.2
  done
  wait "$player_pid"
  player_pid=
else
  wait_for_line 'file processing finished' "$server_log" "$client_pid" "$((duration_seconds + 45))"
fi

kill -INT "$client_pid"
wait "$client_pid"
client_pid=

python3 - "$events" "$DATA_DIR" "$playback_start_ms" "$gap_ms" "$resume_ms" "$max_segment_ms" <<'PY'
import json
import sys
from pathlib import Path

events_path, data_dir = map(Path, sys.argv[1:3])
start_ms, gap, resume, max_segment_ms = map(int, sys.argv[3:])


def require(condition, message):
    if not condition:
        sys.exit(f"验收失败：{message}")


def read_jsonl(path):
    with path.open(encoding="utf-8") as lines:
        return [json.loads(line) for line in lines]


events = read_jsonl(events_path)
require(sum(event["type"] == "hello.ok" for event in events) == 1, "应收到一次 hello.ok")
errors = [event for event in events if event["type"] == "error"]
require(not errors, f"收到 {len(errors)} 条 error：{errors}")
states = [event["state"] for event in events if event["type"] == "state"]
require(states and states[-1] == "idle", "录音未回到 idle")
if start_ms:
    require("stopping" in states, "live 模式未确认 session.stop")
levels = [event["tsMs"] for event in events if event["type"] == "level"]
require(levels, "未收到音频帧")
start_ms = start_ms or levels[0]

# Allow for capture buffering, file frame alignment and local scheduling jitter.
tolerance_ms = 2_000
gap_start = start_ms + gap
resume_start = start_ms + resume
segments = [event for event in events if event["type"] == "segment.end"]
durations = [event["durMs"] for event in segments]
require(len(segments) >= 2, f"segment.end 少于 2 次：{durations}")
require(all(0 <= ms <= max_segment_ms for ms in durations), f"存在超限段：{durations}")

last_level = levels[0]
rotation_seen = False
gap_pause_index = None
for index, event in enumerate(events):
    if event["type"] == "level":
        last_level = event["tsMs"]
    if event["type"] != "segment.end":
        continue
    if event["reason"] in {"soft", "force", "watchdog"} and last_level < gap_start + tolerance_ms:
        rotation_seen = True
    if event["reason"] == "pause" and gap_start - tolerance_ms <= last_level < resume_start - tolerance_ms:
        gap_pause_index = index
        break
require(rotation_seen, "首段口播未发生防超时轮转")
require(gap_pause_index is not None, "36 秒静音期未收到 pause 收尾")

deltas = [(index, event) for index, event in enumerate(events) if event["type"] == "transcript.delta"]
before = [event for index, event in deltas if index < gap_pause_index and event["tsMs"] < gap_start]
after = [
    event for index, event in deltas
    if index > gap_pause_index and event["tsMs"] >= resume_start - tolerance_ms
]
require(before and after, "静音前后均应有转写")
text = "".join(event["text"] for _, event in deltas)
count = len("".join(text.split()))
require(count >= 300, f"总字数不足 300：{count}")
words = ("十五五", "新质生产力", "粤港澳大湾区", "雄安新区")
hits = [word for word in words if word in text]
require(len(hits) == len(words), f"核心热词缺失，仅命中：{', '.join(hits)}")
recovered_text = "".join(event["text"] for event in after)
recovered_hits = [word for word in words if word in recovered_text]
require(recovered_hits, "静音后恢复转写未命中核心热词")

logs = sorted((data_dir / "sessions").glob("*.jsonl"))
require(logs, "DATA_DIR/sessions 下没有转写日志")
for path in logs:
    require(read_jsonl(path), f"转写日志为空：{path.name}")

print(f"验收通过｜段数 {len(segments)}｜各段 durMs {durations}｜总字数 {count}｜error {len(errors)}")
print(f"核心热词命中 {'、'.join(hits)}｜静音后命中 {'、'.join(recovered_hits)}｜落盘 JSONL {len(logs)} 个")
PY
