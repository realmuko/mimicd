import test from "node:test";
import assert from "node:assert/strict";

import { PendingBridge, formatPendingPrompt, pickNewItems, resolveChatSession } from "../lib/bridge.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pendingItem(id, extra = {}) {
  const now = Date.now();
  return {
    id,
    chat: "摸鱼闲聊群",
    kind: "group",
    createdAt: now,
    expiresAt: now + 300000,
    needsJudgment: true,
    messages: [
      { from: "other", text: "在吗", sender: "阿瓜" },
      { from: "me", text: "在" },
      { from: "other", text: "你看这个", sender: "BX" },
    ],
    ...extra,
  };
}

function fakeEngine(items, moods = { 无语: 2, 开心: 1 }) {
  const calls = { pending: 0, stickers: 0 };
  return {
    calls,
    async pending() {
      calls.pending++;
      const list = typeof items === "function" ? items() : items;
      return { ok: true, items: list };
    },
    async stickers() {
      calls.stickers++;
      return { ok: true, moods };
    },
  };
}

function fakeSchedule({ fail = false, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    create(...args) {
      calls.push(args);
      if (hang) return new Promise(() => {});
      if (fail) return Promise.reject(new Error("schedule down"));
      return Promise.resolve({ ok: true });
    },
  };
}

test("prompt：群聊显示「昵称：内容」、不要求 @、带工具和待办 id", () => {
  const item = pendingItem("id-123");
  const prompt = formatPendingPrompt(item, { 无语: 2 });

  assert.match(prompt, /其他人名字就是发这句话的人/);
  assert.match(prompt, /别把别的群\/私聊里的事带进来/, "要写明不串话题");
  assert.match(prompt, /阿瓜：在吗/);
  assert.match(prompt, /BX：你看这个/);
  assert.match(prompt, /我：在/);
  assert.match(prompt, /不用等 @/);
  assert.match(prompt, /完全插不上、或者会打断别人正事时才跳过/);
  assert.doesNotMatch(prompt, /必须 ?@/);
  assert.match(prompt, /wechat_reply_pending/);
  assert.match(prompt, /wechat_skip_pending/);
  assert.match(prompt, /id-123/);
  assert.match(prompt, /无语 2 张/);
});

test("prompt：私聊用「对方」，不出现群聊接话引导", () => {
  const prompt = formatPendingPrompt(
    pendingItem("id-9", { kind: "dm", chat: "阿杰", needsJudgment: false, messages: [{ from: "other", text: "hi" }] }),
  );
  assert.match(prompt, /「对方」是聊天对象/);
  assert.match(prompt, /对方：hi/);
  assert.doesNotMatch(prompt, /不用等 @/);
});

test("pickNewItems 跳过见过的 id", () => {
  const seen = new Set(["a"]);
  const fresh = pickNewItems(seen, [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(fresh.map((i) => i.id), ["b"]);
});

test("同一批待办只叫醒一次，消失的 id 会被清掉", async () => {
  let items = [pendingItem("a1"), pendingItem("a2")];
  const engine = fakeEngine(() => items);
  const schedule = fakeSchedule();
  const bridge = new PendingBridge({ engine, sessionId: "session-1", schedule, intervalMs: 99999 });

  assert.equal(await bridge.pollOnce(), 2);
  assert.equal(schedule.calls.length, 2);
  assert.equal(await bridge.pollOnce(), 0);
  assert.equal(schedule.calls.length, 2);

  items = [];
  await bridge.pollOnce();
  assert.equal(bridge.status().pendingSeen, 0);
});

test("叫醒失败会重试，最多 3 次后放弃（不会每拍刷一辈子）", async () => {
  const engine = fakeEngine([pendingItem("bad")]);
  const schedule = fakeSchedule({ fail: true });
  const logs = [];
  const bridge = new PendingBridge({
    engine,
    sessionId: "session-1",
    schedule,
    wakeTimeoutMs: 500,
    log: (m) => logs.push(m),
  });

  await bridge.pollOnce(); // 第 1 次：现代签名 + 旧签名各失败一次
  await bridge.pollOnce(); // 第 2 次
  await bridge.pollOnce(); // 第 3 次：达到上限，放弃
  const callsAfterThree = schedule.calls.length;
  assert.equal(callsAfterThree, 6);

  await bridge.pollOnce(); // 已放弃：不再叫
  assert.equal(schedule.calls.length, callsAfterThree);
  assert.equal(bridge.status().wakes, 0);
  assert.match(logs.join("\n"), /放弃这条/);
  assert.match(logs.join("\n"), /3 次/);
});

test("叫醒超时算失败，不会再拿旧签名重复唤醒", async () => {
  const engine = fakeEngine([pendingItem("slow")]);
  const schedule = fakeSchedule({ hang: true });
  const bridge = new PendingBridge({ engine, sessionId: "session-1", schedule, wakeTimeoutMs: 40 });

  await bridge.pollOnce();
  assert.equal(schedule.calls.length, 1);

  await bridge.pollOnce();
  await bridge.pollOnce();
  assert.equal(schedule.calls.length, 3); // 超时路径每次都只调一次

  await bridge.pollOnce();
  assert.equal(schedule.calls.length, 3); // 放弃
});

test("看门狗：超过 stallMs 才复位，复位后下一轮能照常跑", async () => {
  const resolvers = [];
  const engine = {
    async pending() {
      return await new Promise((resolve) => resolvers.push(resolve));
    },
    async stickers() {
      return { moods: {} };
    },
  };
  const logs = [];
  const bridge = new PendingBridge({
    engine,
    sessionId: "session-1",
    schedule: fakeSchedule(),
    stallMs: 40,
    log: (m) => logs.push(m),
  });

  const first = bridge.pollOnce();
  assert.equal(bridge.unstick(), false); // 还没到 40ms
  await sleep(60);
  assert.equal(bridge.unstick(), true);
  assert.equal(bridge.status().watchdogResets, 1);
  assert.match(logs.join("\n"), /看门狗/);

  const second = bridge.pollOnce(); // 复位后可以重新进来
  resolvers[1]({ ok: true, items: [] });
  await second;
  assert.equal(bridge.status().busy, false);

  resolvers[0]({ ok: true, items: [] });
  await first;
  assert.equal(bridge.status().busy, false);
});

test("没配 sessionId 时 wake 给出明确错误", async () => {
  const bridge = new PendingBridge({ engine: fakeEngine([]), sessionId: "", schedule: fakeSchedule() });
  await assert.rejects(() => bridge.wake(pendingItem("x")), /唤醒会话/);
});

test("会话对齐：精确 / 前缀 / 取最长命中，没有命中就是空", () => {
  const map = {
    "摸鱼闲聊群": "session-aaa",
    "周末爬山小分队": "session-bbb",
    "周末爬山小分队摸鱼": "session-ccc",
  };
  assert.equal(resolveChatSession(map, "摸鱼闲聊群"), "session-aaa");
  // 手机上群名被截断（OCR 只到前面几个字）也要能对上
  assert.equal(resolveChatSession(map, "周末爬山小分队有2个人领了红包"), "session-bbb");
  // 两个都包含时取更长的那个
  assert.equal(resolveChatSession(map, "周末爬山小分队摸鱼群"), "session-ccc");
  assert.equal(resolveChatSession(map, "陌生群"), "");
  assert.equal(resolveChatSession({ "周末爬山小分队": "" }, "周末爬山小分队"), "");
});

test("wake 按会话对齐表选目标会话；没配专属会话就用默认", async () => {
  const schedule = fakeSchedule();
  const bridge = new PendingBridge({
    engine: fakeEngine([]),
    sessionId: "session-default",
    chatSessions: { "周末爬山小分队": "session-zhihu" },
    schedule,
  });

  await bridge.wake(pendingItem("a", { chat: "周末爬山小分队有2个人领了红包" }));
  await bridge.wake(pendingItem("b", { chat: "摸鱼闲聊群" }));

  const targets = schedule.calls.map((args) => JSON.stringify(args[0]));
  assert.match(targets[0], /session-zhihu/, "有专属会话就发给它");
  assert.match(targets[1], /session-default/, "没有专属会话用默认");
});

test("启动日志写明轮询间隔、叫醒超时、看门狗", async () => {
  const logs = [];
  const bridge = new PendingBridge({
    engine: fakeEngine([]),
    sessionId: "session-1",
    schedule: fakeSchedule(),
    intervalMs: 11000,
    log: (m) => logs.push(m),
  });

  bridge.start();
  await sleep(10);
  bridge.stop();

  assert.match(logs[0], /11000ms/);
  assert.match(logs[0], /叫醒超时 25s/);
  assert.match(logs[0], /看门狗 60s/);
});