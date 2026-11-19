/**
 * 从「面板当前屏看到的候选」里挑一张贴纸。
 *
 * 2026-11-19 的教训：收藏面板一屏只有 7~8 格（`sticker_panel.grid.scan.maxRows = 2`），
 * 而挑图只看当前屏 —— 「无语」这种情绪常常整屏只有一张可用，于是整晚同一张反复发。
 * 所以这里只负责「排序 + 判断这张是不是刚发过」，要不要翻页扩大候选池由调用方决定。
 */

export interface StickerLike {
  id: string;
  mood: string;
  tags: readonly string[];
  funny: number;
  /** 历史发送时间戳；空数组 = 从没发过 */
  sends: readonly number[];
}

export type StickerCandidate = { entry: StickerLike };

/** 最后一次发出去的时间；从没发过算 0（排序时优先）。 */
export function lastSentAt(entry: { sends: readonly number[] }): number {
  return entry.sends.length > 0 ? Math.max(...entry.sends) : 0;
}

export interface PickOptions {
  /** 当前时间，默认 Date.now()；测试里固定住 */
  now?: number;
  /** 这么久之内刚发过的算「太新鲜」，调用方应翻页找别的；0 = 不管 */
  avoidRecentMs?: number;
}

export interface PickResult<T> {
  chosen: T | undefined;
  /**
   * 挑中的这张是「刚发过」的（或者池子里压根只有它）。
   * 调用方看到 true 就该往下翻几屏扩大池子再挑一次。
   */
  tooFresh: boolean;
}

/**
 * 排序规则：情绪对得上的优先（mood 或 tags 命中），其次最久没发过的优先，
 * 同样久就按有趣度（funny）高的优先。情绪一张都对不上时退回全池，别因此不发。
 */
export function pickSticker<T extends StickerCandidate>(
  cands: readonly T[],
  mood: string | undefined,
  opts: PickOptions = {},
): PickResult<T> {
  if (!cands || cands.length === 0) return { chosen: undefined, tooFresh: false };

  const m = String(mood ?? "").trim();
  const matched = m ? cands.filter((c) => c.entry.mood === m || c.entry.tags.includes(m)) : [];
  const list = matched.length > 0 ? matched : cands;

  const sorted = [...list].sort(
    (a, b) => lastSentAt(a.entry) - lastSentAt(b.entry) || b.entry.funny - a.entry.funny,
  );
  const chosen = sorted[0];
  if (!chosen) return { chosen: undefined, tooFresh: false };

  const now = opts.now ?? Date.now();
  const avoid = opts.avoidRecentMs ?? 0;
  const tooFresh = avoid > 0 && lastSentAt(chosen.entry) > now - avoid;
  return { chosen, tooFresh };
}