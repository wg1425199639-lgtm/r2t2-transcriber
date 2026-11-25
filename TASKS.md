# TASKS.md

约定：`Sol`=Codex 执行；`人工`=人在终端执行（涉及权限/下载/听音）。每张工单：范围≤3文件、一条硬验收命令（退出码 0 即通过）。引擎协议与端口以 `docs/r2t2-reference.md` §3（M0 实测版）为准。

---
## Milestone 0 — 零 UI 裸机验效（先于一切代码）

**M0-01 [人工] 编译 audio.cpp（已完成实测）**
- 范围：`scripts/build-audiocpp.sh`（可选）、`third_party/audio.cpp/`
- 目标：clone `0xShug0/audio.cpp`，开启 Metal 精简编译 `confucius4_r2t2`，产出 `audiocpp_server`。
- 验收：`third_party/audio.cpp/build/macos-metal-release/bin/audiocpp_server --help | head -50`

**M0-02 [人工] 下载 F16 / Q8_0 权重**
- 范围：`scripts/fetch-models.sh`、`models/`
- 目标：从 `davidxifeng/Confucius4-R2T2-gguf` 下载单文件自包含 `r2t2-f16.gguf`(~4.09GB) 与 `r2t2-q8_0.gguf`(~2.48GB) 至 `models/Confucius4-R2T2-GGUF/`；同时下载 `silero_vad.onnx` 到 `models/`。
- 验收：`ls -lh models/Confucius4-R2T2-GGUF/ models/ | grep -Ei "f16|q8_0|silero"`

**M0-03 [人工] 核验真实启动参数与配置文件（已完成实测）**
- 范围：`docs/r2t2-reference.md`（§3.2 回填）、`scripts/m0-server.json`
- 目标：核验 `audiocpp_server --config scripts/m0-server.json --no-ui`、`GET /health`、`session_options`（`confucius4_r2t2.chunk_size_ms`）等真实参数并回填文档。
- 验收：`curl -sf http://127.0.0.1:19488/health | grep -q '"status":"ok"'`

**M0-04 [Sol] 核验流式传输协议（HTTP/1.1 Chunked + SSE）并回填（已完成实测）**
- 范围：`docs/r2t2-reference.md`（§3.3）、`scripts/m0-live-probe.mjs`
- 目标：基于 `POST /v1/audio/transcriptions/live` 写最小探针：以 `Transfer-Encoding: chunked` 推送 `fixtures/news01.wav` 的 320ms 帧 + ≥300ms 尾静音 + `req.end()`，解析 SSE `transcript.text.delta` / `transcript.text.done` 并回填协议细节与单槽位并发约束。
- 验收：`node scripts/m0-live-probe.mjs fixtures/news01.wav | tail -20`（须打印出中文转写文本；先启动 server）

**M0-05 [人工] 准备口播样本**
- 范围：`fixtures/`
- 目标：放入 ≥3 段本地新闻口播（含"十五五规划"、地名、人名），转为 16k/mono/s16le；写 `fixtures/hotwords.txt` 与 `fixtures/*.ref.txt` 参考文本。
- 验收：`for f in fixtures/*.wav; do ffprobe -v error -show_entries stream=sample_rate,channels,codec_name -of csv=p=0 "$f"; done | sort -u`（应只输出 `pcm_s16le,16000,1`）

**M0-06 [Sol] 热词 A/B 与 F16/Q8 对比脚本**
- 范围：`scripts/m0-hotword-ab.mjs`、`docs/r2t2-reference.md`（追加结果表）
- 目标：对每段 wav 分别 {无热词, 有热词} × {F16, Q8_0} 跑转写，计算对参考文本的字错率(CER，自实现编辑距离)与热词命中率，输出 Markdown 表，写入文档，并给出默认量化推荐。
- 验收：`node scripts/m0-hotword-ab.mjs --out /tmp/m0-ab.md && grep -E "F16|Q8_0" /tmp/m0-ab.md`

**M0-07 [人工] M0 关卡**：确认热词有效、F16/Q8 延迟与 CER 可接受，`docs/r2t2-reference.md` 中无剩余 `[VERIFY_IN_M0]`，并同步更新 `ARCHITECTURE.md` §3.3 回填区。验收：`! grep -rn "VERIFY_IN_M0" docs/r2t2-reference.md`（架构师 review 后进入 M1）

---
## Milestone 1 — Mac Swift 内录 CLI

- [x] **M1-01 [Sol] Swift 包骨架 + 参数解析 + `--list-devices`**
- 范围：`capture/mac/Package.swift`、`Sources/capture-mac/main.swift`、`Devices.swift`
- 目标：按契约解析参数，退出码规范；`--list-devices` 输出 JSON。
- 验收：`cd capture/mac && swift build -c release && .build/release/capture-mac --list-devices | python3 -c "import sys,json;json.load(sys.stdin)['devices']"`

- [x] **M1-02 [Sol] 重采样器（含单测）**
- 范围：`Sources/capture-mac/Resampler.swift`、`Tests/capture-macTests/ResamplerTests.swift`
- 目标：48k F32 stereo → 16k mono s16le；正弦波输入输出频率/幅度正确，无削波。
- 验收：`cd capture/mac && swift test`

- [x] **M1-03 [Sol] WAV 落盘器**
- 范围：`Sources/capture-mac/WavDump.swift`、`Tests/capture-macTests/WavDumpTests.swift`
- 目标：流式写 WAV，关闭时回填头；SIGTERM 安全。
- 验收：`cd capture/mac && swift test --filter WavDumpTests`

- [x] **M1-04 [Sol] 麦克风采集**
- 范围：`Sources/capture-mac/MicCapture.swift`、`main.swift`
- 目标：AVAudioEngine 采集，按 `--device-id`，经重采样输出到 stdout，`--dump-wav` 生效，READY/PERM_DENIED 走 stderr JSON。
- 验收：`cd capture/mac && swift build -c release && .build/release/capture-mac --source mic --dump-wav /tmp/mic.wav 2>/tmp/mic.err & sleep 5; kill -TERM $!; sleep 1; ffprobe -v error -show_entries stream=sample_rate,channels,duration -of csv=p=0 /tmp/mic.wav`（应 `16000,1,≈5`）

- [x] **M1-05 [Sol] ScreenCaptureKit 系统内录**
- 范围：`Sources/capture-mac/SCKCapture.swift`、`main.swift`
- 目标：`--source system` 仅音频流（排除自身），经重采样输出。
- 验收：同 M1-04，将 `--source mic` 换为 `--source system` 并输出 `/tmp/sys.wav`（须先播放音频）

- [x] **M1-06 [人工] 听音验收**：播放新闻视频 + 对麦克风说话，各录 10s，听 `/tmp/sys.wav`、`/tmp/mic.wav` 无爆音/变速/变调。验收：`afplay /tmp/sys.wav`；并执行 `capture/mac/.build/release/capture-mac --source system 2>/dev/null | head -c 320000 | wc -c` 得 `320000`（=10s）

- [x] **M1-07 [Sol] stdout 纯净性测试脚本**
- 范围：`scripts/e2e-capture-pure.sh`
- 目标：运行 5s，断言 stdout 字节数为 `10240` 的整数倍且 ≈ `160000±10%`，stderr 全为合法 JSON 行。
- 验收：`bash scripts/e2e-capture-pure.sh`

---
## Milestone 2 — 调度服务 + R2T2 适配层

- [x] **M2-01 [Sol] 项目骨架 + config + protocol**
- 范围：`scheduler/package.json`、`tsconfig.json`、`src/config.ts`、`src/protocol.ts`（4 文件内合并创建）
- 目标：strict TS；常量按 ARCHITECTURE §2.1；zod 定义 §3.2 全部消息。
- 验收：`cd scheduler && npm i && npx tsc --noEmit`

- [x] **M2-02 [Sol] 帧切分器 capture-reader + 单测**
- 范围：`src/capture-reader.ts`、`src/capture-reader.test.ts`
- 目标：把任意分片的字节流重组为定长帧（10240B/5120B）。
- 验收：`cd scheduler && npx vitest run src/capture-reader.test.ts`

- [x] **M2-03 [Sol] 电平计 level-meter + 单测**
- 范围：`src/level-meter.ts`、`src/level-meter.test.ts`
- 目标：帧 → rmsDb/peakDb；静音 `-120`，满幅 `0`。
- 验收：`cd scheduler && npx vitest run src/level-meter.test.ts`

- [x] **M2-04 [Sol] Silero VAD 推理封装**
- 范围：`src/vad/silero.ts`、`src/vad/silero.test.ts`
- 目标：onnxruntime-node 加载 `models/silero_vad.onnx`，按 512 样本窗输出 prob，维护 state；测试用 fixtures wav 与全零数据。
- 验收：`cd scheduler && npx vitest run src/vad/silero.test.ts`

- [x] **M2-05 [Sol] 分段状态机 segmenter（纯逻辑 + 单测）**
- 范围：`src/vad/segmenter.ts`、`src/vad/segmenter.test.ts`
- 目标：输入 {帧, 各窗 prob}，输出动作流 `OPEN/PUSH/TAIL_SILENCE/FINISH/ROTATE`；覆盖 60/75/90/100s、1500ms 空闲收尾、预卷、stop 时必先 TAIL_SILENCE(9600B)。用合成 prob 序列模拟 3 小时无越界。
- 验收：`cd scheduler && npx vitest run src/vad/segmenter.test.ts`

- [x] **M2-06 [Sol] Adapter 接口 + MockAdapter**
- 范围：`src/asr/adapter.ts`、`src/asr/mock-adapter.ts`
- 目标：按 §3.3 接口；Mock 记录收到的字节并校验"END 前累计尾部 ≥9600B 全零"，吐假 delta。
- 验收：`cd scheduler && npx tsc --noEmit && npx vitest run src/asr`

- [x] **M2-07 [Sol] R2T2Adapter 真实实现（HTTP/1.1 Chunked + SSE）**
- 范围：`src/asr/r2t2-adapter.ts`、`src/process-manager.ts`、`src/asr/r2t2-adapter.smoke.ts`
- 目标：严格遵守 `docs/r2t2-reference.md` §3.3~§3.4：启动 `audiocpp_server --config <server.json> --no-ui` 并轮询 `GET /health`；`openSession` 必须用 `node:http`（禁 `fetch`/`undici`/`axios`）调 `POST /v1/audio/transcriptions/live`（显式 `Transfer-Encoding: chunked`，禁 `Content-Length` 与 `Expect: 100-continue`，立即 `req.flushHeaders()`，socket `setNoDelay(true)` + `setTimeout(0)`，`prompt` 去换行且编码前 `<= 250` 字符）；`StringDecoder('utf8')` 按 `\r?\n\r?\n` 切 SSE 帧；`done` 按前缀/LCP 补齐未提交尾字；`finish()` 发送终止块 `0\r\n\r\n`（`req.end()`）并保证单槽位互斥；崩溃退避重启。
- 验收：`cd scheduler && npx tsx src/asr/r2t2-adapter.smoke.ts ../fixtures/news01.wav | tail -5`（打印中文转写）

- [x] **M2-08 [Sol] 热词持久化 + transcript-log**
- 范围：`src/hotwords-store.ts`、`src/transcript-log.ts`、`src/hotwords-store.test.ts`
- 目标：JSON 原子写；改动后下一次 `get()` 立即为新值；jsonl 追加。
- 验收：`cd scheduler && npx vitest run src/hotwords-store.test.ts`

- [x] **M2-09 [Sol] 编排 main + ws-server**
- 范围：`src/main.ts`、`src/ws-server.ts`
- 目标：串联 capture → reader → meter/VAD/segmenter → adapter → WS；实现 §3.2 全部消息；支持 `--source file:<wav>` 开发模式喂文件。
- 验收：`cd scheduler && npx tsx src/main.ts --source file:../fixtures/news01.wav --engine mock --exit-on-eof & sleep 1; npx tsx ../scripts/ws-client-dump.ts | grep -c transcript.delta`（>0）

- [x] **M2-10 [Sol] 5 分钟连续播报 E2E**
- 范围：`scripts/e2e-5min.sh`、`scripts/ws-client-dump.ts`
- 目标：拼接 fixtures 为 ≥300s wav，用真实引擎、实时速率喂入；断言：WS 不断连、出现 ≥3 次 `segment.end`、无 `error`、每段 durMs ≤100000、每个 `segment.end` 前引擎收到尾静音、最终文本 CER 低于阈值。
- 验收：`bash scripts/e2e-5min.sh`

**M2-11 [人工] 真实内录联调 + 30 分钟稳定性**：`capture-mac --source system | scheduler`，播放新闻 30 分钟，观察 RSS 内存曲线平稳。验收：`bash scripts/soak.sh 1800`（Sol 可代写；输出峰值 RSS 与断连次数=0）

---
## Milestone 3 — Tauri + React 前端

- [x] **M3-01 [Sol] 前端脚手架 + 主题 token**
- 范围：`app/` 初始化（Tauri 2 + Vite React TS + Tailwind + shadcn 初始化）、`app/src/styles/tokens.css`
- 目标：按 `DESIGN.md` §2 写入浅/暗 CSS 变量；跟随系统。
- 验收：`cd app && npm i && npm run build`

- [x] **M3-02 [Sol] WS 客户端 + 状态 store**
- 范围：`app/src/lib/ws-client.ts`、`app/src/store/session.ts`、`ws-client.test.ts`
- 目标：自动重连(指数退避)、消息 zod 校验（复用 protocol 类型）、append-only 合并 delta。
- 验收：`cd app && npx vitest run`

- [x] **M3-03 [Sol] 转写区组件（Append-only + 智能滚动）**
- 范围：`app/src/components/Transcript.tsx`、`hooks/useStickyScroll.ts`、`components/JumpToLatest.tsx`
- 目标：按 DESIGN §4；用户上滚立即解锁，显示"回到最新"胶囊；新文本不产生布局跳动。
- 验收：`cd app && npx vitest run src/hooks/useStickyScroll.test.ts && npm run build`

- [x] **M3-04 [Sol] 侧边栏热词管理**
- 范围：`components/Sidebar.tsx`、`components/HotwordEditor.tsx`
- 目标：热词 chip 增删、背景词多行输入、变更发 `hotwords.set`，显示"自第 N 段起生效"。
- 验收：`cd app && npm run build && npx vitest run src/components/HotwordEditor.test.tsx`

- [x] **M3-05 [Sol] 顶栏：音源选择 + 电平条 + 开始/停止**
- 范围：`components/TopBar.tsx`、`components/LevelMeter.tsx`、`components/SourcePicker.tsx`
- 目标：设备列表来自 `devices`；电平 60fps 平滑、静音超 3s 显示"未收到声音"。
- 验收：`cd app && npm run build`

- [x] **M3-06 [Sol] 主界面组装 + 命中热词高亮 + 时间戳**
- 范围：`app/src/App.tsx`、`components/Segment.tsx`、`lib/highlight.ts`
- 目标：按 DESIGN 排版；命中热词克制高亮；段首时间戳。
- 验收：`cd app && npx vitest run src/lib/highlight.test.ts && npm run build`

- [x] **M3-07 [Sol] Tauri sidecar 拉起 scheduler**
- 范围：`app/src-tauri/src/main.rs`、`tauri.conf.json`、`capabilities/default.json`
- 目标：应用启动时拉起 scheduler 并随退出终止；仅放行必要权限。
- 验收：`cd app && npm run tauri build -- --debug 2>&1 | tail -5`

- [x] **M3-08 [人工] 视觉与联调验收**：`npm run tauri dev`，播放新闻，核对 DESIGN 全部条目；会议中途改热词，下一分段起生效。验收：`bash scripts/e2e-hotword-live.sh`（Sol 可代写：脚本通过 WS 中途 `hotwords.set` 并断言 `segment` 轮转后 `hotwords.appliesFromSegment` 生效）；交由架构师截图验收。

---
## Milestone 4 — 导出、恢复、打包

- [x] **M4-01 [Sol] 导出 Markdown/TXT**
- 范围：`scheduler/src/export.ts`、`export.test.ts`
- 目标：从 jsonl 生成 `.md`（含时间戳标题、分段）与 `.txt`（纯文本）。
- 验收：`cd scheduler && npx vitest run src/export.test.ts`

- [x] **M4-02 [Sol] 前端导出区**
- 范围：`components/ExportPanel.tsx`、`app/src-tauri/src/main.rs`（保存对话框）
- 目标：一键导出，复制全文，打开所在目录。
- 验收：`cd app && npm run build && cd src-tauri && cargo check`

- [x] **M4-03 [Sol] 异常恢复：引擎崩溃**
- 范围：`scheduler/src/process-manager.ts`、`scheduler/src/process-manager.test.ts`
- 目标：kill 引擎后自动重启并续接新分段，前端收 `warn` 且不丢已转写文本。
- 验收：`cd scheduler && npx vitest run src/process-manager.test.ts`

- [x] **M4-04 [Sol] 异常恢复：采集崩溃/设备热插拔 + 应用崩溃恢复**
- 范围：`scheduler/src/main.ts`、`scheduler/src/transcript-log.ts`、`app/src/store/session.ts`
- 目标：采集退出后重启；应用重开时可恢复上一个未导出的会话。
- 验收：`bash scripts/e2e-recover.sh`（Sol 代写：kill -9 采集与引擎各一次，断言会话持续且 jsonl 完整）

- [x] **M4-05 [Sol] 一键启动与打包脚本**
- 范围：`scripts/package-mac.sh`、`app/src-tauri/tauri.conf.json`
- 目标：构建 capture-mac、scheduler(单文件化)、audiocpp_server 并作为 sidecar/resources 打入 `.app`；权重不入包，首次启动指向 `models/` 或用户目录。
- 验收：`bash scripts/package-mac.sh && test -d app/src-tauri/target/release/bundle/macos/*.app`

**M4-06 [人工] 3 小时终验**：在 `.app` 中连续跑 3 小时发布会回放，导出 md/txt。验收：`bash scripts/soak.sh 10800`（断连=0、峰值 RSS 平稳、无 `error`）。

---
## Milestone 5 — v0.2 穿透悬浮字幕 · OBS 同源 · 原声点读 · 金句打点

- [x] **M5-01 [Sol] 悬浮字幕视图 `CaptionOverlay` + 单测**
- 范围：`app/src/components/CaptionOverlay.tsx`、`app/src/components/CaptionOverlay.test.tsx`、`app/src/main.tsx`
- 目标：`?view=overlay` 渲染广播级双行悬浮字幕胶囊（`DESIGN.md` §6.1：深色毛玻璃、双行限流、热词微亮、5s 无新字自动呼吸弱化至 `0.18` 透明度、支持 `?view=overlay&obs=1` 纯透明无外框模式）；`main.tsx` 按 URL query 路由至 `CaptionOverlay` 或 `App`。
- 验收：`cd app && npx tsc --noEmit && npx vitest run src/components/CaptionOverlay.test.tsx && npm run build`

- [x] **M5-02 [Sol] Tauri 透明置顶副窗口 + 鼠标穿透与 `⌘L` 接线**
- 范围：`app/src-tauri/src/main.rs`、`app/src-tauri/capabilities/default.json`、`app/src/components/TopBar.tsx`、`app/src/App.tsx`
- 目标：Rust 新增 `toggle_overlay_window`（动态创建/显隐 `overlay` 透明无边框置顶窗口 `760×116`）与 `set_overlay_click_through(enabled: bool)`（调用 `set_ignore_cursor_events`）；顶栏新增克制的「悬浮字幕 (`⌘L`)」与「穿透锁定」按钮并绑定 `⌘L` 快捷键，同时在 `index.html`/`global.css` 确保 overlay 模式下 `html/body` 透明。
- 验收：`cd app && npx tsc --noEmit && npm run build && cd src-tauri && cargo check`

**M5-03 [Sol] `⌘M` 重点金句打点 + Markdown 顶部速览导出**
- 范围：`app/src/store/session.ts`、`app/src/components/Segment.tsx`、`app/src/App.tsx`、`app/src/lib/ws-client.test.ts`
- 目标：支持按 `segmentId` 切换重点书签（`⌘M` 标记当前最新/活跃段落，或点击段落悬停 `Bookmark` 图标；已打点段左侧显示 `2px` `--accent` 细竖线）；导出 Markdown 时若有打点段落，顶部自动生成 `# 实时语音转写记录` + `## 重点打点速览`（含 `HH:MM:SS` 与摘要）再输出全文。
- 验收：`cd app && npx tsc --noEmit && npx vitest run && npm run build`

**M5-04 [Sol] 会话原声自动缓存 + `/audio/latest.wav` 与 `/caption` 本地路由**
- 范围：`scheduler/src/ws-server.ts`、`scheduler/src/main.ts`、`scheduler/src/audio-http.test.ts`
- 目标：录制时将 `16kHz/Mono/s16le` 帧同步追加写入 `data/sessions/<sessionId>.pcm`（并在 `segment.start` 前或会话内以首个段起点对齐）；同一 loopback `47800` HTTP 服务新增 `GET /audio/latest.wav`（动态合成 44B WAV 头 + 支持 `Range: bytes=...` `206` 随机寻址，录制中与结束后均可播）以及 `GET /caption`（零配置 OBS 透明双行字幕页，复用本地 `/ws`）。
- 验收：`cd scheduler && npx tsc --noEmit && npx vitest run src/audio-http.test.ts`

**M5-05 [Sol] 点击时间戳原声点读（Click-to-Play）**
- 范围：`app/src/hooks/useAudioPreview.ts`、`app/src/components/Segment.tsx`、`app/src/App.tsx`
- 目标：点击任意段落左侧 `HH:MM:SS` 时间戳，计算该段相对本轮首段的秒数偏移，通过 `<audio>` 加载 `http://127.0.0.1:47800/audio/latest.wav` 跳转到对应秒数播放原声（播放该段期间时间戳高亮 `--accent` 并显示播放态，再次点击或播完该段时长自动暂停）。
- 验收：`cd app && npx tsc --noEmit && npx vitest run && npm run build`

**M5-06 [Sol] 全量测试回归与重新打包 Release `.app`**
- 范围：`scripts/package-mac.sh`（如需适配，否则零改动直接执行验收）
- 目标：跑通 Swift + Scheduler + App 全部单测，重新构建包含 v0.2 全部新特性的 `R2T2 Transcriber.app` 并清理多余 debug 包。
- 验收：`bash scripts/package-mac.sh && test -d "app/src-tauri/target/release/bundle/macos/R2T2 Transcriber.app"`
