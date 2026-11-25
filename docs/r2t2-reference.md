# Confucius4-R2T2 & audio.cpp 技术参考规范（Single Source of Truth）

> **致 AI 架构师（重要）：** `Confucius4-R2T2` 为 2026 年 11 月开源的最新流式语音大模型，晚于常规预训练知识截止时间。**严禁**依据旧经验将其替换为 Whisper、Paraformer 或 X-ASR，所有架构与接口设计必须严格以本文档为准。

## 1. 模型定位与核心特性

* **模型名称：** `Confucius4-R2T2`（网易有道开源，基于 `Qwen3-ASR-1.7B` 微调的 2B 参数端到端流式语音大模型）
* **权重仓库：**
  * `audio.cpp` 专用单文件自包含 GGUF（已内嵌 tokenizer、chat_template、model_spec，**M0 实测验证推荐**）：`davidxifeng/Confucius4-R2T2-gguf`（`r2t2-f16.gguf` 约 4.09 GB、`r2t2-q8_0.gguf` 约 2.48 GB）
  * 上游官方仓库：`netease-youdao/Confucius4-R2T2`（Safetensors）及 `netease-youdao/Confucius4-R2T2-GGUF`（`llama.cpp` 分体式 GGUF + mmproj，非 `audio.cpp` 单文件包格式）
* **运行精度要求（强约束）：**
  * 目标开发机为 **MacBook Pro M5 Pro (48GB 统一内存)**，未来需兼容 Windows（CUDA / Vulkan）。
  * 必须使用 **F16（约 4.09GB）** 或 **Q8_0（约 2.48GB）** 权重。
  * **严禁对解码器使用 Q4 / 4-bit 量化**（实测会显著拉低识别精度）。
* **核心推理机制：**
  * 引入最长稳定前缀（LSP）与显式 `WAIT` 机制，160ms~320ms 切片下中文平均输出延迟约 `0.53s ~ 0.75s`。
  * **Append-only（吐字不回改）：** 一旦输出文字即永久锁定，无传统流式模型的"草稿闪烁覆盖"问题。
  * **上下文/热词原生支持：** 支持在解码时注入背景文本或专有名词热词（如"十五五规划"、发布人姓名、生僻地名）。
* **已知能力边界：**
  * 不输出词级时间戳（Word Timestamps），仅提供文本流，段落时间戳需由调度层记录收到首字/分段时的本地系统时间。
  * 授权协议为 `Confucius4-R2T2 Model Use License`，架构上需保留引擎可插拔能力以便未来按需替换。

## 2. 推荐推理引擎与音频规格

* **首选推理后端：** 纯 C++ 实现的 `audio.cpp`（基于 `llama.cpp` 生态，`audiocpp_server`），macOS 下原生支持 Metal GPU 加速，Windows 下支持 CUDA / Vulkan，无重型 Python 深度学习框架依赖。
* **备选后端：** 网易有道官方仓库提供的 WebSocket 推理服务。
* **标准音频输入格式（必须严格对齐）：**
  * 采样率：`16000 Hz`
  * 声道：`1`（Mono 单声道）
  * 编码格式：`PCM signed 16-bit little-endian (int16 / s16le)`
* **推荐推流步长：**
  * `160ms` 切片 = `2560` 采样点 = **`5120` 字节 / 帧**（低延迟优先）
  * `320ms` 切片 = `5120` 采样点 = **`10240` 字节 / 帧**（吞吐与精度均衡，新闻发布会默认推荐）

## 3. 启动参数与流式传输协议（M0 实测核验版）

> 以下内容已于 2026-11-25 基于 `0xShug0/audio.cpp`（commit `86d9355`，Apple M5 Pro Metal 后端）源码与实机运行核验完成。

### 3.1 编译与二进制路径

* **仓库地址：** `https://github.com/0xShug0/audio.cpp.git`
* **精简 Metal 编译（仅链接 `confucius4_r2t2`，无需完整 Xcode，Command Line Tools 即可）：**
  ```bash
  cmake -S third_party/audio.cpp -B third_party/audio.cpp/build/macos-metal-release -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DENGINE_ENABLE_CUDA=OFF -DENGINE_ENABLE_VULKAN=OFF \
    -DENGINE_ENABLE_METAL=ON -DENGINE_ENABLE_OPENMP=OFF -DGGML_OPENMP=OFF \
    -DENGINE_ENABLE_LLAMAFILE=ON -DENGINE_ENABLE_NATIVE_CPU=ON -DGGML_METAL_EMBED_LIBRARY=ON \
    -DAUDIOCPP_DEPLOYMENT_BUILD=ON -DAUDIOCPP_MODEL_SET=custom -DAUDIOCPP_MODELS=confucius4_r2t2
  cmake --build third_party/audio.cpp/build/macos-metal-release --parallel 14 --target audiocpp_server --target audiocpp_cli
  ```
* **产物路径：** `third_party/audio.cpp/build/macos-metal-release/bin/audiocpp_server`（及 `audiocpp_cli`）

### 3.2 `audiocpp_server` 启动命令与配置文件

* **启动命令：**
  ```bash
  audiocpp_server --config scripts/m0-server.json --no-ui
  ```
  常用 CLI 覆写参数：`--host <ip|unix:path>`（默认 `127.0.0.1`）、`--port <port>`（默认 `8080`）、`--backend metal|cuda|vulkan|cpu`、`--device <id>`、`--threads <n>`、`--busy-timeout-ms <ms>`（默认 `300000`）、`--no-ui`、`--log`、`--log-file <path>`、`--list-devices --json`、`--version`。
* **配置文件 Schema（`server.json`）：**
  ```json
  {
    "host": "127.0.0.1",
    "port": 19488,
    "backend": "metal",
    "device": 0,
    "threads": 4,
    "lazy_load": false,
    "max_loaded_models": 1,
    "live_ingest": {
      "idle_timeout_ms": 30000,
      "total_timeout_ms": 180000,
      "max_body_bytes": 536870912,
      "max_chunk_bytes": 8388608,
      "send_timeout_ms": 30000
    },
    "models": [
      {
        "id": "r2t2-stream",
        "family": "confucius4_r2t2",
        "path": "/abs/path/to/models/Confucius4-R2T2-GGUF/r2t2-q8_0.gguf",
        "task": "asr",
        "mode": "streaming",
        "session_options": {
          "confucius4_r2t2.chunk_size_ms": 320
        }
      }
    ]
  }
  ```
  *注：单模型 `session_options` 支持 `confucius4_r2t2.chunk_size_ms`（默认 `320`，可设 `160`）、`unfixed_chunk_num`（默认 `2`）、`unfixed_token_num`（默认 `5`）、`rollback_punctuation`（默认 `false`）、`max_tokens`（默认 `32`）。健康检查路由：`GET /health` 返回 `{"status":"ok","backend":"metal","models":1,...}`。*

### 3.3 实时流式识别传输协议（HTTP/1.1 全双工 Chunked + SSE）

> **关键核验结论：** `audiocpp_server` 原生实时流式识别接口不是 WebSocket，而是 **HTTP/1.1 全双工流式传输**（请求体为 `Transfer-Encoding: chunked` 裸 PCM，响应体在同一连接上实时返回 `text/event-stream` SSE）。调度层 `R2T2Adapter` 内部封装该 HTTP/1.1 流式连接，调度层 ↔ Tauri 前端仍维持 `ARCHITECTURE.md` 定义的本地 WebSocket。

* **路由：** `POST /v1/audio/transcriptions/live`
* **Query 参数：**
  * `model`（必填）：配置中的模型 `id`（如 `r2t2-stream`）
  * `sample_rate`（默认 `16000`）：采样率
  * `channels`（默认 `1`）：声道数
  * `sample_format`（默认 `s16le`）：`s16le` 或 `f32le`
  * `language`（可选）：锁定语种，传 `Chinese`（映射至 `task_request.options["language"]`）
  * `prompt`（可选）：URL 编码的热词/背景上下文（如 `十五五规划,新质生产力,...`，映射至 `task_request.text_input.text`，等价于 CLI `--text`）
  * `busy_timeout_ms`（可选）：等待模型锁超时
* **请求头与请求体：**
  * 必须携带 `Transfer-Encoding: chunked`（仅允许单一 `chunked` 编码，不可带 `Expect: 100-continue`）。
  * 持续写入 `16kHz/Mono/s16le` 裸 PCM 字节块（推荐每块 320ms = 10240B）。
* **结束信号（END）：**
  * 先写入至少 `300ms`（9600B）全 `0x00` 静音帧，再发送 HTTP/1.1 终止块 `0\r\n\r\n`（Node.js `req.end()`）。**严禁**不发终止块直接断开 TCP，否则服务端视为异常截断并拒绝返回 `transcript.text.done`。
* **响应 SSE 事件 Schema（`data: <payload>\n\n`）：**
  * 追加增量（append-only）：`{"type":"transcript.text.delta","delta":"..."}`
  * 最终完整文本（含未提交尾字）：`{"type":"transcript.text.done","text":"...","timing":{"ttft_ms":123.4}}`
    * **工程要点：** `delta` 仅输出已锁定的稳定前缀，末尾 `unfixed_token_num`（默认 5）个 token 不会作为 `delta` 发出，而是在 `transcript.text.done` 的完整 `text` 中一并返回。`R2T2Adapter` 收到 `done` 时，必须比对已发射的累计 delta，将未发射的尾部后缀作为最后一条补齐增量输出，避免末尾漏字或重复拼接。
  * 流结束标记：`data: [DONE]`
  * 错误响应：HTTP 4xx/5xx JSON 或 SSE error 事件。
* **并发约束：** 每个模型槽位由 `busy_timeout_ms` 互斥锁保护，单槽位同一时刻仅支持一个活跃流式请求；VAD 分段切换时需按"旧流补静音 → `req.end()` 等 `done` → 开新请求"顺序执行。
* **业务隔离要求：** 所有 `audiocpp_server` 协议细节严格收敛于 `scheduler/src/asr/r2t2-adapter.ts`。

### 3.4 M2 调度层接入强约束（必须严格遵守）

1. **HTTP/1.1 全双工客户端锁定：** `scheduler/src/asr/r2t2-adapter.ts` 必须使用 Node.js 原生 `node:http`（`http.request`）实现 HTTP/1.1 全双工 Chunked + SSE，**严禁**使用 `fetch` / `undici` / `axios`；显式设置 `Transfer-Encoding: chunked`，禁发 `Content-Length` 与 `Expect: 100-continue`，建连后立即 `req.flushHeaders()`，socket 开启 `setNoDelay(true)` 与 `setTimeout(0)`。
2. **SSE UTF-8 安全切帧：** SSE 解析必须使用 `StringDecoder('utf8')` 按 `\r?\n\r?\n` 缓冲切帧，防止中文多字节字符或 JSON 跨 TCP 包截断。
3. **静音不保活 + Pre-roll 环形缓冲：** 静音待机时不保持空闲 HTTP 连接（规避服务端 `idle_timeout_ms: 30000` 超时断连），本地维护 `320ms~640ms` Pre-roll 环形缓冲，VAD 检测到人声后再建连并先发 Pre-roll。
4. **分段切换 Pending 队列不丢帧：** 分段切换期间（旧流补 `300ms` 全零静音帧 → `req.end()` → 等 `transcript.text.done`），新到达的 PCM 帧必须写入内存 Pending 队列，待新流就绪后突发冲刷追帧，严禁丢弃切换期音频。
5. **Prompt 长度护栏与尾字 LCP 补齐：** Query 参数 `prompt` 必须去除换行并限制编码前长度 `<= 250` 字符（防 HTTP 414 超长）；收到 `transcript.text.done` 时优先前缀匹配补齐未提交的尾部 `unfixed_token_num`，未严格匹配时按最长公共前缀（LCP）补齐并打 `warn` 日志。

### 3.5 M0 实机验效记录（Apple M5 Pro / Metal / Q8_0）

* **测试样本：** `fixtures/news01.wav`（23.49s，16kHz/Mono/s16le），热词 `十五五规划,新质生产力,粤港澳大湾区,雄安新区,成渝地区双城经济圈,国务院新闻办公室`。
* **Burst 推流（无热词）：** 总耗时 `11.35s`（RTF `0.48`），首字 `1555ms`，正文零错字。
* **实时 320ms 推流（带热词 + 300ms 尾静音）：** 音频 23.49s + 尾静音 0.30s，总耗时 `24.07s`（结束后 ~280ms 返回 `done`），所有专有名词与“十五五规划”均准确命中，尾字无吞字。

## 4. 必须遵守的 4 条工程硬约束（架构防踩坑红线）

1. **110 秒连续流硬上限（必做 VAD 分段）：**
   * `Confucius4-R2T2` 单次未切分的连续流式会话上限约为 **110 秒**，超时会导致识别退化或断连。
   * **架构解法：** 在音频采集层与 R2T2 引擎之间，必须设置本地调度层并接入轻量级 **Silero VAD**。策略为：检测到发言人自然停顿（如 `400ms~600ms` 静音）且当前段已超过安全阈值，或单段连续时长逼近 **60~90 秒**（强制在最近短停顿处切分）时，主动结束当前 R2T2 流并无缝开启新会话；前端文本区保持连续滚动，对用户无感。
2. **句尾补静音帧防吞字（必做）：**
   * 如果在发言人刚说完最后一个字的瞬间立刻发送流结束信号，模型容易吞掉末尾 1~2 个字。
   * **架构解法：** 每次分段结束或用户点击停止录音，在发送 `END` 控制帧之前，调度层必须自动追加发送至少 **`300ms` 的全零静音帧**（即 `4800` 个 int16 采样点 = **`9600` 字节全 `0x00`**），再触发结束并等待最终文本回传。
3. **热词上下文跨分段持久化：**
   * 每次 VAD 自动分段重建 R2T2 流会话时，调度层必须把用户当前配置的"会前热词与背景词"重新注入新会话；用户在会议中途修改热词后，需在下一个分段自动热生效（或手动触发安全重连生效）。
4. **严格分离实时音频采集与重采样：**
   * macOS 系统内录（`ScreenCaptureKit`）默认输出常为 `48kHz Float32 Stereo`，严禁直接推给 R2T2。采集插件必须在推送前完成 **48kHz Float32 Stereo -> 16kHz Int16 Mono** 的无损重采样，并保留 `--dump-wav` 调试开关用于人工听音验收。
