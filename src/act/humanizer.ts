/**
 * Humanizer：把「点这个矩形」变成一条可执行的动作计划。
 *
 * 只做**功能地板**（D11），不做统计拟真：
 *  - 按压 ≥ 40 ms，否则长按/双击本身不稳；
 *  - 落点在目标框内、离边 ≥ 8 px，避免点到框外；
 *  - 滑动带加速-减速，末速留一点，让系统惯性收尾；
 *  - 所有随机都走种子 RNG，保证可重放。
 *
 * 参数来源与实测见 docs/research/设计前调研.md §3；这里只实现最小的那一档。
 */

import type { Rng } from "../core/rng.ts";
import type { Rect } from "../image/image.ts";

export interface TapPlan {
  x: number;
  y: number;
  /** 按压时长 ms */
  downMs: number;
  pressure: number;
  size: number;
}

export interface HoldPlan {
  x: number;
  y: number;
  ms: number;
  pressure: number;
  size: number;
}

export interface SwipePlan {
  points: Array<{ x: number; y: number; t: number }>;
  durationMs: number;
}

export interface HumanizerOptions {
  /** 轻点按压时长中位数（ms） */
  tapMedianMs?: number;
  /** 落点高斯 σ，相对短边 */
  sigmaRatio?: number;
  /** 离边框最小距离（px） */
  edgePadPx?: number;
  /** 压力均值与抖动 */
  pressure?: number;
  pressureJitter?: number;
  size?: number;
}

const DEFAULTS: Required<HumanizerOptions> = {
  tapMedianMs: 65,
  sigmaRatio: 0.12,
  edgePadPx: 8,
  pressure: 0.55,
  pressureJitter: 0.08,
  size: 0.12,
};

/** 在矩形里按高斯取一个点，夹到离边 edgePad 以内。 */
export function pointInRect(rect: Rect, rng: Rng, opts: HumanizerOptions = {}): { x: number; y: number } {
  const o = { ...DEFAULTS, ...opts };
  const pad = Math.min(o.edgePadPx, Math.floor(Math.min(rect.w, rect.h) / 4));
  const minX = rect.x + pad;
  const maxX = rect.x + rect.w - pad;
  const minY = rect.y + pad;
  const maxY = rect.y + rect.h - pad;
  if (maxX <= minX || maxY <= minY) {
    // 太小的目标就取中心，别硬塞高斯
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }
  const sigma = o.sigmaRatio * Math.min(rect.w, rect.h);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  // 3σ 之外的离群点直接截断，避免偶尔点到框外
  const x = clamp(rng.gauss((minX + maxX) / 2, Math.max(1, sigma)), minX, maxX);
  const y = clamp(rng.gauss((minY + maxY) / 2, Math.max(1, sigma)), minY, maxY);
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

export function planTap(rect: Rect, rng: Rng, opts: HumanizerOptions = {}): TapPlan {
  const o = { ...DEFAULTS, ...opts };
  const { x, y } = pointInRect(rect, rng, o);
  const downMs = clamp(Math.round(rng.lognormal(o.tapMedianMs, 0.22)), 40, 180);
  return {
    x,
    y,
    downMs,
    pressure: round3(clamp(o.pressure + rng.gauss(0, o.pressureJitter), 0.25, 0.95)),
    size: round3(clamp(o.size + rng.gauss(0, 0.02), 0.05, 0.3)),
  };
}

export function planHold(rect: Rect, rng: Rng, opts: HumanizerOptions = {}): HoldPlan {
  const o = { ...DEFAULTS, ...opts };
  const { x, y } = pointInRect(rect, rng, o);
  return {
    x,
    y,
    // 平台长按阈值 500ms，人中位大约 650–750
    ms: Math.round(rng.uniform(600, 850)),
    pressure: round3(clamp(o.pressure + rng.gauss(0, o.pressureJitter), 0.25, 0.95)),
    size: round3(clamp(o.size + rng.gauss(0, 0.02), 0.05, 0.3)),
  };
}

/**
 * 滑动计划：三次缓出（先快后慢），30% 概率小幅 overscroll，2–3 px 的横向抖动。
 * 末速留 10–20%，让系统自己去收惯性。
 */
export function planSwipe(
  from: { x: number; y: number },
  to: { x: number; y: number },
  rng: Rng,
  opts: { durationMs?: number; overscrollChance?: number } = {},
): SwipePlan {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const durationMs = opts.durationMs ?? clamp(Math.round((distance / 1400) * 1000), 120, 600);

  const overscroll = rng.chance(opts.overscrollChance ?? 0.3) ? rng.uniform(20, 60) : 0;
  const endX = to.x + (distance > 0 ? (dx / distance) * overscroll : 0);
  const endY = to.y + (distance > 0 ? (dy / distance) * overscroll : 0);

  const steps = Math.max(6, Math.round(durationMs / 12));
  const points: Array<{ x: number; y: number; t: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    // 1-(1-k)^3：开始快、收尾慢
    const e = 1 - Math.pow(1 - k, 3);
    const jitterX = rng.gauss(0, 0.9);
    const x = Math.round((from.x + (endX - from.x) * e + jitterX) * 10) / 10;
    const y = Math.round((from.y + (endY - from.y) * e + rng.gauss(0, 0.5)) * 10) / 10;
    points.push({ x, y, t: Math.round(durationMs * k) });
  }
  return { points, durationMs };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}