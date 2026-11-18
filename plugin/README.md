# dsh-mimicd-wechat

DSH（DeepSeek Harness）与 [mimicd](../README.md) 引擎之间的**瘦适配层**。

```
mimicd（独立进程，独占手机）            DSH
  感知 / 判断 / 发送 / 待办队列  ──HTTP──▶  ①wechat_* 工具
  127.0.0.1:65480                       ②bridge：待办 → 叫醒会话
                                        ③设置页（状态 / 启停 / 配置）
```

插件**不碰手机**：没有 adb、没有 OCR、没有点击，也没有 `wechat_shot` /
`wechat_send` / `wechat_open` 这类旧工具 —— 设备由引擎独占，
主模型的职责只剩「写要发的那句话」，发送由引擎执行。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主侧：注册工具、桥接生命周期、设置页 API 后端 |
| `client.js` | 设置页 UI（DSH `settings.section` 槽位，无浮窗） |
| `lib/engine.js` | mimicd HTTP 客户端（node:http，分接口超时） |
| `lib/bridge.js` | `/pending` 轮询 → `schedule.create` 叫醒会话（含重试/超时/看门狗） |
| `lib/api.js` | 设置页本机 API（`127.0.0.1:65482`，代理引擎 + 读写插件配置） |
| `lib/config.js` | 插件配置读写/校验 |
| `lib/sessions.js` | 只读列出本机 DSH 会话（设置页选唤醒会话） |
| `lib/format.js` | 纯格式化（工具返回值 / 设置页摘要） |
| `cordis.patch.yml` | 插到 DSH profile 的 bundle patch |

## 工具（宿主侧）

| 工具 | 说明 |
| --- | --- |
| `wechat_engine_status` | 引擎在线/暂停/dry-run、uptime、设备焦点与页面、最后一轮原因、待办条数、桥接状态 |
| `wechat_reply_pending` `{id,text?,stickerMood?}` | 把主模型写的话（或一个表情）交给引擎发出；文字+表情可同时给 |
| `wechat_skip_pending` `{id,reason?}` | 这条不接，理由写进引擎事件 |
| `wechat_say` `{chat,text?,stickerMood?}` | 主动搭话；引擎按安静时段/限额/群聊开关把关，拒绝会说明原因 |
| `wechat_stickers` | 表情库概况（情绪 → 张数） |
| `wechat_chats` `{limit?}` | 最近会话（按 `lastSeenAt` 倒序，来自 `/state`） |
| `wechat_read_link` `{chat,which?}` | 让引擎打开链接读正文（慢，几十秒） |

## 配置

`wechat-mimicd.config.json`（首次运行缺失时会从 `.example.json` 生成）：

```json
{
  "bridge": {
    "enabled": true,
    "engineUrl": "http://127.0.0.1:65480",
    "sessionId": "",
    "intervalMs": 8000
  },
  "tools": { "enabled": true }
}
```

- `enabled`：桥接总开关。
- `engineUrl`：工具和桥接都用它；只支持 `http(s)://`。
- `sessionId`：被叫醒的 DSH 会话 id；**空 = 不叫醒任何会话**（工具照常可用）。
- `intervalMs`：轮询 `/pending` 的间隔，2000–120000，默认 8000。
- `tools.enabled=false`：`wechat_*` 调用直接报错，桥接也不会启动（唤醒后没有回话工具）。

配置写盘走「临时文件 + rename」，设置页保存后桥接立即按新配置重启，不用重启 DSH。

引擎自己的配置在 `../data/config.json`（mimicd 仓库的 `data/`，可用
`MIMICD_CONFIG` 覆盖）。引擎的 HTTP 层没有写配置的接口，设置页只读展示 +
提示文件路径；要改就编辑文件并重启引擎。引擎若启用了 `token`，把同样的值放进
环境变量 `MIMICD_TOKEN`，工具和桥接会自动带上 `Authorization: Bearer`。

## bridge 怎么工作

每 `intervalMs` 轮询 `GET /pending`，对没见过的待办调用一次
`schedule.create({ title, prompt, timing:{kind:"at", at}, target:{kind:"session", sessionId} })`
（失败时退回旧签名）。prompt 里包含：会话/群聊类型、最近对话、待办 id、回话工具说明、
表情库情绪列表；群聊消息按「昵称：内容」显示。

三处保护（旧插件踩过的坑，别删）：

1. **叫醒 25s 超时**：`schedule.create` 可能永不 resolve；超时算本次失败，走重试计数。
2. **同一条待办最多 3 次**：失败 3 次后放弃并记日志，不会每 8 秒刷一辈子。
3. **#busy 看门狗**：某轮超过 60s 没结束就强制复位并记日志，避免桥接「看着活着、其实再没动过」。

启动日志会写明轮询间隔、叫醒超时、看门狗时长和引擎地址；日志在
`data/plugin.log`（自动轮换到 `plugin.log.1`）。

群聊提示词明确写了「不用等 @」：有自然接话口就接，完全插不上或会打断正事才跳过；
没被 @ 的待办（`needsJudgment`）也按同样判断，不会被忽略。

## 设置页

DSH 设置里新增「mimicd 微信」一节（`settings.section` 槽位，不是浮窗），每 3 秒刷新：

- **监控**：引擎在线/暂停/干跑、uptime、最后一轮（时间 + acted + reason + 会话）、
  设备焦点/页面、会话概览（未读、最后一条、活跃时间、冷却剩余）、待办队列
  （id 尾号、几秒前、剩余有效期、消息摘要、「跳过」按钮）、最近事件流
  （可勾选显示心跳事件、可跳引擎自带状态页）。
- **启停**：暂停/恢复（`/control`）、切到干跑/恢复真发（`/control dry_run|wet`）、
  强制跑一轮（`/tick`）、清空/忽略某条待办（`/pending/skip`）。
- **插件配置**：桥接开关、引擎地址、轮询间隔、唤醒会话（从本机 DSH 会话里选）、
  工具开关；保存即生效；显示桥接运行细节（上次轮询/叫醒、看门狗复位、最后错误）。
- **引擎配置（只读）**：白名单、群聊策略（judge / mention）、静默时段、同会话最小间隔、
  每小时上限、单条字数、同会话冷却、合并窗口（`mergeWindowMs` / `maxMergeWaitMs`）、
  主动搭话限额、表情概率。引擎的 HTTP 层没有写配置的接口，页面里明确标注「只读 + 文件路径」。
- **重启引擎**：只显示命令提示（`scripts/run-daemon.cmd` 或手动命令），插件不执行重启。

设置页 UI 通过本机 API `http://127.0.0.1:65482` 取数；该服务只监听回环，
只放行本机 `127.0.0.1/localhost/[::1]` 的 Origin（和 `dsh-app://`、`null`），其余 403。

## 安装（由 lead / 用户统一做）

1. 在 profile 的 `package.json` 依赖里加：
   ```json
   "dsh-mimicd-wechat": "link:<repo>/plugin"
   ```
   （或 `file:`；link 便于本地改代码）。把 `dsh-mimicd-wechat` 加进
   `dsh.profile.bundles`，然后 `pnpm install`。
2. 在 profile 的 `cordis.patch.yml` 里加：
   ```yaml
   - insert:
       - id: dsh-mimicd-wechat
         name: dsh-mimicd-wechat
         config: {}
   ```
3. 重启（或重载）DSH，让宿主加载插件和 `client.js`；设置页出现「mimicd 微信」。
4. 在设置页选「唤醒会话」并确认桥接变成「运行中」。
   - 需要用户确认：安装 `link:<repo>/plugin` 路径、profile 里新增 bundle 的顺序、
     以及用哪个 DSH 会话承接唤醒。
5. 卸载旧插件 `dsh-wechat-usb` 后再启用本插件：两者都注册 `wechat_*` 前缀
   （本插件没有旧插件的设备工具），不要同时启用。

## 本地检查

```bash
cd <repo>/plugin
npm run check   # node --check 全部 .js
npm test        # node:test：配置 / 格式化 / 引擎客户端 / 桥接重试、超时、看门狗 / 设置页 API
```

需要环境：Node ≥ 22（用了 global fetch 的测试与 `node --test`）；mimicd 引擎
`http://127.0.0.1:65480` 在线时设置页才有数据，引擎离线时工具和设置页都会给出
「连不上引擎」的明确错误，不会自己去碰手机。