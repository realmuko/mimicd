/**
 * 表情面板的格子识别。
 *
 * 为什么不能按固定网格硬点（实测，docs/device-probes.md §6）：
 *  - 收藏页不是统一网格：左区「添加的单个表情」格距 199px，右区「微信输入法」推广位格距约 100px；
 *  - 格子里混着虚线「+」和推广位图标，按序号点必然点错；
 *  - 面板滚动位置会被记住，内容整体 y 偏移能差 45px。
 *
 * 做法：按已知的格距枚举候选格，量**内缩后的内容占比**，只保留「像一张图」的格子。
 * 「+」是空心虚线框，内缩后内容占比接近 0，自然被排除。
 */

import { crop, dhash, colorHist, meanColor, type Bitmap, type Rect } from "../image/image.ts";

export interface PanelGrid {
  /** 首格中心（比例） */
  firstCenterX: number;
  firstCenterY: number;
  /** 格距（比例） */
  pitchX: number;
  pitchY: number;
  /** 单格尺寸（比例） */
  cellW: number;
  cellH: number;
  /** 扫描范围（比例），超出右边界的是推广位，不扫 */
  areaX: number;
  areaY: number;
  areaW: number;
  areaH: number;
  /** 最多扫几行 */
  maxRows?: number;
}

export interface StickerCell {
  /** 第几个「真贴纸」（1 起） */
  index: number;
  /** 整格矩形（用于点击） */
  rect: Rect;
  /** 内缩后的内容占比 0..1 */
  fill: number;
  meanLuma: number;
  dhash: string;
  hist: number[];
}

export interface CellOptions {
  /** 内容占比阈值，低于它当空白 */
  minFill?: number;
  /** 内缩比例（排除虚线边框） */
  inset?: number;
}

export function screenGrid(grid: PanelGrid, width: number, height: number): {
  firstX: number;
  firstY: number;
  pitchX: number;
  pitchY: number;
  cellW: number;
  cellH: number;
  right: number;
  bottom: number;
} {
  return {
    firstX: grid.firstCenterX * width,
    firstY: grid.firstCenterY * height,
    pitchX: grid.pitchX * width,
    pitchY: grid.pitchY * height,
    cellW: grid.cellW * width,
    cellH: grid.cellH * height,
    right: (grid.areaX + grid.areaW) * width,
    bottom: (grid.areaY + grid.areaH) * height,
  };
}

export function findStickerCells(bmp: Bitmap, grid: PanelGrid, opts: CellOptions = {}): StickerCell[] {
  const minFill = opts.minFill ?? 0.28;
  const inset = opts.inset ?? 0.12;
  const g = screenGrid(grid, bmp.width, bmp.height);
  const maxRows = grid.maxRows ?? 3;
  const out: StickerCell[] = [];

  // 面板背景：扫描区左上角的一小块（格子之间一定是底色）
  const bgPatch = crop(bmp, { x: grid.areaX * bmp.width + 2, y: grid.areaY * bmp.height + 2, w: 6, h: 6 });
  const bg = meanColor(bgPatch);
  const tol = 18;

  for (let row = 0; row < maxRows; row++) {
    const cy = g.firstY + row * g.pitchY;
    if (cy + g.cellH / 2 > g.bottom) break;
    for (let col = 0; col < 8; col++) {
      const cx = g.firstX + col * g.pitchX;
      if (cx + g.cellW / 2 > g.right) break;
      const rect: Rect = {
        x: Math.round(cx - g.cellW / 2),
        y: Math.round(cy - g.cellH / 2),
        w: Math.round(g.cellW),
        h: Math.round(g.cellH),
      };
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > bmp.width || rect.y + rect.h > bmp.height) continue;
      const cell = crop(bmp, rect);
      const padX = Math.round(rect.w * inset);
      const padY = Math.round(rect.h * inset);
      const inner = crop(cell, { x: padX, y: padY, w: rect.w - padX * 2, h: rect.h - padY * 2 });
      if (inner.width < 8 || inner.height < 8) continue;
      let hit = 0;
      for (let i = 0; i < inner.data.length; i += 4) {
        if (
          Math.abs(inner.data[i]! - bg[0]) > tol ||
          Math.abs(inner.data[i + 1]! - bg[1]) > tol ||
          Math.abs(inner.data[i + 2]! - bg[2]) > tol
        ) {
          hit++;
        }
      }
      const fill = hit / Math.max(1, inner.width * inner.height);
      if (fill < minFill) continue;
      out.push({
        index: out.length + 1,
        rect,
        fill: Math.round(fill * 1000) / 1000,
        meanLuma: meanLuma(inner),
        dhash: dhash(inner),
        hist: colorHist(inner),
      });
    }
  }
  return out;
}

function meanLuma(bmp: Bitmap): number {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < bmp.data.length; p += 4) {
    sum += (bmp.data[p]! * 77 + bmp.data[p + 1]! * 150 + bmp.data[p + 2]! * 29) >> 8;
    n++;
  }
  return Math.round((sum / Math.max(1, n)) * 10) / 10;
}