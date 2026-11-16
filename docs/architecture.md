# 架构（v0，2026-11-17）

> 控制流自上而下；每一层都能单独替换。模型只出「意图」，坐标与手势由代码保证。
> 目标分层图：`docs/research/architecture.html` / `architecture-v0.png`。
> 行为层的完整设计（多路感知、页面图、三个能力、注意力、探针）见 [`behavior-layer.md`](behavior-layer.md)。

## 分层

| 层 | 职责 | 代码（规划） | 现状 |
|---|---|---|---|
| ① 意图 | DeepSeek 出 `Intent` | 插件侧的 DSH 会话 | 旧插件 |
| ② 节奏 | 在不在线、要不要现在做、延迟采样 | `src/rhythm/` | 未开始 |
| ③ 编排 | Intent → 技能调用、预算/幂等/pre/post/熔断 | `src/orchestrator/` | 未开始 |
| ④ 拟真 | **只做功能地板**：按压 ≥40 ms + MOVE、逐字提交、滑动留末速 | `src/humanizer/` | 未开始（统计拟真已降级，见 D11） |
| ⑤ 执行 | 唯一改设备状态的地方、单写者串行 | `src/act/` + `android/injector` | 未开始 |
| ⑥ 感知 | a11y / OCR / 通知 / 剪贴板往返 / `dumpsys` / 稳定帧 | `src/perception/` | 未开始 |
| ⑦ 世界模型 | 每会话类型/未读/串/冷却 + 焦点/IME/屏幕 | `src/world/` | 未开始 |
| ⑧ profile | 微信的页面图与会话语义 | `src/profiles/wechat/` | 未开始 |
| ⑨ 技能库 | 她能做的每件事（闭集、声明式、无坐标） | `src/skills/` + `skills/` | **契约与校验已落**，执行器未开始 |
| ⑩ 注意力 | 机会检测 → 打分 → 预算 → 让位 | `src/attention/` | 未开始 |
| — | 事件流 + 回放（横切） | `src/events.ts` `src/eventlog.ts` `src/artifacts.ts` | **M0 已有** |

依赖方向只能向下（①→⑧），横切的事件层谁都可用。`profiles/` 不许 import `orchestrator/` 的内部类型。

## 进程与协议（草案，M3 前可改）

```
dsh-wechat-usb  ──HTTP 127.0.0.1:65480 + Bearer token──▶  mimicd  ──adb──▶  手机
```

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | `{ok, run, version, device:{serial, online}, paused, dryRun}` |
| GET | `/state` | 世界模型快照（会话列表、串、冷却、焦点、IME、屏幕） |
| GET | `/skills` | 技能注册表 + 校验问题（设置页直接显示） |
| GET | `/events?afterSeq=` | 增量事件（回放/监控用；不分页就 SSE） |
| POST | `/intent` | `{kind, chat, text?, params?, idem}` → `{accepted, planId}`；幂等键重复提交返回同一 plan |
| POST | `/observe` | 强制一次感知（调试用） |
| POST | `/control` | `{action:"pause"\|"resume"\|"dry_run"\|"drain"}` |

**契约纪律**
- 插件**不**直接碰 adb；引擎是唯一执行者。
- 引擎离线时插件只读降级（报「引擎离线」），**不许**自己发。
- `/intent` 是异步受理：受理 ≠ 发出。结果从 `/events` 里读 `send.succeeded` / `send.failed`（对应旧文档「决策与执行分开记账」）。
- 协议类型单独定义在 `src/protocol/`，不复用引擎内部类型；新增字段必须可选。
- 意图里的 `kind` 只能是注册表里出现过的 `intent`，或 `wait` / `escalate`；引擎不认识就拒绝，不猜。

## 数据目录

```
data/
  events/2026-11-17/run-r-20261117-230015-a1b2.jsonl
  artifacts/2026-11-17/<sha 前两位>/<sha256>.png
  config.json            # 引擎配置（拟真参数、白名单、通道开关）
  pages/wechat-1080x2160.json    # 页面图：元素比例矩形（可替换，不写死坐标）
  stickers/index.json    # 贴纸库：哈希 → 标签 / 首次见到 / 来源
  knowledge/links.jsonl  # 读过的链接：url / 标题 / 摘要 / 在哪看到的
```

事件信封与写入规则见 `DECISIONS.md` D8；`src/eventlog.ts` 是唯一写入点。

## 稳定帧（M1 的核心）

一次「等」= 等到**连续 N 帧画面哈希不变**，而不是睡固定时间。

```
settle(page, action):  # 分档，写在动作层
  tap            → 等 2 帧不变，硬超时 1200 ms
  swipe          → 等惯性停（2 帧不变），硬超时 2000 ms
  enter_chat     → 等标题出现（元素级），硬超时 3000 ms
  send           → 等自己气泡出现（元素级），硬超时 3000 ms
```

帧计数来源：`dumpsys gfxinfo <pkg> framestats` 的帧号 + 截图区域哈希。两条都拿不到时降级为「两次截图间隔 ≥ 400 ms 且哈希相同」，并在事件里标 `stability:"degraded"`。

## 页面图与未知页面

页面图存 `data/pages/`，每个页面：`detect`（像素探针 / 元素存在 / Activity）、`elements`（名字 → 比例矩形）、`exits`。
图外页面：截图 → 记 `page.unknown` → 退回最近已知页面 → 不进决策，并进「待补页面图」队列。

## 失败与降级

| 故障 | 行为 |
|---|---|
| 注入器没起来 / dex 被杀 | 重试一次；仍失败 → 切 `input` 兜底并标 `channel:"input-fallback"`；连续 3 次 → 引擎 paused，只读 |
| 截图全黑 | 判为锁屏/灭屏，不做动作，发 `note`；唤醒失败 → escalate |
| OCR 超时 | 本帧丢弃，记 `frame.captured{ocr:"timeout"}`；连续 5 帧 → 降级到页面探针 |
| 页面类型低置信 / 未知页面 | 只做低风险动作（回列表、看一眼），不主动开口 |
| 剪贴板被占用 | 放弃本次高保真读取，记 `note`，回退 OCR；**绝不**覆盖未知内容的剪贴板 |
| 技能 post 不满足 | 记 `failed` + 原因，升级给人；**不重试不可撤销动作** |
| 用户手动碰手机 | `input` 事件来自真实 `deviceId>=0` → 引擎立刻让位 60 s |

## 未定

1. 注入器与引擎的通道：`adb forward tcp` + 本地 socket（草案）vs 每次 `app_process` 起停（慢但无状态）。倾向后者先做，前者再优化。
2. 世界模型持久化：JSON 快照 + 事件重放（可重建）vs SQLite。倾向「事件是真相，快照只是加速」。
3. 多手机：当前只支持一台；`serial` 已是显式配置，先不抽象。
4. 贴纸哈希算法：dHash 64 bit 够不够区分相似的二次元表情（实测再定，可能加主色直方图）。