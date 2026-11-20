/**
 * 一次性脚本：把一份 fish-memory 工作区里「早期」的条目并进另一份。
 *
 *   node scripts/merge-fish-memory.mjs <from.json> <to.json>
 *
 * 文件都在 ~/.dsh/fish-memory/ 下（工作区记忆按 cwd 命名，自己挑两个）。
 *
 * - 只并 memories（traces 是对话轨迹，那边记的是运维对话，不搬）
 * - 只并 2026-11-18 之前创建的（之后新增的多是运维记录）
 * - 按 text 去重，两边都保留原文件（写 .bak-merge-* 备份，不删不挪）
 */
import fs from "node:fs";

const [H, S] = process.argv.slice(2);
if (!H || !S) {
  console.error("usage: node scripts/merge-fish-memory.mjs <from.json> <to.json>");
  process.exit(1);
}
const CUTOFF = "2026-11-18T00:00:00.000Z";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const h = JSON.parse(fs.readFileSync(H, "utf8"));
const s = JSON.parse(fs.readFileSync(S, "utf8"));

fs.copyFileSync(H, `${H}.bak-merge-${stamp}`);
fs.copyFileSync(S, `${S}.bak-merge-${stamp}`);

const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
const have = new Set((s.memories || []).map((m) => norm(m.text)));
const haveIds = new Set((s.memories || []).map((m) => m.id));

const add = [];
for (const m of h.memories || []) {
  const at = m.createdAt || m.at || "";
  if (at >= CUTOFF) continue;
  if (have.has(norm(m.text))) continue;
  if (haveIds.has(m.id)) continue;
  add.push(m);
}

s.memories = [...(s.memories || []), ...add];
fs.writeFileSync(S, JSON.stringify(s, null, 2), "utf8");

console.log(JSON.stringify({
  backup: `.bak-merge-${stamp}`,
  fromMemories: (h.memories || []).length,
  toBefore: have.size,
  mergedIn: add.length,
  toAfter: s.memories.length,
  merged: add.map((m) => (m.createdAt || m.at || "").slice(0, 10) + " " + norm(m.text).slice(0, 40)),
}, null, 2));