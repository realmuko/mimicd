import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutoChat } from "../src/daemon/autochat.ts";
import { Actuator } from "../src/act/actuator.ts";
import { World } from "../src/world/state.ts";
import { EventLog, readEvents } from "../src/eventlog.ts";
import { ScriptedBrain } from "../src/brain/brain.ts";
import { createRng } from "../src/core/rng.ts";
import { encode } from "../src/image/image.ts";

// ---------- 造两张屏 ----------

function blank(w, h, rgb) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
function fill(bmp, rect, rgb) {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const p = (y * bmp.width + x) * 4;
      bmp.data[p] = rgb[0];
      bmp.data[p + 1] = rgb[1];
      bmp.data[p + 2] = rgb[2];
    }
  }
}

function listScreen() {
  const bmp = blank(1080, 2160, [237, 237, 237]);
  fill(bmp, { x: 120, y: 240, w: 36, h: 36 }, [230, 60, 60]); // 未读红点
  for (let i = 0; i < 4; i++) {
    fill(bmp, { x: Math.round(1080 * (0.06 + i * 0.25)), y: 2045, w: 100, h: 40 }, [40, 40, 40]);
  }
  return bmp;
}

function chatScreen() {
  const bmp = blank(1080, 2160, [237, 237, 237]);
  fill(bmp, { x: 150, y: 2056, w: 600, h: 76 }, [255, 255, 255]); // 输入框
  fill(bmp, { x: 40, y: 2085, w: 40, h: 40 }, [40, 40, 40]);
  fill(bmp, { x: 860, y: 2085, w: 40, h: 40 }, [40, 40, 40]);
  fill(bmp, { x: 970, y: 2085, w: 40, h: 40 }, [40, 40, 40]);
  return bmp;
}

const LIST_PNG = encode(listScreen());
const CHAT_PNG = encode(chatScreen());

const LIST_LINES = [
  { text: "张三", x: 200, y: 240, w: 120, h: 40 },
  { text: "在吗", x: 200, y: 300, w: 100, h: 34 },
];
const CHAT_LINES = [
  { text: "在吗", x: 150, y: 260, w: 120, h: 40 },
  { text: "出来吃饭", x: 150, y: 500, w: 260, h: 40 },
];

// ---------- 假设备 ----------

function makeDevice() {
  const calls = [];
  const state = { page: "list", typed: [] };
  const adb = {
    async exec() {
      return Buffer.alloc(0);
    },
    async shell(cmd) {
      calls.push(["shell", cmd]);
      if (cmd.includes("KEYCODE_BACK")) state.page = "list";
      return "";
    },
    async screencap() {
      calls.push(["screencap", state.page]);
      const png = state.page === "list" ? LIST_PNG : CHAT_PNG;
      return { png, width: 1080, height: 2160, ms: 10 };
    },
    async focus() {
      return {
        raw: "",
        pkg: "com.tencent.mm",
        activity: state.page === "list" ? "com.tencent.mm.ui.LauncherUI" : "com.tencent.mm.ui.chatting.ChattingUI",
        component: "",
      };
    },
    async forward() {},
    async push() {},
  };
  const injector = {
    async tap(x, y) {
      calls.push(["tap", x, y]);
      if (state.page === "list" && Math.abs(y - 258) < 60) state.page = "chat";
    },
    async hold() {},
    async swipe() {},
    async path() {},
    async press() {},
    async info() {
      return "ok";
    },
    async ping() {},
  };
  const ime = {
    async ping() {
      return "ok ime=true";
    },
    async readClipboard() {
      return "";
    },
    async readInput() {
      return { before: state.typed.at(-1) ?? "", after: "" };
    },
    async type(text) {
      state.typed.push(text);
      calls.push(["type", text]);
    },
    async setClipboard() {},
    async clear() {},
  };
  return { device: { adb, injector, ime }, calls, state };
}

const GRAPH = {
  schema: 1,
  profile: "wechat",
  device: { screen: { w: 1080, h: 2160 } },
  pages: {
    list: { elements: { list_area: { x: 0, y: 0.06, w: 1, h: 0.86 } } },
    chat: {
      elements: {
        header: { x: 0, y: 0.03, w: 1, h: 0.05 },
        title_strip: { x: 0.25, y: 0.03, w: 0.5, h: 0.05 },
        message_area: { x: 0, y: 0.08, w: 1, h: 0.86 },
      },
    },
  },
};

function makeOcr(opts = {}) {
  return {
    async recognize(png, region) {
      let lines;
      if (png === LIST_PNG) lines = opts.list ?? LIST_LINES;
      else if (region && region.y < 100) lines = opts.header ?? [{ text: "张三", x: 400, y: 80, w: 100, h: 40 }];
      else lines = opts.chat ?? CHAT_LINES;
      return { lines, text: lines.map((l) => l.text).join("\n"), ms: 5 };
    },
  };
}

test("自动聊天：列表有未读 → 进会话 → 读出对方消息 → 回一句 → 回列表", async () => {
  const { device, state } = makeDevice();
  const root = mkdtempSync(join(tmpdir(), "auto-"));
  const log = new EventLog({ file: join(root, "run.jsonl"), run: "r-auto" });
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7), eventLog: log });

  const sent = [];
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr(),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "收到「{last}」" }),
    eventLog: log,
    config: { policy: { quietHours: null, whitelist: [] }, rowTapX: 300 },
    sendReply: async (text) => {
      sent.push(text);
      await device.ime.type(text);
      return { ok: true };
    },
  });

  const result = await auto.tick();

  assert.equal(result.acted, true, result.reason);
  assert.equal(result.replied, true, result.reason);
  assert.equal(result.chat, "张三");
  assert.deepEqual(sent, ["收到「出来吃饭」"]);
  assert.deepEqual(state.typed, ["收到「出来吃饭」"]);

  // 世界记账：回过、冷却已设
  const chat = world.chat("张三");
  assert.equal(chat.replies.length, 1);
  assert.ok(chat.cooldownUntil > Date.now());
  assert.ok(chat.repliedTo, "应记录回到哪条");

  // 回完应该回到列表
  assert.equal(state.page, "list");

  const kinds = readEvents(log.file).map((e) => e.kind);
  assert.ok(kinds.includes("message.seen"));
  assert.ok(kinds.includes("intent.decided"));
  assert.ok(kinds.includes("send.succeeded"));
});

test("自动聊天：白名单不含这个会话 → 不进去、不发", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const sent = [];
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr(),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain(),
    config: { policy: { quietHours: null, whitelist: ["李四"] } },
    sendReply: async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });

  const result = await auto.tick();
  assert.ok(!result.replied, "不该回复");
  assert.match(result.reason, /白名单/);
  assert.deepEqual(sent, []);
});

test("自动聊天：没有未读就空转，不动作", async () => {
  const { device } = makeDevice();
  // 把未读红点去掉：换一张没有红点的列表图
  const plain = blank(1080, 2160, [237, 237, 237]);
  for (let i = 0; i < 4; i++) {
    fill(plain, { x: Math.round(1080 * (0.06 + i * 0.25)), y: 2045, w: 100, h: 40 }, [40, 40, 40]);
  }
  const plainPng = encode(plain);
  device.adb.screencap = async () => ({ png: plainPng, width: 1080, height: 2160, ms: 10 });
  const ocr = {
    async recognize() {
      return { lines: [], text: "", ms: 1 };
    },
  };
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  let sentCount = 0;
  const auto = new AutoChat({
    device,
    actuator,
    ocr,
    graph: GRAPH,
    world,
    brain: new ScriptedBrain(),
    config: { policy: { quietHours: null } },
    sendReply: async () => {
      sentCount++;
      return { ok: true };
    },
  });

  const result = await auto.tick();
  assert.equal(result.acted, false);
  assert.match(result.reason, /没有未读/);
  assert.equal(sentCount, 0);
});
test("自动聊天：进错会话就退出，不回", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  let sent = 0;
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr({ header: [{ text: "李四", x: 400, y: 80, w: 100, h: 40 }] }),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "不该发：{last}" }),
    config: { policy: { quietHours: null, whitelist: [] } },
    sendReply: async () => {
      sent++;
      return { ok: true };
    },
  });

  const result = await auto.tick();
  assert.equal(result.replied, undefined);
  assert.match(result.reason, /进错会话/);
  assert.equal(sent, 0);
});

test("自动聊天：群聊没 @ 我 → 读完但不回", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  let sent = 0;
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr({
      list: [{ text: "家庭群", x: 200, y: 240, w: 160, h: 40 }],
      header: [{ text: "家庭群(5)", x: 400, y: 80, w: 180, h: 40 }],
      chat: [
        { text: "今天谁做饭", x: 150, y: 260, w: 300, h: 40 },
        { text: "又是点外卖吧", x: 150, y: 500, w: 300, h: 40 },
      ],
    }),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "不该发" }),
    config: { policy: { quietHours: null, whitelist: [] } },
    sendReply: async () => {
      sent++;
      return { ok: true };
    },
  });

  const result = await auto.tick();
  assert.equal(result.chat, "家庭群");
  assert.match(result.reason, /群里没 @ 我/, result.reason);
  assert.equal(sent, 0);
  assert.equal(world.chat("家庭群").kind, "group");
});
