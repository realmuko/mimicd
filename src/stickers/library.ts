/**
 * 表情库：收藏的表情 + 情绪标签 + 使用记录。
 *
 * 为什么要有标签：模型说「发个无语的表情」，引擎得知道哪张是「无语」。
 * 标签由视觉模型（qwen3-vl）看缩略图打，人工可以在 data/stickers/index.json 里改。
 *
 * 槽位不可靠（新收藏会插到最前，序号整体后移），所以库里只按**内容**索引；
 * 发送时现场识别面板格子，再用直方图把「库里的这一张」对到「屏幕上的那一格」。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { colorHist, cosine, hamming, type Bitmap } from "../image/image.ts";
import { stickerFeatures } from "../image/image.ts";

export interface StickerEntry {
  /** 内容哈希（dhash + 直方图前几位），稳定标识 */
  id: string;
  dhash: string;
  hist: number[];
  /** 情绪：开心 / 无语 / 敷衍 / 惊讶 / 亲昵 / 嘲讽 / 委屈 … */
  mood: string;
  tags: string[];
  /** 好不好玩 0..1（自动收藏用） */
  funny: number;
  /** 首次见到时从哪来 */
  source: "panel" | "received";
  firstSeenAt: number;
  /** 最近发送时间，用于「别连着发同一张」 */
  sends: number[];
}

export interface StickerIndex {
  version: 1;
  entries: StickerEntry[];
}

export class StickerLibrary {
  readonly #file?: string;
  #entries = new Map<string, StickerEntry>();

  constructor(file?: string) {
    this.#file = file;
  }

  load(): void {
    if (!this.#file || !existsSync(this.#file)) return;
    try {
      const idx = JSON.parse(readFileSync(this.#file, "utf8")) as StickerIndex;
      for (const e of idx.entries ?? []) this.#entries.set(e.id, e);
    } catch {
      // 坏文件当空库
    }
  }

  save(): void {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const idx: StickerIndex = { version: 1, entries: [...this.#entries.values()] };
    writeFileSync(this.#file, JSON.stringify(idx, null, 2), "utf8");
  }

  get size(): number {
    return this.#entries.size;
  }

  list(): StickerEntry[] {
    return [...this.#entries.values()];
  }

  /** 新增或更新（同 id 保留已有标签与发送记录）。 */
  upsert(partial: Omit<StickerEntry, "id" | "firstSeenAt" | "sends"> & Partial<Pick<StickerEntry, "firstSeenAt" | "sends">>): StickerEntry {
    const id = fingerprint(partial.dhash, partial.hist);
    const existing = this.#entries.get(id);
    const entry: StickerEntry = {
      id,
      dhash: partial.dhash,
      hist: partial.hist,
      mood: partial.mood || existing?.mood || "未知",
      tags: partial.tags.length > 0 ? partial.tags : (existing?.tags ?? []),
      funny: Number.isFinite(partial.funny) ? partial.funny : (existing?.funny ?? 0.5),
      source: partial.source,
      firstSeenAt: partial.firstSeenAt ?? existing?.firstSeenAt ?? Date.now(),
      sends: partial.sends ?? existing?.sends ?? [],
    };
    this.#entries.set(id, entry);
    return entry;
  }

  /** 按内容找库里的那一张（直方图为主、dHash 为辅，见 DECISIONS D18）。 */
  find(bmp: Bitmap): StickerEntry | null {
    const feat = stickerFeatures(bmp);
    return this.findByFeatures(feat.hist, feat.dhash);
  }

  findByFeatures(hist: number[], dhash: string, threshold = 0.9): StickerEntry | null {
    let best: { entry: StickerEntry; score: number } | null = null;
    for (const entry of this.#entries.values()) {
      const score = cosine(hist, entry.hist);
      if (score < threshold) continue;
      if (!best || score > best.score) best = { entry, score };
    }
    if (!best) return null;
    // 直方图打平时用 dHash 复核
    return hamming(dhash, best.entry.dhash) <= 24 ? best.entry : null;
  }

  /**
   * 挑一张发给指定情绪的表情。
   * 规则：情绪匹配优先 → 好玩程度高的优先 → 最近 3 张发过的不选（除非只有它）。
   */
  pick(mood: string, opts: { recentWindow?: number; now?: number } = {}): StickerEntry | null {
    const now = opts.now ?? Date.now();
    const recentWindow = opts.recentWindow ?? 30 * 60 * 1000;
    const all = this.list();
    if (all.length === 0) return null;

    const wanted = mood.trim();
    const same = wanted ? all.filter((e) => e.mood === wanted || e.tags.includes(wanted)) : all;
    const pool = same.length > 0 ? same : all;

    const isRecent = (e: StickerEntry) =>
      e.sends.some((t) => now - t < recentWindow) && pool.length > 1;

    const fresh = pool.filter((e) => !isRecent(e));
    const candidates = fresh.length > 0 ? fresh : pool;
    return candidates.sort((a, b) => b.funny - a.funny)[0] ?? null;
  }

  markSent(entry: StickerEntry, at = Date.now()): void {
    const stored = this.#entries.get(entry.id);
    if (!stored) return;
    stored.sends.push(at);
    stored.sends = stored.sends.slice(-20);
  }

  /** 库里情绪 → 张数，方便看标签分布 */
  moodCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.#entries.values()) out[e.mood] = (out[e.mood] ?? 0) + 1;
    return out;
  }
}

/** id = dhash + 直方图前 8 个桶的粗指纹，避免不同图撞 dHash。 */
export function fingerprint(dhash: string, hist: number[]): string {
  const bins = hist
    .map((v, i) => [i, v] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([i]) => i)
    .join("-");
  return createHash("sha1").update(`${dhash}|${bins}`).digest("hex").slice(0, 16);
}