/**
 * 聊天里的「图片/表情气泡」识别。
 *
 * 为什么要单独找：文本气泡是白/绿的纯色块，图片和表情是**多色**的。
 * 收藏表情的操作是「长按那个气泡 → 添加」，所以先得知道它在哪里。
 *
 * 判据：连通块足够大 + 颜色方差足够高（纯色气泡会被方差挡掉）。
 */

import type { Bitmap, Rect } from "../image/image.ts";

export interface Bubble {
  rect: Rect;
  side: "left" | "right";
  /** 颜色方差（越大越像图片） */
  variance: number;
  dhash: string;
}

export interface BubbleOptions {
  /** 最小边长 */
  minSize?: number;
  /** 颜色方差下限（0..1，按通道极差算） */
  minVariance?: number;
  /** 背景容差 */
  tolerance?: number;
}

function px(bmp: Bitmap, x: number, y: number): [number, number, number] {
  const p = (y * bmp.width + x) * 4;
  return [bmp.data[p]!, bmp.data[p + 1]!, bmp.data[p + 2]!];
}

/** 估计聊天背景色：取消息区左上角一小块的中位数。 */
export function chatBackground(bmp: Bitmap, area: Rect): [number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = area.y + 2; y < area.y + 10; y += 2) {
    for (let x = area.x + 2; x < area.x + 10; x += 2) {
      const [r, g, b] = px(bmp, x, y);
      xs.push(r);
      ys.push(g);
      void b;
    }
  }
  const med = (arr: number[]) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 237;
  return [med(xs), med(ys), 237];
}

/**
 * 找图片气泡。用连通块 + 方差过滤，不依赖气泡边框。
 */
export function findImageBubbles(bmp: Bitmap, area: Rect, opts: BubbleOptions = {}): Bubble[] {
  const minSize = opts.minSize ?? 140;
  const minVariance = opts.minVariance ?? 0.16;
  const tol = opts.tolerance ?? 16;
  const bg = chatBackground(bmp, area);

  const x0 = Math.max(0, area.x);
  const y0 = Math.max(0, area.y);
  const x1 = Math.min(bmp.width, area.x + area.w);
  const y1 = Math.min(bmp.height, area.y + area.h);

  const step = 2;
  const w = Math.ceil((x1 - x0) / step);
  const h = Math.ceil((y1 - y0) / step);
  const seen = new Uint8Array(w * h);
  const idx = (gx: number, gy: number) => gy * w + gx;

  const isContent = (x: number, y: number): boolean => {
    const [r, g, b] = px(bmp, x, y);
    return Math.abs(r - bg[0]) > tol || Math.abs(g - bg[1]) > tol || Math.abs(b - bg[2]) > tol;
  };

  const out: Bubble[] = [];
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      if (seen[idx(gx, gy)]) continue;
      seen[idx(gx, gy)] = 1;
      const sx = x0 + gx * step;
      const sy = y0 + gy * step;
      if (!isContent(sx, sy)) continue;

      const stack: Array<[number, number]> = [[gx, gy]];
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      let n = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let rr = 0;
      let minR = 255;
      let maxR = 0;
      let minG = 255;
      let maxG = 0;
      let minB = 255;
      let maxB = 0;

      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        const ax = x0 + cx * step;
        const ay = y0 + cy * step;
        const [r, g, b] = px(bmp, ax, ay);
        n++;
        sumR += r;
        sumG += g;
        sumB += b;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (g < minG) minG = g;
        if (g > maxG) maxG = g;
        if (b < minB) minB = b;
        if (b > maxB) maxB = b;
        if (ax < minX) minX = ax;
        if (ax > maxX) maxX = ax;
        if (ay < minY) minY = ay;
        if (ay > maxY) maxY = ay;
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as Array<[number, number]>) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (seen[idx(nx, ny)]) continue;
          seen[idx(nx, ny)] = 1;
          if (isContent(x0 + nx * step, y0 + ny * step)) stack.push([nx, ny]);
        }
      }

      const cw = maxX - minX + step;
      const ch = maxY - minY + step;
      if (cw < minSize || ch < minSize) continue;
      const variance = Math.max(maxR - minR, maxG - minG, maxB - minB) / 255;
      if (variance < minVariance) continue;

      out.push({
        rect: { x: minX, y: minY, w: cw, h: ch },
        side: minX + cw / 2 > bmp.width * 0.55 ? "right" : "left",
        variance: Math.round(variance * 1000) / 1000,
        dhash: "",
      });
    }
  }

  out.sort((a, b) => a.rect.y - b.rect.y);
  return out;
}