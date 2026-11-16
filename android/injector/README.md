# 输入注入器（android/injector）

**这是仓库里唯一需要构建的部件。** 一个 Java 类，编译成 dex，用 `app_process` 在手机上跑，通过 `InputManager.injectInputEvent` 注入我们自己构造的 `MotionEvent`。

## 为什么需要它

`adb shell input` 在 AOSP 里写死了：DOWN/UP **同一时间戳**（按压 0 ms）、`pressure=1.0`、`size=1.0`、无中间 MOVE、无 history。
注入器改不了 `deviceId`（`InputDispatcher` 会强制改写成 `VIRTUAL_KEYBOARD_ID=-1`，这是 AOSP 故意的），但按压时长、压力曲线、接触面积、每个事件的时间戳、轨迹全部可控。

## 构建与部署

```bash
bash android/injector/build.sh                       # → build/dex/classes.dex（11 KB）
node tools/inject/deploy.ts --adb "<adb 路径>"       # 推送 + 重启 + 端口转发 + 自检
node tools/inject/client.ts "info"
```

工具链在 `.toolchain/`（不入库，约 330 MB）：

```bash
# JDK 17（清华镜像，2.7 秒）
curl -L -o .toolchain/jdk17.zip "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.21_9.zip"
# build-tools 34（含 d8）
curl -L -o .toolchain/build-tools-r34.zip "https://dl.google.com/android/repository/build-tools_r34-windows.zip"
# platform 29（android.jar）
curl -L -o .toolchain/platform-29.zip "https://dl.google.com/android/repository/platform-29_r05.zip"
# 解压（Windows 自带 bsdtar）
/c/Windows/System32/tar.exe -xf ...
```

## 协议

一行一条命令，一行一条回复（`ok ...` / `err ...`），TCP `127.0.0.1:7801`（`adb forward` 过来）。

| 命令 | 说明 |
|---|---|
| `ping` / `info` | 存活 / 状态（uid、注入次数、默认压力面积） |
| `press <p> <s>` | 设默认压力与接触面积（0..1） |
| `tap <x> <y> <ms>` | 轻点：DOWN → 每 8 ms 一个 MOVE（压力渐变 + 亚像素抖动）→ UP |
| `hold <x> <y> <ms>` | 按住：DOWN → 睡 → UP，**中间不发任何 MOVE** |
| `swipe <x1> <y1> <x2> <y2> <ms>` | 滑动：1-(1-k)² 减速曲线，按绝对时间调度 |
| `path <x,y,t> ...` | 逐点轨迹，t 为相对毫秒；末点后 40 ms 抬起 |
| `quit` | 退出 |

## 实测（2026-11-17，Honor BKL-AL20 / Android 10 / 微信 8.0.80）

| 命令 | 请求 | 实际 | 备注 |
|---|---|---|---|
| `tap` | 65 ms | 65 ms（5 个 MOVE） | ✓ |
| `tap` | 40 ms | 41 ms（3 个 MOVE） | ✓ |
| `hold` | 800 ms | 800 ms（0 个 MOVE） | ✓ 首版发 MOVE 时 990 ms，改绝对时间调度后精确 |
| `swipe` | 400 ms | 400 ms（40 步） | ✓ |
| `path` | 330 ms 轨迹 | 374 ms（含末尾 40 ms 保持） | ✓ |

功能验证（都在微信里真做）：
- 点搜索图标 → 进搜索页；
- 点会话行 → 进会话；
- 点输入栏笑脸 → 表情面板打开；
- **长按会话行** → 「标为未读/置顶/不显示/删除」菜单；
- **长按消息气泡** → 10 项菜单（复制/转发/收藏…）。

## 踩过的坑（都是实测，不是猜）

1. **长按必须不发 MOVE**：按住期间发 MOVE，微信消息气泡的长按会被取消（列表行的长按反而容忍 MOVE）。真人按住不动本来也不产生中间事件。
2. **`pkill -f mimic.Injector` 会杀掉执行它的 shell**：命令行里含同样的字符串，自己匹配自己。要用 `ps -A -o PID,ARGS | grep '[m]imic'` 取 PID 再 kill。
3. **Android 10 的 `ps -A` 不显示命令行**，只有进程名 `app_process`；要 `-o PID,ARGS` 才能看到 `mimic.Injector 7801`。
4. **重启有端口竞争**：旧进程刚被 kill、socket 还没释放，新进程 bind 会失败 → 注入器内置 10 次重试（每次 300 ms）。
5. **MSYS 路径转换**：`adb push 文件 /data/local/tmp/x.dex` 会被转成 Windows 路径；`MSYS_NO_PATHCONV=1` 能解决 push，但会让 Node 收到的 `--adb /d/...` 失效。**统一用 Node 脚本（deploy.ts）发 adb 命令**，不要在 bash 里混着来。
6. **坐标会漂**：面板开合、消息滚动都会让之前量好的坐标失效。每次动作前必须重新截图确认，不能缓存。

## 还没做

- **事件参数的端到端验证**：注入器知道自己设了 pressure=0.55/downMs=65，但没有第三方能证明微信收到的是这些值。要真正验证，得做一个极小的「触摸参数显示」APK，装在手机上读 `MotionEvent` 的 `getPressure()/getSize()/getEventTime()` 并显示出来。这是 L1 验收（KS 检验）的前置。
- **多指/捏合**：协议目前只有单点。
- **键盘注入**：文本仍走 ADBKeyboard（逐字 base64），注入器不管键盘。