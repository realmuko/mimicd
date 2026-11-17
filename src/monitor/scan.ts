/**
 * 会话列表扫描：找未读（红点/未读数字），并把未读行对上会话名。
 *
 * 微信列表行没有 a11y，只能看像素：
 *  - 未读是头像右上角的**红色**标记（数字或圆点）；
 *  - 会话名在同一行的上半部，靠 OCR 拿。
 */

import type { Bitmap, Rect } from "../image/image.ts";
import type { OcrLine } from "../perception/ocr.ts";

export interface Badge {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 标记里的像素量，用来区分「小红点」与「带数字的气泡」 */
  area: number;
}

export interface UnreadRow {
  /** 行中心 y */
  y: number;
  badge: Badge;
}

export interface ListRow {
  /** 未读数（没有数字时按 1 算） */
  unread: number;
  y: number;
  name: string;
}

export interface ScanOptions {
  /** 红色判定 */
  redMin?: number;
  redOtherMax?: number;
  /** 标记的最小/最大尺寸 */
  minSize?: number;
  maxSize?: number;
}

function isRed(r: number, g: number, b: number, redMin: number, otherMax: number): boolean {
  return r >= redMin && g <= otherMax && b <= otherMax;
}

/** 找红色未读标记（连通块）。 */
export function findRedBadges(bmp: Bitmap, area: Rect, opts: ScanOptions = {}): Badge[] {
  const redMin = opts.redMin ?? 170;
  const other = opts.redOtherMax ?? 110;
  const minSize = opts.minSize ?? 10;
  const maxSize = opts.maxSize ?? 90;

  const x0 = Math.max(0, area.x);
  const y0 = Math.max(0, area.y);
  const x1 = Math.min(bmp.width, area.x + area.w);
  const y1 = Math.min(bmp.height, area.y + area.h);

  const seen = new Uint8Array((x1 - x0) * (y1 - y0));
  const badges: Badge[] = [];
  const idx = (x: number, y: number) => (y - y0) * (x1 - x0) + (x - x0);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (seen[idx(x, y)]) continue;
      const p = (y * bmp.width + x) * 4;
      if (!isRed(bmp.data[p]!, bmp.data[p + 1]!, bmp.data[p + 2]!, redMin, other)) {
        seen[idx(x, y)] = 1;
        continue;
      }

      // 洪水填充这一块红色
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;
      const stack: Array<[number, number]> = [[x, y]];
      seen[idx(x, y)] = 1;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as Array<[number, number]>) {
          if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
          if (seen[idx(nx, ny)]) continue;
          seen[idx(nx, ny)] = 1;
          const q = (ny * bmp.width + nx) * 4;
          if (isRed(bmp.data[q]!, bmp.data[q + 1]!, bmp.data[q + 2]!, redMin, other)) {
            stack.push([nx, ny]);
          }
        }
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      if (w < minSize || h < minSize || w > maxSize || h > maxSize) continue;
      // 长条形的多半是二维码/图片里的红色，不是未读标记
      if (w > h * 2.2 || h > w * 2.2) continue;
      if (count < 40) continue;
      badges.push({ x: minX, y: minY, w, h, area: count });
    }
  }

  return badges;
}

/** 同一行的多个红色块合并成一个未读行。 */
export function unreadRows(badges: Badge[], rowTolerance = 40): UnreadRow[] {
  const sorted = [...badges].sort((a, b) => a.y - b.y);
  const rows: UnreadRow[] = [];
  for (const badge of sorted) {
    const center = badge.y + badge.h / 2;
    const existing = rows.find((r) => Math.abs(r.y - center) <= rowTolerance);
    if (existing) continue;
    rows.push({ y: center, badge });
  }
  return rows;
}

/**
 * 把未读行对上 OCR 出来的会话名。
 * 规则：取该行附近（±rowTolerance）最靠上的一条 OCR 文本，且不是时间/预览。
 */
export function matchNames(lines: OcrLine[], rows: UnreadRow[], rowTolerance = 60): ListRow[] {
  const out: ListRow[] = [];
  for (const row of rows) {
    const nearby = lines.filter((l) => Math.abs(l.y + l.h / 2 - row.y) <= rowTolerance);
    if (nearby.length === 0) continue;
    // 名字通常是这一行最上面、字最大（高最大）的一条
    nearby.sort((a, b) => a.y - b.y || b.h - a.h);
    const nameLine = nearby[0]!;
    const name = cleanName(nameLine.text);
    if (!name) continue;
    out.push({ y: row.y, name, unread: 1 });
  }
  return out;
}

/** 名字里去掉未读数字、括号里的计数等噪声。 */
export function cleanName(text: string): string {
  return text
    .replace(/\[?\d+\s*条\]?/g, "")
    .replace(/^[\[\s]+|[\]\s]+$/g, "")
    .trim();
}

export interface ScanResult {
  rows: ListRow[];
  badges: number;
}

/** 一次扫描：红点 → 行 → OCR 匹配名字。 */
export function scanList(bmp: Bitmap, lines: OcrLine[], area: Rect, opts: ScanOptions = {}): ScanResult {
  const badges = findRedBadges(bmp, area, opts);
  const rows = matchNames(lines, unreadRows(badges));
  return { rows, badges: badges.length };
}