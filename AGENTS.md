# AGENTS.md — 写给 Codex (GPT-6.2 Sol) 的施工宪法

## 0. 开工必读（每个会话）
先读 `ARCHITECTURE.md`、`docs/r2t2-reference.md`，再只读 `TASKS.md` 中**被指定**工单。不读无关工单。

## 1. 单工单铁律
1. 每个会话**只执行一张**指定工单（如 `M2-03`）。不得顺手做下一张，不得"顺便重构"。
2. 只允许修改该工单「文件范围」内的文件（≤3 个）。需要范围外改动 → 停止，在汇报里写明原因，不要擅自改。
3. 完成后**必须亲自运行**该工单的验收命令，并贴出命令与输出结尾。
4. 验收未通过 → 继续修复直到通过；不得以"基本完成/需用户测试"提前结束。确实被外部条件阻塞（权限、网络、缺权重）→ 明确写 `BLOCKED: 原因 + 需要人做的一步`，不得假装通过。
5. 汇报格式（≤8 行）：工单号 / 改动文件 / 验收命令 / 结果 / 遗留风险。

## 2. 技术栈红线（禁止变更）
- 前端：Tauri 2 + React + TypeScript(strict) + Tailwind CSS + shadcn/ui + lucide-react。
- 采集：Mac = 独立 Swift CLI（ScreenCaptureKit）；经 stdout 输出裸 PCM；Win 预留同契约实现。
- 调度层：Node 22 + TypeScript，独立进程；前端只通过本地 WebSocket 与其通信。
- 引擎：`audio.cpp (Confucius4-R2T2)`，仅 F16 / Q8_0。
- **严禁**引入或建议 Whisper / Paraformer / X-ASR / FunASR / 任何云端 ASR 或联网调用；严禁 Q4/4-bit 解码器权重。运行期不得有任何外网请求。
- 不新增依赖，除非工单明确列出。

## 3. 事实源与引擎协议约束（M0 已核验）
- `audio.cpp` 的启动配置（`server.json`）、流式路由（`POST /v1/audio/transcriptions/live`）、Query 参数与 SSE Schema **只能**取自 `docs/r2t2-reference.md` §3（M0 实测版）。**严禁**凭旧印象将引擎侧写为 WebSocket。
- 引擎流式请求必须使用单一 `Transfer-Encoding: chunked` 裸 PCM，**严禁**携带 `Expect: 100-continue`；结束时必须先送 ≥9600B 全零静音再发送 HTTP/1.1 终止块 `0\r\n\r\n`（`req.end()`），严禁直接断开 TCP。
- 单模型槽位互斥：同一时刻仅允许 1 个活跃流式请求；VAD 切段必须严格按「旧流补静音 → `req.end()` 等 `transcript.text.done` → 开新请求」顺序执行。
- 所有 `audiocpp_server` 协议细节只存在于 `scheduler/src/asr/r2t2-adapter.ts`，其他文件禁止出现引擎路由或字段名。

## 4. 音频与分段红线
- 全链路音频格式 **16kHz / Mono / int16 little-endian**；采集层负责重采样，调度层与引擎永不接收 48k/Float32/Stereo。
- 常量只在 `scheduler/src/config.ts` 定义（帧 10240B/320ms、尾静音 9600B、60/75/90/100s 阈值），其他处引用，不得写魔法数。
- VAD 分段必须按 `ARCHITECTURE.md` §2.2 状态机；任何会话在 100s 前必须切换。
- **每次**会话结束/分段/用户停止，在发 END 前必须先送 ≥300ms（9600B）全零静音。严禁绕过。
- 每次新会话必须重新注入**最新**热词与背景词。
- 转写文本 append-only：前后端均禁止回改已输出文字。
- stdout 只放 PCM，日志只走 stderr。

## 5. 代码规范
- TypeScript `strict`，禁 `any`；Swift 无 force-unwrap 于外部输入。
- 函数小而纯；模块边界以 `ARCHITECTURE.md` 目录为准，不新建顶层目录。
- 长时稳定：禁无界缓冲、必须清理定时器/子进程/监听器；子进程必须随父进程退出。
- 不写与工单无关的注释、README、示例；不提交 `models/`、`third_party/`、`data/`。
- 测试/验收脚本放 `scripts/` 或工单指定位置，必须非交互、可重复、失败返回非 0。

## 6. 停止条件
遇到：需要改架构、协议与文档矛盾、需改范围外文件、验收标准无法满足 —— 停止并汇报，由架构师裁决。不得自行变通。
