/**
 * 页面判定：先看活动名，再用像素兜底。
 *
 * 必须用像素兜底的原因（实测）：微信的聊天页有时**渲染在 LauncherUI 里**
 * （mCurrentFocus 仍是 LauncherUI，屏幕上却是会话）。只信活动名会判错。
 *
 * 判据（1080×2160 实测）：
 *  - 输入栏中部是一个接近纯白的圆角框（>248），tab 栏区域是页面底色（~237）→ 用白盒比例区分；
 *  - tab 栏是底部四簇图标 + 浅色底。
 */

import { decode, type Bitmap, type Rect } from "../image/image.ts";
import type { Focus, Frame } from "../device/types.ts";

export interface RectRatio {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageDef {
  detect?: { kind?: string; signature?: string; activity?: string; note?: string };
  elements?: Record<string, RectRatio>;
  staticZones?: string[];
  dirtyZones?: string[];
  notes?: string[];
  [key: string]: unknown;
}

export interface PageGraph {
  schema: number;
  profile: string;
  device: { screen: { w: number; h: number } };
  pages: Record<string, PageDef>;
}

export type PageName =
  | "chat"
  | "list"
  | "search"
  | "article"
  | "article_menu"
  | "bubble_menu"
  | "sticker_panel"
  | "xiaowei"
  | "other"
  | "unknown";

export interface PageGuess {
  page: PageName;
  confidence: number;
  reason: string;
}

/** 把页面图里的比例矩形换算成像素矩形。 */
export function rectOf(graph: PageGraph, page: string, element: string, width: number, height: number): Rect {
  const def = graph.pages[page];
  if (!def) throw new Error(`页面图里没有页面 ${page}`);
  const r = def.elements?.[element];
  if (!r) throw new Error(`页面 ${page} 里没有元素 ${element}`);
  return {
    x: Math.round(r.x * width),
    y: Math.round(r.y * height),
    w: Math.round(r.w * width),
    h: Math.round(r.h * height),
  };
}

export function hasElement(graph: PageGraph, page: string, element: string): boolean {
  return Boolean(graph.pages[page]?.elements?.[element]);
}

/** 活动名 → 页面。返回 null 表示要交给像素判。 */
export function pageFromFocus(focus: Focus): PageGuess | null {
  const { pkg, activity } = focus;
  if (!pkg) return null;
  if (pkg !== "com.tencent.mm") return { page: "other", confidence: 0.99, reason: `前台是 ${pkg}` };
  if (activity.includes("ChattingUI")) return { page: "chat", confidence: 0.95, reason: "活动名 ChattingUI" };
  if (activity.includes("FTSMainUI")) return { page: "search", confidence: 0.95, reason: "活动名 FTSMainUI" };
  if (activity.includes("TmplWebViewMMUI")) return { page: "article", confidence: 0.95, reason: "活动名 TmplWebViewMMUI" };
  if (activity.includes("MMFlutterViewActivity")) return { page: "xiaowei", confidence: 0.9, reason: "活动名 MMFlutterViewActivity" };
  // LauncherUI 可能是列表，也可能是渲染在里面的会话页 —— 交给像素
  return null;
}

function luma(bmp: Bitmap, x: number, y: number): number {
  const p = (y * bmp.width + x) * 4;
  return (bmp.data[p]! * 77 + bmp.data[p + 1]! * 150 + bmp.data[p + 2]! * 29) >> 8;
}

/** 区域内「接近纯白」的像素占比（白盒输入框 vs 灰底 tab 栏）。 */
export function nearWhiteRatio(bmp: Bitmap, rect: Rect, threshold = 248): number {
  let white = 0;
  let total = 0;
  const x1 = Math.min(bmp.width, rect.x + rect.w);
  const y1 = Math.min(bmp.height, rect.y + rect.h);
  for (let y = Math.max(0, rect.y); y < y1; y += 2) {
    for (let x = Math.max(0, rect.x); x < x1; x += 2) {
      total++;
      if (luma(bmp, x, y) >= threshold) white++;
    }
  }
  return total === 0 ? 0 : white / total;
}

/** 区域内深色像素占比（图标、文字）。 */
export function inkRatio(bmp: Bitmap, rect: Rect, threshold = 130): number {
  let ink = 0;
  let total = 0;
  const x1 = Math.min(bmp.width, rect.x + rect.w);
  const y1 = Math.min(bmp.height, rect.y + rect.h);
  for (let y = Math.max(0, rect.y); y < y1; y += 2) {
    for (let x = Math.max(0, rect.x); x < x1; x += 2) {
      total++;
      if (luma(bmp, x, y) < threshold) ink++;
    }
  }
  return total === 0 ? 0 : ink / total;
}

/** 底部四簇图标：tab 栏的特征。 */
export function looksLikeTabBar(bmp: Bitmap): boolean {
  const bandY = Math.round(bmp.height * 0.945);
  const bandH = Math.round(bmp.height * 0.028);
  let clusters = 0;
  for (let i = 0; i < 4; i++) {
    const x = Math.round(bmp.width * (0.06 + i * 0.25));
    const w = Math.round(bmp.width * 0.13);
    if (inkRatio(bmp, { x, y: bandY, w, h: bandH }, 160) > 0.02) clusters++;
  }
  return clusters >= 3;
}

/** 输入栏中部是接近纯白的圆角框。 */
export function looksLikeInputBar(bmp: Bitmap): boolean {
  const rect: Rect = {
    x: Math.round(bmp.width * 0.14),
    y: Math.round(bmp.height * 0.952),
    w: Math.round(bmp.width * 0.55),
    h: Math.round(bmp.height * 0.035),
  };
  return nearWhiteRatio(bmp, rect) > 0.5;
}

/** 综合判定：活动名优先，LauncherUI 用像素分 chat / list。 */
export function detectPage(bmp: Bitmap, focus: Focus): PageGuess {
  const byActivity = pageFromFocus(focus);
  if (byActivity) return byActivity;

  if (focus.pkg === "com.tencent.mm" && focus.activity.includes("LauncherUI")) {
    if (looksLikeInputBar(bmp) && !looksLikeTabBar(bmp)) {
      return { page: "chat", confidence: 0.8, reason: "LauncherUI + 底部白盒输入栏且无 tab 栏" };
    }
    if (looksLikeTabBar(bmp)) {
      return { page: "list", confidence: 0.85, reason: "LauncherUI + 底部四簇 tab 栏" };
    }
    return { page: "unknown", confidence: 0.4, reason: "LauncherUI，但像素特征都不匹配" };
  }
  return { page: "unknown", confidence: 0.3, reason: `未覆盖的活动：${focus.component || "(空)"}` };
}

export function decodeFrame(frame: Frame): Bitmap {
  return decode(frame.png);
}