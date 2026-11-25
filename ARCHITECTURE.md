# ARCHITECTURE.md

> 唯一事实源：`docs/r2t2-reference.md`（M0 已实测核验）。引擎 = `audio.cpp (Confucius4-R2T2)`，F16 或 Q8_0，禁 Q4；引擎侧采用 HTTP/1.1 全双工 Chunked + SSE，前端侧仍为本地 WebSocket。

## 1. 目录结构

```
./
├── ARCHITECTURE.md  TASKS.md  AGENTS.md  DESIGN.md
├── docs/r2t2-reference.md          # 单一事实源（M0 已回填）
├── capture/
│   ├── mac/                        # Swift Package, 可执行名 `capture-mac`
│   │   ├── Package.swift
│   │   └── Sources/capture-mac/{main.swift, SCKCapture.swift, MicCapture.swift, Resampler.swift, WavDump.swift, Devices.swift}
│   └── win/                        # 预留: capture-win (WASAPI loopback), 同一 CLI 契约
├── scheduler/                      # Node 22 + TypeScript (strict), 本地调度服务
│   ├── package.json  tsconfig.json
│   └── src/
│       ├── main.ts                 # 入口: 启动 WS 服务 + 编排
│       ├── config.ts               # 端口/路径/常量(见 §3)
│       ├── protocol.ts             # 前端 WS 消息类型 (zod)
│       ├── ws-server.ts            # 对前端 WS (127.0.0.1)
│       ├── process-manager.ts      # 子进程(capture / audiocpp_server)启停、心跳、重启退避
│       ├── capture-reader.ts       # 读 stdout, 按帧切 Buffer
│       ├── vad/{silero.ts, segmenter.ts}   # Silero 推理 + 分段状态机
│       ├── asr/{adapter.ts, r2t2-adapter.ts, mock-adapter.ts}
│       ├── hotwords-store.ts       # JSON 持久化
│       ├── level-meter.ts          # RMS/peak 计算
│       └── transcript-log.ts       # 追加写 jsonl, 崩溃恢复/导出源
├── app/                            # Tauri 2 + React + TS + Tailwind + shadcn/ui + lucide-react
│   ├── src-tauri/                  # 仅: 拉起 scheduler sidecar、文件对话框、窗口; 无业务逻辑
│   └── src/{components, hooks, lib/ws-client.ts, store, styles}
├── scripts/                        # build-audiocpp.sh, fetch-models.sh, m0-*.sh, e2e-*.sh
├── fixtures/                       # 本地新闻口播 .wav (16k/mono/s16le), 热词清单, 参考文本
├── third_party/audio.cpp/          # git clone, gitignore
├── models/                         # GGUF + silero.onnx, gitignore
└── data/                           # 运行期: hotwords.json, sessions/*.jsonl (gitignore)
```

## 2. 数据管道

```
 ScreenCaptureKit(48k F32 stereo) / Mic
        │  capture-mac: 重采样 → 16kHz Mono s16le
        ▼ stdout (裸 PCM, 无头)
 ┌──────────────── scheduler ────────────────┐
 │ capture-reader: 凑满 FRAME(=10240B/320ms) │
 │   ├─► level-meter ──► WS `level` (10Hz)   │
 │   ├─► Silero VAD (每帧 10×512 样本窗)      │
 │   └─► segmenter ──► R2T2Adapter ──► 引擎   │
 │ 结果 delta ──► transcript-log ──► WS `transcript.delta` ──► Tauri/React
 └───────────────────────────────────────────┘
```

### 2.1 数值常量（`config.ts` 唯一定义处）

| 常量 | 值 |
|---|---|
| 采样格式 | 16000 Hz / 1ch / s16le，2 字节/样本 |
| 默认帧 FRAME_MS | 320 → 5120 样本 → **10240 B**（可配 160 → 2560 样本 → **5120 B**） |
| VAD 窗 | 512 样本(32ms)=1024 B；320ms 帧=10 窗；160ms 帧=5 窗 |
| 尾部静音 TAIL_SILENCE | 300ms = 4800 样本 = **9600 B 全 0x00** |
| 预卷 PREROLL | 320ms（语音起点前回放，防吞首字） |
| SOFT_CUT_AT | 60 s：此后静音 ≥ 500ms 即切 |
| NEAR_CUT_AT | 75 s：此后静音 ≥ 200ms 即切 |
| FORCE_CUT_AT | 90 s：立即强切，不等静音 |
| WATCHDOG | **100 s**：看门狗兜底强切（引擎硬上限 110s，留 10s 余量） |
| IDLE_CLOSE | 会话内持续静音 ≥ 1500ms → 正常收尾关闭会话 |
| VAD 阈值 | speech_prob ≥ 0.5 为语音；< 0.35 为静音（滞回） |

### 2.2 VAD 状态机

```
            speech≥0.5 (连续≥2窗)
 IDLE ───────────────────────────► SPEAKING   [open session, 注入热词, 先送 PREROLL]
  ▲                                   │ prob<0.35
  │                                   ▼
  │  silence≥1500ms              PAUSING (silenceMs 累加, 帧仍送引擎)
  │◄──── FLUSH_AND_CLOSE ◄────────────┤
  │                                   │ speech 恢复 → SPEAKING
  │                                   │ 切段条件满足 (见下) → ROTATING
  │                                   ▼
  │                              ROTATING: FLUSH_AND_CLOSE → open 新会话(重注热词) → SPEAKING/PAUSING 继承
  └── 用户 stop: 任意状态 → FLUSH_AND_CLOSE → IDLE
```

切段条件（任一，segLen=当前会话已送音频时长）：
1. `segLen ≥ 60s` 且 `silenceMs ≥ 500`
2. `segLen ≥ 75s` 且 `silenceMs ≥ 200`
3. `segLen ≥ 90s`（强切，无需静音）
4. `segLen ≥ 100s` 看门狗（与 3 同流程，额外上报 `warn`）

### 2.3 FLUSH_AND_CLOSE（300ms 尾字静音 + 无缝切换）

1. 停止向旧会话转发新帧；新到帧进入 `pending` 队列（不丢音频）。
2. 向旧会话发送 **9600 B 全零**（可按 FRAME 拆块，总量不得少于 9600 B）。
3. 调 `adapter.finish()`（发送 END），等待 `final` 文本，超时 3s 仍未返回则记 `warn` 并 `abort()`。
4. 若为 ROTATING：立即 `open()` 新会话（读取**最新** `hotwords-store`，实现热词下一分段热生效），先 flush `pending` 再续流。
5. 段落间文本在前端连续追加，`segmentId` 自增，UI 不感知切换。
6. 时间戳：调度层在**收到某段首个 delta 的本机时间**记 `tsMs`（引擎无词级时间戳）。

## 3. 进程间通信

### 3.1 采集 CLI 契约（Mac/Win 同一契约）

```
capture-mac --source system|mic [--device-id <id>] [--dump-wav <path>] [--frame-ms 320]
capture-mac --list-devices        # stdout 输出一行 JSON 后退出
```
- **stdout**：仅裸 PCM（16k/mono/s16le/LE），无头无分隔，连续输出，写入粒度 = 整帧。严禁往 stdout 写任何日志。
- **stderr**：每行一个 JSON 日志：`{"lvl":"info|warn|error","code":"...","msg":"..."}`；就绪：`{"lvl":"info","code":"READY"}`；权限缺失：`code":"PERM_DENIED"`，随后以退出码 `3` 退出。
- `--list-devices`：`{"devices":[{"id":"...","name":"...","kind":"input|system"}]}`。
- 退出码：0 正常(SIGTERM)；2 参数错误；3 权限；4 设备不可用；5 内部错误。
- `--dump-wav`：同步写 16k/mono/16bit 标准 WAV 头+数据（SIGTERM 时回填头长度）。
- 重采样：48k F32 stereo → 下混 mono（均值）→ 16k 低通抗混叠重采样 → clip → int16。

### 3.2 前端 ↔ 调度层 WebSocket

`ws://127.0.0.1:47800/ws`，仅绑定 loopback，文本 JSON，每条含 `type`；协议版本 `v:1`。同一本地 HTTP Server 同时暴露只读辅助路由：
- `GET http://127.0.0.1:47800/audio/latest.wav`：动态封装 44 字节 `16kHz/1ch/s16le` WAV 头并支持 `Range: bytes=...`（`206 Partial Content`），供主界面点击时间戳原声点读（录制中与结束后均可用）。
- `GET http://127.0.0.1:47800/caption`：纯透明背景只读字幕 HTML 页（连同一本地 `/ws`），供 OBS Browser Source 直接叠加直播画面。

客户端 → 服务端：

| type | 字段 |
|---|---|
| `hello` | `v` |
| `devices.list` | — |
| `session.start` | `source:"system"|"mic"`, `deviceId?`, `frameMs?:160|320` |
| `session.stop` | — |
| `hotwords.set` | `hotwords:string[]`, `background:string` |
| `hotwords.get` | — |
| `export.request` | `format:"md"|"txt"`, `sessionId` |

服务端 → 客户端：

| type | 字段 |
|---|---|
| `hello.ok` | `v`, `engine:{name,quant}`, `state` |
| `state` | `state:"idle"|"starting"|"running"|"stopping"|"error"`, `vad:"idle"|"speaking"|"pausing"|"rotating"` |
| `devices` | `devices[]` |
| `level` | `rmsDb`, `peakDb`, `tsMs`（≈10Hz） |
| `segment.start` | `segmentId`, `tsMs` |
| `transcript.delta` | `segmentId`, `seq`, `text`, `tsMs`（append-only，前端禁止回改） |
| `segment.end` | `segmentId`, `reason:"pause"|"soft"|"force"|"watchdog"|"stop"`, `durMs` |
| `hotwords` | `hotwords[]`, `background`, `appliesFromSegment` |
| `export.ready` | `path` |
| `warn` / `error` | `code`, `msg` |

### 3.3 R2T2Adapter 接口（调度层 ↔ 引擎）

```ts
// scheduler/src/asr/adapter.ts —— 签名为稳定契约; 内部实现严格对齐 docs/r2t2-reference.md §3
export interface AsrSessionOptions {
  language: "Chinese";
  chunkMs: 160 | 320;
  context: string;            // 热词+背景词拼接结果
}
export interface AsrSession {
  pushAudio(pcm: Buffer): void;                    // s16le 16k mono
  finish(): Promise<void>;                         // 发 END 并等 final
  abort(): void;
  onDelta(cb: (text: string) => void): void;       // append-only
  onFinal(cb: (text: string) => void): void;
  onError(cb: (e: Error) => void): void;
}
export interface AsrAdapter {
  start(): Promise<void>;                          // 拉起 audiocpp_server 并健康检查
  openSession(o: AsrSessionOptions): Promise<AsrSession>;
  stop(): Promise<void>;
}
```
**M0 实测回填区**（来自 `docs/r2t2-reference.md` §3 实测版）：
- 启动命令/参数：`audiocpp_server --config <server.json> --no-ui`（`backend: "metal"`, `family: "confucius4_r2t2"`, `mode: "streaming"`, `session_options: {"confucius4_r2t2.chunk_size_ms": 160, "confucius4_r2t2.unfixed_chunk_num": 2, "confucius4_r2t2.unfixed_token_num": 2}`）
- 传输协议与路由：HTTP/1.1 全双工流式 `POST /v1/audio/transcriptions/live?model=r2t2-stream&sample_rate=16000&channels=1&sample_format=s16le&language=Chinese&prompt=<url-encoded>`（非 WebSocket；请求体 `Transfer-Encoding: chunked` 裸 PCM，响应体 SSE）
- 会话初始化（热词字段）：Query 参数 `language=Chinese` 与 `prompt=<URL 编码热词/背景词>`
- END 控制帧格式：写入 ≥9600B 全零静音后发送 HTTP/1.1 终止块 `0\r\n\r\n`（`req.end()`）
- 结果 SSE schema：delta = `{"type":"transcript.text.delta","delta":"..."}`；final = `{"type":"transcript.text.done","text":"...","timing":{"ttft_ms":...}}`；结束 = `data: [DONE]`
- 并发能力：单模型槽位互斥（同一时刻 1 个活跃流），VAD 切段按顺序 finish 旧流再开新流（期间新帧入 `pending` 队列，新流就绪后突发冲刷追帧）
- M2 接入强约束（详见 `docs/r2t2-reference.md` §3.4）：必须使用 `node:http`（禁 `fetch`/`undici`/`axios`）、`req.flushHeaders()`、`setNoDelay(true)`、`setTimeout(0)`、`StringDecoder('utf8')` 按 `\r?\n\r?\n` 切帧、静音不保活 + `320~640ms` Pre-roll、`prompt` 去换行且编码前 `<= 250` 字符、`done` 尾字前缀/LCP 补齐

## 4. 稳定性设计（1~3 小时）

- `process-manager`：子进程异常退出 → 指数退避重启（1s/2s/4s，上限 5 次/分钟），重启期间音频进入有界环形缓冲（≤10s），超限丢弃并 `warn`。
- 背压：WS 慢消费者仅丢 `level`，永不丢 `transcript.*`。
- `transcript-log`：每个 delta 即时 `appendFile` 到 `data/sessions/<id>.jsonl`，崩溃后可恢复/导出。
- 内存：固定帧复用 Buffer，禁止无界数组累积。

## 5. Mac / Windows 适配边界

| 层 | Mac（现） | Windows（后） | 跨平台共享 |
|---|---|---|---|
| 采集 | `capture/mac` Swift, ScreenCaptureKit + AVAudioEngine | `capture/win` WASAPI Loopback + 麦克风，同一 CLI 契约 | stdout PCM 契约、stderr JSON |
| 权限 | 屏幕录制/麦克风 TCC | 无 | `PERM_DENIED` 码 |
| 引擎 | audio.cpp Metal | audio.cpp CUDA / Vulkan | `AsrAdapter` |
| 引擎路径/可执行名 | `audiocpp_server` | `audiocpp_server.exe` | `config.ts` 按 `process.platform` 解析 |
| VAD | onnxruntime-node (CPU) | 同 | 全部 |
| 调度层 | Node sidecar | 同 | 全部 |
| 前端 | Tauri (WKWebView, 毛玻璃 vibrancy) | Tauri (WebView2, Mica 或纯色回退) | React 代码；毛玻璃用 CSS 变量降级 |
| 打包 | `.app` + dmg, 签名公证 | `.msi/nsis` | `scripts/` 分平台 |

移植时**只允许**新增 `capture/win/` 与 `config.ts` 的平台分支及 CI，不得改动 `vad/`、`asr/adapter.ts`、`protocol.ts`、前端。
