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

/** 区域内平均亮度。 */
export function meanLuma(bmp: Bitmap, rect: Rect): number {
  let sum = 0;
  let total = 0;
  const x1 = Math.min(bmp.width, rect.x + rect.w);
  const y1 = Math.min(bmp.height, rect.y + rect.h);
  for (let y = Math.max(0, rect.y); y < y1; y += 2) {
    for (let x = Math.max(0, rect.x); x < x1; x += 2) {
      total++;
      sum += luma(bmp, x, y);
    }
  }
  return total === 0 ? 0 : sum / total;
}

/**
 * 屏幕最底部那一条的亮度，用「最底 100px 里最亮的 20px 窗口」来代表。
 *
 * 为什么不直接量最底 30px：
 *  - 切过输入法之后，ADBKeyboard 会常驻一条「ADB Keyboard {ON}」状态条（实测 luma 83），
 *    把真 tab 栏的浅色边整个盖住，列表页因此被判成 unknown；
 *  - 但也不能简单地往上挪一格 —— 再往上就是 tab 图标带（0.945–0.973），
 *    图标本身就是深色，会把这个窗口的均值拉到 181 左右，一样过不了 200。
 * 所以在最底 100px 内滑动找一个最亮的窗口：真界面总有一片浅色边，
 * 表情墙/图片墙是彩色的铺满到底，任何窗口都暗。
 */
function bottomBandLuma(bmp: Bitmap): number {
  const h = Math.round(bmp.height * 0.012);
  let best = 0;
  for (let y = bmp.height - h; y >= bmp.height - 100; y -= 8) {
    best = Math.max(best, meanLuma(bmp, { x: 0, y, w: bmp.width, h }));
    if (best >= 235) break;
  }
  return best;
}

/** 底部四簇图标 + **底边是浅色**：tab 栏的特征。 */
export function looksLikeTabBar(bmp: Bitmap): boolean {
  const bandY = Math.round(bmp.height * 0.945);
  const bandH = Math.round(bmp.height * 0.028);
  // 底下必须有浅色边：真 tab 栏一直铺到屏幕底边、是浅灰的（实测均值 243）；
  // 表情面板/图片墙那一带是表情本身铺到底（实测 163）。
  // 不加这一条时，表情网格会被当成"四簇图标"，页面被判成 list，
  // 于是引擎一直在群里空转 —— 2026-11-18 真机撞到的就是它。
  if (bottomBandLuma(bmp) < 200) return false;
  let clusters = 0;
  for (let i = 0; i < 4; i++) {
    const x = Math.round(bmp.width * (0.06 + i * 0.25));
    const w = Math.round(bmp.width * 0.13);
    if (inkRatio(bmp, { x, y: bandY, w, h: bandH }, 160) > 0.02) clusters++;
  }
  return clusters >= 3;
}

/** 输入栏中部是接近纯白的圆角框。 */
export function looksLikeInputBar(bmp: Bitmap, yRatio = 0.952): boolean {
  const rect: Rect = {
    x: Math.round(bmp.width * 0.14),
    y: Math.round(bmp.height * yRatio),
    w: Math.round(bmp.width * 0.55),
    // 只取输入框**最上面那一条**（实测 254–255）。
    // 往下半截是 247，而列表页 tab 栏那片白底实测 245 —— 阈值降到 244 确实能把
    // 输入框认出来，但会把列表页也一起认成会话页（实测把 reopen 那张列表截图判成 chat）。
    // 所以不降阈值，改成只采样确定是纯白的那一条带，高度 0.013 刚好停在 247 之前。
    h: Math.round(bmp.height * 0.013),
  };
  return nearWhiteRatio(bmp, rect) > 0.5;
}

/**
 * 表情面板打开时，会话输入栏被面板顶到屏幕中部（实测 y≈0.600），底部换成表情网格。
 * 这时底部没有输入栏，而网格里浅底的贴纸又会让「四簇 tab 栏」判据成立 ——
 * 页面就被判成 list：引擎以为在列表页，报「列表里没有未读」，实际卡在会话页动弹不得。
 * 2026-11-19 15:33~15:44 就是这么空转的（面板一直开着，40 分钟没回一条）。
 */
export function looksLikeStickerPanel(bmp: Bitmap): boolean {
  // 输入栏在底部 = 没开面板，直接排除
  if (looksLikeInputBar(bmp)) return false;
  // 会话页标题栏左侧有返回箭头（‹）；列表页顶部那一片是空的（「微信(N)」居中）。
  // 实测：面板开着 0.050，列表页 0.000 —— 这是这两个页面唯一稳定分得开的差别。
  const chevron: Rect = {
    x: Math.round(bmp.width * 0.02),
    y: Math.round(bmp.height * 0.045),
    w: Math.round(bmp.width * 0.06),
    h: Math.round(bmp.height * 0.03),
  };
  // 标题栏在、输入栏又不在底部 —— 只可能是被表情面板（或键盘+面板）顶上去了
  return inkRatio(bmp, chevron, 120) > 0.02;
}

/** 综合判定：活动名优先，LauncherUI 用像素分 chat / list。 */
export function detectPage(bmp: Bitmap, focus: Focus): PageGuess {
  const byActivity = pageFromFocus(focus);
  if (byActivity) return byActivity;

  if (focus.pkg === "com.tencent.mm" && focus.activity.includes("LauncherUI")) {
    // 输入栏是比 tab 栏更硬的证据：列表页底部根本没有输入框（实测近白比例 0.00），
    // 会话页一定有。原来要求「像输入栏 **且** 不像 tab 栏」，但会话页输入框里一旦有东西
    // （草稿文字 / 语音图标 / 表情 / 发送按钮），那四簇墨迹就会被当成底部 tab 图标，
    // 于是会话页被判成列表页 —— 引擎每轮扫"列表"其实扫的是聊天内容，报"列表里没有未读"，
    // 在群里空转几个小时。2026-11-18 14:13 就是这么卡住的：一句没发出去的草稿留在输入框里。
    if (looksLikeInputBar(bmp)) {
      return { page: "chat", confidence: 0.85, reason: "LauncherUI + 底部白盒输入栏" };
    }
    // 输入栏被顶到屏幕中部 = 表情面板开着。必须在 tab 栏之前判：
    // 面板底部是贴纸网格，浅底贴纸会让「四簇 tab 栏」成立，整个页面被误判成 list。
    if (looksLikeStickerPanel(bmp)) {
      return { page: "sticker_panel", confidence: 0.8, reason: "LauncherUI + 输入栏被顶到中部（表情面板）" };
    }
    if (looksLikeTabBar(bmp)) {
      return { page: "list", confidence: 0.85, reason: "LauncherUI + 底部四簇 tab 栏" };
    }
    return { page: "unknown", confidence: 0.4, reason: "LauncherUI，但像素特征都不匹配" };
  }
  return { page: "unknown", confidence: 0.3, reason: `未覆盖的活动：${focus.component || "(空)"}` };
}

export function decodeFrame(frame: Frame): Bitmap {
  // Frame.bmp 是 Adb.screencap 顺手解好的（同一帧不要解两遍）；假设备没填才自己解
  return frame.bmp ?? decode(frame.png);
}