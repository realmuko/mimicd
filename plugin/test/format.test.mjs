import test from "node:test";
import assert from "node:assert/strict";

import {
  formatClock,
  formatUptime,
  summarizeChats,
  summarizeEvent,
  summarizePending,
} from "../lib/format.js";

test("formatUptime 的单位", () => {
  assert.equal(formatUptime(1500), "2s");
  assert.equal(formatUptime(120_000), "2m");
  assert.equal(formatUptime(3_600_000), "1h");
  assert.equal(formatUptime(90_000_000), "1d1h");
});

test("formatClock 对空值给短横线", () => {
  assert.equal(formatClock(0), "—");
  assert.match(formatClock(1794990006997), /^\d{2}:\d{2}:\d{2}$/);
});

test("summarizeChats 按 lastSeenAt 倒序、去掉 seen 历史", () => {
  const world = {
    chats: {
      a: { name: "a", kind: "dm", lastSeenAt: 100, lastText: "一", seen: [{ text: "x" }] },
      b: { name: "b", kind: "group", lastSeenAt: 300, lastText: "二", unread: 2 },
      c: { name: "c", kind: "group", lastSeenAt: 200, lastText: "三" },
    },
  };
  const chats = summarizeChats(world, { limit: 2 });
  assert.deepEqual(chats.map((c) => c.name), ["b", "c"]);
  assert.equal(chats[0].unread, 2);
  assert.equal(chats[0].seen, undefined);
  assert.equal(chats[1].kind, "group");
});

test("summarizePending 算出几秒前和还剩几秒", () => {
  const now = 1_000_000;
  const items = summarizePending(
    [
      {
        id: "id1",
        chat: "群",
        kind: "group",
        createdAt: now - 5000,
        expiresAt: now + 60_000,
        needsJudgment: true,
        messages: [{ from: "other", text: "在吗", sender: "阿瓜" }],
      },
    ],
    now,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].ageSec, 5);
  assert.equal(items[0].expiresInSec, 60);
  assert.equal(items[0].needsJudgment, true);
  assert.equal(items[0].messages[0].sender, "阿瓜");
});

test("summarizeEvent 给群聊发送者、链接、心跳打标", () => {
  const seen = summarizeEvent({
    t: 1,
    kind: "message.seen",
    src: "monitor",
    data: { chat: "群", from: "other", sender: "阿瓜", text: "hi" },
  });
  assert.equal(seen.noise, true);
  assert.match(seen.summary, /阿瓜：hi/);

  const decided = summarizeEvent({
    t: 2,
    kind: "intent.decided",
    data: { chat: "群", reply: true, reason: "群里没 @，交给主模型判断" },
  });
  assert.equal(decided.noise, false);
  assert.match(decided.summary, /回复=true/);
});