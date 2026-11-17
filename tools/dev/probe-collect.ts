/**
 * 开发用：查「长按表情 → 菜单 → 点添加」这条收藏链路，到底卡在哪一步。
 *
 *   node tools/dev/probe-collect.ts --adb "<adb>"
 *
 * 只做诊断：长按最新一张对方发的图/表情，截图、找深色菜单、打印面板与格点，
 * **不点添加、不改任何东西**（除了那一张被长按）。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { Adb } from "../../src/device/adb.ts";
import { InjectorClient } from "../../src/device/injector.ts";
import { decode, crop, encode } from "../../src/image/image.ts";
import type { PageGraph } from "../../src/perception/page.ts";
import { rectOf } from "../../src/perception/page.ts";
import { findImageBubbles } from "../../src/perception/bubbles.ts";
import { findDarkPanel, isMenuPanel } from "../../src/perception/panel.ts";
import { Ocr } from "../../src/perception/ocr.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adb = new Adb({ adbPath: arg("adb", process.env["ADB_PATH"] ?? "adb") });
const graph = JSON.parse(readFileSync(resolve("profiles/wechat/pages.json"), "utf8")) as PageGraph;
const injector = new InjectorClient({ port: 7801 });
await adb.forward(7801, 7801);
await injector.ping();

mkdirSync("data/probe", { recursive: true });
const screen = graph.device.screen;
const area = rectOf(graph, "chat", "message_area", screen.w, screen.h);

const before = await adb.screencap();
writeFileSync("data/probe/collect-before.png", before.png);
const bmp = decode(before.png);
const bubbles = findImageBubbles(bmp, area).filter((b) => b.side === "left");
console.log(
  "左图/表情气泡：",
  bubbles.length,
  bubbles.map((b) => JSON.stringify(b.rect)).join(" "),
);
if (bubbles.length === 0) process.exit(2);

const target = bubbles[bubbles.length - 1]!;
console.log("长按：", JSON.stringify(target.rect));
await injector.hold(target.rect.x + target.rect.w / 2, target.rect.y + target.rect.h / 2, 650);
await new Promise((r) => setTimeout(r, 900));

const after = await adb.screencap();
writeFileSync("data/probe/collect-after-hold.png", after.png);
const afterBmp = decode(after.png);
const focus = await adb.focus();
console.log("长按后焦点：", focus.component || focus.raw);

const panel = findDarkPanel(afterBmp);
if (!panel) {
  console.log("没找到深色面板");
  process.exit(3);
}
console.log("面板：", JSON.stringify(panel.rect), "isMenuPanel=", isMenuPanel(afterBmp, panel.rect));
for (let row = 0; row < 2; row++) {
  for (let col = 0; col < 5; col++) {
    const p = panel.cell(col, row, 5, 2);
    console.log(`  格 [${row},${col}] → (${Math.round(p.x)}, ${Math.round(p.y)})`);
  }
}
const ocr = new Ocr({ script: resolve("tools/ocr/ocr.ps1"), workDir: resolve("data/tmp"), scale: 4 });
const panelOcr = await ocr.recognize(after.png, panel.rect);
console.log("面板 OCR：", panelOcr.lines.map((l) => `${l.text}@${l.x},${l.y}`).join(" / "));
// 把面板区域裁出来存一张，肉眼确认菜单项顺序
writeFileSync("data/probe/collect-panel.png", encode(crop(afterBmp, panel.rect)));
console.log("面板截图：data/probe/collect-panel.png");