# R2T2 Transcriber

面向新闻发布会、直播和长时间发言的 macOS 实时语音转写与字幕工作台。使用 `audio.cpp` 的 Metal GPU 后端，在 Apple Silicon 上运行 `Confucius4-R2T2` Q8_0 模型。支持系统声音和麦克风采集，并提供透明、无黑框、可鼠标穿透的置顶字幕。

## 核心功能

- **全离线转写**。模型下载完成后，音频采集、推理、记录和导出均在本机完成。
- **160 ms 低延迟流式模式**。引擎常驻热备，识别结果连续追加。160 ms 为音频切片时长。
- **单句悬浮字幕**。按 `⌘L` 显示透明字幕，可锁定鼠标穿透，方便在播放全屏画面时查看。
- **OBS 透明字幕源**。在 OBS 添加「浏览器」源，将 URL 设为 `http://127.0.0.1:47800/caption`。
- **动态热词**。热词与背景词合计最多 250 字，修改后在下个转写分段生效。
- **重点打点与原声复核**。按 `⌘M` 为当前转写段落打点，Markdown 导出包含重点速览。点击时间戳可从对应的音频采样位置播放原声。

## 安装与使用

### 方式一 · 下载 Release 安装镜像

1. 在仓库 Releases 下载 `R2T2-Transcriber-v0.2.0-macos-arm64.dmg`，打开镜像，将 **R2T2 Transcriber.app** 拖到 **Applications**。发行包内置 Node.js、调度服务、采集工具、推理引擎及 VAD 模型。
2. 在终端下载约 2.48 GB 的 Q8_0 权重。下载完成后即可离线使用。

   ```sh
   mkdir -p "$HOME/Library/Application Support/com.r2t2.transcriber/models" && curl -fL --retry 3 "https://huggingface.co/davidxifeng/Confucius4-R2T2-gguf/resolve/main/r2t2-q8_0.gguf" -o "$HOME/Library/Application Support/com.r2t2.transcriber/models/r2t2-q8_0.gguf.part" && mv "$HOME/Library/Application Support/com.r2t2.transcriber/models/r2t2-q8_0.gguf.part" "$HOME/Library/Application Support/com.r2t2.transcriber/models/r2t2-q8_0.gguf"
   ```

3. 如首次打开时 macOS 拦截你确认来自可信 Release 的未公证安装包，可对该应用执行 `xattr -cr "/Applications/R2T2 Transcriber.app"`，再从 Finder 打开。
4. 按所用音源，在「系统设置 → 隐私与安全性」授权「屏幕与系统音频录制」或「麦克风」。在应用中选择音源，按 `⌘R` 开始转写。

### 方式二 · 从源码构建

在 Apple Silicon Mac 上准备原生 arm64 Node.js 22、Rust、Xcode Command Line Tools、CMake 和 Ninja。以下命令从仓库根目录运行。

```sh
npm ci --prefix scheduler
npm ci --prefix app
git clone https://github.com/0xShug0/audio.cpp.git third_party/audio.cpp
git -C third_party/audio.cpp checkout 86d9355
cmake -S third_party/audio.cpp -B third_party/audio.cpp/build/macos-metal-release -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DENGINE_ENABLE_CUDA=OFF -DENGINE_ENABLE_VULKAN=OFF \
  -DENGINE_ENABLE_METAL=ON -DENGINE_ENABLE_OPENMP=OFF -DGGML_OPENMP=OFF \
  -DENGINE_ENABLE_LLAMAFILE=ON -DENGINE_ENABLE_NATIVE_CPU=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DAUDIOCPP_DEPLOYMENT_BUILD=ON -DAUDIOCPP_MODEL_SET=custom -DAUDIOCPP_MODELS=confucius4_r2t2
cmake --build third_party/audio.cpp/build/macos-metal-release --parallel --target audiocpp_server
```

将 Silero VAD 的 `silero_vad.onnx` 放到 `models/silero_vad.onnx`，用方式一的命令下载 ASR 权重，然后执行 `bash scripts/package-mac.sh`。安装镜像输出到 `app/src-tauri/target/release/bundle/dmg/`。打包时会根据二进制的构建目标设置最低 macOS 版本。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `⌘R` | 开始或停止转写 |
| `⌘L` | 显示或隐藏悬浮字幕 |
| `⌘M` | 切换当前转写段落的重点打点 |
| `⌘\` | 显示或隐藏侧边栏 |
| `⌘↓` | 跳到最新转写 |
| `⌘E` | 导出 Markdown |
| `⌘+` / `⌘-` | 增大或减小转写字号 |

## 架构

```text
采集层   Swift · ScreenCaptureKit / AVAudioEngine
           │ 裸 PCM · 16 kHz / Mono / int16 LE
           ▼
调度层   Node.js + TypeScript · Silero VAD · 分段、热词与记录
           ├── 本地 HTTP 流式传输 / SSE ── 推理层 · audio.cpp + Metal
           └── 本地 WebSocket ──────────── 界面层 · Tauri + React
```

## 许可证

项目源码采用 [MIT License](LICENSE)。第三方组件及模型权重适用各自的许可条款。
