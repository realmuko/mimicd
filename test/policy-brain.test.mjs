import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, decide, pickChat } from "../src/policy/policy.ts";
import { HttpBrain, ScriptedBrain, sanitizeReply } from "../src/brain/brain.ts";
import { World } from "../src/world/state.ts";

function chatState(overrides = {}) {
  return {
    name: "张三",
    kind: "dm",
    unread: 1,
    lastText: "在吗",
    lastFrom: "other",
    lastSeenAt: 0,
    replies: [],
    cooldownUntil: 0,
    seen: [],
    ...overrides,
  };
}

function fresh(text, from = "other") {
  return { id: "id-" + text, text, from, firstSeenAt: 0, source: "ocr", y: 500 };
}

// 挑一个不在静默时段的时间：中午 12 点
const NOON = new Date(2026, 10, 17, 12, 0, 0).getTime();

test("策略：正常情况放行", () => {
  const d = decide({ now: NOON, chat: chatState(), fresh: [fresh("在吗")] });
  assert.equal(d.reply, true, d.reason);
});

test("策略：没有新消息 / 最后一条是我 / 不在白名单 都拒", () => {
  assert.equal(decide({ now: NOON, chat: chatState(), fresh: [] }).reply, false);
  assert.match(
    decide({ now: NOON, chat: chatState(), fresh: [fresh("在的", "me")] }).reason,
    /我自己发的/,
  );
  const d = decide({ now: NOON, chat: chatState(), fresh: [fresh("在吗")], config: { whitelist: ["李四"] } });
  assert.equal(d.reply, false);
  assert.match(d.reason, /不在白名单/);
});

test("策略：静默时段跨零点（23–8）", () => {
  const night = new Date(2026, 10, 17, 2, 0, 0).getTime();
  assert.match(decide({ now: night, chat: chatState(), fresh: [fresh("在吗")] }).reason, /静默/);
  // 早上 8 点整已经出静默
  const morning = new Date(2026, 10, 17, 8, 0, 0).getTime();
  assert.equal(decide({ now: morning, chat: chatState(), fresh: [fresh("在吗")] }).reply, true);
  // 关掉静默就放行
  assert.equal(
    decide({ now: night, chat: chatState(), fresh: [fresh("在吗")], config: { quietHours: null } }).reply,
    true,
  );
});

test("策略：会话冷却与最小间隔", () => {
  const d1 = decide({ now: NOON, chat: chatState({ cooldownUntil: NOON + 60000 }), fresh: [fresh("在吗")] });
  assert.match(d1.reason, /冷却/);

  const d2 = decide({ now: NOON, chat: chatState({ replies: [NOON - 60000] }), fresh: [fresh("在吗")] });
  assert.match(d2.reason, /不足/);
});

test("策略：每小时上限", () => {
  const replies = Array.from({ length: 6 }, (_, i) => NOON - i * 60000);
  const d = decide({
    now: NOON,
    chat: chatState({ replies }),
    fresh: [fresh("在吗")],
    config: { minGapMs: 0, maxPerHour: 6 },
  });
  assert.match(d.reason, /上限/);
});

test("策略：已经回过这条就不再回", () => {
  const d = decide({
    now: NOON,
    chat: chatState({ repliedTo: "id-在吗" }),
    fresh: [fresh("在吗")],
    config: { minGapMs: 0 },
  });
  assert.match(d.reason, /回过了/);
});

test("pickChat：白名单优先，未读优先", () => {
  const rows = [
    { name: "群A", unread: 0 },
    { name: "张三", unread: 2 },
  ];
  assert.equal(pickChat(rows, ["张三"]), "张三");
  assert.equal(pickChat(rows, []), "张三");
  assert.equal(pickChat([{ name: "群A", unread: 0 }], []), "群A");
  assert.equal(pickChat([], []), null);
});

// ---------- 脑子 ----------

test("ScriptedBrain：模板替换，确定性", async () => {
  const brain = new ScriptedBrain({ template: "（{chat}）你说「{last}」" });
  const r = await brain.reply({ chat: "张三", messages: [{ from: "other", text: "在吗" }] });
  assert.equal(r, "（张三）你说「在吗」");
});

test("HttpBrain：请求体与解析都正确", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "  「好呀，我来啦」  " } }] };
      },
    };
  };
  const brain = new HttpBrain({ url: "http://x/v1", model: "m", apiKey: "k", fetchImpl });
  const text = await brain.reply({
    chat: "张三",
    kind: "dm",
    messages: [
      { from: "other", text: "在吗" },
      { from: "me", text: "在的" },
      { from: "other", text: "吃饭吗" },
    ],
  });
  assert.equal(text, "好呀，我来啦");
  assert.equal(captured.url, "http://x/v1/chat/completions");
  assert.equal(captured.init.headers.authorization, "Bearer k");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "m");
  assert.match(body.messages[1].content, /对方：在吗/);
  assert.match(body.messages[1].content, /我：在的/);
});

test("HttpBrain：非 200 与空内容都抛错", async () => {
  const bad = new HttpBrain({
    url: "http://x/v1/chat/completions",
    model: "m",
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return "boom"; }, async json() { return {}; } }),
  });
  await assert.rejects(() => bad.reply({ chat: "a", messages: [] }), /HTTP 500/);

  const empty = new HttpBrain({
    url: "http://x",
    model: "m",
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { choices: [] }; } }),
  });
  await assert.rejects(() => empty.reply({ chat: "a", messages: [] }), /空内容/);
});

test("sanitizeReply：去引号/前缀/换行，压到 200 字", () => {
  assert.equal(sanitizeReply('「你好」'), "你好");
  assert.equal(sanitizeReply("回复：好的"), "好的");
  assert.equal(sanitizeReply("第一行\n第二行"), "第一行 第二行");
  assert.equal(sanitizeReply("x".repeat(300)).length, 200);
});

test("World + 策略：真实一轮（收到→判定→记账）", () => {
  const w = new World();
  const [m] = w.ingest("张三", [{ text: "在吗", from: "other", y: 500, source: "ocr" }], NOON);
  assert.equal(decide({ now: NOON, chat: w.chat("张三"), fresh: [m] }).reply, true);
  w.markReplied("张三", m.id, NOON);
  const again = w.ingest("张三", [{ text: "在吗", from: "other", y: 500, source: "ocr" }], NOON + 1000);
  assert.equal(again.length, 0, "同一句话不该重复触发");
});
test("策略：群里没 @ 我不回，@ 了就回", () => {
  const group = chatState({ name: "家庭群", kind: "group" });
  const noMention = decide({
    now: NOON,
    chat: group,
    fresh: [fresh("今天谁做饭")],
    config: { selfNames: ["阿鲤"], groupMentionOnly: true },
  });
  assert.equal(noMention.reply, false);
  assert.match(noMention.reason, /群里没 @ 我/);

  const mentioned = decide({
    now: NOON,
    chat: group,
    fresh: [fresh("@阿鲤 今天谁做饭")],
    config: { selfNames: ["阿鲤"], groupMentionOnly: true },
  });
  assert.equal(mentioned.reply, true, mentioned.reason);

  // 私聊不受这条限制
  assert.equal(
    decide({ now: NOON, chat: chatState(), fresh: [fresh("在吗")], config: { selfNames: ["阿鲤"] } }).reply,
    true,
  );
});
