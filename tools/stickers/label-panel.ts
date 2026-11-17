/**
 * 给收藏的表情打标签：进会话 → 开表情面板 → 收藏页 → 截图 → 识别格子 → 逐张交给视觉模型 → 入库。
 *
 *   node tools/stickers/label-panel.ts --adb "<adb>"             # 真机
 *   node tools/stickers/label-panel.ts --adb "<adb>" --chat 文件传输助手
 *   node tools/stickers/label-panel.ts --png data/probe/panel.png   # 离线，用现成截图
 *
 * 只读操作 + 视觉标注；不会发送任何消息。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Adb } from "../../src/device/adb.ts";
import { InjectorClient } from "../../src/device/injector.ts";
import { Ocr } from "../../src/perception/ocr.ts";
import { crop, decode, type Bitmap } from "../../src/image/image.ts";
import { findStickerCells, type PanelGrid } from "../../src/perception/cells.ts";
import { rectOf, detectPage, decodeFrame } from "../../src/perception/page.ts";
import { cleanName, isNameLine, scanList } from "../../src/monitor/scan.ts";
import { StickerLabeler, featuresOf } from "../../src/stickers/labeler.ts";
import { StickerLibrary } from "../../src/stickers/library.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i >= 0 && next && !next.startsWith("--") ? next : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const serial = arg("serial");
const chatName = arg("chat", "文件传输助手");
const pngPath = arg("png");
const graph = JSON.parse(readFileSync(resolve("profiles/wechat/pages.json"), "utf8"));
const lib = new StickerLibrary(resolve("data/stickers/index.json"));
lib.load();
const labeler = new StickerLabeler();

const grid = (graph.pages.sticker_panel.grid as { scan: PanelGrid }).scan;

async function labelFromBitmap(bmp: Bitmap, source: "panel" | "received") {
  const cells = findStickerCells(bmp, grid);
  console.log(`识别到 ${cells.length} 个候选格`);
  let added = 0;
  for (const cell of cells) {
    const piece = crop(bmp, cell.rect);
    const feat = featuresOf(piece);
    const known = lib.findByFeatures(feat.hist, feat.dhash);
    if (known) {
      console.log(`  #${cell.index} 已在库里（${known.mood} · funny ${known.funny}）`);
      continue;
    }
    const t0 = Date.now();
    const label = await labeler.label(piece);
    const entry = lib.upsert({
      dhash: feat.dhash,
      hist: feat.hist,
      mood: label.mood,
      tags: label.tags,
      funny: label.funny,
      source,
    });
    added++;
    console.log(`  #${cell.index} → ${label.mood} · funny ${label.funny} · ${label.tags.join("/")}  (${Date.now() - t0}ms)`);
    void entry;
  }
  return added;
}

if (pngPath) {
  const bmp = decode(readFileSync(resolve(pngPath)));
  console.log(`离线：${pngPath}`);
  const added = await labelFromBitmap(bmp, "panel");
  lib.save();
  console.log(`新增 ${added} 张，库共 ${lib.size} 张；分布 ${JSON.stringify(lib.moodCounts())}`);
  process.exit(0);
}

// ---- 真机 ----
const adb = new Adb({ adbPath, serial });
const injector = new InjectorClient({ port: 7801 });
const ocr = new Ocr({ script: resolve("tools/ocr/ocr.ps1"), workDir: resolve("data/tmp"), scale: 3 });

await adb.forward(7801, 7801);
await injector.ping();

// 回列表
for (let i = 0; i < 4; i++) {
  const frame = await adb.screencap();
  if (detectPage(decodeFrame(frame), await adb.focus()).page === "list") break;
  await adb.shell("input keyevent KEYCODE_BACK", 15000);
  await new Promise((r) => setTimeout(r, 500));
}

// 找到目标会话并进入
const listShot = await adb.screencap();
const screen = graph.device.screen;
const listArea = rectOf(graph, "list", "list_area", screen.w, screen.h);
const listOcr = await ocr.recognize(listShot.png, listArea);
const hit =
  listOcr.lines.find((l) => isNameLine(l) && cleanName(l.text).includes(chatName)) ??
  scanList(decode(listShot.png), listOcr.lines, listArea).rows.find((r) => r.name.includes(chatName));
if (!hit) {
  console.error(`列表里没找到「${chatName}」`);
  process.exit(2);
}
const y = "h" in hit ? hit.y + hit.h / 2 : hit.y;
await injector.tap(300, Math.round(y), 70);
await new Promise((r) => setTimeout(r, 2500));

// 开面板 → 收藏 tab
await injector.tap(Math.round(screen.w * 0.83), Math.round(screen.h * 0.98), 70);
await new Promise((r) => setTimeout(r, 1200));
const fav = rectOf(graph, "sticker_panel", "tab_favorites", screen.w, screen.h);
await injector.tap(fav.x + fav.w / 2, fav.y + fav.h / 2, 70);
await new Promise((r) => setTimeout(r, 1500));

const shot = await adb.screencap();
const added = await labelFromBitmap(decode(shot.png), "panel");
lib.save();

// 关面板
await adb.shell("input keyevent KEYCODE_BACK", 15000);
console.log(`新增 ${added} 张，库共 ${lib.size} 张；分布 ${JSON.stringify(lib.moodCounts())}`);