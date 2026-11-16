/**
 * 链接卡片定位。
 *
 * 为什么要单独找：聊天里的卡片是**白色大圆角矩形**（微信底色 237，卡片 255），
 * 宽度远大于普通气泡（约 60% 屏宽），位置随消息滚动 —— 不能写死在页面图里。
 *
 * 做法：行/列投影找「近白占比高的宽带」，再用高度和宽度卡掉普通白气泡。
 */

import type { Bitmap, Rect } from "../image/image.ts";

export interface CardHit {
  rect: Rect;
  /** 卡片高度占扫描区高度的比例，用于排序（最近的通常在下面） */
  ratio: number;
}

export interface CardOptions {
  /** 近白阈值 */
  whiteThreshold?: number;
  /** 一行里近白像素占比超过它算「卡片行」 */
  minRowCoverage?: number;
  /** 卡片最小宽度占屏比 */
  minWidthRatio?: number;
  /** 卡片最小/最大高度占扫描区比 */
  minHeightRatio?: number;
  maxHeightRatio?: number;
}

function lumaAt(bmp: Bitmap, x: number, y: number): number {
  const p = (y * bmp.width + x) * 4;
  return (bmp.data[p]! * 77 + bmp.data[p + 1]! * 150 + bmp.data[p + 2]! * 29) >> 8;
}

export function findLinkCards(bmp: Bitmap, area: Rect, opts: CardOptions = {}): CardHit[] {
  const white = opts.whiteThreshold ?? 250;
  const minRowCoverage = opts.minRowCoverage ?? 0.5;
  const minWidthRatio = opts.minWidthRatio ?? 0.45;
  const minHeightRatio = opts.minHeightRatio ?? 0.05;
  const maxHeightRatio = opts.maxHeightRatio ?? 0.5;

  const x0 = Math.max(0, area.x);
  const y0 = Math.max(0, area.y);
  const x1 = Math.min(bmp.width, area.x + area.w);
  const y1 = Math.min(bmp.height, area.y + area.h);
  const rows = Math.max(1, y1 - y0);
  const cols = Math.max(1, x1 - x0);

  const rowHit = new Float32Array(rows);
  // 逐行填满（步长 2 会让奇数行永远是 0，行带被切碎）
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x += 2) {
      if (lumaAt(bmp, x, y) >= white) n++;
    }
    rowHit[y - y0] = n / Math.ceil(cols / 2);
  }

  // 行带
  const bands: Array<[number, number]> = [];
  let top = -1;
  for (let i = 0; i < rows; i++) {
    const on = rowHit[i]! >= minRowCoverage;
    if (on && top < 0) top = i;
    if (!on && top >= 0) {
      bands.push([top, i]);
      top = -1;
    }
  }
  if (top >= 0) bands.push([top, rows]);

  // 卡片里的深色标题会把行带切开：间隔很小的相邻带合并
  const mergeGap = Math.max(4, Math.round(rows * 0.03));
  const merged: Array<[number, number]> = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last && band[0] - last[1] <= mergeGap) last[1] = band[1];
    else merged.push([band[0], band[1]]);
  }

  const out: CardHit[] = [];
  for (const [a, b] of merged) {
    const h = b - a;
    if (h < rows * minHeightRatio || h > rows * maxHeightRatio) continue;
    const bandY0 = y0 + a;
    const bandY1 = y0 + b;

    // 列带（在行带内）
    const colHit = new Float32Array(cols);
    const bandRows = Math.max(1, Math.ceil((bandY1 - bandY0) / 2));
    for (let x = x0; x < x1; x++) {
      let n = 0;
      for (let y = bandY0; y < bandY1; y += 2) {
        if (lumaAt(bmp, x, y) >= white) n++;
      }
      colHit[x - x0] = n / bandRows;
    }
    let left = -1;
    let bestL = -1;
    let bestR = -1;
    for (let i = 0; i <= cols; i++) {
      const on = i < cols && colHit[i]! >= minRowCoverage;
      if (on && left < 0) left = i;
      if (!on && left >= 0) {
        if (bestL < 0 || i - left > bestR - bestL) {
          bestL = left;
          bestR = i;
        }
        left = -1;
      }
    }
    if (bestL < 0) continue;
    const w = bestR - bestL;
    if (w < bmp.width * minWidthRatio) continue;
    out.push({
      rect: { x: x0 + bestL, y: bandY0, w, h: bandY1 - bandY0 },
      ratio: Math.round((h / rows) * 1000) / 1000,
    });
  }

  out.sort((p, q) => p.rect.y - q.rect.y);
  return out;
}