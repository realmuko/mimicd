import { test } from "node:test";
import assert from "node:assert/strict";

import { PendingQueue } from "../src/daemon/pending.ts";

function ctx(chat = "阿杰") {
  return {
    chat,
    kind: "dm",
    messages: [
      { from: "other", text: "在吗" },
      { from: "me", text: "在的" },
      { from: "other", text: "帮我看个东西" },
    ],
  };
}

test("pending：挂起、列出、按 id 取", () => {
  const q = new PendingQueue();
  const item = q.add(ctx());
  assert.equal(item.status, "open");
  assert.equal(q.list().length, 1);
  assert.equal(q.list()[0].chat, "阿杰");
  assert.equal(q.get(item.id)?.messages.length, 3);
});

test("pending：回复后从待办里消失，重复回复被拒", () => {
  const q = new PendingQueue();
  const item = q.add(ctx());
  assert.ok(q.reply(item.id, "好呀"));
  assert.equal(q.list().length, 0);
  assert.equal(q.reply(item.id, "再回一次"), null);
});

test("pending：跳过与过期", () => {
  const q = new PendingQueue({ ttlMs: 1000 });
  const a = q.add(ctx());
  assert.ok(q.skip(a.id));
  assert.equal(q.list().length, 0);

  const b = q.add(ctx());
  // 把时钟拨到过期之后
  q.sweep(Date.now() + 2000);
  assert.equal(q.list().length, 0);
  assert.equal(q.reply(b.id, "x"), null);
});

test("pending：容量上限丢最老的", () => {
  const q = new PendingQueue({ capacity: 2, ttlMs: 60_000 });
  const a = q.add(ctx("A"));
  const b = q.add(ctx("B"));
  const c = q.add(ctx("C"));
  const ids = q.list().map((i) => i.chat);
  assert.deepEqual(ids, ["B", "C"]);
  assert.equal(q.get(a.id), undefined);
  assert.ok(q.get(b.id));
  assert.ok(q.get(c.id));
});