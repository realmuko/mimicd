/**
 * 一次性清理：把表情库里「同一张贴纸被收了好几次」的重复条目合并掉。
 *
 *   node tools/stickers/dedupe.ts                  # 只看会合并哪些（不动文件）
 *   node tools/stickers/dedupe.ts --apply          # 真合并并写回 index.json
 *   node tools/stickers/dedupe.ts --hist 0.97 --hd 16
 *
 * 判据默认 hist ≥0.96 且 dHash ≤20 位（同一张动图换帧的量级）。
 * 别把阈值往下压：0.95/24 会让 37 条黑白梗图连成一片，合并完就再也分不开了。
 */

import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { cosine, hamming } from "../../src/image/image.ts";
import { StickerLibrary, type StickerEntry } from "../../src/stickers/library.ts";
import { groupDuplicates, mergeGroup } from "../../src/stickers/dedupe.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const num = (s: string, d: number) => (Number.isFinite(Number(s)) && s !== "" ? Number(s) : d);

const apply = flag("apply");
const hi = num(arg("hist", "0.96"), 0.96);
const hd = num(arg("hd", "20"), 20);

const indexFile = resolve(arg("file", "data/stickers/index.json"));
const lib = new StickerLibrary(indexFile);
lib.load();
const entries = lib.list();
console.log(`库里 ${entries.length} 条（已收藏 ${entries.filter((e) => e.collectedAt).length} 条），阈值 hist≥${hi} / dHash≤${hd}`);

const isSame = (a: StickerEntry, b: StickerEntry): boolean =>
  cosine(a.hist, b.hist) >= hi && hamming(a.dhash, b.dhash) <= hd;

const groups = groupDuplicates(entries, isSame).filter((g) => g.length > 1);
if (groups.length === 0) {
  console.log("没有重复，收工");
  process.exit(0);
}

let removed = 0;
let sendsMerged = 0;
for (const group of groups) {
  const merged = mergeGroup(group);
  const dropped = group.filter((e) => e.id !== merged.id);
  removed += dropped.length;
  sendsMerged += group.reduce((n, e) => n + e.sends.length, 0) - merged.sends.length;
  const moods = [...new Set(group.map((e) => e.mood))].join("/");
  console.log(
    `合并 ${group.length} 条 → ${merged.id}（${moods}，发送 ${group.reduce((n, e) => n + e.sends.length, 0)} 次，` +
      `保留 ${merged.sends.length} 条记录；丢掉 ${dropped.map((e) => e.id.slice(0, 8)).join(",")}）`,
  );
  if (apply) {
    lib.replace(merged);
    for (const e of dropped) lib.delete(e.id);
  }
}

console.log(
  `\n共 ${groups.length} 组，可去掉 ${removed} 条重复（163 → ${entries.length - removed}），发送记录合并掉 ${sendsMerged} 条`,
);
if (!apply) console.log("（这是预演，要真写回就加 --apply）");
else {
  // 合并会删条目，先留一份完整备份，后悔了能直接换回来
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${indexFile}.bak-${stamp}`;
  if (existsSync(indexFile)) copyFileSync(indexFile, backup);
  lib.save();
  console.log(`已写回 ${indexFile}（备份：${backup}）`);
}