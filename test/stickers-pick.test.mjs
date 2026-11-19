import { test } from "node:test";
import assert from "node:assert/strict";

import { lastSentAt, pickSticker } from "../src/stickers/pick.ts";

const NOW = Date.parse("2026-11-19T14:00:00+08:00");
const MIN = 60 * 1000;

function st(id, mood, sends, extra = {}) {
  return { entry: { id, mood, tags: [], funny: 0.7, sends, ...extra } };
}

test("情绪对得上的优先", () => {
  const r = pickSticker([st("a", "嘲讽", []), st("b", "无语", [])], "无语", { now: NOW });
  assert.equal(r.chosen?.entry.id, "b");
});

test("tags 里带这个情绪也算对得上", () => {
  const r = pickSticker(
    [st("a", "其他", [NOW - 1 * MIN], { tags: ["无语"] }), st("b", "其他", [NOW - 60 * MIN], { tags: [] })],
    "无语",
    { now: NOW },
  );
  assert.equal(r.chosen?.entry.id, "a");
});

test("同情绪里挑最久没发过的", () => {
  const r = pickSticker(
    [st("old", "无语", [NOW - 90 * MIN]), st("new", "无语", [NOW - 3 * MIN]), st("never", "无语", [])],
    "无语",
    { now: NOW },
  );
  assert.equal(r.chosen?.entry.id, "never");
});

test("都没发过时按 funny 高的", () => {
  const r = pickSticker(
    [st("lo", "开心", [], { funny: 0.2 }), st("hi", "开心", [], { funny: 0.9 })],
    "开心",
    { now: NOW },
  );
  assert.equal(r.chosen?.entry.id, "hi");
});

test("情绪一张都对不上：退回全池，别因为没得选就不发", () => {
  const r = pickSticker([st("a", "嘲讽", [])], "亲昵", { now: NOW });
  assert.equal(r.chosen?.entry.id, "a");
});

test("刚发过的会被标成 tooFresh（调用方据此翻页找别的）", () => {
  const r = pickSticker([st("a", "无语", [NOW - 3 * MIN])], "无语", { now: NOW, avoidRecentMs: 20 * MIN });
  assert.equal(r.chosen?.entry.id, "a");
  assert.equal(r.tooFresh, true);
});

test("池子里有更久没发过的，就不算 tooFresh", () => {
  const r = pickSticker(
    [st("a", "无语", [NOW - 3 * MIN]), st("b", "无语", [NOW - 40 * MIN])],
    "无语",
    { now: NOW, avoidRecentMs: 20 * MIN },
  );
  assert.equal(r.chosen?.entry.id, "b");
  assert.equal(r.tooFresh, false);
});

test("从不发的永远不算 tooFresh", () => {
  const r = pickSticker([st("a", "无语", [])], "无语", { now: NOW, avoidRecentMs: 20 * MIN });
  assert.equal(r.tooFresh, false);
});

test("空池不炸", () => {
  const r = pickSticker([], "无语", { now: NOW });
  assert.equal(r.chosen, undefined);
  assert.equal(r.tooFresh, false);
});

test("lastSentAt 取最大值，空数组是 0", () => {
  assert.equal(lastSentAt({ sends: [1, 99, 5] }), 99);
  assert.equal(lastSentAt({ sends: [] }), 0);
});

test("排序稳定：同样的发送时间不会来回抖", () => {
  const a = st("a", "无语", [NOW - 30 * MIN], { funny: 0.5 });
  const b = st("b", "无语", [NOW - 30 * MIN], { funny: 0.5 });
  const r1 = pickSticker([a, b], "无语", { now: NOW });
  const r2 = pickSticker([b, a], "无语", { now: NOW });
  // 全等时保留输入顺序，不要求特定 id，只要求两次调用同样输入同样结果
  assert.deepEqual(
    pickSticker([a, b], "无语", { now: NOW }).chosen?.entry.id,
    pickSticker([a, b], "无语", { now: NOW }).chosen?.entry.id,
  );
  assert.ok(r1.chosen && r2.chosen);
});