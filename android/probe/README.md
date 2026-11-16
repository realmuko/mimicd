# MimicProbe（android/probe）

一个自用的小 APK，干两件事：

1. **触摸参数探针**：把收到的每个 `MotionEvent` 原样打出来（`deviceId`、`pressure`、`size`、`toolMajor`、`downToEvent`、`source`、`history`）。用来证明注入器设的值真的到了应用这一侧。
2. **自建输入法**：作为默认输入法时，读剪贴板、读输入框已有文本（`getTextBeforeCursor`）、写剪贴板、提交文本。这是微信里唯一**零 OCR 误差**的文本通道。

## 构建与安装

```bash
bash android/probe/build.sh            # aapt2 → javac → d8 → 打包 → zipalign → apksigner
node tools/probe/install.ts --adb "<adb>"
```

手工打包，不引 Gradle：`aapt2 compile/link` + `javac`（`-bootclasspath android.jar`）+ `d8` + `jar uf` 塞 dex + `zipalign` + `apksigner`，首次会自动生成 `debug.keystore`。

**Honor/EMUI 会拦两次**：「风险提示」→「未经华为应用市场检测」，各要按一次「继续安装」。
`tools/probe/install.ts` 会自动做这件事：轮询 `uiautomator dump`，找 `text="继续安装"` 且 `clickable=true` 的节点，按它的 `bounds` 中心点。不要手点，也不要用 `adb install`（它会一直等这个框，看起来像卡死）。

## 触摸探针

```bash
adb shell am start -n mimic.probe/.MainActivity
adb logcat -c
node tools/inject/client.ts "tap 540 800 65"
adb logcat -d -s MimicTouch:I | tail
```

输出形如：

```json
{"n":1,"action":"DOWN","x":540.0,"y":800.0,"pressure":0.550,"size":0.120,"toolMajor":24.0,
 "deviceId":0,"source":4098,"downToEvent":0,"eventTime":534595867,"history":0,"pointers":1}
```

同时写 `getExternalFilesDir/touch.jsonl`（logcat 缓冲有限，长跑用文件）。

## 输入法

```bash
adb shell ime enable mimic.probe/.ProbeIme
adb shell ime set    mimic.probe/.ProbeIme        # 切过去（记得切回来！）

# 命令（必须用 -n 指定组件：receiver 没声明 intent-filter，-p 包名不算显式广播）
adb shell am broadcast -n mimic.probe/.CommandReceiver -a mimic.READ_CLIPBOARD
adb shell am broadcast -n mimic.probe/.CommandReceiver -a mimic.READ_INPUT
adb shell am broadcast -n mimic.probe/.CommandReceiver -a mimic.SET_CLIPBOARD --es text 'hello'
adb shell am broadcast -n mimic.probe/.CommandReceiver -a mimic.TYPE --es text 'hello'
adb shell am broadcast -n mimic.probe/.CommandReceiver -a mimic.CLEAR

# 用完切回原来的输入法
adb shell ime set com.android.adbkeyboard/.AdbIME
adb shell ime disable mimic.probe/.ProbeIme
```

结果在 `adb logcat -s MimicCmd:I`，格式 `动作 => 结果`。

## 实测（2026-11-17，Honor BKL-AL20 / Android 10 / 微信 8.0.80）

| 项 | 注入器设的 | 应用侧收到 |
|---|---|---|
| `pressure` | 0.550 | **0.550** |
| `size` | 0.120 | **0.120** |
| `toolMajor` | 24 px | **24.0** |
| `downToEvent` | 65 / 700 / 300 ms | **66 / 702 / 300 ms** |
| `source` | touchscreen | **4098** |
| `deviceId` | 0 | **0**（不是 -1） |

- `deviceId=0` 与 AOSP 文档/CTS 里「注入事件被改写成 `VIRTUAL_KEYBOARD_ID=-1`」的结论**不一致**。至少在这台 EMUI 10 上，这条「一行代码即可判定」的检测不成立。要判定得靠其它特征（例如 `getDevice(0)` 的设备名、压力/面积分布）。
- 输入法：`SET_CLIPBOARD` → `READ_CLIPBOARD` 原样读回；`TYPE` 11 个字符 → 在**微信搜索框**（a11y 全封的应用）里 `READ_INPUT` 读回 `hello-mimic`。零 OCR 误差的文本通道成立。

## 坑

1. 触摸监听必须挂在 `dispatchTouchEvent` 上。第一版挂在 `TextView.setOnTouchListener`，结果窗口下半部分（ScrollView 空白区）的触摸全丢了。
2. `<receiver>` 没有 `intent-filter` 时，`am broadcast -p <包名>` **送不到**（`-p` 只限定包，不算显式）。必须用 `-n <包>/.<类>`。
3. `ime set` 会改全局默认输入法；脚本里切走之后一定要切回来，否则你打字会打到探针里。
4. APK 的 `versionCode` 要动。否则 `pm install -r` 看起来装成功，实际还是旧进程。
5. `uiautomator dump` 会写到 `/sdcard/`；用 `adb exec-out cat /sdcard/x.xml` 时 MSYS 会把路径转成 `C:/...`，要么用 `adb shell "cat /sdcard/x.xml"`，要么加 `MSYS2_ARG_CONV_EXCL='*'`。