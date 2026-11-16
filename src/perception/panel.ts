/**
 * 深色浮层定位：长按气泡后弹出的菜单是一块深灰圆角矩形（约 rgb 60,60,60）。
 *
 * 为什么需要它：菜单是**锚定在气泡上**的，位置随气泡走；写死坐标必然点偏
 * （实测两次长按失败都是这个原因）。所以先找到这块面板的 bbox，
 * 再按「第几行第几列」点它内部的相对位置。
 *
 * 做法：行/列投影。面板是实心矩形，投影会给出很干净的边界；比连通块简单，
 * 也不会被面板里的图标/文字切碎。
 */

import type { Bitmap, Rect } from "../image/image.ts";

export interface PanelOptions {
  /** 多暗算「面板」（luma 上限） */
  maxLuma?: number;
  /** 一行里暗像素占比超过它才算面板行 */
  minRowCoverage?: number;
  /** 面板最小高度占屏比 */
  minHeightRatio?: number;
}

export interface PanelHit {
  rect: Rect;
  /** 面板里「第 row 行第 col 列」的格点中心（相对面板，按行列数均分） */
  cell(col: number, row: number, cols?: number, rows?: number): { x: number; y: number };
}

function lumaAt(bmp: Bitmap, x: number, y: number): number {
  const p = (y * bmp.width + x) * 4;
  return (bmp.data[p]! * 77 + bmp.data[p + 1]! * 150 + bmp.data[p + 2]! * 29) >> 8;
}

export function findDarkPanel(bmp: Bitmap, opts: PanelOptions = {}): PanelHit | null {
  const maxLuma = opts.maxLuma ?? 90;
  const minRowCoverage = opts.minRowCoverage ?? 0.25;
  const minHeightRatio = opts.minHeightRatio ?? 0.05;

  // 行投影
  const rowHit: number[] = new Array(bmp.height).fill(0);
  for (let y = 0; y < bmp.height; y += 2) {
    let dark = 0;
    for (let x = 0; x < bmp.width; x += 2) {
      if (lumaAt(bmp, x, y) <= maxLuma) dark++;
    }
    rowHit[y] = dark / Math.ceil(bmp.width / 2);
  }

  // 找最长的连续「面板行」带
  let bestTop = -1;
  let bestBottom = -1;
  let curTop = -1;
  for (let y = 0; y < bmp.height; y += 2) {
    const on = rowHit[y]! >= minRowCoverage;
    if (on && curTop < 0) curTop = y;
    if (!on && curTop >= 0) {
      if (bestTop < 0 || y - curTop > bestBottom - bestTop) {
        bestTop = curTop;
        bestBottom = y;
      }
      curTop = -1;
    }
  }
  if (curTop >= 0 && (bestTop < 0 || bmp.height - curTop > bestBottom - bestTop)) {
    bestTop = curTop;
    bestBottom = bmp.height;
  }
  if (bestTop < 0 || bestBottom - bestTop < bmp.height * minHeightRatio) return null;

  // 列投影（只在这一带内）
  const colHit: number[] = new Array(bmp.width).fill(0);
  const rows = Math.max(1, Math.ceil((bestBottom - bestTop) / 2));
  for (let x = 0; x < bmp.width; x += 2) {
    let dark = 0;
    for (let y = bestTop; y < bestBottom; y += 2) {
      if (lumaAt(bmp, x, y) <= maxLuma) dark++;
    }
    colHit[x] = dark / rows;
  }
  let bestLeft = -1;
  let bestRight = -1;
  let curLeft = -1;
  for (let x = 0; x < bmp.width; x += 2) {
    const on = colHit[x]! >= minRowCoverage;
    if (on && curLeft < 0) curLeft = x;
    if (!on && curLeft >= 0) {
      if (bestLeft < 0 || x - curLeft > bestRight - bestLeft) {
        bestLeft = curLeft;
        bestRight = x;
      }
      curLeft = -1;
    }
  }
  if (curLeft >= 0 && (bestLeft < 0 || bmp.width - curLeft > bestRight - bestLeft)) {
    bestLeft = curLeft;
    bestRight = bmp.width;
  }
  if (bestLeft < 0) return null;

  const rect: Rect = {
    x: bestLeft,
    y: bestTop,
    w: Math.max(0, bestRight - bestLeft),
    h: Math.max(0, bestBottom - bestTop),
  };
  if (rect.w < bmp.width * 0.2 || rect.h < bmp.height * 0.05) return null;

  return {
    rect,
    cell(col: number, row: number, cols = 5, rows = 2) {
      return {
        x: Math.round(rect.x + ((col + 0.5) * rect.w) / cols),
        y: Math.round(rect.y + ((row + 0.5) * rect.h) / rows),
      };
    },
  };
}