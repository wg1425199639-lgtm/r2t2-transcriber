#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$PWD"
capture="$root/capture/mac"
server="$root/third_party/audio.cpp/build/macos-metal-release/bin/audiocpp_server"
resources="$root/app/src-tauri/resources"
bin="$resources/bin"

(
  cd "$capture"
  swift build -c release
)
if [[ ! -f "$server" || ! -x "$server" ]]; then
  printf 'Missing executable: %s\n' "$server" >&2
  exit 1
fi
(
  cd scheduler
  npx --no-install tsc
  test -f dist/main.js
)

created_resources=0
if [[ ! -d "$resources" ]]; then
  mkdir "$resources"
  created_resources=1
fi
mkdir "$bin"
cleanup() {
  rm -f "$bin/capture-mac" "$bin/audiocpp_server"
  rmdir "$bin"
  if [[ "$created_resources" == 1 ]]; then
    rmdir "$resources"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -m 755 "$capture/.build/release/capture-mac" "$bin/capture-mac"
install -m 755 "$server" "$bin/audiocpp_server"
(
  cd app
  npm run tauri build -- --ci --bundles app --config '{
    "bundle": {
      "resources": {
        "resources/bin/capture-mac": "bin/capture-mac",
        "resources/bin/audiocpp_server": "bin/audiocpp_server"
      }
    }
  }'
)

bundle="$root/app/src-tauri/target/release/bundle/macos/R2T2 Transcriber.app"
test -d "$bundle"
test -x "$bundle/Contents/Resources/bin/capture-mac"
test -x "$bundle/Contents/Resources/bin/audiocpp_server"
size_kb=$(du -sk "$bundle")
printf '%s (%s MB)\n' "$bundle" "$(awk '{printf "%.1f", $1 * 1024 / 1000000}' <<< "$size_kb")"
