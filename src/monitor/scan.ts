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
      // 未读标记在头像右上角：限制在头像列，且近似方形（预览里的红字 [有人@我] 会被这两条挡掉）
      const cx = (minX + maxX) / 2;
      if (cx < bmp.width * 0.08 || cx > bmp.width * 0.22) continue;
      if (w / h < 0.6 || w / h > 1.7) continue;
      if (count < 250) continue;
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
 * 一组 OCR 行的**并集外接框的垂直中心**（点击落点用）。
 *
 * 为什么不用红点中心：红点在头像右上角，比整行中心偏上半个行高；
 * 拿它当 y 去点是「点在这一行的上沿」，稍微一重排就落到上一行去了。
 * 一行里所有 OCR 行（时间 / 名字 / 预览 / [3条]）的并集框才是这一行的真实范围。
 */
export function rowCenter(lines: ReadonlyArray<OcrLine>): number {
  if (lines.length === 0) return 0;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const l of lines) {
    if (l.y < top) top = l.y;
    const b = l.y + l.h;
    if (b > bottom) bottom = b;
  }
  return Math.round((top + bottom) / 2);
}

/**
 * 把未读行对上 OCR 出来的会话名。
 * 规则：取该行附近（±rowTolerance）最靠上的一条 OCR 文本，且不是时间/预览。
 *
 * 返回的 `y` 是**这一行所有 OCR 行的并集外接框中心**（不再是红点中心 —— 偏上）。
 * 旧插件的教训：截图到点击之间列表会重排，落点越接近行中心，点到隔壁的概率越小；
 * 红点中心比行中心高 ~40px，正好落在上一行的下沿。
 */
export function matchNames(lines: OcrLine[], rows: UnreadRow[], rowTolerance = 60): ListRow[] {
  const out: ListRow[] = [];
  for (const row of rows) {
    const nearby = lines.filter((l) => Math.abs(l.y + l.h / 2 - row.y) <= rowTolerance);
    if (nearby.length === 0) continue;
    const candidates = nearby.filter((l) => isNameLine(l));
    if (candidates.length === 0) continue;
    // 会话名通常字最大；同样大小时取最靠上的一条
    candidates.sort((a, b) => b.h - a.h || a.y - b.y);
    const name = cleanName(candidates[0]!.text);
    if (!name) continue;
    out.push({ y: rowCenter(nearby), name, unread: 1 });
  }
  return out;
}

/** 名字里去掉未读数字、括号里的计数等噪声。 */
/** 这一行像不像会话名：不是纯数字/时间、不是预览（带冒号或方括号开头）、不是系统提示。 */
export function isNameLine(line: OcrLine): boolean {
  const t = line.text.trim();
  if (t.length === 0) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^\d{1,2}[:：]\d{2}/.test(t)) return false;
  if (/^(上午|下午|凌晨|晚上|中午|昨天|今天)/.test(t)) return false;
  if (/^[\[（(【]/.test(t)) return false;
  if (/^\d+\s*[条]/.test(t)) return false;
  if (/[：:]/.test(t)) return false;
  return t.length >= 2;
}

export function cleanName(text: string) {
  return text
    .replace(/\s+/g, "")
    .replace(/\[?\d+\s*条\]?/g, "")
    .replace(/^\d+/, "")
    .replace(/^[\[\s]+|[\]\s]+$/g, "")
    .trim();
}

export interface ScanResult {
  rows: ListRow[];
  badges: number;
}

/** 「有人@我」预览：微信有时不给红点（只在预览里显示红字），但这类行必须当未读。 */
const MENTION_PREVIEW = /有人\s*[@＠]\s*我/;

/** 一次扫描：红点 → 行 → OCR 匹配名字。 */
export function scanList(bmp: Bitmap, lines: OcrLine[], area: Rect, opts: ScanOptions = {}): ScanResult {
  const badges = findRedBadges(bmp, area, opts);
  const rows = matchNames(lines, unreadRows(badges));

  // 红点漏了的「有人@我」行补进来（名字在这一行上方，间隔不超过 140px）
  const seen = new Set(rows.map((r) => r.name));
  for (const line of lines) {
    if (!MENTION_PREVIEW.test(line.text)) continue;
    if (line.y < area.y || line.y > area.y + area.h) continue;
    const above = lines
      .filter((l) => isNameLine(l) && l.y + l.h <= line.y + 10 && line.y - (l.y + l.h) <= 140)
      .sort((a, b) => b.y - a.y)[0];
    if (!above) continue;
    const name = cleanName(above.text);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({ name, y: above.y + above.h / 2, unread: 1 });
  }
  rows.sort((a, b) => a.y - b.y);
  return { rows, badges: badges.length };
}