import { test } from "node:test";
import assert from "node:assert/strict";

import { groupDuplicates, mergeGroup } from "../src/stickers/dedupe.ts";

const base = { mood: "无语", tags: [], funny: 0.5, sends: [] };

test("分组：isSame 决定谁和谁一组", () => {
  const a = { ...base, id: "a" };
  const b = { ...base, id: "b" };
  const c = { ...base, id: "c" };
  const groups = groupDuplicates([a, b, c], (x, y) => (x.id === "a" && y.id === "b") || (x.id === "b" && y.id === "a"));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.map((e) => e.id).sort()), [["a", "b"], ["c"]]);
});

test("分组：全都不一样就一人一组", () => {
  const groups = groupDuplicates([{ ...base, id: "a" }, { ...base, id: "b" }], () => false);
  assert.equal(groups.length, 2);
});

test("合并：保留已收藏的那条", () => {
  const merged = mergeGroup([
    { ...base, id: "old", firstSeenAt: 1 },
    { ...base, id: "collected", collectedAt: 100, firstSeenAt: 2 },
  ]);
  assert.equal(merged.id, "collected");
});

test("合并：都收藏过就保留最早收藏的", () => {
  const merged = mergeGroup([
    { ...base, id: "late", collectedAt: 300, firstSeenAt: 1 },
    { ...base, id: "early", collectedAt: 100, firstSeenAt: 2 },
  ]);
  assert.equal(merged.id, "early");
  assert.equal(merged.collectedAt, 100);
});

test("合并：发送记录取并集去重，谁也不丢", () => {
  const merged = mergeGroup([
    { ...base, id: "a", sends: [1, 5], collectedAt: 10 },
    { ...base, id: "b", sends: [5, 9] },
  ]);
  assert.deepEqual(merged.sends, [1, 5, 9]);
});

test("合并：funny 取最大，tags 取并集", () => {
  const merged = mergeGroup([
    { ...base, id: "a", tags: ["吐槽"], funny: 0.4, collectedAt: 1 },
    { ...base, id: "b", tags: ["网络梗"], funny: 0.9 },
  ]);
  assert.equal(merged.funny, 0.9);
  assert.deepEqual([...merged.tags].sort(), ["吐槽", "网络梗"]);
});

test("合并：没收藏过的组，就按发送次数多的留", () => {
  const merged = mergeGroup([
    { ...base, id: "few", sends: [1], firstSeenAt: 1 },
    { ...base, id: "many", sends: [1, 2, 3], firstSeenAt: 2 },
  ]);
  assert.equal(merged.id, "many");
});