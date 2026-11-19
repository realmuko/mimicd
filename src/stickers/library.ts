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
  /** 收藏成功的时间（undefined = 还没收藏） */
  collectedAt?: number;
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

  /** 删掉一条（去重合并用）。 */
  delete(id: string): boolean {
    return this.#entries.delete(id);
  }

  /** 就地替换一条（合并后的结果写回去用）。 */
  replace(entry: StickerEntry): void {
    this.#entries.set(entry.id, entry);
  }

  list(): StickerEntry[] {
    return [...this.#entries.values()];
  }

  /**
   * 新增或更新（同 id 保留已有标签与发送记录）。
   *
   * `opts.id` 用于「认出来是库里已有的那张、但这次看到的是另一帧」：不带 id 时会按
   * fingerprint(dhash,hist) 算出一个新 id —— 动图每帧算出来都不一样，库就被同一张贴纸
   * 塞满了（2026-11-19 用户指出）。带上 id 就地更新特征，不新增条目。
   */
  upsert(
    partial: Omit<StickerEntry, "id" | "firstSeenAt" | "sends"> & Partial<Pick<StickerEntry, "firstSeenAt" | "sends">>,
    opts: { id?: string } = {},
  ): StickerEntry {
    const id = opts.id ?? fingerprint(partial.dhash, partial.hist);
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
      collectedAt: existing?.collectedAt,
    };
    this.#entries.set(id, entry);
    return entry;
  }

  /** 按内容找库里的那一张（直方图为主、dHash 为辅，见 DECISIONS D18）。 */
  find(bmp: Bitmap): StickerEntry | null {
    const feat = stickerFeatures(bmp);
    return this.findByFeatures(feat.hist, feat.dhash);
  }

  findByFeatures(hist: number[], dhash: string, threshold = 0.96, maxHamming = 14): StickerEntry | null {
    let best: { entry: StickerEntry; score: number } | null = null;
    for (const entry of this.#entries.values()) {
      const score = cosine(hist, entry.hist);
      if (score < threshold) continue;
      // 先过 dHash 再看分数。以前是「先挑分数最高的，再拿它的 dHash 复核」——
      // 只要库里有一张别的高分但 dHash 对不上的贴纸挡在前面，真正那张就被挡掉，
      // 返回 null，于是同一张口口声声「没见过」，又收一遍、又建一条（2026-11-19 查出来的）。
      if (hamming(dhash, entry.dhash) > maxHamming) continue;
      if (!best || score > best.score) best = { entry, score };
    }
    return best?.entry ?? null;
  }

  /**
   * 两条记录是不是「同一张图」。
   *
   * 库里的记录是按每次看到的样子各建一条的（动图换个帧就多一条），所以同一个 id 不等于
   * 同一张图、不同 id 也可能就是同一张。发之前判「这张刚发过没有」必须按图判，不能按 id 判
   * —— 否则轮换是假的：换了个 id，发出来还是同一张（2026-11-19 用户指出的重点）。
   */
  isSamePicture(a: Pick<StickerEntry, "hist" | "dhash">, b: Pick<StickerEntry, "hist" | "dhash">): boolean {
    return cosine(a.hist, b.hist) >= SAME_PICTURE_HIST && hamming(a.dhash, b.dhash) <= SAME_PICTURE_DH;
  }

  /** 最近真的发出去过的那些记录（判断「是不是同一张」用）。 */
  recentlySent(windowMs = 20 * 60 * 1000, now = Date.now()): StickerEntry[] {
    return this.list().filter((e) => e.sends.some((t) => now - t < windowMs));
  }

  /**
   * 挑一张发给指定情绪的表情。
   *
   * 规则：情绪匹配优先 → 最久没发过 → 好玩程度高；并且**跳过任何跟最近发过的图看着一样的
   * 记录**（库里同一张可能有好几条，按 id 轮换等于没轮换）。
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
    // 最久没发过的优先，同样久再按有趣度 —— 只按 funny 排的话，同一张会一直被选中
    // （funny 都一样时排序稳定，每次都还是它；2026-11-19 用户：「怎么一直发同一个表情」）
    const lastSent = (e: StickerEntry) => (e.sends.length > 0 ? Math.max(...e.sends) : 0);
    const ranked = [...candidates].sort((a, b) => lastSent(a) - lastSent(b) || b.funny - a.funny);

    // 关键一步：按「图」而不是按 id 排重。库里同一张动图可能有好几条记录，各自有自己的发送时间，
    // 只按 id 判「最近发过」的话，来回换 id 就等于没换图 —— 发出来还是同一张。
    const sentRecently = all.filter(isRecent);
    const distinct = ranked.find((c) => !sentRecently.some((r) => r.id !== c.id && this.isSamePicture(r, c)));
    return distinct ?? ranked[0] ?? null;
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

/** 「发出来是同一张图」的判据：库内两条记录之间比，不是面板那边比（那边 dHash 会漂 25~40 位）。 */
export const SAME_PICTURE_HIST = 0.96;
export const SAME_PICTURE_DH = 16;

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