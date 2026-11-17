/**
 * 开发用：在当前（聊天）页找链接卡片，把 OCR 行与判定结果打出来。
 *
 *   node tools/dev/find-card.ts --adb "<adb>"
 *
 * 用来校准 findCardTitle 的阈值：不同 scale 下 OCR 行高会变，
 * 这里直接把 scale=2/3 的行都打印出来对照。
 */

import { writeFileSync } from "node:fs";

import { Adb } from "../../src/device/adb.ts";
import { Ocr } from "../../src/perception/ocr.ts";
import { findCardTitle } from "../../src/perception/cards.ts";
import { findLinkCards } from "../../src/perception/cards.ts";
import { decode } from "../../src/image/image.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const adb = new Adb({ adbPath });
const area = { x: 0, y: 173, w: 1080, h: 1858 };

const shot = await adb.screencap();
writeFileSync("data/probe/card-now.png", shot.png);
const bmp = decode(shot.png);
const pixel = findLinkCards(bmp, area);
console.log(`像素白卡：${pixel.length} 张`, pixel.map((c) => JSON.stringify(c.rect)).join(" "));

for (const scale of [2, 3, 4]) {
  const ocr = new Ocr({ script: "<repo>/tools/ocr/ocr.ps1", workDir: "<repo>/data/tmp", scale });
  const r = await ocr.recognize(shot.png, area);
  const title = findCardTitle(r.lines);
  console.log(`\n=== scale ${scale}：${r.lines.length} 行，标题 = ${title ? JSON.stringify(title.text) : "无"}`);
  for (const l of r.lines) {
    console.log(`  y=${String(l.y).padStart(4)} h=${String(l.h).padStart(3)} x=${String(l.x).padStart(4)} w=${String(l.w).padStart(4)}  ${l.text.slice(0, 40)}`);
  }
}