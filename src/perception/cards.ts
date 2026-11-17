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

/** 卡片里有没有彩色块（缩略图）。文字气泡是白底黑字，没有。 */
export function hasColorBlock(bmp: Bitmap, rect: Rect): boolean {
  const x1 = Math.min(bmp.width, rect.x + rect.w);
  const y1 = Math.min(bmp.height, rect.y + rect.h);
  let colored = 0;
  let total = 0;
  for (let y = rect.y + 4; y < y1 - 4; y += 3) {
    for (let x = rect.x + 4; x < x1 - 4; x += 3) {
      const p = (y * bmp.width + x) * 4;
      const r = bmp.data[p]!;
      const g = bmp.data[p + 1]!;
      const b = bmp.data[p + 2]!;
      total++;
      // 饱和度：三通道极差够大才算「有颜色」
      if (Math.max(r, g, b) - Math.min(r, g, b) > 26) colored++;
    }
  }
  return total > 0 && colored / total > 0.01;
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
    // 列判据：近白 或 有颜色（右侧缩略图）。白带里出现颜色只可能是图，不会是绿气泡
    const isCardInk = (x: number, y: number) => {
      const p = (y * bmp.width + x) * 4;
      const r = bmp.data[p]!;
      const g = bmp.data[p + 1]!;
      const b2 = bmp.data[p + 2]!;
      if (((r * 77 + g * 150 + b2 * 29) >> 8) >= 250) return true;
      return Math.max(r, g, b2) - Math.min(r, g, b2) > 26;
    };
    for (let x = x0; x < x1; x++) {
      let n = 0;
      for (let y = bandY0; y < bandY1; y += 2) {
        if (isCardInk(x, y)) n++;
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
    // 卡片右侧有缩略图：要求卡片内存在一块「有颜色」的区域，纯白文字气泡会被挡掉
    if (!hasColorBlock(bmp, { x: x0 + bestL, y: bandY0, w, h: bandY1 - bandY0 })) continue;
    out.push({
      rect: { x: x0 + bestL, y: bandY0, w, h: bandY1 - bandY0 },
      ratio: Math.round((h / rows) * 1000) / 1000,
    });
  }

  out.sort((p, q) => p.rect.y - q.rect.y);
  return out;
}
/**
 * 用 OCR 定位链接卡片：不找白色矩形，找「标题 + 来源」这对行。
 *
 * 实测（微信 8.0.80，1080×2160）：
 *   标题「你，想家了吗？」 y=1564 h=46 x=198 w=302
 *   来源「人民网」       y=1816 h=29 x=253 w=91
 * 特征：左对齐（|Δx| ≤ 80）、标题大（h ≥ 34）、来源小（h ≤ 32）、纵向相距 120–400。
 * 普通气泡后面跟时间行时 Δx ≈ 230，会被挡掉。
 */
export function findCardTitle(
  lines: Array<{ text: string; x: number; y: number; w: number; h: number }>,
): { text: string; x: number; y: number; w: number; h: number } | null {
  const big = lines.filter((l) => l.h >= 34 && l.w >= 100 && l.text.trim().length >= 2);
  const small = lines.filter((l) => l.h <= 32 && l.w >= 20 && l.w <= 400 && l.text.trim().length >= 2);
  for (const title of big.sort((a, b) => b.y - a.y)) {
    const source = small.find((s) => {
      const dy = s.y - title.y;
      return dy >= 120 && dy <= 400 && Math.abs(s.x - title.x) <= 80;
    });
    if (source) return title;
  }
  return null;
}
