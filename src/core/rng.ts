/**
 * 可复现的随机数。
 *
 * 为什么不用 Math.random：动作参数（按压时长、落点、滑动轨迹）必须能**按种子重放**，
 * 否则「昨天那次失败」永远复现不了，L1 的 KS 检验也没法做 A/B。
 */

export interface Rng {
  /** [0,1) */
  next(): number;
  uniform(min: number, max: number): number;
  int(min: number, max: number): number;
  /** 正态分布（Box-Muller） */
  gauss(mu: number, sigma: number): number;
  /** 对数正态：给中位数与 σ，最适合「按压时长」这类右偏分布 */
  lognormal(median: number, sigma: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const gauss = (mu: number, sigma: number): number => {
    // 避免 log(0)
    const u = Math.max(next(), 1e-12);
    const v = next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mu + z * sigma;
  };

  return {
    next,
    uniform: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    gauss,
    lognormal: (median, sigma) => Math.max(1, median * Math.exp(sigma * gauss(0, 1))),
    chance: (p) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}