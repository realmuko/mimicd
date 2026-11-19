/**
 * 开发用：收藏表情面板到底能不能往下滑、下面是还有多少张。
 *
 *   node tools/dev/probe-panel-scroll.ts --adb "<adb>" [--serial XXX] [--screens 6]
 *
 * 做三件事（只开面板、只滑动，**不发任何表情**）：
 *   1. 在会话页点开表情面板，确认面板真的开了；
 *   2. 每滑一下截一帧，数出这一屏能识别到几个格子、内容有没有真的动；
 *   3. 把每屏的格子跟表情库对上，看「库里有、但当前屏够不着」的到底有多少。
 *
 * 结论用来回答：引擎是不是永远不会往下滑（2026-11-19 用户指出的问题）。
 * 跑完按 BACK 关面板，不动聊天记录。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { Adb } from "../../src/device/adb.ts";
import { InjectorClient } from "../../src/device/injector.ts";
import { decode, crop, regionDiff, stickerFeatures } from "../../src/image/image.ts";
import { detectPage, decodeFrame, rectOf, type PageGraph } from "../../src/perception/page.ts";
import { findStickerCells, type PanelGrid } from "../../src/perception/cells.ts";
import { looksLikeInputBar } from "../../src/perception/page.ts";
import { StickerLibrary } from "../../src/stickers/library.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}
const num = (s: string, d: number) => (Number.isFinite(Number(s)) && s !== "" ? Number(s) : d);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const adb = new Adb({ adbPath: arg("adb", process.env["ADB_PATH"] ?? "adb") });
const graph = JSON.parse(readFileSync(resolve("profiles/wechat/pages.json"), "utf8")) as PageGraph;
const injector = new InjectorClient({ port: 7801 });
const screensToTry = num(arg("screens", "6"), 6);

await adb.forward(7801, 7801);
await injector.ping();

const lib = new StickerLibrary(resolve("data/stickers/index.json"));
lib.load();
const scan = (graph.pages["sticker_panel"]?.grid as { scan?: unknown } | undefined)?.scan as PanelGrid | undefined;
if (!scan) throw new Error("页面图里没有 sticker_panel.grid.scan");
const screen = graph.device.screen;
const gridArea = rectOf(graph, "sticker_panel", "grid_area", screen.w, screen.h);
const emojiBtn = rectOf(graph, "chat", "emoji_button", screen.w, screen.h);
const midX = gridArea.x + gridArea.w / 2;
const stepPx = Math.round(scan.pitchY * screen.h);

mkdirSync("data/probe", { recursive: true });

const page0 = detectPage(decodeFrame(await adb.screencap()), await adb.focus());
if (page0.page !== "chat") {
  console.log(JSON.stringify({ ok: false, step: "enter-chat", page: page0.page, hint: "先把微信停在某个会话页" }));
  process.exit(2);
}

// 1) 打开表情面板
await injector.tap(Math.round(emojiBtn.x + emojiBtn.w / 2), Math.round(emojiBtn.y + emojiBtn.h / 2), 60);
await sleep(1500);

interface FrameReport {
  screen: number;
  cells: number;
  matched: string[];
  changedFromPrev: boolean | null;
  file: string;
}

const reports: FrameReport[] = [];
let prevBmp: ReturnType<typeof decode> | null = null;

async function snap(n: number): Promise<void> {
  const shot = await adb.screencap();
  const file = `data/probe/panel-${String(n).padStart(2, "0")}.png`;
  writeFileSync(file, shot.png);
  const bmp = decode(shot.png);
  const panelOpen = !looksLikeInputBar(bmp);
  const cells = panelOpen ? findStickerCells(bmp, scan!) : [];
  const matched: string[] = [];
  for (const cell of cells) {
    const feat = stickerFeatures(crop(bmp, cell.rect));
    const e = lib.findByFeatures(feat.hist, feat.dhash) ?? lib.findByFeatures(feat.hist, feat.dhash, 0.88, 30);
    matched.push(e ? `${e.id}:${e.mood}` : "?");
  }
  const changed =
    prevBmp === null ? null : regionDiff(prevBmp, bmp, gridArea, 8).changed > 0;
  reports.push({ screen: n, cells: cells.length, matched, changedFromPrev: changed, file });
  prevBmp = bmp;
}

await snap(0);
if (reports[0]!.cells === 0) {
  console.log(
    JSON.stringify({ ok: false, step: "panel-open", hint: "面板没开（格子 0）。先确认会话页在、键盘收起来了" }),
  );
  process.exit(3);
}

// 2) 一下一下往下滑
for (let i = 1; i <= screensToTry; i++) {
  const y0 = Math.round(gridArea.y + gridArea.h * 0.72);
  const y1 = y0 - stepPx;
  await injector.swipe(midX, y0, midX, y1, 260);
  await sleep(800);
  await snap(i);
}

// 3) 收尾：滑回顶部再关面板
for (let i = 0; i < screensToTry; i++) {
  const y0 = Math.round(gridArea.y + gridArea.h * 0.3);
  await injector.swipe(midX, y0, midX, y0 + stepPx, 260);
  await sleep(350);
}
await adb.shell("input keyevent KEYCODE_BACK", 15000);

const allMatched = new Set(reports.flatMap((r) => r.matched.filter((m) => m !== "?")));
console.log(
  JSON.stringify(
    {
      ok: true,
      library: lib.size,
      screen: { w: screen.w, h: screen.h },
      gridArea,
      stepPx,
      frames: reports.map((r) => ({
        screen: r.screen,
        cells: r.cells,
        changed: r.changedFromPrev,
        matched: r.matched,
      })),
      reachableUnique: allMatched.size,
      reachable: [...allMatched],
      hint:
        reports.filter((r) => r.changedFromPrev === true).length <= 1
          ? "滑不动：内容几乎没变，scroll() 的 swipe 没落到可滚区域/幅度不够"
          : "能滑：内容在变",
    },
    null,
    2,
  ),
);