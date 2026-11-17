import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { World } from "../src/world/state.ts";

function msg(text, from = "other", y = 500) {
  return { text, from, y, source: "ocr" };
}

test("world：新增消息按屏幕顺序进世界，重复读同一屏不会重复计数", () => {
  const w = new World();
  const first = w.ingest("张三", [msg("在吗", "other", 400), msg("在的", "me", 500)]);
  assert.equal(first.length, 2);
  assert.equal(w.chat("张三").lastText, "在的");
  assert.equal(w.chat("张三").lastFrom, "me");

  // 再读一次同一屏：一条都不算新
  const again = w.ingest("张三", [msg("在吗", "other", 400), msg("在的", "me", 500)]);
  assert.equal(again.length, 0);

  // 底下多出一条
  const more = w.ingest("张三", [msg("在吗", "other", 400), msg("在的", "me", 500), msg("出来吃饭", "other", 600)]);
  assert.equal(more.length, 1);
  assert.equal(more[0].text, "出来吃饭");
});

test("world：同一句话在不同位置（新消息）算新的", () => {
  const w = new World();
  w.ingest("群", [msg("哈哈", "other", 300)]);
  const added = w.ingest("群", [msg("哈哈", "other", 300), msg("哈哈", "other", 900)]);
  assert.equal(added.length, 1);
});

test("world：markReplied 记录 repliedTo 与时间", () => {
  const w = new World();
  const [m] = w.ingest("张三", [msg("在吗")]);
  w.markReplied("张三", m.id, 1000);
  assert.equal(w.chat("张三").repliedTo, m.id);
  assert.deepEqual(w.chat("张三").replies, [1000]);
  assert.equal(w.chat("张三").lastFrom, "me");
});

test("world：持久化后能读回来", () => {
  const dir = mkdtempSync(join(tmpdir(), "world-"));
  const file = join(dir, "world.json");
  const w = new World({ file });
  w.ingest("张三", [msg("你好")]);
  w.patch("张三", { kind: "dm", unread: 2 });
  w.save();

  const w2 = new World({ file });
  w2.load();
  assert.equal(w2.chat("张三").lastText, "你好");
  assert.equal(w2.chat("张三").kind, "dm");
  // 读回来之后，同一条消息仍然算「已见」
  assert.equal(w2.ingest("张三", [msg("你好")]).length, 0);
});

test("world：坏文件不会让监控起不来", () => {
  const dir = mkdtempSync(join(tmpdir(), "world-"));
  const file = join(dir, "world.json");
  writeFileSync(file, "{ 坏掉的 json", "utf8");
  const w = new World({ file });
  w.load();
  assert.equal(w.list().length, 0);
});

test("world：上下文只给最近 N 条，顺序不变", () => {
  const w = new World();
  const many = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, "other", 300 + i * 50));
  w.ingest("群", many);
  const ctx = w.context("群", 5);
  assert.deepEqual(ctx.map((m) => m.text), ["m15", "m16", "m17", "m18", "m19"]);
});