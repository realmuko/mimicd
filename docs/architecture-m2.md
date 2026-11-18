# M2 架构：自动监测 + 自动聊天

> 2026-11-17 · 对应 `src/daemon/`、`src/monitor/`、`src/world/`、`src/policy/`、`src/brain/`
> 一句话：**引擎自己看列表、自己进会话、自己判断该不该回、自己说一句、自己发出**，全程只落事件、不靠人。

---

## 1. 一张图

```
                    ┌──────────────────────────── mimicd daemon ────────────────────────────┐
  手机（USB）         │                                                                      │
  ┌──────────┐  adb  │  ┌──────────┐   ┌──────────┐   ┌─────────┐   ┌────────┐   ┌────────┐  │
  │ 真机微信  │◄─────►│  │ device 层 │──►│ monitor  │──►│  world  │──►│ policy │──►│ brain  │  │
  │ 8.0.80   │ 注入器 │  │ adb/触摸/ │   │ 扫列表/读 │   │ 会话状态 │   │ 硬规则  │   │ 出稿子  │  │
  │          │ 输入法 │  │ 输入法    │   │ 尾部消息  │   │ 去重/冷却 │   │        │   │        │  │
  └──────────┘        │  └──────────┘   └──────────┘   └─────────┘   └────────┘   └───┬────┘  │
                      │        ▲                                                发文本 │       │
                      │        └────────────────────── act（技能执行器）◄────────────┘       │
                      │                                       │                              │
                      │                                  events（JSONL）                      │
                      │                                       │                              │
                      │              HTTP 127.0.0.1:65480  ─────┴──────────►  /health /state │
                      │                                                    /events /intent   │
                      └──────────────────────────────────────────────────────────────────────┘
```

## 2. 一轮 tick 的完整时序

```
1. ensureList()      不在列表就 back（最多 3 次，防搜索页/浮层卡住）
2. 扫列表            screencap → OCR(列表区) → 红点连通块 → 行 y ↔ 会话名
3. 选会话            pickChat：白名单过滤 → 未读优先
4. 进会话            injector.tap(行) → waitStable(标题栏区域)
5. 读尾部            OCR(消息区) → 按左右分「我/对方」→ 合并气泡换行
6. 进世界            world.ingest 多重集去重 → 新增消息（fresh）
7. 判                 policy.decide → {reply, reason}
8. 想                brain.reply(最近 12 条上下文) → 一句话
9. 发                skill runner → wechat.send_text（打字 + 点发送 + 校验）
10. 记账             world.markReplied + cooldownUntil + save；事件落盘
11. 回列表           back → 下一轮
```

每一轮的产物：`frame.captured`（列表）、`message.seen`（每条新消息）、`intent.decided`（回不回、为什么）、
`action.executed`（技能内部动作）、`send.succeeded` / `send.failed`。

## 3. 各层职责与边界

| 层 | 输入 | 输出 | 不做的事 |
|---|---|---|---|
| device | 命令 | 截图 / 触摸 / 文本 | 不做判断 |
| monitor | 截图 + OCR | `ListRow[]`、消息列表 | 不决定回不回 |
| world | 消息 | 会话状态、去重、上下文 | 不碰设备 |
| policy | 会话 + 新消息 | `{reply, reason}` | 不生成文本 |
| brain | 上下文 | 一句话 | 不碰设备、不判断该不该回 |
| act / runner | 技能 + 参数 | 动作 + 事件 | 不决定说什么 |
| daemon | 定时器 / HTTP | 调度 + 外部接口 | 不含业务规则 |

依赖方向单向：daemon → 各层；各层之间只有 monitor→world→policy→brain→act 这一条链。

## 4. 关键设计点（都有实测支撑）

1. **未读只能看红点**：微信 a11y 全封，列表行没有文本节点。红点是头像右上角连通块，尺寸 10–90px，
   行内多个红块按 y 合并；名字靠同一行的 OCR 取最上面一条。
2. **「谁说的」只能靠横向位置**：气泡中心 x > 55% 屏宽判为「我」。这条也是 `requireOtherSide` 的实现基础。
3. **去重必须按多重集**：同一屏会被反复 OCR，但真正的新消息可能和旧消息同字（「哈哈」）。
   规则：最近 20 条内同文本的计数当「预算」，本轮读到几次抵扣几次，剩下的才算新。
4. **tick 只处理一个会话**：单窗口是物理约束（同一时刻只有一个聊天页），多会话在时间上轮流。
5. **政策全在代码里**（静默时段/冷却/限频/白名单），prompt 只负责「怎么说」。这是旧插件最大的债之一，不重复。
6. **脑子可插拔**：`ScriptedBrain` 用于测试与冒烟；`HttpBrain` 打任何 OpenAI 兼容端点。
   引擎不关心是谁在说话，只关心「给我一句能发的话」。
7. **事件是真相**：world 只是加速缓存，删掉 `data/world.json` 也能从事件流重建。

## 5. HTTP 契约

> v3 交接链路（待办 ↔ 主模型）看 [`architecture-v3.md`](architecture-v3.md)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活、暂停、干跑、设备页面、上一轮结果 |
| GET | `/state` | 世界快照（会话、未读、冷却、最近消息） |
| GET | `/events?afterSeq=&limit=` | 增量事件（回放/监控用） |
| GET | `/skills` | 技能清单 + 校验问题 |
| GET | `/pending` | 待回复队列（交接模式） |
| POST | `/pending/reply` | `{id, text}` 或 `{id, stickerMood}` → 引擎发送（排队等设备锁） |
| POST | `/pending/skip` | `{id, reason}` → 跳过并落 `intent.skipped` 事件 |
| POST | `/pending/inject` | 测试用：不等真消息就能验整条链（需 `--allow-pending-inject`） |
| POST | `/observe/link` | `{chat, which?}` → 读一条链接（AI 摘要优先，正文兜底） |
| POST | `/intent` | `{skill, params}` → 执行技能（走同一把设备锁） |
| POST | `/control` | `pause` / `resume` / `dry_run` / `wet` / `tick` |
| POST | `/tick` | 立即跑一轮（调试） |

只监听 `127.0.0.1`，可选 `token`（`Authorization: Bearer` 或 `?token=`）。
`/intent` 同步返回，但**不可逆动作**（发送）在技能里是 `idempotency: unsafe`，调用方要自己防重。
设备锁：`tick` 撞到忙就跳过；`/pending/reply` 与 `/observe/link` 会排队等锁（45s / 30s）。

## 6. 失败与降级

| 情况 | 行为 |
|---|---|
| 回不到列表（搜索页/浮层） | 本轮放弃，记 reason，下一轮再试 |
| 进会话后画面不稳定 | 退列表，记 reason |
| OCR 读不到消息 | 本轮 fresh 为空 → 不回复 |
| 脑子超时/报错 | 记 `note`，本轮不回，不重试 |
| 发送技能失败 | 记 `send.failed`，不重试（不可撤销） |
| 注入器掉线 | daemon 启动时自检失败直接退出，不裸跑 |
| 手机断开（`no devices` / `offline`） | tick 捕获 → 60s 后重试；第 2 轮起自动 `kill-server` → `start-server` → 重建 `forward`；每 5 分钟打一次 `[alert]` |
| adb 命令被强杀（超时 / 超 buffer） | 不半路丢流：`spawn` + `taskkill /T /F` 收进程树，错误带 `recoverable`，下一轮立刻重置 server |
| 引擎退出 / Ctrl+C | 先清掉还在跑的 adb 客户端（孤儿客户端会一直占着设备），再关 HTTP |

> adb 层为什么用 `spawn` 而不是 `execFile`、为什么启动时要先重置一次 server，见 `src/device/adb.ts` 顶部注释。
> 跳过启动重置：`--no-adb-reset`。

## 7. 怎么跑

```bash
# 1) 注入器与输入法（手机插着）
node tools/inject/deploy.ts --adb "<adb>"
node tools/ime-mode.ts --adb "<adb>" on

# 2) 干跑看一轮（不真发）
node tools/daemon.ts --adb "<adb>" --once --dry-run

# 3) 正式跑：每 20 秒一轮，HTTP 在 65480
node tools/daemon.ts --adb "<adb>" --interval 20
curl -s localhost:65480/health
curl -s -X POST localhost:65480/control -d '{"action":"pause"}'
```

配置：`data/config.example.json` 复制成 `data/config.json`。白名单默认空（不限）——
**真机上建议先设成自己的小号或文件传输助手，别直接上群聊。**

## 8. 验证矩阵

| 层 | 验证方式 | 结果 |
|---|---|---|
| world 去重/持久化 | 单测 6 个（含「同字新消息」与坏文件） | 通过 |
| monitor 红点/名字/左右分 | 单测 9 个（合成截图 + OCR 行） | 通过 |
| policy 白名单/静默/冷却/限频 | 单测 8 个 | 通过 |
| brain scripted/http | 单测 4 个（含请求体与错误） | 通过 |
| daemon HTTP | 单测 4 个（health/state/skills/intent/control/token/404） | 通过 |
| 整循环（有未读→回一句） | AutoChat 单测：假设备 + 假 OCR + scripted brain | 通过 |
| 真机扫描 | `--once --no-send`：红点+名字校准 | 2 个真未读，名字全对 |
| 真机自动回复 | `--chat 文件传输助手 --targeted-send-ok` | replied=true，消息真的发出（08:49） |
| 真机群聊安全 | `--chat 摸鱼 --no-send` | 判定「群里没 @ 我」，一条没发 |
| 真机进错会话 | 列表重排导致点错 | 标题核对拦下，未执行任何动作 |

## 9. 已知限制

0. **真实他人入站未跑通**：需要第二个客户端（PC 微信/另一台手机）发一条消息；
   目前真机闭环是用文件传输助手 + `targeted-send-ok` 验证的，发送内容带「（自动回复测试）」前缀。

1. **一个 tick 只处理一个会话**，热闹的时候会有延迟；多会话按未读顺序轮。
2. **读消息靠 OCR**：小字、表情、引用会读歪；要精确文本得走「长按→复制」（技能 `obs.text_bubble` 已支持，但监控循环还没用它）。
3. **群 @ 识别依赖 OCRO 文本**：已支持「[有人@我]」与 `@昵称`（昵称要配 `selfNames`），但读歪了就漏回——宁可漏不可错。
4. **没有图片/语音理解**：读不出内容，只能看到占位。
5. **没有防「自己刚发完又触发」的严格时间窗**：靠 `requireOtherSide` + 冷却挡。
6. **HTTP 没有鉴权默认值**：`token` 要自己配。