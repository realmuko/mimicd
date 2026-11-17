/**
 * 只读的列表扫描：回到列表 → 截图 → OCR → 红点 → 打印未读行。
 *
 *   node tools/dev/scan-list.ts --adb "<adb>"
 *
 * 不点会话、不进聊天，只按 back 回列表。用来校验「红点 + 名字」在真机屏幕上准不准。
 */

import { Adb } from "../../src/device/adb.ts";
import { Ocr } from "../../src/perception/ocr.ts";
import { detectPage, decodeFrame, rectOf } from "../../src/perception/page.ts";
import { scanList } from "../../src/monitor/scan.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i >= 0 && next && !next.startsWith("--") ? next : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const serial = arg("serial");
const graphPath = resolve(arg("graph", "profiles/wechat/pages.json"));

const graph = JSON.parse(readFileSync(graphPath, "utf8"));
const adb = new Adb({ adbPath, serial });
const ocr = new Ocr({ script: resolve("tools/ocr/ocr.ps1"), workDir: resolve("data/tmp"), scale: 3 });

// 回列表
for (let i = 0; i < 4; i++) {
  const frame = await adb.screencap();
  const page = detectPage(decodeFrame(frame), await adb.focus());
  if (page.page === "list") break;
  await adb.shell("input keyevent KEYCODE_BACK", 15000);
  await new Promise((r) => setTimeout(r, 500));
}

const frame = await adb.screencap();
const bmp = decodeFrame(frame);
const screen = graph.device.screen;
const area = rectOf(graph, "list", "list_area", screen.w, screen.h);
const result = await ocr.recognize(frame.png, area);
const scan = scanList(bmp, result.lines, area);

console.log(`OCR ${result.lines.length} 行 · 红点 ${scan.badges} 个 · 未读行 ${scan.rows.length} 个`);
for (const row of scan.rows) {
  console.log(`  y=${Math.round(row.y)}  ${row.name}  (unread=${row.unread})`);
}

if (process.argv.includes("--lines")) {
  console.log("--- 全部 OCR 行 ---");
  for (const l of result.lines) console.log(`  y=${l.y} h=${l.h} x=${l.x} ${JSON.stringify(l.text)}`);
}