# Lead 自采笔记（草稿，供最终合成用）

> 时间：2026-11-16 晚。这一份是我自己查的，队友四路在跑（01~04）。不要直接给用户看。

## A. 现状（读代码/文档得到的事实）

- 插件输入路径极原始（`<dsh-wechat-usb>\lib\core.js`）：
  - `tap()` → `input tap x y`（第 202-204 行）
  - `key()` → `input keyevent`（206-208 行）
  - 发送：`input tap` 输入框 + `sleep 0.5` + `keyevent MOVE_END` + `ADB_CLEAR_TEXT` 广播 + `ADB_INPUT_TEXT` 广播（406-409 行）
  - 滑动：`input swipe 540 1680 540 720 200`（poller.js:919，固定 200ms）
  - 坐标写死 1080×2160（poller.js:870 等）
  - 所有 adb 调用是 `execFileSync` 同步阻塞；`sleep()` 用 ping 实现的秒级粒度（core.js 210-214）
- 也就是说：**当前没有任何「拟真」层**——没有按压时长、没有轨迹、没有逐字、没有阅读停顿、没有动作后验证（只有个别地方 probe 页面）。
- 旧文档自己已经指出：感知不可靠 vs 决策要确定、单窗口串行 vs 多会话、实时 vs 模型延迟、规则在代码 vs 规则在 prompt、状态分散 vs 可回放。
- 新架构图（architecture-current.png，11-16 21:30）：主模型只发 Action（不输出坐标）；感知 L1 8 个 + 执行 L1 13 个；EventStore 是 journal 不是总线；最大缺口：① EventStore 成为唯一协调方式 ② 旧 poller 换 PerceptionService ③ Action 契约（reply/send_sticker/open_link/read/scroll/back）④ 主模型只发 Action ⑤ 多窗口回复 ⑥ qwen3-vl:4b。

## B. 关键事实（我核过的）

### B1. Android 注入事件在事件层是可识别的（重要）

AOSP CTS `VerifyInputEventTest`（`cts/tests/tests/view/src/android/view/cts/VerifyInputEventTest.java`）：
- 测试名：`testDeviceIdBecomesVirtualForInjectedKeys` / `...ForInjectedMotions`
- 断言：注入事件即使带了「真实 deviceId=1」，应用收到的 `event.getDeviceId()` 也会被改成
  `INJECTED_EVENT_DEVICE_ID = KeyCharacterMap.VIRTUAL_KEYBOARD`（= -1）。
- 注释原文："Ensure that injected key events that contain a real device id get injected as virtual device events, to prevent misrepresentation of actual hardware."
- 另：`InputManager.verifyInputEvent(event)` 用系统 HMAC 校验事件是否被动过；注入事件本身**仍能被 verify 通过**（CTS 里 assertNotNull），所以它不是「注入检测器」；但 `getDeviceId() == -1` 是。
- uiautomator2 维护者（issue #423 讨论）：「Injected events can always be detected, depending on whether the app wants to do so or not. This lib is for testing, not for security related purposes.」
- 推论（我）：`input tap` 走 `InputManager.injectInputEvent`，与 UiAutomation 同一路径 → 同样带虚拟 deviceId；且 `input` 生成的 MotionEvent 是「单点 DOWN+UP、pressure=1、size=1、无中间 MOVE、无 history」——真手指事件有压力/尺寸变化、有抖动轨迹。**结论：事件层拟真只能靠 uinput/真实 HID 路径，`input tap` 永远不是「真触摸」。**

### B2. Terminal-Bench 2.0（arXiv 2601.11868，2026-01）
- 89 个任务、每个任务独立环境 + 人写解法 + 完整测试；前沿模型 <65%。
- 评测范式值得抄：**环境隔离 + 可验证的终态断言（不是看过程）**；harness 开源（tbench.ai / harbor-framework/terminal-bench）。
- 对「拟真控制」的启示：拟真度也要能被「终态断言」测，而不是靠肉眼看像不像。

### B3. 现成可抄的人类输入模型（有具体参数）
- `crawlex`（Rust，docs.rs 源码 `render/keyboard/mod.rs`）：击键时间线引擎
  - hold：log-normal，μ=ln(100ms)，σ=0.35（Balanced μ=ln(90), σ=0.3）
  - flight：log-logistic，α≈70–110ms，β≈3–3.5（比 log-normal 尾巴重，偶发慢转移才自然）
  - thinking pause：Pareto，xₘ=500–700ms，α=1.4–1.5，概率 5–8%
  - typo：1–1.5%（仅 ASCII 字母），打错 → 80–600ms 后 backspace → 20–400ms 后补对
  - 还有 bimodal（左右手交替快 / 同手慢）与 fatigue（同会话越打越慢，上限 1.3×）
  - 代码里明确写："A fixed inter-key delay is as visible as a missing mousemove."
- `human-input`（PyPI 0.1.0）：鼠标用 Fitts 定律估时长 + Sigma-Lognormal 轨迹模型 + 目标区内随机控制点 + 接近目标的修正小动作；点击按下/抬起时长 log-normal（参数取自 Mouse Dynamics Dataset）；键盘按**每个字符码**各自的 flight/hold 分布采样，且先排好 press/release 时间线再执行（允许自然 rollover）。
- `Peekaboo` 的 `docs/human-typing.md`：用 WPM 推基础延迟 + ±20% 抖动 + 标点/空格额外加停顿。

### B4. 终端（CLI）侧的「拟真」范式
- 不是「模拟键盘敲给终端看」，而是 **PTY + 终端模拟器状态**：
  - `brepl`：node-pty 起子进程 + `pyte`（headless VT100 模拟器）维护「屏幕上有哪些字、光标在哪」，把任意 CLI（bash/vim/ssh）变成可编程对象。
  - `terminal-mcp` / `SmartCLI` / `ptydriver`：同一思路做成 MCP/CLI 工具：PTY 驱动 + 屏幕状态 + 「等待提示符/稳定」。
- 启示：终端拟真的关键是**状态从屏幕读**（而不是从 stdout 猜），输入可以是「逐字写 PTY」，本来就和真人敲键在字节流上等价——终端里没有 deviceId 这种取证面，拟真重点变成节奏与「等人看」。

## C. 待核 / 待队友补

- iOS 不用管（用户是 Android）。
- 微信 8.0.80 本身有没有 ADB/自动化检测？——没有公开证据，不要断言。威胁模型要写清：主要风险是行为风控，不是 MotionEvent 取证。
- 需要实测：`input tap` 在真机上 `getevent` 能看到什么；uiautomator2 的 `minitouch` 路径是否产生 deviceId=-1；uinput（需 root）是否表现为真实设备。