#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
capture="$repo_root/capture/mac/.build/release/capture-mac"
source=${CAPTURE_SOURCE:-system}
if [[ ! -x "$capture" ]]; then
    printf 'capture-mac is missing or not executable: %s\n' "$capture" >&2
    exit 1
fi
case "$source" in
    system|mic) ;;
    *) printf 'Invalid CAPTURE_SOURCE: %s (expected system or mic)\n' "$source" >&2; exit 1 ;;
esac
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 1; }

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/e2e-capture-pure.XXXXXXXX")
pcm="$work_dir/stdout.pcm"
log="$work_dir/stderr.jsonl"
capture_pid=
cleanup() {
    if [[ -n "$capture_pid" ]]; then
        kill -KILL "$capture_pid" 2>/dev/null || true
        wait "$capture_pid" 2>/dev/null || true
    fi
    rm -rf -- "$work_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
    printf '%s\n' "$1" >&2
    cat "$log" >&2
    exit 1
}

"$capture" --source "$source" </dev/null >"$pcm" 2>"$log" &
capture_pid=$!

if ! python3 - "$capture_pid" "$log" <<'PY'
import json
import os
import signal
import sys
import time

pid = int(sys.argv[1])
deadline = time.monotonic() + 5
with open(sys.argv[2], "rb") as log:
    pending = b""
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            sys.exit("capture-mac exited before READY")
        pending += log.read()
        lines = pending.split(b"\n")
        pending = lines.pop()
        for line in lines:
            try:
                entry = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeError):
                continue
            if isinstance(entry, dict) and entry.get("code") == "READY":
                break
        else:
            time.sleep(min(0.01, max(0, deadline - time.monotonic())))
            continue
        break
    else:
        sys.exit("Timed out waiting for READY")

time.sleep(5)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    sys.exit("capture-mac exited before SIGTERM")

deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        break
    time.sleep(0.01)
else:
    sys.exit("capture-mac did not exit within 5 seconds of SIGTERM")
PY
then
    fail 'Capture failed. stderr follows.'
fi

status=0
wait "$capture_pid" || status=$?
capture_pid=
if (( status != 0 )); then
    fail "capture-mac exited with status $status. stderr follows."
fi

python3 - "$pcm" "$log" <<'PY'
import json
from pathlib import Path
import sys


def reject_constant(value):
    raise ValueError(f"invalid JSON constant {value}")


pcm, log = map(Path, sys.argv[1:])
byte_count = pcm.stat().st_size
frame_bytes = 10240
if byte_count <= 0 or byte_count % frame_bytes:
    sys.exit(f"stdout has {byte_count} bytes; expected nonempty {frame_bytes}-byte frames")
if not 144000 <= byte_count <= 176000:
    sys.exit(f"stdout has {byte_count} bytes; expected 144000–176000")

line_count = 0
ready = False
with log.open("rb") as stream:
    for line_count, line in enumerate(stream, 1):
        try:
            entry = json.loads(line.decode("utf-8"), parse_constant=reject_constant)
        except ValueError as error:
            sys.exit(f"stderr line {line_count} is invalid JSON: {error}")
        if not isinstance(entry, dict) or not {"lvl", "code", "msg"} <= entry.keys():
            sys.exit(f"stderr line {line_count} must be a JSON object with lvl, code, and msg")
        ready |= entry["code"] == "READY"
if not line_count or not ready:
    sys.exit("stderr must contain a READY record")

print(f"PASS: stdout {byte_count} bytes, {byte_count // frame_bytes} frames; stderr {line_count} lines")
PY
