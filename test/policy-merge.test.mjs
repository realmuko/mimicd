import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, decide } from "../src/policy/policy.ts";

const NOON = new Date(2026, 10, 18, 12, 0, 0).getTime();

function chatState(overrides = {}) {
  return {
    name: "张三",
    kind: "dm",
    unread: 1,
    lastText: "在吗",
    lastFrom: "other",
    lastSeenAt: NOON,
    replies: [],
    cooldownUntil: 0,
    seen: [],
    unsent: [],
    ...overrides,
  };
}

function fresh(text, from = "other", firstSeenAt = 0, extra = {}) {
  return {
    id: `id-${text}-${from}-${firstSeenAt}`,
    text,
    from,
    firstSeenAt,
    source: "ocr",
    y: 500,
    ...extra,
  };
}

test("默认群聊策略是 judge：没 @ 也放行，交给主模型判断（不再静默）", () => {
  assert.equal(DEFAULT_POLICY.groupStrategy, "judge", "用户 2026-11-18 要求：不强制靠 @ 开启会话");

  const d = decide({
    now: NOON,
    chat: chatState({ name: "家庭群", kind: "group" }),
    fresh: [fresh("今天谁做饭", "other", NOON - 10_000)],
    config: { selfNames: ["阿鲤"] },
  });
  assert.equal(d.reply, true, d.reason);
  assert.equal(d.needsJudgment, true);
  assert.match(d.reason, /交给主模型判断/);

  // @ 仍然是强信号：不需要主模型再判断
  const mentioned = decide({
    now: NOON,
    chat: chatState({ name: "家庭群", kind: "group" }),
    fresh: [fresh("@阿鲤 今天谁做饭", "other", NOON - 10_000)],
    config: { selfNames: ["阿鲤"] },
  });
  assert.equal(mentioned.reply, true);
  assert.equal(mentioned.needsJudgment, undefined);
});

test("向后兼容：显式 mention / groupMentionOnly 仍然拦群里的非 @", () => {
  const blocked = decide({
    now: NOON,
    chat: chatState({ name: "家庭群", kind: "group" }),
    fresh: [fresh("今天谁做饭", "other", NOON - 10_000)],
    config: { selfNames: ["阿鲤"], groupStrategy: "mention" },
  });
  assert.equal(blocked.reply, false);
  assert.match(blocked.reason, /群里没 @ 我/);

  const legacy = decide({
    now: NOON,
    chat: chatState({ name: "家庭群", kind: "group" }),
    fresh: [fresh("今天谁做饭", "other", NOON - 10_000)],
    config: { selfNames: ["阿鲤"], groupMentionOnly: true },
  });
  assert.equal(legacy.reply, false);
  assert.match(legacy.reason, /群里没 @ 我/);
});

test("合并窗口：最新一条太新就先等等（真人会把一句话拆几条发）", () => {
  const d = decide({
    now: NOON,
    chat: chatState({ replies: [NOON - 3600_000] }), // 不是私聊第一条
    fresh: [fresh("我跟你说个事", "other", NOON - 1000)],
    config: { quietHours: null, minGapMs: 0 },
  });
  assert.equal(d.reply, false);
  assert.match(d.reason, /合并窗口内，再等等/);
});

test("合并窗口：@ 我 / 私聊第一条 / 等够 maxMergeWaitMs 三种豁免", () => {
  // ① @ 我：群里被点名不等
  const at = decide({
    now: NOON,
    chat: chatState({ name: "家庭群", kind: "group", replies: [NOON - 3600_000] }),
    fresh: [fresh("@阿鲤 在吗", "other", NOON - 500)],
    config: { selfNames: ["阿鲤"], quietHours: null, minGapMs: 0 },
  });
  assert.equal(at.reply, true, at.reason);

  // ② 私聊第一条：对方主动开聊，先接住
  const dmFirst = decide({
    now: NOON,
    chat: chatState({ replies: [] }),
    fresh: [fresh("在吗", "other", NOON - 500)],
    config: { quietHours: null },
  });
  assert.equal(dmFirst.reply, true, dmFirst.reason);

  // ③ 已经等够 maxMergeWaitMs：对方一直发也得放行，不能永远等
  const waited = decide({
    now: NOON,
    chat: chatState({ replies: [NOON - 3600_000] }),
    fresh: [fresh("我又想到一句", "other", NOON - 20_000)],
    config: { quietHours: null, minGapMs: 0 },
  });
  assert.equal(waited.reply, true, waited.reason);
});

test("待补发队列：冷却解除后整批放行，reason 说明补发几条", () => {
  const old = fresh("我下午跟你说的事", "other", NOON - 60_000);
  const d = decide({
    now: NOON,
    chat: chatState({ replies: [NOON - 120_000], unsent: [old] }),
    fresh: [],
    config: { quietHours: null, minGapMs: 0 },
  });
  assert.equal(d.reply, true, d.reason);
  assert.match(d.reason, /补发 1 条/);
});

test("待补发队列：冷却中拒绝，但要说明消息攒着没丢", () => {
  const old = fresh("我下午跟你说的事", "other", NOON - 60_000);
  const d = decide({
    now: NOON,
    chat: chatState({ cooldownUntil: NOON + 60_000, unsent: [old] }),
    fresh: [],
  });
  assert.equal(d.reply, false);
  assert.match(d.reason, /冷却/);
  assert.match(d.reason, /补发 1 条/);
});

test("待补发队列：不传 unsent 时自动读 chat.unsent（autochat 只要 queueUnsent 就生效）", () => {
  const old = fresh("攒下来的一句", "other", NOON - 60_000);
  const d = decide({
    now: NOON,
    chat: chatState({ replies: [NOON - 120_000], unsent: [old] }),
    fresh: [],
    config: { quietHours: null, minGapMs: 0 },
  });
  assert.equal(d.reply, true, "没有新消息也要把攒下的补上");
});

test("待补发队列：攒下的旧消息 + 这拍新消息一起算，按时间先后合并", () => {
  const old = fresh("上一句", "other", NOON - 60_000);
  const d = decide({
    now: NOON,
    chat: chatState({ replies: [NOON - 120_000], unsent: [old] }),
    fresh: [fresh("这一句", "other", NOON - 5000)],
    config: { quietHours: null, minGapMs: 0 },
  });
  assert.equal(d.reply, true, d.reason);
  assert.match(d.reason, /补发 1 条/);
});

test("@ 不能跳过防刷屏预算：每小时上限照样拦", () => {
  const replies = Array.from({ length: 6 }, (_, i) => NOON - i * 60_000);
  const d = decide({
    now: NOON,
    chat: chatState({ name: "家庭群", kind: "group", replies }),
    fresh: [fresh("@阿鲤 在吗", "other", NOON - 10_000)],
    config: { selfNames: ["阿鲤"], minGapMs: 0, maxPerHour: 6 },
  });
  assert.equal(d.reply, false);
  assert.match(d.reason, /上限/);
});