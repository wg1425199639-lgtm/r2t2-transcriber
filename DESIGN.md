# DESIGN.md — macOS 原生极简专业工作台

原则：像 Notes/Xcode，不像 AI 产品。零渐变、零发光、阴影仅用于浮层。信息密度低，文字是唯一主角。

## 1. 布局
```
┌──────────┬───────────────────────────────────────────┐
│ Sidebar  │ TopBar: 音源 ▾  ▮▮▮▯▯ 电平  ●00:42:10  [开始/停止] │
│ 240px    ├───────────────────────────────────────────┤
│ 毛玻璃    │         Transcript (居中, max-w 42em)       │
│ 热词/背景  │                                [↓ 回到最新] │
│ 导出区    │                                            │
└──────────┴───────────────────────────────────────────┘
```
窗口最小 960×600；Sidebar 可折叠（⌘\）。使用 Tauri `titleBarStyle: Overlay` + 原生红绿灯，严格遵守防撞规则：
- Sidebar 顶部留出红绿灯安全区（`38px` 顶部留白）；
- Sidebar 折叠时，TopBar 左侧动态增加 `78px` 左边距避免与红绿灯重叠；
- 顶部空白拖拽区统一绑定 `data-tauri-drag-region`（交互控件除外）。

## 2. 色彩 Token（`app/src/styles/tokens.css`，跟随系统，可手动切换）

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#1C1C1E` | 主区背景 |
| `--bg-sidebar` | `rgba(246,246,247,.72)` | `rgba(38,38,40,.62)` | 侧栏（`backdrop-filter: blur(24px) saturate(1.2)`；Win 回退纯色 `#F3F3F4/#262628`） |
| `--bg-elevated` | `#FAFAFA` | `#2C2C2E` | 输入框、chip 底 |
| `--border` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.10)` | 1px 细边框 |
| `--text` | `#1D1D1F` | `#E8E8EA`（非纯白，降眩光） | 正文 |
| `--text-2` | `#6E6E73` | `#98989D` | 时间戳、次要 |
| `--text-3` | `#A1A1A6` | `#636366` | 占位、禁用 |
| `--accent` | `#2F6FEB` | `#5B8DEF` | 仅用于焦点环、主按钮、选中；**纯色，禁渐变，禁紫** |
| `--hit-bg` | `rgba(47,111,235,.10)` | `rgba(91,141,239,.16)` | 命中热词底 |
| `--ok` / `--warn` / `--danger` | `#2E9E5B / #C98A00 / #D13438` | `#4CC38A / #E0A92E / #F0636A` | 电平/状态 |
| `--selection` | `rgba(47,111,235,.22)` | `rgba(91,141,239,.30)` | 选中文本 |

规则：对比度正文 ≥ 7:1（AAA），次要 ≥ 4.5:1；圆角 8px（chip 6px，按钮 8px）；阴影仅 `0 8px 24px rgba(0,0,0,.12)` 用于「回到最新」与弹层；禁用 `bg-gradient-*`、`shadow-lg/xl`、`ring` 光晕。

## 3. 中文排版死规则
- 字体栈：`"PingFang SC", -apple-system, "SF Pro Text", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`；数字/时间戳 `"SF Mono", ui-monospace` + `font-variant-numeric: tabular-nums`。
- 正文：`font-size: 20px`（可设 18/20/22/24），`line-height: 1.75`（上限 1.8），`letter-spacing: .01em`，`font-weight: 400`；禁斜体、禁两端对齐（`text-align: left`）。
- 行宽：转写容器 `max-width: 42em`（≈ 38~45 汉字），水平居中；窗口变宽仅增加留白。
- 标点：`line-break: strict; word-break: normal; hanging-punctuation` 尽量；避免标点开头行。
- 段落：每个 VAD 分段为一个自然段，段间距 `1.25em`；段首左侧 gutter 显示时间戳 `HH:MM:SS`（`--text-2`, 13px, 等宽，hover 才完整显示；与正文基线对齐）。
- 命中热词：`--hit-bg` 底 + `border-radius: 3px` + `padding: 0 2px`，字重/颜色不变；禁加粗、禁下划线、禁变色。
- 当前正在生成的末尾：末字后附 2px 宽、`--text-2` 的细光标，1.2s 缓闪（仅 opacity）。

## 4. 高频交互
**Append-only 追加**：文本只在末尾追加，不回改。新增字符 `opacity 0→1`，120ms `ease-out`，无位移、无弹跳；历史已完成段落必须使用 `React.memo` 冻结，仅当前唯一活跃段落允许按整段重算热词高亮（防止热词跨 delta 拆分漏标）；过滤空白段落不占位；使用 `content-visibility: auto` 对远端段落做虚拟化，3 小时文本滚动保持 60fps。

**智能滚动锁定**
- 默认 `stick=true`：新文本到来时平滑贴底（`scrollTo` 直接设置，无动画抖动）。
- 用户 `wheel/touchmove/键盘 PageUp·↑·Home` 向上滚动 → **立即** `stick=false`，停止一切自动滚动。
- `stick=false` 时右下浮出胶囊「↓ 回到最新 · N 段新内容」（高度 32px，圆角 999，`--bg-elevated` + 1px 边框 + 浮层阴影，120ms 淡入）。
- 点击胶囊或快捷键 `⌘↓` → 平滑滚到底并 `stick=true`；用户手动滚到距底 < 24px 也自动恢复 `stick=true`。
- 追加内容时按 `scroll-anchor` 保持用户当前阅读位置不抖动。

**侧边栏**
- 会前热词：chip 列表（回车添加，× 删除，粘贴支持逗号/换行批量）；搜索过滤；条数计数。
- 背景词：多行文本框（占位示例"十五五规划、国务院新闻办……"）。
- 底部显示 `当前字数 / 250` 轻提示（按归一化后长度计，`hotwords` 优先计入 250 字符额度，超额时截断背景词并轻提示）；修改后底部淡出提示「将从第 N 段起生效」；不打断录制。
- 底部「导出」区：`导出 Markdown` / `导出 TXT` / `复制全文`，分段控件，次按钮样式。

**音频电平**（TopBar）
- 12 格横条，高 8px，dB 映射 -60→0；绿 `--ok`，> -6dB 变 `--warn`，削波 `--danger`；60fps 平滑，衰减时间常数 300ms。
- 录制中静音 > 3s：电平条变 `--warn`，旁显「未收到声音」；断线显示 `--danger` 点 +「采集中断，重连中」。
- 录制状态：红点 + 等宽计时 `HH:MM:SS`；开始/停止为单一主按钮（`⌘R`）。

**键盘**：`⌘R` 开始/停止，`⌘\` 侧栏，`⌘↓` 回到最新，`⌘E` 导出 MD，`⌘+/-` 字号。

## 5. 组件与图标
shadcn/ui 基础组件（Button/Input/Select/Toggle/Tooltip）覆盖为上述 token；图标仅 Lucide，线宽 1.5，16px，色 `--text-2`。无插画、无 emoji、无欢迎页（空状态一行灰字："选择音源并点击开始"）。
