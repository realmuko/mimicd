# 设备探针

一次跑完「微信到底给了我们什么」的五个问题，产出人读的报告 + 机器读的 `raw.json`。

```bash
cd <repo>
node tools/probe/probe.ts --adb "<dsh>/.tools/platform-tools/adb.exe"
# 指定设备 / 指定输出目录：
node tools/probe/probe.ts --adb <adb> --serial A7Q0212... --out data/probe
```

**纪律：只读。** 不点击、不输入、不滚动、不发消息；跑完手机停在原来的页面。

## 它回答什么

| # | 问题 | 为什么重要 | 判好的标准 |
|---|---|---|---|
| 1 | `uiautomator dump` 能拿到几个节点、几段文本？ | 旧插件注释说「微信把无障碍树封了」，要复核。能拿到 → 输入框/搜索框可零误差读 | 节点 ≥5 且文本 ≥1 |
| 2 | shell 有没有办法读剪贴板？ | 有 → 复制/粘贴即高保真文本通道（零 OCR 误差） | 任一命令返回真文本 |
| 3 | 微信通知里有正文吗？ | 有 → 低频巡场不必点亮屏幕 | 至少 1 条带正文 |
| 4 | 静置时两帧是否相同、gfxinfo 帧号是否不动、一帧多少 ms？ | 「等稳定帧」的判据能不能成立 | 两帧哈希相同 + 帧数不涨 |
| 5 | 型号/分辨率/密度/输入法/前台/微信版本 | 页面图与坐标表的基准 | 记录下来即可 |

## 输出

```
data/probe/20261116-234500/
  report.md          人读：五问结论表 + a11y 文本 + 通知正文 + 剪贴板尝试
  raw.json           机器读：每步的 ok/ms/error
  screen-1.png       第一帧
  screen-2.png       300ms 后第二帧（对比用）
  a11y.xml           原始 dump
  notifications.txt  原始 dumpsys
```

## 已知的坑（来自旧插件 + 这次调研）

- `uiautomator dump` 失败有四种：动画中拿不到 idle、厂商 ROM 抛异常、单例冲突、WebView 无节点。探针把异常原样记进 `error`，不猜。
- ADBKeyboard **只能写不能读**（[README](https://github.com/senzhk/ADBKeyBoard) 里没有任何取回文本的 action）。所以「剪贴板往返读回」不能靠它：要么自建 IME 读 `InputConnection`，要么粘贴后截图 OCR 大字。
- `dumpsys notification` 在部分 ROM 上要加 `--noredact` 才有正文；折叠成「N 条新消息」时只拿到标题。
- `gfxinfo framestats` 需要应用在前台才会有数据；后台时帧数不涨，别误判成「页面稳定」。所以探针要先记录前台是谁。