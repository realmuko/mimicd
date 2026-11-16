/**
 * 图像原语：解码 / 裁剪 / 区域差分 / 感知哈希。
 *
 * 为什么自己写而不是用 sharp：要的东西很少（RGBA 缓冲区 + 几个纯函数），
 * 但每样都要能离线测、能在没有 GPU 的机器上跑、行为可预测。
 *
 * 三条来自设备实测的约束（见 docs/device-probes.md）：
 *  1. 整帧哈希太敏感：微信聊天页静置时输入框光标闪烁就让两帧哈希不同（实测 4/4 次都不同）。
 *  2. 因此「稳定」用**区域像素差**判，不用哈希相等。
 *  3. 贴纸在气泡里被放大（面板缩略图约 90×150，气泡里约 230×310），
 *     所以贴纸比对必须用尺度无关的 dHash，不能直接比像素。
 */

import { PNG } from "pngjs";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** RGBA8888，行优先，无 padding（与 pngjs 一致）。 */
export interface Bitmap {
  width: number;
  height: number;
  data: Buffer;
}

export function decode(buf: Buffer): Bitmap {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

export function encode(bmp: Bitmap): Buffer {
  const png = new PNG({ width: bmp.width, height: bmp.height });
  bmp.data.copy(png.data);
  return PNG.sync.write(png);
}

export function clampRect(bmp: Bitmap, r: Rect): Rect {
  const x = Math.max(0, Math.min(bmp.width, Math.floor(r.x)));
  const y = Math.max(0, Math.min(bmp.height, Math.floor(r.y)));
  const w = Math.max(0, Math.min(bmp.width - x, Math.floor(r.w)));
  const h = Math.max(0, Math.min(bmp.height - y, Math.floor(r.h)));
  return { x, y, w, h };
}

export function crop(bmp: Bitmap, r: Rect): Bitmap {
  const rr = clampRect(bmp, r);
  const out = Buffer.alloc(rr.w * rr.h * 4);
  for (let row = 0; row < rr.h; row++) {
    const src = ((rr.y + row) * bmp.width + rr.x) * 4;
    bmp.data.copy(out, row * rr.w * 4, src, src + rr.w * 4);
  }
  return { width: rr.w, height: rr.h, data: out };
}

export interface DiffResult {
  /** 变化像素占比 0..1 */
  ratio: number;
  changed: number;
  total: number;
  /** 变化像素的外接框（没有变化时为 0×0） */
  bbox: Rect;
}

/**
 * 区域差分。perChannel 是单通道容差（默认 8/255，压掉编码噪声），
 * 只有三通道任意一个超过容差才算「变了」。
 */
export function regionDiff(a: Bitmap, b: Bitmap, rect?: Rect, perChannel = 8): DiffResult {
  const area = rect ? clampRect(a, rect) : { x: 0, y: 0, w: a.width, h: a.height };
  const w = Math.min(area.w, b.width - area.x);
  const h = Math.min(area.h, b.height - area.y);
  let changed = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;

  for (let row = 0; row < h; row++) {
    let ai = ((area.y + row) * a.width + area.x) * 4;
    let bi = ((area.y + row) * b.width + area.x) * 4;
    for (let col = 0; col < w; col++) {
      const dr = Math.abs(a.data[ai]! - b.data[bi]!);
      const dg = Math.abs(a.data[ai + 1]! - b.data[bi + 1]!);
      const db = Math.abs(a.data[ai + 2]! - b.data[bi + 2]!);
      if (dr > perChannel || dg > perChannel || db > perChannel) {
        changed++;
        if (col < minX) minX = col;
        if (col > maxX) maxX = col;
        if (row < minY) minY = row;
        if (row > maxY) maxY = row;
      }
      ai += 4;
      bi += 4;
    }
  }

  const total = Math.max(1, w * h);
  return {
    ratio: changed / total,
    changed,
    total,
    bbox:
      changed === 0
        ? { x: area.x, y: area.y, w: 0, h: 0 }
        : { x: area.x + minX, y: area.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/** 灰度（Rec.601 定点近似），返回 0..255 的 Uint8Array。 */
export function grayscale(bmp: Bitmap): Uint8Array {
  const out = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (bmp.data[p]! * 77 + bmp.data[p + 1]! * 150 + bmp.data[p + 2]! * 29) >> 8;
  }
  return out;
}

/** 双线性之外的最省算法：按格子取均值（够 dHash 用）。 */
export function resizeGray(gray: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += gray[yy * sw + xx]!;
          n++;
        }
      }
      out[y * dw + x] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

/**
 * dHash：缩到 (size+1)×size 灰度，比较左右相邻像素。
 * 返回 16 进制字符串（8×8 → 64 bit → 16 字符）。尺度无关，适合贴纸匹配。
 */
export function dhash(bmp: Bitmap, size = 8): string {
  const gray = grayscale(bmp);
  const small = resizeGray(gray, bmp.width, bmp.height, size + 1, size);
  let bits = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      bits += small[y * (size + 1) + x]! < small[y * (size + 1) + x + 1]! ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** 汉明距离（两个 dHash 之间）。≤10 视为近似同一张图。 */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    d += ((x & 1) ? 1 : 0) + ((x & 2) ? 1 : 0) + ((x & 4) ? 1 : 0) + ((x & 8) ? 1 : 0);
  }
  return d;
}

/** 4×4×4 RGB 直方图（归一化）。用于区分「形状像但颜色不像」。 */
export function colorHist(bmp: Bitmap): number[] {
  const h = new Array<number>(64).fill(0);
  const step = 4;
  let n = 0;
  for (let p = 0; p < bmp.data.length; p += 4 * step) {
    const r = bmp.data[p]! >> 6;
    const g = bmp.data[p + 1]! >> 6;
    const b = bmp.data[p + 2]! >> 6;
    h[r * 16 + g * 4 + b]!++;
    n++;
  }
  return h.map((v) => (n ? v / n : 0));
}

/** 平均色（判断「这一格是不是白底/空白」用）。 */
export function meanColor(bmp: Bitmap): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = Math.max(1, bmp.width * bmp.height);
  for (let p = 0; p < bmp.data.length; p += 4) {
    r += bmp.data[p]!;
    g += bmp.data[p + 1]!;
    b += bmp.data[p + 2]!;
  }
  return [r / n, g / n, b / n];
}

/** 两个直方图的余弦相似度。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 内容框：把「贴纸/图片本身」从白底或灰底里切出来。
 *
 * 背景取四角均色。实测：贴纸在收藏面板里是灰底，在气泡里是白/绿底，
 * 不先切掉背景，任何哈希都会被背景主导（实测 4×4 色格余弦同图 0.97、异图 0.96，无法区分）。
 */
export function contentBox(bmp: Bitmap, tolerance = 20): Rect & { bg: [number, number, number]; filled: number } {
  const at = (x: number, y: number): [number, number, number] => {
    const p = (y * bmp.width + x) * 4;
    return [bmp.data[p]!, bmp.data[p + 1]!, bmp.data[p + 2]!];
  };
  const corners = [
    at(0, 0),
    at(bmp.width - 1, 0),
    at(0, bmp.height - 1),
    at(Math.max(0, bmp.width - 1), Math.max(0, bmp.height - 1)),
  ];
  const bg: [number, number, number] = [0, 1, 2].map((i) =>
    Math.round(corners.reduce((s, c) => s + c[i]!, 0) / corners.length),
  ) as [number, number, number];

  let minX = bmp.width;
  let minY = bmp.height;
  let maxX = -1;
  let maxY = -1;
  let filled = 0;
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const p = (y * bmp.width + x) * 4;
      if (
        Math.abs(bmp.data[p]! - bg[0]) > tolerance ||
        Math.abs(bmp.data[p + 1]! - bg[1]) > tolerance ||
        Math.abs(bmp.data[p + 2]! - bg[2]) > tolerance
      ) {
        filled++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: bmp.width, h: bmp.height, bg, filled: 0 };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, bg, filled };
}

export interface StickerFeatures {
  /** 内容框（已去掉背景） */
  box: Rect;
  /** 内容框的 dHash（尺度无关；对动图会随帧变化，故只作辅助判据） */
  dhash: string;
  /** 内容框的 4×4×4 颜色直方图（对动图稳定，是主判据） */
  hist: number[];
  /** 内容框宽高比（同一张图在面板与气泡里可能不同，只作参考） */
  aspect: number;
}

export function stickerFeatures(bmp: Bitmap, tolerance = 20): StickerFeatures {
  const box = contentBox(bmp, tolerance);
  const content = crop(bmp, box);
  return {
    box,
    dhash: dhash(content),
    hist: colorHist(content),
    aspect: box.h > 0 ? box.w / box.h : 1,
  };
}

/**
 * 两张贴纸图的相似度。
 * 实测（1080×2160，微信 8.0.80）：同一张动图的不同帧 hist 0.94–0.98 而 dHash 距离 14–25；
 * 不同贴纸 hist 0.60–0.76。所以主判据是 hist，dHash 只在 hist 临界时辅助。
 */
export function stickerSimilarity(
  a: StickerFeatures,
  b: StickerFeatures,
): { hist: number; dh: number; same: boolean } {
  const hist = cosine(a.hist, b.hist);
  const dh = hamming(a.dhash, b.dhash);
  return { hist, dh, same: hist >= 0.9 && dh <= 24 };
}