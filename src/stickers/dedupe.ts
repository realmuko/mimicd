/**
 * 表情库去重：把「同一张贴纸被收了好几次」的重复条目合并掉。
 *
 * 为什么会重复（2026-11-19 用户指出）：收藏去重靠认图，而认图用的判据是给静态截图定的
 * —— 动图每次看到的是不同帧，dHash 能差 15~25 位，认不出来就当新贴纸：
 *   ① 库里多一条（id = fingerprint(dhash,hist)，一帧一个 id）
 *   ② 顺手「添加」一次，微信把已经收藏的那张刷回收藏列表最前面（用户：不严重，只是乱）
 *
 * 所以这里用「同一张动图换帧」的量级来配对：直方图 ≥0.96 且 dHash ≤20 位。
 * 实测（163 条现有库）这个阈值下最大一组 4~5 条；再放宽到 0.95/24 会出现 37 条连成一片
 * —— 那是把不同的黑白梗图串起来了，不能接受。
 */

export interface DedupeLike {
  id: string;
  mood: string;
  tags: readonly string[];
  funny: number;
  sends: readonly number[];
  collectedAt?: number;
  firstSeenAt?: number;
}

/**
 * 把条目按「看起来是同一张」分组。返回的组包含全部单条（组内 ≥1 条），
 * 调用方只处理 length > 1 的组即可。
 */
export function groupDuplicates<T extends DedupeLike>(
  entries: readonly T[],
  isSame: (a: T, b: T) => boolean,
): T[][] {
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < entries.length; i++) {
    for (let k = i + 1; k < entries.length; k++) {
      if (isSame(entries[i]!, entries[k]!)) union(i, k);
    }
  }
  const groups = new Map<number, T[]>();
  entries.forEach((e, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(e);
    else groups.set(root, [e]);
  });
  return [...groups.values()];
}

/**
 * 合并一组重复条目，保留一条。
 *
 * 保留谁：已经真正收藏进微信的那条优先（`collectedAt`，越早收藏越靠前），
 * 其次发过次数多的，再其次最早见到的 —— 这样发送历史、情绪标签都不丢。
 * 合并时：发过的时刻取并集（去重排序）、funny 取最大、collectedAt 取最早、tags 取并集。
 */
export function mergeGroup<T extends DedupeLike>(group: readonly T[]): T {
  const ranked = [...group].sort((a, b) => {
    // 收藏过的优先（没收藏算 Infinity）；都收藏过就留最早那次收藏的
    const ac = a.collectedAt ?? Infinity;
    const bc = b.collectedAt ?? Infinity;
    if (ac !== bc) return ac - bc;
    if (a.sends.length !== b.sends.length) return b.sends.length - a.sends.length;
    return (a.firstSeenAt ?? 0) - (b.firstSeenAt ?? 0);
  });
  const keep = ranked[0]!;
  const sends = [...new Set(group.flatMap((e) => e.sends))].sort((a, b) => a - b);
  const collected = group
    .map((e) => e.collectedAt)
    .filter((t): t is number => typeof t === "number")
    .sort((a, b) => a - b)[0];
  const tags = [...new Set(group.flatMap((e) => e.tags))];
  return {
    ...keep,
    sends,
    tags,
    funny: Math.max(...group.map((e) => e.funny)),
    ...(collected !== undefined ? { collectedAt: collected } : {}),
  };
}