import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDaemonServer } from "../src/daemon/server.ts";
import { PendingQueue } from "../src/daemon/pending.ts";
import { World } from "../src/world/state.ts";
import { EventLog } from "../src/eventlog.ts";

function makeDeps(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
  const file = join(dir, "run.jsonl");
  const log = new EventLog({ file, run: "r-handoff" });
  const world = new World();
  return {
    world,
    file,
    deps: {
      world,
      auto: { async tick() { return { acted: false, reason: "测试", ms: 1 }; } },
      registry: { issues: [], skills: new Map(), resolve: () => ({ skill: {}, params: {} }) },
      runner: { async run() { return { ok: true, steps: 0, ms: 0, outputs: {} }; } },
      eventLog: log,
      eventFile: file,
      state: { paused: false, dryRun: false, startedAt: Date.now() },
      control: async () => ({ ok: true, message: "" }),
      probe: async () => ({ focus: "", page: "list", online: true }),
      ...overrides,
    },
  };
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("交接回复成功 → 回写 repliedTo / replies / 冷却 / 自己说过的话", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-world-"));
  const world = new World({ file: join(dir, "world.json") });
  const [seen] = world.ingest("张三", [{ text: "在吗", from: "other", y: 500, source: "ocr" }]);

  const queue = new PendingQueue();
  const item = queue.add({ chat: "张三", kind: "dm", messages: [{ from: "other", text: "在吗" }] });
  const { deps } = makeDeps({
    world,
    pending: queue,
    perChatCooldownMs: 120_000,
    sendReply: async () => ({ ok: true, textSent: true }),
  });

  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const before = Date.now();
    const r = await post(d.port, "/pending/reply", { id: item.id, text: "在的" });
    assert.equal(r.status, 200);

    const chat = world.chat("张三");
    assert.equal(chat.repliedTo, seen.id, "要记回到哪一条（交接路径以前完全没写）");
    assert.equal(chat.replies.length, 1, "回复时间要进 replies，minGap/maxPerHour 才有依据");
    assert.ok(chat.cooldownUntil >= before + 120_000 - 2000, "每会话冷却要按配置写上");
    assert.equal(chat.lastFrom, "me");
    assert.equal((chat.ownReplies ?? []).at(-1).text, "在的");
    assert.equal(queue.list().length, 0);
  } finally {
    await d.close();
  }
});

test("交接回复成功 → 调 onReplied 钩子；钩子出错不影响已发送的结果", async () => {
  const world = new World();
  const queue = new PendingQueue();
  const item = queue.add({ chat: "李四", kind: "dm", messages: [{ from: "other", text: "在吗" }] });
  const hooked = [];
  const { deps } = makeDeps({
    world,
    pending: queue,
    sendReply: async () => ({ ok: true }),
    onReplied: async (chat, text) => {
      hooked.push({ chat, text });
    },
  });

  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const r = await post(d.port, "/pending/reply", { id: item.id, text: "在的" });
    assert.equal(r.status, 200);
    assert.deepEqual(hooked, [{ chat: "李四", text: "在的" }]);
    assert.equal(world.chat("李四").replies.length, 1);
  } finally {
    await d.close();
  }

  // 钩子抛错也照样 200（消息已经发出去了，不能反过来说失败）
  const queue2 = new PendingQueue();
  const item2 = queue2.add({ chat: "王五", kind: "dm", messages: [{ from: "other", text: "在吗" }] });
  const { deps: deps2 } = makeDeps({
    world: new World(),
    pending: queue2,
    sendReply: async () => ({ ok: true }),
    onReplied: () => {
      throw new Error("钩子坏了");
    },
  });
  const d2 = await startDaemonServer(deps2, { port: 0 });
  try {
    const r = await post(d2.port, "/pending/reply", { id: item2.id, text: "在的" });
    assert.equal(r.status, 200);
  } finally {
    await d2.close();
  }
});

test("交接回复发送失败 → 不改世界（还是没回过）", async () => {
  const world = new World();
  const queue = new PendingQueue();
  const item = queue.add({ chat: "张三", kind: "dm", messages: [{ from: "other", text: "在吗" }] });
  const { deps } = makeDeps({
    world,
    pending: queue,
    sendReply: async () => ({ ok: false, reason: "没进到会话" }),
  });

  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const r = await post(d.port, "/pending/reply", { id: item.id, text: "在的" });
    assert.equal(r.status, 422);
    assert.equal(world.chat("张三").replies.length, 0);
    assert.equal(world.chat("张三").cooldownUntil, 0);
    assert.equal(queue.list().length, 1, "发送失败要把待办还回去");
  } finally {
    await d.close();
  }
});

test("交接跳过 → 挂一个短冷却（默认 5 分钟，可配）", async () => {
  const world = new World();
  const queue = new PendingQueue();
  const item = queue.add({ chat: "张三", kind: "dm", messages: [{ from: "other", text: "在吗" }] });
  const { deps } = makeDeps({ world, pending: queue, skipCooldownMs: 60_000 });

  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const before = Date.now();
    const r = await post(d.port, "/pending/skip", { id: item.id, reason: "不适合接" });
    assert.equal(r.status, 200);
    const chat = world.chat("张三");
    assert.ok(chat.cooldownUntil >= before + 60_000 - 2000, "跳过也要冷却，否则同一拍又扫到同一条");
    assert.equal(chat.replies.length, 0, "跳过不算回复");
  } finally {
    await d.close();
  }
});