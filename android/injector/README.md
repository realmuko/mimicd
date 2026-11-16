# 架构（v0，2026-11-17）

> 控制流自上而下；每一层都能单独替换。模型只出「意图」，坐标与手势由代码保证。
> 图：`docs/research/architecture.html` / `architecture-v0.png`

## 分层

| 层 | 职责 | 代码（规划） | 现状 |
|---|---|---|---|
| ① 意图 | DeepSeek 出 `Intent` | 插件侧的 DSH 会话 | 旧插件 |
| ② 节奏 | 在不在线、要不要现在做、延迟采样 | `src/rhythm/` | 未开始 |
| ③ 编排 | Intent → 动作计划、预算/幂等/pre/post/熔断 | `src/orchestrator/` | 未开始 |
| ④ 拟真 | 运动计划（tap/swipe/key 时间线） | `src/humanizer/` | 未开始 |
| ⑤ 执行 | 唯一改设备状态的地方、单写者串行 | `src/act/` + `android/injector` | 未开始 |
| ⑥ 感知 | a11y / OCR / 像素探针 / 稳定帧 | `src/perception/` | 未开始 |
| ⑦ 世界模型 | 每会话类型/未读/串/冷却 + 焦点/IME/屏幕 | `src/world/` | 未开始 |
| ⑧ profile | 微信的页面地图与会话语义 | `src/profiles/wechat/` | 未开始 |
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
| GET | `/events?afterSeq=` | 增量事件（回放/监控用；不分页就 SSE） |
| POST | `/intent` | `{kind, chat, text?, idem}` → `{accepted, planId}`；幂等键重复提交返回同一 plan |
| POST | `/observe` | 强制一次感知（调试用） |
| POST | `/control` | `{action:"pause"\|"resume"\|"dry_run"\|"drain"}` |

**契约纪律**
- 插件**不**直接碰 adb；引擎是唯一执行者。
- 引擎离线时插件只读降级（报「引擎离线」），**不许**自己发。
- `/intent` 是异步受理：受理 ≠ 发出。结果从 `/events` 里读 `send.succeeded` / `send.failed`（对应旧文档「决策与执行分开记账」）。
- 协议类型单独定义在 `src/protocol/`，不复用引擎内部类型；新增字段必须可选。

## 数据目录

```
data/
  events/2026-11-17/run-r-20261117-230015-a1b2.jsonl
  artifacts/2026-11-17/<sha 前两位>/<sha256>.png
  config.json            # 引擎配置（拟真参数、白名单、通道开关）
  coords/wechat-1080x2160.json   # 页面元素矩形（可替换，不写死坐标）
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

## 拟真参数

默认值见 `docs/research/设计前调研.md` §3。落成 `data/config.json` 的 `humanizer` 段，每个参数带 `source` 字段（`ahb` / `cmu` / `aosp` / `self:<采集日期>`）。调试开关 `humanizer.enabled=false` 时全部退化为固定值，便于对照。

## 失败与降级

| 故障 | 行为 |
|---|---|
| 注入器没起来 / dex 被杀 | 重试一次；仍失败 → 切 `input` 兜底并标 `channel:"input-fallback"`；连续 3 次 → 引擎 paused，只读 |
| 截图全黑 | 判为锁屏/灭屏，不做动作，发 `note`；唤醒失败 → escalate |
| OCR 超时 | 本帧丢弃，记 `frame.captured{ocr:"timeout"}`；连续 5 帧 → 降级到页面探针 |
| 页面类型低置信 | `unknown`：只做低风险动作（回列表、看一眼），不主动开口 |
| 用户手动碰手机 | `input` 事件来自真实 `deviceId>=0` → 引擎立刻让位 60 s |

## 未定

1. 注入器与引擎的通道：`adb forward tcp` + 本地 socket（草案）vs 每次 `app_process` 起停（慢但无状态）。倾向后者先做，前者再优化。
2. 世界模型持久化：JSON 快照 + 事件重放（可重建）vs SQLite。倾向「事件是真相，快照只是加速」。
3. 多手机：当前只支持一台；`serial` 已是显式配置，先不抽象。

<｜DSML｜ calls>
<｜DSML｜ invoke name="write">
<｜DSML｜ parameter name="content" string="true"># 输入注入器（android/injector）

**这是唯一需要构建的部件。** 一个 Java 类，编译成 dex，推到手机上用 `app_process` 起起来；它通过反射拿 `InputManager` 的注入接口，按我们给的参数合成触摸事件。scrcpy 用的是同一条路。

## 为什么需要它

`adb shell input` 在 AOSP 里是写死的：DOWN/UP 同一时间戳（按压 0 ms）、`pressure=1.0`、`size=1.0`、无 `touchMajor/minor`、无中间 MOVE、无 history。四条里任意一条都够把「这是程序」判出来。

注入器改不了 `deviceId`（`injectInputEvent` 会强制改写成 `VIRTUAL_KEYBOARD_ID=-1`，这是 AOSP 故意留的口子），但其余全部可控：按压时长、压力曲线、接触面积、每个 MOVE 的时间戳、history 批、`toolType`。我们把「单事件取证」从三条判据压到一条，代价是不用 root。

## 构建

```bash
# 需要 JDK 17+ 与 Android build-tools（d8）。台机上目前都没有，第一次跑要装（~250 MB）。
javac -source 11 -target 11 -d build/classes src/mimic/Injector.java
d8 --min-api 29 --output build/ build/classes/mimic/*.class
# → build/classes.dex，推到 /data/local/tmp/mimic-injector.dex
```

## 运行与接口（草案）

```bash
adb push build/classes.dex /data/local/tmp/mimic-injector.dex
adb shell "CLASSPATH=/data/local/tmp/mimic-injector.dex app_process /system/bin mimic.Injector --port 7801"
adb forward tcp:7801 tcp:7801
```

单行 JSON 请求 → 单行 JSON 回复：

```json
{"op":"tap","x":540,"y":1200,"downMs":65,"pressure":[0.5,0.62],"size":0.12}
{"op":"swipe","path":[[540,1800],[541,1700],[545,1500]],"t":[[0],[12],[28]],"downMs":90}
{"op":"key","text":"你好","perCharMs":[80,110,95]}
{"op":"ping"}
```

- `tap`：DOWN 在 `(x,y)`，`downMs` 后 UP，中间按 8 ms 间隔插 MOVE（压力/面积在区间内游走）。
- `swipe`：`path` 与 `t`（相对 ms）由引擎的 Humanizer 生成，注入器只负责精确重放，保证「计划即事实」。
- `key`：走 `commitText`，逐字提交，间隔由引擎给（中文按词组，见调研 E10）。
- 注入器**不懂**微信，只懂坐标与时间。

## 纪律

- 每次动作必须带 `downMs` 与至少一个 MOVE；0 ms 按压不允许（既是拟真问题，也会让长按/双击不稳定）。
- 注入器不决定任何参数；参数全部来自 `data/config.json` 的 `humanizer` 段，便于 A/B 与一键关闭。
- 版本与引擎绑定：`protocol` 字段版本不一致时引擎拒绝启动注入器，避免「装了新的、跑着旧的」。