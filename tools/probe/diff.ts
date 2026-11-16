/**
 * 两张截图的差分报告：变化多少、变在哪。
 *
 *   node tools/probe/diff.ts a.png b.png [--rect x,y,w,h]
 *
 * 用来回答「静置时画面到底有没有变、变的是不是输入框光标」这种问题。
 */

import { readFileSync } from "node:fs";

import { crop, decode, dhash, hamming, regionDiff, type Bitmap, type Rect } from "../../src/image/image.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [fileA, fileB] = positional;
if (!fileA || !fileB) {
  console.error("用法: node tools/probe/diff.ts a.png b.png [--rect x,y,w,h]");
  process.exit(1);
}

const a = decode(readFileSync(fileA));
const b = decode(readFileSync(fileB));

const rectArg = arg("rect");
const rect: Rect | undefined = rectArg
  ? (() => {
      const [x, y, w, h] = rectArg.split(",").map(Number) as [number, number, number, number];
      return { x, y, w, h };
    })()
  : undefined;

function report(name: string, target: Rect | undefined) {
  const d = regionDiff(a, b, target);
  const pct = (d.ratio * 100).toFixed(3);
  console.log(
    `${name.padEnd(18)} 变化 ${String(d.changed).padStart(7)} / ${d.total} 像素 (${pct}%)  外接框 ${d.bbox.w}×${d.bbox.h} @ ${d.bbox.x},${d.bbox.y}`,
  );
  return d;
}

function hashOf(bmp: Bitmap, target?: Rect): string {
  return dhash(target ? crop(bmp, target) : bmp);
}

console.log(`图 A ${a.width}×${a.height} · 图 B ${b.width}×${b.height}`);
console.log(`全帧 dHash  A=${hashOf(a)}  B=${hashOf(b)}  汉明距离=${hamming(hashOf(a), hashOf(b))}`);
report("全帧", undefined);
report("消息区(上 80%)", { x: 0, y: 0, w: a.width, h: Math.floor(a.height * 0.8) });
report("输入栏(下 20%)", { x: 0, y: Math.floor(a.height * 0.8), w: a.width, h: Math.floor(a.height * 0.2) });
if (rect) report("指定区域", rect);