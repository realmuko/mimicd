/**
 * 开发用：拿一张截图，找出里面的表情/图片气泡，交给视觉模型打标。
 *
 *   node tools/dev/label-sticker.ts --png "C:/path/to/sticker.png"
 *   node tools/dev/label-sticker.ts            # 不给就用当前手机截图
 */

import { readFileSync } from "node:fs";

import { Adb } from "../../src/device/adb.ts";
import { decode, crop } from "../../src/image/image.ts";
import { findImageBubbles } from "../../src/perception/bubbles.ts";
import { StickerLabeler } from "../../src/stickers/labeler.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const pngPath = arg("png");
const png = pngPath
  ? readFileSync(pngPath)
  : (await new Adb({ adbPath }).screencap()).png;

const bmp = decode(png);
const bubbles = findImageBubbles(bmp, { x: 0, y: 173, w: bmp.width, h: bmp.height - 350 });
console.log(`图片/表情气泡：${bubbles.length}`, bubbles.map((b) => JSON.stringify(b.rect)).join(" "));
if (bubbles.length === 0) process.exit(2);

const best = bubbles.slice().sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0]!;
const part = crop(bmp, best.rect);
const labeler = new StickerLabeler();
const t0 = Date.now();
const label = await labeler.label(part);
console.log(`用时 ${Date.now() - t0}ms`, JSON.stringify(label));