/**
 * 开发用：长按一个气泡 → 找浮层 → 点「复制」→ 读剪贴板。
 *
 *   node tools/dev/read-bubble.ts --adb "<adb>" --rect 473,1526,433,111
 *
 * 这是「零 OCR 读消息」的最小验证。气泡位置目前由调用方给（矩形从截图量），
 * 等页面图里有了「气泡定位」再做成技能。
 */

import { Adb } from "../../src/device/adb.ts";
import { InjectorClient } from "../../src/device/injector.ts";
import { ImeClient } from "../../src/device/ime.ts";
import { decode } from "../../src/image/image.ts";
import { findDarkPanel } from "../../src/perception/panel.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const serial = arg("serial");
const rectArg = arg("rect");
if (!rectArg) {
  console.error("用法: node tools/dev/read-bubble.ts --adb <adb> --rect x,y,w,h");
  process.exit(1);
}
const [x, y, w, h] = rectArg.split(",").map(Number);
if ([x, y, w, h].some((n) => !Number.isFinite(n))) {
  console.error("--rect 需要 x,y,w,h 四个数字");
  process.exit(1);
}

const adb = new Adb({ adbPath, serial });
const injector = new InjectorClient({ port: 7801 });
const ime = new ImeClient(adb);

const cx = x + w / 2;
const cy = y + h / 2;

console.log(`长按 ${cx},${cy}（矩形 ${w}×${h}）`);
await injector.hold(cx, cy, 700);
await new Promise((r) => setTimeout(r, 700));

const shot = await adb.screencap();
const bmp = decode(shot.png);
const panel = findDarkPanel(bmp);
if (!panel) {
  console.error("没找到浮层菜单：可能长按没选中气泡，或页面已经变了");
  process.exit(2);
}
console.log(`浮层 bbox ${panel.rect.x},${panel.rect.y} ${panel.rect.w}×${panel.rect.h}`);
const copy = panel.cell(0, 0, 5, 2);
console.log(`点「复制」@ ${copy.x},${copy.y}`);
await injector.tap(copy.x, copy.y, 60);
await new Promise((r) => setTimeout(r, 400));

const text = await ime.readClipboard();
console.log("剪贴板：" + JSON.stringify(text));
if (!text) {
  console.error("剪贴板是空的：可能点错了菜单项（点了「转发」之类），或者输入法不是 mimic.probe");
  process.exit(3);
}