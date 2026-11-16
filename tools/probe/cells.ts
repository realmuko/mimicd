/**
 * 在表情面板里找「真贴纸」格子。
 *
 *   node tools/probe/cells.ts data/probe/snaps/panel-after/screen.png [--y0 0.63] [--x1 0.72]
 *
 * 为什么需要：收藏页不是统一网格（左区格距 199、右区推广位格距约 100），
 * 而且混着 `+`（虚线空框）和「微信输入法」推广位。按序号硬点必然点错。
 *
 * 判据：非背景像素的连通块 + 面积/尺寸/填充率。
 *   - 真贴纸：一块实心内容，填充率通常 > 0.45
 *   - `+` 号：空心虚线框，填充率很低
 *   - 推广位图标：比贴纸小一圈
 */

import { readFileSync } from "node:fs";

import { contentBox, crop, decode, dhash, colorHist, type Bitmap, type Rect } from "../../src/image/image.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const file = process.argv[2];
if (!file) {
  console.error("用法: node tools/probe/cells.ts <panel.png> [--y0 0.63] [--y1 0.93] [--x1 0.72]");
  process.exit(1);
}

const img = decode(readFileSync(file));
const y0 = Math.floor(img.height * Number(arg("y0", "0.63")));
const y1 = Math.floor(img.height * Number(arg("y1", "0.93")));
const x0 = 0;
const x1 = Math.floor(img.width * Number(arg("x1", "0.72")));

// 背景色：取网格区左上角一小块的中位数
const bgSample = contentBox(crop(img, { x: x0, y: y0, w: 8, h: 8 }));
const bg = bgSample.bg;
const tol = 16;

function isContent(x: number, y: number): boolean {
  const p = (y * img.width + x) * 4;
  return (
    Math.abs(img.data[p]! - bg[0]) > tol ||
    Math.abs(img.data[p + 1]! - bg[1]) > tol ||
    Math.abs(img.data[p + 2]! - bg[2]) > tol
  );
}

// 连通块（4 邻域，迭代栈，按 2px 步长采样以提速；bbox 仍按全分辨率算）
const step = 2;
const w = Math.ceil((x1 - x0) / step);
const h = Math.ceil((y1 - y0) / step);
const seen = new Uint8Array(w * h);
const comps: Array<{ x0: number; y0: number; x1: number; y1: number; area: number }> = [];

for (let gy = 0; gy < h; gy++) {
  for (let gx = 0; gx < w; gx++) {
    const idx = gy * w + gx;
    if (seen[idx]) continue;
    seen[idx] = 1;
    const px = x0 + gx * step;
    const py = y0 + gy * step;
    if (!isContent(px, py)) continue;

    const stack: Array<[number, number]> = [[gx, gy]];
    let minX = px;
    let minY = py;
    let maxX = px;
    let maxY = py;
    let area = 0;

    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      area++;
      const ax = x0 + cx * step;
      const ay = y0 + cy * step;
      if (ax < minX) minX = ax;
      if (ax > maxX) maxX = ax;
      if (ay < minY) minY = ay;
      if (ay > maxY) maxY = ay;
      const neigh: Array<[number, number]> = [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ];
      for (const [nx, ny] of neigh) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        if (isContent(x0 + nx * step, y0 + ny * step)) stack.push([nx, ny]);
      }
    }
    comps.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, area });
  }
}

interface Cell extends Rect {
  fill: number;
  dhash: string;
  meanLuma: number;
}

const cells: Cell[] = [];
for (const c of comps) {
  const cw = c.x1 - c.x0 + step;
  const ch = c.y1 - c.y0 + step;
  if (cw < 50 || ch < 50) continue; // 噪声/小图标
  if (cw > 300 || ch > 400) continue; // 整块背景或横跨多格
  const rect: Rect = { x: c.x0, y: c.y0, w: cw, h: ch };
  const piece = crop(img, rect);
  const box = contentBox(piece, tol);
  const fill = c.area * step * step / (cw * ch);
  const luma = (() => {
    const hh = colorHist(piece);
    // 亮度近似：直方图按 bin 的 r/g/b 均值加权
    let sum = 0;
    for (let i = 0; i < hh.length; i++) {
      const r = (i >> 4) & 3;
      const g = (i >> 2) & 3;
      const b = i & 3;
      sum += hh[i]! * (r + g + b) / 3;
    }
    return sum;
  })();
  cells.push({ ...rect, fill: Number(fill.toFixed(3)), dhash: dhash(piece), meanLuma: Number(luma.toFixed(2)) });
  void box;
}

cells.sort((a, b) => a.x - b.x || a.y - b.y);

console.log(`# ${file}  区域 y ${y0}-${y1} x ${x0}-${x1}  背景 rgb(${bg.join(",")})`);
console.log(`找到 ${cells.length} 个候选格：`);
for (const [i, c] of cells.entries()) {
  const small = c.w < 120 || c.h < 120;
  const verdict = small ? "小图标（推广位/装饰，跳过）" : c.fill < 0.35 ? "空心（+ 号，跳过）" : "贴纸";
  console.log(
    `  #${i + 1}  bbox ${String(c.x).padStart(4)},${String(c.y).padStart(4)} ${String(c.w).padStart(3)}×${String(c.h).padStart(3)}  ` +
      `填充 ${c.fill.toFixed(3)}  亮度 ${c.meanLuma.toFixed(2)}  dhash ${c.dhash}  → ${verdict}`,
  );
}