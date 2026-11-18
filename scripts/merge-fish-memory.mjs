/**
 * 一次性脚本：把 <dsh> 工作区那份鱼记忆里「早期」的条目并进 另一个工作区 那份。
 *
 * - 只并 memories（traces 是对话轨迹，那边记的是运维对话，不搬）
 * - 只并 2026-11-18 之前创建的（今天新增的三条是运维记录，留在 harness 那边）
 * - 按 text 去重，两边都保留原文件（写 .bak-merge-* 备份，不删不挪）
 */
import fs from "node:fs";

const DIR = "<home>/.dsh/fish-memory";
const H = `${DIR}/ws_--D-deepseek_0020harness--.json`;
const S = `${DIR}/ws_--D-<other-workspace>--.json`;
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
  if (at >= CUTOFF) continue; // 今天的运维记录不搬
  if (have.has(norm(m.text))) continue;
  if (haveIds.has(m.id)) continue;
  add.push(m);
}

s.memories = [...(s.memories || []), ...add];
fs.writeFileSync(S, JSON.stringify(s, null, 2), "utf8");

console.log(JSON.stringify({
  backup: `.bak-merge-${stamp}`,
  harnessMemories: (h.memories || []).length,
  syotenBefore: have.size,
  mergedIn: add.length,
  syotenAfter: s.memories.length,
  merged: add.map((m) => (m.createdAt || m.at || "").slice(0, 10) + " " + norm(m.text).slice(0, 40)),
}, null, 2));