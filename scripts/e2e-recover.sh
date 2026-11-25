#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/scheduler"
port=47822
work="$(mktemp -d "${TMPDIR:-/tmp}/r2t2-recover.XXXXXXXX")"
export DATA_DIR="$work/data"
server_log="$work/scheduler.log"
client_log="$work/client.log"
events="$work/ws.jsonl"
scheduler_pid=
client_pid=
player_pid=

cleanup() {
  local status=$? pid attempt active log
  trap - EXIT
  trap '' INT TERM
  for pid in "$player_pid" "$client_pid" "$scheduler_pid"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  for attempt in {1..50}; do
    active=0
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
# Keep each background job and its descendants in a process group for cleanup.
set -m

die() { echo "$*" >&2; exit 1; }

wait_for_line() {
  local pattern=$1 log=$2 pid=$3 deadline=$((SECONDS + $4))
  until grep -Eq "$pattern" "$log"; do
    kill -0 "$pid" 2>/dev/null || die "进程提前退出，未收到 $pattern"
    (( SECONDS < deadline )) || die "等待 $pattern 超时"
    sleep 0.05
  done
}

capture_pid() {
  pgrep -x -P "$scheduler_pid" capture-mac || true
}

capture_ready='"code"[[:space:]]*:[[:space:]]*"READY"'
restart_warn='"type":"warn","code":"CAPTURE_RESTARTING"'
command -v afplay >/dev/null || die '系统音频测试需要 afplay'
test -x node_modules/.bin/tsx || die 'scheduler/node_modules 缺少 tsx'

node --import tsx src/main.ts --engine mock --port "$port" </dev/null >"$server_log" 2>&1 &
scheduler_pid=$!
wait_for_line "listening on port $port" "$server_log" "$scheduler_pid" 15

node --import tsx ../scripts/ws-client-dump.ts --port "$port" --start-source system \
  </dev/null >"$events" 2>"$client_log" &
client_pid=$!
wait_for_line '"type":"hello.ok"' "$events" "$client_pid" 10
wait_for_line "$capture_ready" "$server_log" "$client_pid" 15
pid1="$(capture_pid)"
[[ "$pid1" =~ ^[0-9]+$ ]] || die '无法确定初始 capture-mac PID'

afplay "$root/fixtures/news01.wav" </dev/null &
player_pid=$!
wait_for_line '"type":"state","state":"running"' "$events" "$client_pid" 10

deadline=$((SECONDS + 5))
kill -9 "$pid1"
while :; do
  kill -0 "$client_pid" 2>/dev/null || die '采集崩溃后 WebSocket 已断开'
  pid2="$(capture_pid)"
  if [[ "$pid2" =~ ^[0-9]+$ && "$pid2" != "$pid1" ]] &&
    grep -Eq "$restart_warn" "$events"; then break; fi
  (( SECONDS < deadline )) || die '5 秒内未收到重启警告或未找到新的 capture-mac PID'
  sleep 0.05
done

level_pattern='"type":"level"'
deadline=$((SECONDS + 10))
until awk -v warning="$restart_warn" -v level="$level_pattern" '
  $0 ~ warning { restarted = 1 }
  restarted && $0 ~ level { resumed = 1 }
  END { exit !resumed }
' "$events"; do
  kill -0 "$client_pid" 2>/dev/null || die '等待恢复音频时 WebSocket 已断开'
  (( SECONDS < deadline )) || die '新采集进程未恢复音频帧'
  sleep 0.05
done

# SIGINT tells the dump client to send session.stop on the same connection.
kill -INT "$client_pid"
wait "$client_pid"
client_pid=
awk '
  /"type":"error"/ { failed = 1 }
  /"type":"state","state":"stopping"/ { stopping = 1 }
  stopping && /"type":"state","state":"idle"/ { stopped = 1 }
  END { exit (failed || !stopped) }
' "$events" || die 'WebSocket 收到 error 或未确认 session.stop 正常回到 idle'

printf '验收通过｜capture-mac PID %s → %s｜收到 CAPTURE_RESTARTING 并恢复音频帧｜session.stop 退出码 0\n' "$pid1" "$pid2"
