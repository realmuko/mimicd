import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDaemonServer } from "../src/daemon/server.ts";
import { World } from "../src/world/state.ts";
import { EventLog, readEvents } from "../src/eventlog.ts";

function makeDeps(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daemon-"));
  const file = join(dir, "run.jsonl");
  const log = new EventLog({ file, run: "r-test" });
  log.append("message.seen", { chat: "张三", text: "在吗" }, { src: "test" });
  const world = new World();
  world.ingest("张三", [{ text: "在吗", from: "other", y: 500, source: "ocr" }]);

  const calls = [];
  const deps = {
    world,
    auto: {
      async tick() {
        calls.push("tick");
        return { acted: true, chat: "张三", replied: false, reason: "测试", ms: 5 };
      },
    },
    registry: {
      issues: [],
      skills: new Map([
        [
          "wechat.send_text",
          { id: "wechat.send_text", version: 2, title: "发文本", intent: "reply", idempotency: "unsafe" },
        ],
      ]),
      resolve(id) {
        if (id !== "wechat.send_text") throw new Error(`没有技能 ${id}`);
        return { skill: { id }, params: { text: "hi" } };
      },
    },
    runner: {
      async run() {
        calls.push("run");
        return { ok: true, skillId: "wechat.send_text", steps: 1, ms: 1, outputs: {} };
      },
    },
    eventLog: log,
    eventFile: file,
    state: { paused: false, dryRun: false, startedAt: Date.now() - 1000 },
    control: async (action) => {
      calls.push(`control:${action}`);
      return { ok: true, message: `did ${action}` };
    },
    probe: async () => ({ focus: "com.tencent.mm/ui.LauncherUI", page: "list", online: true }),
    ...overrides,
  };
  return { deps, file, calls };
}

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}
async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("daemon：/health /state /skills /events", async () => {
  const { deps } = makeDeps();
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const health = await get(d.port, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.paused, false);
    assert.equal(health.body.device.page, "list");
    assert.equal(health.body.run, "r-test");

    const state = await get(d.port, "/state");
    assert.equal(state.body.world.chats["张三"].lastText, "在吗");

    const skills = await get(d.port, "/skills");
    assert.deepEqual(skills.body.skills.map((s) => s.id), ["wechat.send_text"]);

    const events = await get(d.port, "/events?limit=10");
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].kind, "message.seen");
  } finally {
    await d.close();
  }
});

test("daemon：/intent 调技能，未知技能返回 422/500 而不是假装成功", async () => {
  const { deps } = makeDeps();
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const ok = await post(d.port, "/intent", { skill: "wechat.send_text", params: { text: "hi" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);

    const bad = await post(d.port, "/intent", { skill: "wechat.nope", params: {} });
    assert.ok(bad.status >= 400);
    assert.equal(bad.body.ok, false);
  } finally {
    await d.close();
  }
});

test("daemon：/control 与 /tick", async () => {
  const { deps, calls } = makeDeps();
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const c = await post(d.port, "/control", { action: "pause" });
    assert.equal(c.status, 200);
    assert.deepEqual(calls, ["control:pause"]);

    const t = await post(d.port, "/tick", {});
    assert.equal(t.body.result.acted, true);
    assert.deepEqual(calls, ["control:pause", "tick"]);
  } finally {
    await d.close();
  }
});

test("daemon：token 保护 / 404 明确报错", async () => {
  const { deps } = makeDeps({ token: "s3cret" });
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const noAuth = await get(d.port, "/health");
    assert.equal(noAuth.status, 401);
    const ok = await fetch(`http://127.0.0.1:${d.port}/health?token=s3cret`);
    assert.equal(ok.status, 200);
    const missing = await get(d.port, "/nope?token=s3cret");
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /没有这个接口/);
  } finally {
    await d.close();
  }
});
test("daemon：交接模式 —— /pending 列出、/pending/reply 发出并出队", async () => {
  const { PendingQueue } = await import("../src/daemon/pending.ts");
  const queue = new PendingQueue();
  const sent = [];
  const { deps } = makeDeps({
    pending: queue,
    sendReply: async (chat, kind) => {
      sent.push(kind.stickerMood ?? kind.text);
      return { ok: true };
    },
  });

  const item = queue.add({ chat: "阿杰", kind: "dm", messages: [{ from: "other", text: "在吗" }] });

  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const list = await get(d.port, "/pending");
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].chat, "阿杰");

    const reply = await post(d.port, "/pending/reply", { id: item.id, text: "在的" });
    assert.equal(reply.status, 200);
    assert.deepEqual(sent, ["在的"]);

    const after = await get(d.port, "/pending");
    assert.equal(after.body.items.length, 0);

    const again = await post(d.port, "/pending/reply", { id: item.id, text: "再回" });
    assert.equal(again.status, 404);
  } finally {
    await d.close();
  }
});

test("daemon：文字发出去了、表情没发成 —— 待办要出队，不能退回重试（回归：同一句发两遍）", async () => {
  const { PendingQueue } = await import("../src/daemon/pending.ts");
  const queue = new PendingQueue();
  const { deps } = makeDeps({
    pending: queue,
    sendReply: async () => ({
      ok: false,
      textSent: true,
      stickerSent: false,
      reason: "文字已发，表情没发出去：面板里没有库里的贴纸",
    }),
  });
  const item = queue.add({ chat: "阿杰", kind: "dm", messages: [{ from: "other", text: "在吗" }] });
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const reply = await post(d.port, "/pending/reply", { id: item.id, text: "在的", stickerMood: "无语" });
    // 文字确实发出去了：整次交接算成功，只是带个 warning
    assert.equal(reply.status, 200);
    assert.equal(reply.body.ok, true);
    assert.equal(reply.body.stickerSent, false);
    assert.match(String(reply.body.warning), /表情/);
    // 关键：待办必须出队 —— 退回队列的话桥接会再叫醒一次，模型就会把同一句再发一遍
    const after = await get(d.port, "/pending");
    assert.equal(after.body.items.length, 0);
    const again = await post(d.port, "/pending/reply", { id: item.id, text: "再回" });
    assert.equal(again.status, 404);
  } finally {
    await d.close();
  }
});

test("daemon：一个字都没发出去 —— 待办留在队列里，返回 422", async () => {
  const { PendingQueue } = await import("../src/daemon/pending.ts");
  const queue = new PendingQueue();
  const { deps } = makeDeps({
    pending: queue,
    sendReply: async () => ({ ok: false, textSent: false, reason: "进不到会话「阿杰」" }),
  });
  const item = queue.add({ chat: "阿杰", kind: "dm", messages: [{ from: "other", text: "在吗" }] });
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const reply = await post(d.port, "/pending/reply", { id: item.id, text: "在的" });
    assert.equal(reply.status, 422);
    const after = await get(d.port, "/pending");
    assert.equal(after.body.items.length, 1);
  } finally {
    await d.close();
  }
});

test("daemon：/say 主动搭话 —— 没配置时 400，被限额拒绝时 422 并落事件", async () => {
  const { deps } = makeDeps();
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const missing = await post(d.port, "/say", { chat: "阿杰", text: "在吗" });
    assert.equal(missing.status, 400);
  } finally {
    await d.close();
  }

  const said = [];
  const { deps: deps2, file } = makeDeps({
    say: async (chat, kind) => {
      said.push({ chat, kind });
      if (chat === "某个群") return { ok: false, refused: "group", reason: "主动搭话默认不进群" };
      return { ok: true };
    },
  });
  const d2 = await startDaemonServer(deps2, { port: 0 });
  try {
    const ok = await post(d2.port, "/say", { chat: "阿杰", text: "好久没聊了" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.chat, "阿杰");
    assert.deepEqual(said[0], { chat: "阿杰", kind: { text: "好久没聊了" } });

    const refused = await post(d2.port, "/say", { chat: "某个群", text: "嘿" });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.refused, "group");
    assert.ok(readEvents(file).some((e) => e.kind === "note" && e.data.stage === "proactive"), "拒绝也要落事件");
  } finally {
    await d2.close();
  }
});

test("daemon：同一条待办被两个人同时回 —— 只发一次（先占位再发送）", async () => {
  const { PendingQueue } = await import("../src/daemon/pending.ts");
  const queue = new PendingQueue();
  const sent = [];
  const { deps } = makeDeps({
    pending: queue,
    sendReply: async (chat, kind) => {
      await new Promise((r) => setTimeout(r, 80));
      sent.push(kind.text);
      return { ok: true };
    },
  });
  const item = queue.add({ chat: "阿杰", kind: "dm", messages: [{ from: "other", text: "在吗" }] });
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const [a, b] = await Promise.all([
      post(d.port, "/pending/reply", { id: item.id, text: "收到" }),
      post(d.port, "/pending/reply", { id: item.id, text: "收到收到" }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 404], "一个成功一个 404，不能两个都发");
    assert.equal(sent.length, 1);
  } finally {
    await d.close();
  }
});

test("daemon：/stickers 给主模型看库里有哪些情绪", async () => {
  const { deps } = makeDeps();
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const empty = await get(d.port, "/stickers");
    assert.equal(empty.status, 200);
    assert.equal(empty.body.total, 0);
  } finally {
    await d.close();
  }

  const lib = {
    list: () => [
      { mood: "无语", tags: ["吐槽"], funny: 0.7, collectedAt: 1, sends: [] },
      { mood: "开心", tags: [], funny: 0.8, collectedAt: 1, sends: [] },
    ],
    moodCounts: () => ({ 无语: 1, 开心: 1 }),
  };
  const { deps: deps2 } = makeDeps({ stickers: lib });
  const d2 = await startDaemonServer(deps2, { port: 0 });
  try {
    const r = await get(d2.port, "/stickers");
    assert.equal(r.body.total, 2);
    assert.equal(r.body.moods["无语"], 1);
    assert.equal(r.body.items.length, 2);
  } finally {
    await d2.close();
  }
});

test("daemon：回复可以同时带一句话和一个表情（先文字后表情）", async () => {
  const { PendingQueue } = await import("../src/daemon/pending.ts");
  const queue = new PendingQueue();
  const kinds = [];
  const { deps } = makeDeps({
    pending: queue,
    sendReply: async (chat, kind) => {
      kinds.push(kind);
      return { ok: true };
    },
  });
  const item = queue.add({ chat: "摸鱼闲聊群", kind: "group", messages: [{ from: "other", text: "哈哈哈" }] });
  const d = await startDaemonServer(deps, { port: 0 });
  try {
    const r = await post(d.port, "/pending/reply", { id: item.id, text: "笑死", stickerMood: "无语" });
    assert.equal(r.status, 200);
    assert.deepEqual(kinds[0], { text: "笑死", stickerMood: "无语" });
  } finally {
    await d.close();
  }
});
