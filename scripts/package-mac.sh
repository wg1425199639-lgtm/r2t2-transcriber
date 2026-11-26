#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$PWD"
tauri="$root/app/src-tauri"
capture="$root/capture/mac"
engine="$root/third_party/audio.cpp"
server="$engine/build/macos-metal-release/bin/audiocpp_server"
vad="$root/models/silero_vad.onnx"
node=$(command -v node)
version=$(node -p 'require("./app/src-tauri/tauri.conf.json").version')

if [[ "$(node -p 'process.platform + "/" + process.arch + "/" + process.versions.node.split(".")[0]')" != darwin/arm64/22 ]]; then
  printf 'Building this package requires native arm64 Node.js 22 on macOS.\n' >&2
  exit 1
fi
test -x "$server" || { printf 'Missing executable: %s\n' "$server" >&2; exit 1; }
test -f "$vad" || { printf 'Missing model: %s\n' "$vad" >&2; exit 1; }

(
  cd "$capture"
  swift build -c release --arch arm64
)
capture_bin=$(cd "$capture" && swift build -c release --arch arm64 --show-bin-path)
(
  cd scheduler
  npx --no-install tsc
  test -f dist/main.js
)

staging=$(mktemp -d "$tauri/.package-mac.XXXXXXXX")
cleanup() {
  rm -rf "$staging"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

resources="$staging/resources"
modules="$resources/scheduler/node_modules"
mkdir -p "$resources/bin" "$resources/models" "$resources/licenses" "$modules"
install -m 755 "$capture_bin/capture-mac" "$resources/bin/capture-mac"
install -m 755 "$server" "$resources/bin/audiocpp_server"
install -m 755 "$node" "$resources/bin/node"
cp "$vad" "$resources/models/silero_vad.onnx"
cp LICENSE "$resources/licenses/R2T2-Transcriber.txt"
cp "$engine/LICENSE" "$resources/licenses/audio.cpp.txt"
cp "$root/scheduler/package.json" "$resources/scheduler/"
cp -R "$root/scheduler/dist" "$resources/scheduler/"

for dependency in ws zod onnxruntime-common; do
  cp -RL "$root/scheduler/node_modules/$dependency" "$modules/"
done
onnx="$root/scheduler/node_modules/onnxruntime-node"
native="$modules/onnxruntime-node/bin/napi-v6/darwin/arm64"
mkdir -p "$native"
cp "$onnx/package.json" "$modules/onnxruntime-node/"
cp -R "$onnx/dist" "$modules/onnxruntime-node/"
cp -RL "$onnx/bin/napi-v6/darwin/arm64/." "$native/"
for notice in "$onnx"/LICENSE* "$onnx"/ThirdPartyNotices*; do
  if [[ -f "$notice" ]]; then
    cp "$notice" "$modules/onnxruntime-node/"
  fi
done

node_executable=$("$node" -p 'require("node:fs").realpathSync(process.argv[1])' "$node")
node_license="$(dirname "$node_executable")/../LICENSE"
if [[ -f "$node_license" ]]; then
  cp "$node_license" "$resources/licenses/Node.js.txt"
else
  printf 'Node.js license file not found alongside %s\n' "$node" >&2
fi

minimum_macos=$(
  for binary in "$resources/bin/"* "$native/"*.node "$native/"*.dylib; do
    /usr/bin/lipo -verify_arch arm64 "$binary"
    /usr/bin/vtool -arch arm64 -show-build "$binary"
  done | awk '/^[[:space:]]*minos / { print $2 }' | sort -V | tail -n 1
)
test -n "$minimum_macos"

# Exercise module resolution and the native VAD binding with the staged runtime.
(
  cd "$resources/scheduler"
  ORT_DISABLE_TELEMETRY=1 ../bin/node --input-type=module -e '
    import "ws";
    import "zod";
    import { InferenceSession } from "onnxruntime-node";
    const session = await InferenceSession.create("../models/silero_vad.onnx");
    await session.release();
  '
)

cat > "$staging/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>用于将麦克风音频实时转写为字幕。</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>用于将系统播放的音频实时转写为字幕。</string>
</dict>
</plist>
PLIST

staging_name=${staging##*/}
cat > "$staging/tauri-package.json" <<EOF_CONFIG
{
  "bundle": {
    "macOS": {
      "minimumSystemVersion": "$minimum_macos",
      "infoPlist": "$staging_name/Info.plist"
    },
    "resources": {
      "$staging_name/resources/bin/": "bin/",
      "$staging_name/resources/licenses/": "licenses/",
      "$staging_name/resources/models/": "models/",
      "$staging_name/resources/scheduler/": "scheduler/"
    }
  }
}
EOF_CONFIG
(
  cd app
  npm run tauri build -- --ci --bundles app --config "$staging/tauri-package.json"
)

bundle_dir="$tauri/target/release/bundle"
bundle="$bundle_dir/macos/R2T2 Transcriber.app"
bundled_resources="$bundle/Contents/Resources"
test -f "$bundled_resources/scheduler/dist/main.js"
test -f "$bundled_resources/models/silero_vad.onnx"
for binary in "$bundled_resources/bin/"* \
  "$bundled_resources/scheduler/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/"*.{node,dylib}; do
  /usr/bin/codesign --force --sign - "$binary"
done
/usr/bin/codesign --force --deep --sign - "$bundle"
/usr/bin/codesign --verify --deep --strict "$bundle"

image_root="$staging/image"
mkdir -p "$image_root" "$bundle_dir/dmg"
/usr/bin/ditto "$bundle" "$image_root/R2T2 Transcriber.app"
ln -s /Applications "$image_root/Applications"
dmg="$bundle_dir/dmg/R2T2-Transcriber-v$version-macos-arm64.dmg"
/usr/bin/hdiutil create -volname "R2T2 Transcriber" -srcfolder "$image_root" \
  -format UDZO -ov "$staging/installer.dmg"
/usr/bin/hdiutil verify "$staging/installer.dmg"
mv "$staging/installer.dmg" "$dmg"

du -sh "$bundle" "$dmg"
