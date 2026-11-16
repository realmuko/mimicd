# 02 · 真机 GUI Agent 工程先例调研

> 设计前调研 · 面向 `dsh-wechat-usb` 重构（1080×2160 / Android / 微信 8.0.80 / USB+ADB）
> 方法：读仓库源码 + README + issue + 论文摘要，不做实测

## 0. 证据分级

| 标记 | 含义 |
|---|---|
| 【声称】 | 项目 README / 论文 / 官方文档**自己说的**（可能是宣传口径） |
| 【实现】 | 我**读到了源码**，说的是代码实际怎么做的 |
| 【推断】 | 我基于上述材料对**我们场景**的判断，未经实测 |
| 【未核实】 | 没读到实现、也没有可信二手材料，只写"存在这种说法" |

一句话结论：**这一代真机 agent 没有一家解决了"多会话共享一台手机"，全部是单任务串行 loop；真正被反复踩的是输入法、a11y 树缺失、坐标空间换算、以及用 sleep 代替等待这四件事。**

---

## 1. 代表性项目逐个拆

### 1.1 智谱 AutoGLM / Open-AutoGLM（Phone Agent）

- 仓库 <https://github.com/zai-org/Open-AutoGLM>，论文 arXiv:2411.00820
- **感知**【实现】：`screencap -p /sdcard/tmp.png` → `adb pull` → PIL 读尺寸 → base64 送模型。纯截图，**无 a11y 树、无 OCR 前置**。
- **动作空间**【实现】：文本 DSL：`do(action="Tap", element=[x,y])`、`Swipe(start,end)`、`Type(text)`、`Launch(app)`、`Back`/`Home`、`Long Press`、`Double Tap`、`Wait(duration)`、`Take_over`、`Note`、`Call_API`、`Interact`、`finish(message=)`。见 [prompts_zh.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/config/prompts_zh.py)
- **坐标**【实现】：prompt 明写"左上角 (0,0) 到右下角（999,999）"，handler 里 `x = int(element[0]/1000*w)`。**0–999 归一化，中文圈最主流。**
- **决策**：VLM 直接出坐标，没有"先 dump 再点"这一层。
- **可抄**：
  1. **动作 DSL 用 `ast.parse` 而不是 `eval`**（源码注释："Use AST parsing instead of eval for safety"）——安全与工程双收益。【实现】
  2. **`Take_over` 是一等公民动作**：登录/验证码/支付在动作空间里就有出口；配套 `confirmation_callback`/`takeover_callback` 注入 handler，不散在业务里。【实现】
  3. 截图失败（`Status: -1`/`Failed`）→ 返回**黑图 + `is_sensitive=True`**，让模型看到黑屏并触发 Take_over，而不是抛异常中断任务。[screenshot.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/adb/screenshot.py)
- **要避开**：
  - **整套时间靠固定 sleep 堆出来**：Type = 切输入法 → `sleep` → 清空 → `sleep` → 输入 → `sleep` → 还输入法 → `sleep`。四个固定睡眠，换机就全错。【实现】
  - prompt 第 14 条把"检查上一步是否生效"交给模型自觉，这正是大量"反复 Tap 同一输入框"的根源，对照 [issue #180](https://github.com/zai-org/Open-AutoGLM/issues/180)。【实现】
  - 送模型前**不缩放**：[#381](https://github.com/zai-org/Open-AutoGLM/issues/381) 报 `input size exceed limit 2048x2048, current input:(1080,2376)`。我们 2160 也会顶穿，**必然踩**。

### 1.2 阿里 Mobile-Agent v1→v3

- 仓库 <https://github.com/X-PLUG/MobileAgent>；v2 论文 arXiv:2406.01014（NeurIPS'24），v3 arXiv:2508.15144，v3.5 arXiv:2602.16855
- **感知**【实现，v2】：**全 OCR + 图标检测**。damo OCR 出文本框 → 启发式合并同行 → GroundingDINO 检 icon → 每个 icon 裁图喂 Qwen-VL 生成描述 → 汇总 `perception_infos=[{text,coordinates}]` → 换成中心点。**完全不碰 a11y 树。**
- **动作空间**【实现】：解析 `Tap (x, y)` / `Swipe (x1,y1),(x2,y2)` / `Type (text)` / `Back` / `Home` / `Open app (name)` / `Stop`，**绝对像素，不归一化**。
- **决策**：多 agent——Action 出动作、Reflection 判上一步是否生效、Memory/Planning 维护进度；v3 起换 GUI-Owl 端到端 VLM。【声称】
- **可抄**：
  1. **Reflection 用前后两张截图对比**：动作后重截，两张图一起给模型回答 A/B/C——A=生效、B=没生效（代码直接 `back()` 回退）、C=无效。**这是"点完核对"最便宜的实现。**【实现】
  2. **键盘状态检测**：OCR 到 `ADB Keyboard` 且 y > 0.9×height 就认为键盘已激活，据此决定允不允许 Type。【实现】
- **要避开**：
  - **`time.sleep(5)` 写死在主循环**，每个动作后无条件等 5 秒。【实现】
  - README 自述 `reflection_switch` *"may cause operation to fall into a dead cycle"*，要靠人往 `add_info` 写知识来绕——**把防死循环寄托在 prompt 上是最普遍的债**。【声称】
  - `0.9*height` 魔法阈值：[#27](https://github.com/X-PLUG/MobileAgent/issues/27) 里 ADB Keyboard 明明开了，但 OCR 没在底部 10% 看到它 → agent 认为自己不能打字，最后靠改阈值 0.8 解决。**用"键盘是否可见"判断能不能输入，是错的抽象。**
  - 两个真实 bug：`Open app` 靠 OCR 找同名文字再点"文字上方一个行高"处（`name_coordinate[1] - 行高`），且 `break` 被注释掉会重复点击；`swipe_precise` 写成 `swipe {start_x} {start_x} {end_x} {end_y}`（y 传成 x）。【实现】→ **用 OCR 文字位置反推图标位置这类补偿逻辑，一写就错且难发现。**

### 1.3 字节 UI-TARS

- 仓库 <https://github.com/bytedance/UI-TARS>（**2026-11-09 已归档**）；论文 arXiv:2501.12326，UI-TARS-2 arXiv:2509.02544
- **动作空间**【实现】：`click(point='x1 y1')`、`long_press`、`type(content)`、`scroll(point,direction)`、`open_app`、`drag`、`press_home`、`press_back`、`finished`。**`click` 收 point 不收 element，没有语义层。** [prompt.py](https://github.com/bytedance/UI-TARS/blob/main/codes/ui_tars/prompt.py)
- **坐标**【实现】：**模型输出坐标 = 模型输入图（经 smart_resize）的像素，不是设备像素**。[README_coordinates.md](https://github.com/bytedance/UI-TARS/blob/main/README_coordinates.md) 要求 `model_output / new_size * original`，并提示 Qwen2.5VL 系输出的是**绝对坐标**而非 0-1000。
- **可抄**：把"模型输入分辨率"做成显式概念——坐标换算是一个纯函数（resize + 反算），不散在业务里；另有 `GROUNDING` 模板只出 Action 不出 Thought，**定位能力可单独评测**。
- **要避开**：`type(content)` 要求"要提交就在 content 末尾加 `\n`"，等于**把回车塞进文本内容**——遇到多行输入框（微信就是）会变成换行而不是发送。【推断】

### 1.4 腾讯 AppAgent

- 仓库 <https://github.com/TencentQQGYLab/AppAgent>（CHI 2025），论文 arXiv:2312.13771
- **感知**【实现】：**`adb shell uiautomator dump` 出 XML + pull**，配合截图。`traverse_tree()` 抽 `clickable`/`focusable` 节点算 bbox 中心，**再用 PIL 在截图上画数字标签**，让模型指"第 N 号元素"。
- **动作空间**【实现】：`tap(x,y)`、`long_press`（用 `input swipe x y x y 1000` 实现）、`swipe(direction,dist)`、`text(str)`、`back()`。
- **决策**：VLM 看"标注图"选编号 → 代码把编号换成 bbox 中心。**语义元素 + 像素兜底的混合流派。**
- **可抄（对我们价值最高）**：
  1. **标注图而不是裸图**：先把可点元素编号再送模型，模型只输出编号，坐标由代码保证。**模型无法瞎编坐标，人也能肉眼复核。**
  2. **`MIN_DIST=30` 去重**：中心距 <30px 只标一个，避免标签重叠致点错；`DARK_MODE` 反转标签配色——深色下标签看不清会直接导致识别失败。[config.yaml](https://github.com/TencentQQGYLab/AppAgent/blob/main/config.yaml)
  3. **网格兜底**（2024-01 加入）：对没有编号的元素，叠一层网格让模型点格子。【声称】
  4. **探索→文档库**：先探索/人工演示，把元素用途写成文档，部署时查文档操作——不依赖 RAG 玄学的"记忆"。
- **要避开**：
  - `text()` 用 `input text`，手动 `replace(" ","%s")`、`replace("'","")`——**空格要转义、单引号直接删、中文完全打不了**。【实现】
  - `REQUEST_INTERVAL: 10` + `MAX_ROUNDS: 20`：任务上限 20 步、每步至少 10 秒，**吞吐被 sleep 吃掉**。【实现】
  - [#39](https://github.com/TencentQQGYLab/AppAgent/issues/39) `ERROR: could not get idle state.`（界面在动就拿不到稳定态）；[#101](https://github.com/TencentQQGYLab/AppAgent/issues/101) MIUI 上 dump 抛 `FileNotFoundException: theme_compatibility.xml`。**dump 在厂商 ROM 和动画页面上不可靠，是硬事实。**

### 1.5 Google AndroidWorld（benchmark harness）

- 仓库 <https://github.com/google-research/android_world>，论文 arXiv:2405.14573
- **感知**【声称】：README 要求模拟器带 `-grpc 8554` 启动，因为"needed communication with **accessibility forwarding app**"——**Google 没用 `uiautomator dump`，而是自写常驻无障碍转发 APK，用 gRPC 把节点树推给 PC。**
- **动作空间**【实现，[json_action.py](https://github.com/google-research/android_world/blob/main/android_world/env/json_action.py)】：`click`/`double_tap`/`long_press`/`scroll`/`swipe`/`input_text`/`keyboard_enter`/`navigate_back`/`navigate_home`/`open_app`/`wait`/`status`/`answer`；字段含 `index`（点第几个无障碍元素）、`x/y`、`text`、`direction`、`keycode`、`clear_text`。**`index` 与 `x/y` 二选一**——语义优先、坐标兜底的官方写法。
- **评测**【声称】：116 任务/20 app，随机参数动态实例化百万变体；步数预算约人类 2 倍；奖励查应用状态而非截图相似度。
- **可抄**：①动作里显式有 `wait` 与 `status`/`answer`，把"该不该继续""完成没"做成动作；②`index` 优先，从根上消灭坐标漂移；③用状态检查判成功。
- **要避开**：这是模拟器 + Pixel 6/API 33 环境，**harness 设计可抄，环境假设不能抄**（锁屏、IME、厂商 ROM、网络抖动都不在里面）。

### 1.6 AppWorld（对照组：不是 GUI）

- 论文 <https://arxiv.org/abs/2407.18901>（ACL'24）：9 个 app、457 个 API 的可控环境，评的是**交互式代码生成**，不是点屏幕。
- 放进来是为划边界：**它证明"走 API"在可控环境里最稳、最好评**，而我们老板明确要"不走官方 API/协议"。所以只借它的**评测思路**（state-based unit test、collateral damage 检查），不借环境。

### 1.7 Auto.js / AutoX.js / hamibot（无障碍脚本生态）

- Auto.js <https://github.com/clearw5/Auto.js>（原 hyb1996，**已归档**，12.8k star，topics 含 `uiautomator`）；AutoX.js 是社区延续分支；hamibot 同类商业化产品。
- **形态**【声称】：设备端跑 JS 的自动化 IDE/运行时，脚本在手机上执行，**不需要 PC**；动作是 `click(x,y)`、`text("...")`、`desc("...").findOne().click()`。
- **对我们的价值有限**（我们决策在 PC 侧），但有两点启发：①设备端自动化可行，省掉 USB 往返；②【推断】这类生态大量脚本靠 `text("确定")` 固定文案选择器，**微信一升级就全废——语义定位比坐标稳，但比坐标更脆**（文案会变）。两者都要，且都要有"找不到就降级"的路。
- 【未核实】它到底依赖 AccessibilityService 还是 root，我没读实现，不作为结论。

### 1.8 工程底座

| 底座 | 机制 | 关键限制 | 对我们的用法 |
|---|---|---|---|
| **uiautomator2** | 设备端跑 UiAutomator 的 HTTP 服务（jar），PC 走 HTTP；`dump_hierarchy()` 拿 XML | ①**单例**：它起来后 `adb shell uiautomator dump` 会失效（[#299](https://github.com/openatx/uiautomator2/issues/299)）；②WebView 拿不到或拿到错的（[#449](https://github.com/openatx/uiautomator2/issues/449)、[#979](https://github.com/openatx/uiautomator2/issues/979)、[#740](https://github.com/openatx/uiautomator2/issues/740)）；③`send_keys` **优先走剪贴板**，不可用才装辅助 IME | 走 a11y 就用它（有 `wait`/`exists`/`click_exists(maxretry)`），但**必须接受 WebView 拿不到** |
| **Appium** | WebDriver 协议，底层同 UiAutomator | 重、启动慢、版本匹配麻烦 | 【推断】收益不匹配，不引入 |
| **scrcpy** | 设备端 `app_process` 起 server，**视频流 + 控制流**两条 socket，控制走 `INJECT_EVENTS` | 小米等机型要额外开"USB 调试(安全设置)"才能注入 | **观察层最优解**：30–120fps、延迟 35–70ms、设备端不装东西、剪贴板双向 |

scrcpy 数字来自 [README](https://github.com/Genymobile/scrcpy)：*"30~120fps"、"low latency: 35~70ms"、"nothing is left installed"*；另有 `--keep-active`（保持常亮）、`--max-size`、`--no-audio`。

> 【推断】这条份量最重：**我们现在是"截图→关掉→再截图"，每次几百毫秒且没有中间帧；scrcpy 是一条持续的流**。有了流，"等画面稳定"才可能实现（§2.4）。

### 1.9 汇总对照

| 项目 | 感知 | 动作空间 | 坐标空间 | 决策 | 最大可抄点 |
|---|---|---|---|---|---|
| AutoGLM | 截图 | Tap/Swipe/Type/Back/Home/Launch/Wait/Take_over | **0–999**【实现】 | VLM 出坐标 | DSL + AST 解析 + Take_over |
| Mobile-Agent v2 | 截图 + OCR + 图标描述 | Tap/Swipe/Type/Back/Home/Open app | 绝对像素 | 多 agent | 前后截图对比做 reflection |
| UI-TARS | 截图 | click/long_press/type/scroll/open_app/drag/home/back/finished | **模型输入图像素** | VLM 出坐标 | 坐标换算纯函数化 |
| AppAgent | **dump XML + 截图** | tap/long_press/swipe/text/back | 元素 bbox 中心 | VLM 选编号 | **标注图**：只输出编号 |
| AndroidWorld | 无障碍转发 APK | click(index 或 x,y)/scroll/input_text/keycode/wait/answer | index 优先 | agent 自实现 | index 优先 + wait/status |
| AppWorld | API | 代码 | 无 | LLM 写代码 | 只借评测思路 |
| uiautomator2 | a11y 树 | 选择器 + 坐标 | 设备像素/百分比 | 脚本 | wait/exists/retry |
| scrcpy | **视频流** | 注入触摸/按键 | 设备像素 | 人/程序 | 低延迟观察流 |

---

## 2. 动作空间与"拟真"的关系

### 2.1 三种流派，本质是"谁承担坐标换算"

1. **像素坐标**（AutoGLM、UI-TARS、Mobile-Agent）：模型直吐坐标。动作空间小、自由度高，但**坐标错了没有任何一层能拦住**。
2. **语义元素**（AppAgent、AndroidWorld 的 `index`）：先拿节点树再选。**模型不可能点到不存在的元素**，但**节点树在微信/WebView/Flutter 上是空的**（§4.1）。
3. **代码生成**（AppWorld、部分 PC agent）：可复现可审计，但每步一次代码生成，慢。

**【推断】我们应该 2 为主、1 为兜底**：能用元素就用（微信的聊天列表、返回键、发送按钮都有 resource-id/text），拿不到（公众号、小程序、图片消息）退到"标注图 + 编号"（AppAgent 那套），最后才允许裸坐标。**三层降级，不是二选一。**

### 2.2 坐标归一化：0–1000 是主流吗

- **AutoGLM：是 0–999**【实现，`/1000*screen_width`】
- **UI-TARS：不是**，用模型输入图像素 + `smart_resize` 反算，Qwen2.5VL 系是绝对坐标。【实现】
- **Mobile-Agent / AppAgent / AndroidWorld：不是**，设备像素或元素 index。

**【推断】** 归一化的真正好处不是"跨分辨率"，而是**让模型输出的数字范围稳定**。我们固定 0–1000 对外、内部换算成设备像素，换算前后都 clamp（越界直接拒，别让它点到边缘触发系统手势）。零成本，收益大。

### 2.3 "点之前先核对"怎么做

- **GUI-Critic-R1**（MobileAgent 仓库内，NeurIPS'25，arXiv:2506.04614）：标题即 *Look Before You Leap*，训一个"术前诊断"模型判断这步会不会错。【声称，未读实现】
- **Mobile-Agent 的 reflection**：点**之后**两图对比，属事后校验。
- **AppAgent 的标注图**：点**之前**把候选编号化，收敛选择空间。
- **AutoGLM**：写进 prompt 第 14 条，靠模型自觉。

**【推断】** 最划算的"点前核对"不是再训 critic，而是**纯代码断言**：①dump/OCR 拿到 bbox；②`tap_point ∈ bbox`（8px 容差）；③bbox 在**当前可见区**内（键盘顶起后的区域，不是整屏）；④元素 `enabled/clickable`；⑤不满足就**不点**，退回上一级重定位。五条不加任何模型调用，能消灭绝大多数"点歪"。

### 2.4 等待与重试：反面教材高度统一

| 反面教材 | 出处 | 问题 |
|---|---|---|
| 四个固定 `sleep` 拼一次输入 | AutoGLM handler.py【实现】 | 换机型/负载全错 |
| 每步 `time.sleep(5)` | Mobile-Agent v2 run.py【实现】 | 吞吐被吃光 |
| 请求间隔 10s、上限 20 步 | AppAgent config.yaml【实现】 | 同上 |
| 靠 prompt 规则"没生效就等一下" | AutoGLM prompts_zh.py【实现】 | 不可保证 |

**正面做法（可直接抄）**：
- **元素级等待**：`d(text="发送").click(timeout=10)`、`click_exists(timeout=)`、`click_gone(maxretry=,interval=)`、`wait_gone()`——语义是"等到条件成立或超时"，天然带重试。【声称，u2 README】
- **可配置的操作延迟**：`d.settings['operation_delay'] = (0.5, 1)`，点击前 0.5s 后 1s，可关，不是无脑 sleep。【声称】
- **等空闲必须带超时**：`waitForIdleTimeout` 在 u2 里默认设 0，README 明说原因是 "To prevent client program timeouts"——否则界面一直动就永不返回。【声称】
- **最理想是等"稳定帧"**：连续 N 帧像素差小于阈值，需要视频流。**#39 的 `could not get idle state` 正是"没有稳定帧概念"的直接后果。**【来源 + 推断】

---

## 3. 中文输入法：头号工程问题

### 3.1 为什么 `adb shell input text` 打不了中文

ADBKeyBoard 作者写得很直接：

> "…**you cannot send unicode characters using this command**, as it is not designed to use it this way. `adb shell input text '你好嗎'` is not going to work."
> —— <https://github.com/senzhk/ADBKeyBoard>

【实现】AppAgent 的 `text()` 因此只能 `replace(" ","%s")` + `replace("'","")`，中文直接丢。【推断】根因是 `input text` 走 KeyCharacterMap 的**按键注入**，只能映射 ASCII 键位，中文没有对应物理键。

### 3.2 三条可行路线

| 路线 | 做法【实现】 | 优点 | 缺点 / 已知坑 |
|---|---|---|---|
| **A. ADBKeyboard 广播** | `am broadcast -a ADB_INPUT_B64 --es msg <base64>`；或 `ADB_INPUT_CHARS --eia chars '128568,32,67'`；清空 `ADB_CLEAR_TEXT` | 最稳，支持中文/emoji/多行；AutoGLM 与 Mobile-Agent 都用 | 需装 APK + `ime enable/set`；**会改全局默认输入法** |
| **B. u2 `send_keys`** | **优先走剪贴板**（设剪贴板 → 粘贴），不可用才装辅助 IME | 不依赖第三方 APK | 剪贴板是全局共享状态；部分输入框禁粘贴 |
| **C. 无障碍 setText** | 对 EditText 节点 `ACTION_SET_TEXT` | 最干净，不碰 IME | **微信这类自定义输入框常不响应**；拿不到节点即失效【推断】 |

ADBKeyBoard 还记了一条历史坑：**"This may not work for Oreo/P, am/adb command seems not accept utf-8 text string anymore"** → 所以才有 base64 通道（`ADB_INPUT_B64`）。**文本通道必须默认 base64，不要赌 UTF-8 参数传递。**

### 3.3 真实翻车案例（最值钱）

1. **[MobileAgent#27](https://github.com/X-PLUG/MobileAgent/issues/27)「ADB Keyboard 开了还是打不了字」**：靠 OCR 在屏幕底部 10% 找 `ADB Keyboard {ON}` 判断键盘可用性，Pixel 8 Pro 上位置偏高 → 判定失败 → 拒绝执行 Type。→ **输入能力要用 `settings get secure default_input_method` 查，不是看图。**
2. **[#260](https://github.com/zai-org/Open-AutoGLM/issues/260)/[#288](https://github.com/zai-org/Open-AutoGLM/issues/288)/[#312](https://github.com/zai-org/Open-AutoGLM/issues/312)「装了 ADB Keyboard 仍无法输入」**：华为/鸿蒙 + 小艺输入法，软键盘弹出但字进不去。→ **IME 是厂商深度定制的子系统，"设了默认"不等于"输入生效"。**
3. **[#154](https://github.com/zai-org/Open-AutoGLM/issues/154)「多行文本解析失败」**：`do(action="Type", text="...\n...")` 带换行，`parse_action` 用字符串切分直接 `SyntaxError: unterminated string literal`，任务中断；日志里模型还把 `do(...)` 嵌进了 `message` 字段。→ **最重要的一条：不要用"带引号的代码串"当动作协议**，用 JSON，让解码器处理换行/引号/emoji。
4. **[#380](https://github.com/zai-org/Open-AutoGLM/issues/380)「PowerToys 改键位就输不进」**：Ctrl 与 CapsLock 互换后只能输入 "Cv"，用户判断"依赖 Ctrl-C/V"。→ 【未核实】当前 main 走的是 base64 广播，**这个诊断可能是用户猜错**；但真问题是**文本通道藏着本地键盘/剪贴板依赖时，故障会以极诡异方式出现**——通道必须只有一条路径且可自检。
5. **[#180](https://github.com/zai-org/Open-AutoGLM/issues/180)「反复 Tap 同一输入框」**：连续 4 步 Tap→Type→Tap→Type，因为截图里占位符还在。→ **Type 之后必须在代码层读回输入框内容**（dump 节点 `text` 或 OCR 输入框区域）；占位符和真实文本视觉上太像。

### 3.4 【推断】我们该定成什么

- 文本通道独立成 `TextChannel`，两个实现：`AdbKeyboardChannel`（主）、`ClipboardChannel`（备）。
- 每次 Type：**记录原 IME → 切 ADBKeyboard → 读 `settings get` 复核 → base64 广播 → 读回校验 → 还原 IME**，全程超时。
- 读回判据：dump 到的 EditText `text` 含目标串前缀；拿不到节点就 OCR 输入框区域模糊匹配。
- **绝不把"输入法已切换"当长期全局状态**——用户随时可能自己打字（§5）。

### 3.5 直接命中我们的现状（我读了 `<dsh-wechat-usb>`）

- `lib/core.js:338` 和 `:409` 都是 **`am broadcast -a ADB_INPUT_TEXT --es msg '<text>'`**，靠 shell 单引号转义拼串。【实现】而 ADBKeyBoard README 明确写着 **"am/adb command seems not accept utf-8 text string anymore"（Oreo/P 之后）**——**我们正在用的正是它自己标注为不可靠的那条通道**，应切 `ADB_INPUT_B64`。这条我认为优先级最高，改动极小、收益确定。
- 发送序列 `core.js:406-409` = `input tap 输入框; sleep 0.5; keyevent MOVE_END; ADB_CLEAR_TEXT` 再广播。【实现】这正是 §2.4 与 §3.3 反面教材的完整组合：**固定 sleep 代替等待、清空后不读回、文本通道与点击耦合在同一条 shell 串里**（任一环节失败都无法定位）。
- 感知是 `exec-out screencap -p`（`core.js:226`），注释写着**一次 0.65 秒**（`lib/poller.js:306`）。【实现】→ 直接印证 §1.8：**没有流、只有离散截图，就永远做不出"等稳定帧"**。

---

## 4. 感知的可靠做法与坑

### 4.1 `uiautomator dump` 到底能不能用

**能用，但只能当"增强信号"，不能当"主感知"。**

| 现象 | 来源 | 含义 |
|---|---|---|
| `ERROR: could not get idle state.` | [AppAgent#39](https://github.com/TencentQQGYLab/AppAgent/issues/39) | 界面在动就 dump 不出来；微信动画多，**必须带超时 + 降级** |
| MIUI 上抛 `FileNotFoundException: theme_compatibility.xml` | [AppAgent#101](https://github.com/TencentQQGYLab/AppAgent/issues/101) | 厂商 ROM 会破坏 dump |
| u2 server 起来后裸 dump 失效（单例） | [u2#299](https://github.com/openatx/uiautomator2/issues/299) | **同一时刻只能有一个 uiautomator 客户端** |
| WebView 内容 dump 不到 / 拿到错的 | [#449](https://github.com/openatx/uiautomator2/issues/449)、[#979](https://github.com/openatx/uiautomator2/issues/979)、[#740](https://github.com/openatx/uiautomator2/issues/740) | 微信的公众号、小程序、内置浏览器全是 WebView → **必须走 OCR** |
| WebView 版本影响元素识别 | [u2#113](https://github.com/openatx/uiautomator2/issues/113) | 同机升级 WebView 就可能变行为 |
| 微信 WebView 用 chromedriver 起不来 | [u2#255](https://github.com/openatx/uiautomator2/issues/255) | 别指望 CDP 方案开箱可用 |
| 社区加了不依赖 chromedriver 的 CDP PR | [u2#1162](https://github.com/openatx/uiautomator2/issues/1162) | 【未核实】后续观察项 |

**耗时**【未核实】：`uiautomator dump` 的公开数字我没找到可信来源，且随节点数/ROM/是否在动画中剧烈波动，**必须本机实测 P50/P95 再写进设计文档**。作为参照，我们自己的代码注释写着**一次 `screencap` 要 0.65 秒**（`lib/poller.js:306`）——这正是 §1.8 那条"要换 scrcpy 流"最硬的论据。

### 4.2 截图 + OCR 路线

Mobile-Agent v2 是完整样本【实现】：OCR → 合并文本块 → GroundingDINO 检 icon → **每个 icon 裁图单独调一次 VLM 生成描述**（线程池并发）。代价是**一张图几十次模型调用**。

【推断】我们不需要这么重。微信真正需要的文字就几类：聊天标题、最近消息、输入框、发送按钮、时间。**区域化 OCR（只 OCR 聊天列表区和输入区）比全屏 OCR 又快又稳**——全屏会把表情、头像上的字、状态栏都识别进来。另外它的 `merge_text_blocks` 是一堆魔法阈值（同 x ±10、行距 <30、高度差 <10），**不要抄**：合并应按"同一行/同一气泡"的几何规则 + 显式容差配置。

### 4.3 判断"画面变没变"

- **Mobile-Agent**：动作后重截，把两张图给 VLM 判 A/B/C——语义级判断（"变了但变错了"也能发现），但每步多一次 VLM 调用。【实现】
- **scrcpy**：持续视频流，天然可做**帧间像素差**，成本几乎为零，100ms 内就能判"还在动/已静止"。【推断】
- **`dumpsys gfxinfo` / `SurfaceFlinger --latency`**【未核实】：Android 自带帧统计通道，理论上可判"是否在连续出帧"，但没读到哪家 agent 用它做主判据，不作为结论。

**【推断】我们的方案**：帧差做快速判据、VLM 双图对比做慢速判据，便宜的先跑，拿不准再上贵的。

### 4.4 屏幕、锁屏、弹窗、遮挡

| 问题 | 已有做法 | 来源 |
|---|---|---|
| 息屏/锁屏 | `d.screen_on()`、`d.unlock()`（按电源 + 右下划到左上）；`d.info['screenOn']` | u2 README【声称】 |
| 保持常亮 | scrcpy `--keep-active`；或 `settings put system screen_off_timeout` | scrcpy README【声称】 |
| Toast | `d.toast.get_message(wait_timeout=5)` | u2 README【声称】 |
| 弹窗/广告 | `d.watch_context()` 内置规则（`立即下载/更新→取消`、`同意`、`好的/确定`…），但**官方已标 deprecated**，建议"点前先查弹窗" | u2 README【声称】 |
| 键盘遮挡 | Mobile-Agent 用 `0.9*height` 判键盘（已翻车，§3.3）；AutoGLM 在 prompt 里告诉模型"ADB Keyboard 不占屏幕" | 【实现】 |
| 分辨率/DPI | [u2#113](https://github.com/openatx/uiautomator2/issues/113) 同机型不同 WebView 行为都不同；[#27](https://github.com/X-PLUG/MobileAgent/issues/27) 屏幕高度比例不同导致阈值失效 | — |
| 截图黑屏 | AutoGLM 返回黑图 + `is_sensitive` → 触发 Take_over | 【实现】 |

---

## 5. 单窗口串行与并发

**硬事实**：真机永远只有一个前台窗口、一个 IME、一个焦点、一个剪贴板。**调研到的所有项目都是"单任务串行 while True"**（AutoGLM `max_steps=100`、Mobile-Agent `while True`、AppAgent `MAX_ROUNDS=20`），**没有一家处理"多会话都要照看"**——它们的场景是"帮我完成一个任务"，不是"长期在线值班"。

我们不一样：**长期在线 + 多会话 + 事件驱动**，这是相对所有先例的**真正差异点**，不能照抄任何一家。

可借的三个结构：
1. **环境/agent 分离**（AndroidWorld）：`AndroidEnv` 负责观察与执行，`Agent` 只实现 `step()`——观察契约与动作契约分开。
2. **常驻设备端服务**（u2 的 HTTP server、AndroidWorld 的 a11y app、scrcpy 的 server）：把"取数据"从"每次起进程"变成"连一个常驻服务"。
3. **前后状态对比**（Mobile-Agent reflection）：动作的"效果"是独立观测结果，不是动作的返回值。

**【推断】调度层建议"一写多读"**：
- **Observation 流（多消费者）**：采集器持续产出 `Frame(ts, png, a11y?)` 进环形缓冲，OCR / 视觉模型 / 状态机各自读，互不阻塞。
- **Action 通道（单写者）**：所有改设备状态的操作走**同一串行队列**，每项带 `expected_precondition`（如"前台是 com.tencent.mm"），不满足就丢弃重排。
- **State store（单一真相）**：前台包名/Activity、当前 IME、屏幕开关、键盘是否弹起、最近动作与结果——**全局共享，任何模块不许自缓存**。
- **抢占**：检测到用户手动操作 → 立即让出，任务标记 `interrupted_by_user`，不抢焦点不抢 IME。

---

## 6. 失败模式清单

| # | 现象 | 根因 | 来源 | 规避 |
|---|---|---|---|---|
| 1 | 反复 Tap 输入框字进不去 | 无读回校验，靠模型看截图 | [AutoGLM#180](https://github.com/zai-org/Open-AutoGLM/issues/180) | Type 后代码层读回 |
| 2 | 中文完全打不进 | `input text` 不支持 unicode | [ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard) + AppAgent `text()`【实现】 | 只用 base64 广播 |
| 3 | 多行文本崩溃 | 动作协议是代码串，字符串切分炸 | [AutoGLM#154](https://github.com/zai-org/Open-AutoGLM/issues/154) | 协议用 JSON |
| 4 | 装了输入法仍打不了字 | IME 被厂商定制 | [#260](https://github.com/zai-org/Open-AutoGLM/issues/260)、[#288](https://github.com/zai-org/Open-AutoGLM/issues/288)、[#312](https://github.com/zai-org/Open-AutoGLM/issues/312) | 切完读 `settings get` 复核 |
| 5 | 键盘可用却拒绝输入 | 靠屏幕底部找字样，阈值失效 | [MobileAgent#27](https://github.com/X-PLUG/MobileAgent/issues/27) | 用系统 API 查 IME |
| 6 | dump 直接失败 | 界面在动，拿不到 idle state | [AppAgent#39](https://github.com/TencentQQGYLab/AppAgent/issues/39) | 超时 + 降级 OCR |
| 7 | dump 在特定 ROM 抛异常 | MIUI 主题资源缺失 | [AppAgent#101](https://github.com/TencentQQGYLab/AppAgent/issues/101) | 捕获异常 + 记 ROM 指纹 + 降级 |
| 8 | 两个工具互踩 | uiautomator 单例 | [u2#299](https://github.com/openatx/uiautomator2/issues/299) | 全进程只一个 a11y 客户端 |
| 9 | 微信 WebView 拿不到节点 | WebView 不暴露 a11y 子树 | [u2#740](https://github.com/openatx/uiautomator2/issues/740)、[#449](https://github.com/openatx/uiautomator2/issues/449)、[#979](https://github.com/openatx/uiautomator2/issues/979) | 公众号/小程序走 OCR |
| 10 | 微信 WebView CDP 连不上 | chromedriver 版本/权限 | [u2#255](https://github.com/openatx/uiautomator2/issues/255) | 不把 CDP 当依赖 |
| 11 | 送模型图片超限 400 | 未缩放到 2048 内 | [AutoGLM#381](https://github.com/zai-org/Open-AutoGLM/issues/381) | 长边 ≤2048 并记比例 |
| 12 | 截图全黑 | 支付/密码页禁止截屏 | AutoGLM README【声称】+ screenshot.py【实现】 | 识别 `Status: -1` → 转人工 |
| 13 | 死循环 | reflection 反复判无效并重试 | Mobile-Agent README 自述【声称】 | 步数/时长/重复动作三重熔断 |
| 14 | 坐标点歪（尤其滑动） | 参数顺序混淆 | AppAgent `swipe_precise` y 写成 x【实现】 | 坐标用命名结构体 |
| 15 | 动画中间帧当结果 | 动作后立刻截图 | [AppAgent#39](https://github.com/TencentQQGYLab/AppAgent/issues/39) 间接 | 稳定帧 + 最小等待下限 |
| 16 | 点到底部触发系统手势 | 坐标越界/贴边 | 【推断】 | clamp + 安全边距 |
| 17 | 深色模式下标签看不清 | 标注配色未适配 | AppAgent `DARK_MODE`【实现】 | 主题感知配色 |
| 18 | 中英混排/表情导致 OCR 漏 | 合并阈值写死 | Mobile-Agent `merge_text_blocks`【实现】 | 区域化 OCR + 显式容差 |

---

## 7. 结论：如果重做一套真机拟真控制

### 7.1 动作层

- **协议**：JSON 对象而非代码串，字段 `{op, target:{kind:"element"|"point",…}, args, precondition, expect}`。**永不用 `eval`/字符串切分**。
- **动作集**：`tap`/`long_press`/`double_tap`/`swipe`/`type`/`key(back|home|enter|delete)`/`open_app`/`wait(until: stable|element|timeout)`/`take_over(reason)`/`finish`。
- **坐标**：对外 0–1000，入口即换算成设备像素，**换算函数唯一且有单测**；所有点 clamp + 8px 安全边距。
- **定位优先级**：`element(resource-id/text/desc)` > `element(bbox)` > `point(归一化)`，每级失败自动降级并记 metric。
- **点前三断言**（§2.3）不满足就不点；**点后核对**用稳定帧 + 局部读回，不依赖模型自觉。
- **文本通道**：`TextChannel` 抽象，主 base64 广播、备剪贴板；切 IME → 复核 → 输入 → 读回 → 还原，全程超时。

### 7.2 感知层

- **三路并行、按需取用**：①`a11y`（常驻 u2）结构化但随时可能空/超时，**有就用**；②`截图 + 区域 OCR`——微信主战场；③`scrcpy 流`——**只做"变没变/稳没稳"的时序判断**，不承担语义。
- **快照是不可变值对象**：`{ts, png, a11y?, foreground_pkg, ime, screen_on, keyboard_shown, stable}`，所有模块读同一份，避免"你看的和我看的不一样"。
- **稳定判据**：连续 3 帧像素差 < 阈值且距上次输入 ≥ 最小间隔——**替代所有 sleep**。
- **敏感页**：黑屏 / `Status: -1` → 直接 `take_over`，不重试。
- **图片规格**：长边 ≤2048（我们 2160 会超），保留缩放比例供坐标反算，与 §2.2 归一化串起来。

### 7.3 调度层

- **一写多读**：Observation 流 + Action 串行队列 + State store。
- **任务模型**：目标 + 前置条件 + 步数预算 + 超时；**步数/时长/同动作重复次数三重熔断**。
- **前台仲裁**：用户手动操作 → 立即让出，标记 `interrupted_by_user`。
- **多会话**：不是"并多个 agent"，而是"一个 agent 维护多个会话状态"——**动作永远串行，只有观察并行**。
- **可观测性**：每步落结构化日志（动作/目标/断言结果/耗时/快照 id/结果）。**没有它，第 6 节的 18 种坑一个都查不出来。**

---

## 8. 别人踩过、我们必须提前规避的 5 个坑

1. **输入法是全局共享状态，不是私有资源。** 切 IME 改的是用户手机的真实设置，用户随时可能自己打字。→ 用完即还 + 幂等检测 + 读回复核，**绝不能假设"我切了就是我的"**。（AutoGLM restore 逻辑；#260/#288/#312）
2. **`uiautomator dump` 是"有时能用"，不是"能用"。** 动画中、厂商 ROM、WebView、单例冲突，四条路都能让它失败。→ 硬超时 + 异常捕获 + **显式降级到 OCR**，**绝不能当唯一感知**。（#39、#101、u2#299、u2#740）
3. **动作协议里不能有字符串切分。** `do(action="Type", text="带\n换行和"引号"的内容")` 一定会炸，且炸在真实用户数据上。→ 用 JSON；非要用 DSL 就用 AST。（#154）
4. **"等一下"不能用 sleep 表达。** 先例的 sleep 全写死且全翻车。→ 稳定帧 + 元素出现 + 条件超时三件套；sleep 只作**最小间隔下限**（如点击间隔 ≥120ms 模拟人速），不作等待手段。（AutoGLM 四 sleep、Mobile-Agent sleep(5)、AppAgent 10s、#39）
5. **坐标空间必须全程可追溯。** "设备像素 / 模型输入图 / 0–1000 / bbox" 四种混用早晚点歪。→ 每个坐标带"空间标签"，只在边界换算，函数唯一且有断言，缩放比例随快照传。（UI-TARS README_coordinates、AutoGLM `/1000*width`、AppAgent bbox、#381）

---

## 9. 未核实清单（别当结论用）

- `uiautomator dump` / u2 的**具体耗时**（P50/P95）——需本机实测。
- `dumpsys gfxinfo` / `SurfaceFlinger --latency` 能否作稳定判据——未读到任何 agent 这么做。
- Auto.js/hamibot 依赖 AccessibilityService 还是 root——只看了仓库简介与 topics。
- GUI-Critic-R1 的实现与效果——只读了 README 标题与论文题名。
- AndroidWorld 的 a11y forwarding app 内部协议（gRPC 传全量树还是精简树）——README 只说了它存在。
- #380 的"输入依赖 Ctrl-C/V"判断——与当前 main 代码不符，可能是用户误判或旧版本行为。

---

## 10. 参考链接

**仓库/代码**
- Open-AutoGLM <https://github.com/zai-org/Open-AutoGLM> ｜ [prompts_zh.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/config/prompts_zh.py) ｜ [handler.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/actions/handler.py) ｜ [adb/input.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/adb/input.py) ｜ [adb/screenshot.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/adb/screenshot.py)
- Mobile-Agent <https://github.com/X-PLUG/MobileAgent> ｜ [v2 run.py](https://github.com/X-PLUG/MobileAgent/blob/main/Mobile-Agent-v2/run.py) ｜ [v2 README](https://github.com/X-PLUG/MobileAgent/blob/main/Mobile-Agent-v2/README.md)
- UI-TARS <https://github.com/bytedance/UI-TARS> ｜ [prompt.py](https://github.com/bytedance/UI-TARS/blob/main/codes/ui_tars/prompt.py) ｜ [README_coordinates.md](https://github.com/bytedance/UI-TARS/blob/main/README_coordinates.md)
- AppAgent <https://github.com/TencentQQGYLab/AppAgent> ｜ [and_controller.py](https://github.com/TencentQQGYLab/AppAgent/blob/main/scripts/and_controller.py) ｜ [config.yaml](https://github.com/TencentQQGYLab/AppAgent/blob/main/config.yaml)
- AndroidWorld <https://github.com/google-research/android_world> ｜ [json_action.py](https://github.com/google-research/android_world/blob/main/android_world/env/json_action.py)
- ADBKeyBoard <https://github.com/senzhk/ADBKeyBoard> ｜ uiautomator2 <https://github.com/openatx/uiautomator2> ｜ scrcpy <https://github.com/Genymobile/scrcpy> ｜ Auto.js <https://github.com/clearw5/Auto.js>

**论文**
- AutoGLM arXiv:2411.00820 ｜ Mobile-Agent-v2 2406.01014 ｜ v3 2508.15144 ｜ v3.5 2602.16855
- UI-TARS 2501.12326 ｜ UI-TARS-2 2509.02544 ｜ AppAgent 2312.13771 ｜ AndroidWorld 2405.14573
- AppWorld <https://arxiv.org/abs/2407.18901> ｜ GUI-Critic-R1 2506.04614