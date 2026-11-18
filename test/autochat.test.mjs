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
test("自动聊天：未读都不在白名单时，也要回去补发欠着的消息", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const auto = new AutoChat({
    device,
    actuator,
    // 列表里只有一个「李四」的未读行，不在白名单里
    ocr: makeOcr({ list: [{ text: "李四", x: 200, y: 240, w: 120, h: 40 }] }),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "补一句：{last}" }),
    config: { policy: { quietHours: null, whitelist: ["张三"] }, rowTapX: 300 },
    sendReply: async () => ({ ok: true }),
  });

  // 张三那边有一条因为合并窗口/冷却攒下来、红点已经被清掉的消息
  const [owed] = world.ingest("张三", [{ text: "在吗", from: "other", y: 260, source: "ocr" }]);
  world.queueUnsent("张三", [owed]);

  const result = await auto.tick();
  assert.equal(result.acted, false, result.reason);
  assert.match(result.reason, /回去补发「张三」/, `不能停在「未读都不在白名单」上：${result.reason}`);
});

test("自动聊天：欠着的会话名被 OCR 读歪 → 归一化到白名单规范名再补发", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr({ list: [{ text: "李四", x: 200, y: 240, w: 120, h: 40 }] }),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "补一句：{last}" }),
    config: { policy: { quietHours: null, whitelist: ["张三丰"] }, rowTapX: 300 },
    sendReply: async () => ({ ok: true }),
  });

  // 真机读歪过：「摸鱼闲聊群」被读成「以摸鱼闲聊群」
  const [owed] = world.ingest("以张三丰", [{ text: "在吗", from: "other", y: 260, source: "ocr" }]);
  world.queueUnsent("以张三丰", [owed]);

  const result = await auto.tick();
  assert.match(result.reason, /回去补发「张三丰」/, `要认成白名单里的名字：${result.reason}`);
  assert.equal(world.peekUnsent("张三丰").length, 1, "欠账要迁到规范名下");
  assert.equal(world.peekUnsent("以张三丰").length, 0, "歪名字下不能留，否则会一直重复补");
});

test("自动聊天：欠账还在冷却里时不去补（别每拍白进一次会话）", async () => {
  const { device } = makeDevice();
  const plain = blank(1080, 2160, [237, 237, 237]);
  for (let i = 0; i < 4; i++) {
    fill(plain, { x: Math.round(1080 * (0.06 + i * 0.25)), y: 2045, w: 100, h: 40 }, [40, 40, 40]);
  }
  const plainPng = encode(plain);
  device.adb.screencap = async () => ({ png: plainPng, width: 1080, height: 2160, ms: 10 });
  const ocr = { async recognize() { return { lines: [], text: "", ms: 1 }; } };

  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const auto = new AutoChat({
    device,
    actuator,
    ocr,
    graph: GRAPH,
    world,
    brain: new ScriptedBrain(),
    config: { policy: { quietHours: null, whitelist: ["张三丰"] } },
    sendReply: async () => ({ ok: true }),
  });
  const [owed] = world.ingest("张三丰", [{ text: "在吗", from: "other", y: 260, source: "ocr" }]);
  world.queueUnsent("张三丰", [owed]);
  world.patch("张三丰", { cooldownUntil: Date.now() + 60_000 });

  const result = await auto.tick();
  assert.equal(result.acted, false);
  assert.match(result.reason, /没有未读/, `冷却里不该回去补：${result.reason}`);
  assert.equal(world.peekUnsent("张三丰").length, 1, "欠账不能被吃掉");
});

test("自动聊天：交给主模型的是这一拍要补的那批，不是「最后 12 条」", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  let ctx = null;
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr({
      list: [{ text: "张三丰", x: 200, y: 240, w: 140, h: 40 }],
      header: [{ text: "张三丰", x: 400, y: 80, w: 120, h: 40 }],
    }),
    graph: GRAPH,
    world,
    config: {
      policy: { quietHours: null, whitelist: ["张三丰"], mergeWindowMs: 0 },
      rowTapX: 300,
      handoff: async (c) => {
        ctx = c;
        return "p-batch";
      },
    },
  });

  // 一条攒下的旧消息，之后又来了 15 条 —— 「最后 12 条」里已经没有它了
  const [old] = world.ingest("张三丰", [{ text: "攒下的旧消息", from: "other", y: 200, source: "ocr" }]);
  world.ingest(
    "张三丰",
    Array.from({ length: 15 }, (_, i) => ({
      // 每句文本都要不一样：去重有模糊层，长得像的会被当成同一条
      text: `第${"天地玄黄宇宙洪荒日月盈昃辰宿列"[i]}句话${i}`,
      from: "other",
      y: 300 + i * 40,
      source: "ocr",
    })),
  );
  world.queueUnsent("张三丰", [old]);
  assert.ok(!world.context("张三丰", 12).some((m) => m.text === "攒下的旧消息"), "前提：已经不在最后 12 条里");

  await auto.tick();
  assert.ok(ctx, "应该挂给主模型");
  assert.ok(
    ctx.messages.some((m) => m.text === "攒下的旧消息"),
    "补偿批次里的旧消息要一起给主模型看，否则它判不掉、跳过时也清不掉",
  );
});

test("自动聊天：群名被 OCR 读歪、标题也没成员数 → 靠「≥2 个发送者」判成群", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr({
      list: [{ text: "周末爬山小分队有2个人领了", x: 200, y: 240, w: 300, h: 40 }],
      header: [{ text: "102 个好兄弟 ．领了 50 人份", x: 400, y: 80, w: 360, h: 40 }],
      chat: [
        { text: "阿瓜", x: 150, y: 260, w: 60, h: 26 }, // 昵称行：小字、靠左
        { text: "在吗", x: 150, y: 300, w: 120, h: 40 },
        { text: "BX", x: 150, y: 500, w: 50, h: 26 },
        { text: "在的", x: 150, y: 540, w: 100, h: 40 },
      ],
    }),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "收到" }),
    config: { policy: { quietHours: null, whitelist: ["周末爬山小分队"] }, rowTapX: 300 },
    sendReply: async () => ({ ok: true }),
  });

  const result = await auto.tick();
  assert.equal(result.chat, "周末爬山小分队", result.reason);
  const chat = world.chat("周末爬山小分队");
  assert.equal(chat.kind, "group", "有 ≥2 个发送者就是群，不能一直按私聊处理");
  const senders = new Set((chat.seen || []).map((m) => m.sender).filter(Boolean));
  assert.ok(senders.size >= 2, `发送者要拆出来：${[...senders].join("/")}`);
});

test("自动聊天：私聊里「注意：…」这种句子不能被当作群昵称拆坏", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr({
      chat: [
        { text: "注意：明天带伞", x: 150, y: 260, w: 240, h: 40 },
        { text: "好", x: 700, y: 500, w: 60, h: 40 },
      ],
    }),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "收到" }),
    config: { policy: { quietHours: null, whitelist: [] }, rowTapX: 300 },
    sendReply: async () => ({ ok: true }),
  });

  await auto.tick();
  const texts = (world.chat("张三").seen || []).map((m) => m.text);
  assert.ok(texts.includes("注意：明天带伞"), `私聊正文不能被拆：${texts.join(" / ")}`);
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
    // 这个用例专门验「mention 策略」的旧行为；默认已改成 judge（T6），必须显式写回来
    config: { policy: { quietHours: null, whitelist: [], groupStrategy: "mention" } },
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

test("自动聊天：群聊 judge 策略 —— 没 @ 也挂给主模型判断（不静默）", async () => {
  const { device } = makeDevice();
  const root = mkdtempSync(join(tmpdir(), "auto-judge-"));
  const log = new EventLog({ file: join(root, "run.jsonl"), run: "r-auto-judge" });
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7), eventLog: log });
  let ctx = null;
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
    brain: new ScriptedBrain({ template: "不该走本地脑子" }),
    eventLog: log,
    config: {
      // 合并窗口这里关掉：这个用例只看 judge 是否放行（合并窗口另有单测）
      policy: { quietHours: null, whitelist: [], groupStrategy: "judge", mergeWindowMs: 0 },
      rowTapX: 300,
      handoff: async (c) => {
        ctx = c;
        return "pending-judge";
      },
    },
  });

  const result = await auto.tick();
  assert.equal(result.acted, true, result.reason);
  assert.ok(ctx, "群里没 @ 也要交给主模型判断，不能静默不回");
  assert.equal(ctx.kind, "group");
  assert.equal(ctx.needsJudgment, true, "要标 needsJudgment，主模型才知道这句得自己拿主意");
  assert.match(result.reason, /已挂起等主模型/);
});

test("自动聊天：对方发的链接卡片标成 [链接]（主模型才知道能点进去读）", async () => {
  const { device } = makeDevice();
  const root = mkdtempSync(join(tmpdir(), "auto-link-"));
  const log = new EventLog({ file: join(root, "run.jsonl"), run: "r-auto-link" });
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7), eventLog: log });
  const ocr = makeOcr({
    chat: [
      { text: "在吗", x: 150, y: 260, w: 120, h: 40 },
      { text: "你，想家了吗？", x: 198, y: 700, w: 302, h: 46 },
      { text: "人民网", x: 253, y: 952, w: 91, h: 29 },
    ],
  });
  let ctx = null;
  const auto = new AutoChat({
    device,
    actuator,
    ocr,
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "x" }),
    eventLog: log,
    config: {
      policy: { quietHours: null, whitelist: [] },
      rowTapX: 300,
      handoff: async (c) => {
        ctx = c;
        return "pending-1";
      },
    },
  });

  const result = await auto.tick();
  assert.equal(result.acted, true, result.reason);
  assert.ok(ctx, "应该挂起给主模型");
  const last = ctx.messages[ctx.messages.length - 1];
  assert.equal(last.text, "[链接] 你，想家了吗？ · 人民网");

  const notes = readEvents(log.file).filter((e) => e.kind === "note" && e.data.stage === "link-card");
  assert.equal(notes.length, 1, "要落一条 link-card note，方便回放归因");
});

test("自动聊天：第一次点错行进了别的会话，退回来重试、标题对上才继续", async () => {
  const { device } = makeDevice();
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const base = makeOcr();
  let headerCalls = 0;
  const ocr = {
    async recognize(png, region) {
      if (png === CHAT_PNG && region && region.y < 100) {
        headerCalls++;
        const text = headerCalls === 1 ? "李四" : "张三";
        return { lines: [{ text, x: 400, y: 80, w: 100, h: 40 }], text, ms: 5 };
      }
      return base.recognize(png, region);
    },
  };
  const sent = [];
  const auto = new AutoChat({
    device,
    actuator,
    ocr,
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "收到「{last}」" }),
    config: { policy: { quietHours: null, whitelist: [] } },
    sendReply: async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });

  const result = await auto.tick();
  assert.equal(result.replied, true, result.reason);
  assert.deepEqual(sent, ["收到「出来吃饭」"]);
  assert.equal(headerCalls, 2, "第一次标题不对，重试一次才对上");
});

test("自动聊天：交接方说「这轮不挂」（返回空 id）就只记一笔，不产生待办", async () => {
  const { device } = makeDevice();
  const root = mkdtempSync(join(tmpdir(), "auto-cap-"));
  const log = new EventLog({ file: join(root, "run.jsonl"), run: "r-auto-cap" });
  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7), eventLog: log });
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr(),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "x" }),
    eventLog: log,
    config: {
      policy: { quietHours: null, whitelist: [] },
      rowTapX: 300,
      handoff: async () => "",
    },
  });

  const result = await auto.tick();
  assert.equal(result.acted, true, result.reason);
  assert.equal(result.replied, false);
  assert.match(result.reason, /太频繁/);
  const kinds = readEvents(log.file).map((e) => e.kind);
  assert.ok(!kinds.includes("intent.pending"), "被限流时不该产生待办");
  assert.ok(kinds.some((k) => k === "note"), "要留一条可解释的记录");
});

test("自动聊天：屏幕上有浮层（unknown 页）盖住微信时，按返回收掉再继续", async () => {
  const { device, state } = makeDevice();
  const baseScreen = device.adb.screencap.bind(device.adb);
  const baseFocus = device.adb.focus.bind(device.adb);
  const popupPng = encode(blank(1080, 2160, [200, 200, 200]));
  state.page = "popup";
  device.adb.screencap = async () => {
    if (state.page === "popup") return { png: popupPng, width: 1080, height: 2160, ms: 10 };
    return baseScreen();
  };
  device.adb.focus = async () => {
    if (state.page === "popup") return { raw: "", pkg: "", activity: "", component: "" };
    return baseFocus();
  };

  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const sent = [];
  const auto = new AutoChat({
    device,
    actuator,
    ocr: makeOcr(),
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "收到「{last}」" }),
    config: { policy: { quietHours: null, whitelist: [] }, rowTapX: 300 },
    sendReply: async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });

  const result = await auto.tick();
  assert.equal(result.replied, true, result.reason);
  assert.deepEqual(sent, ["收到「出来吃饭」"]);
});

test("自动聊天：绿色气泡里的「大字 + 昵称小字」不当成链接卡片", async () => {
  const { device, state } = makeDevice();
  const green = chatScreen();
  fill(green, { x: 170, y: 670, w: 520, h: 100 }, [149, 236, 105]); // 自己的绿色气泡
  const greenPng = encode(green);
  device.adb.screencap = async () => ({
    png: state.page === "list" ? LIST_PNG : greenPng,
    width: 1080,
    height: 2160,
    ms: 10,
  });

  const world = new World();
  const actuator = new Actuator(device, { rng: createRng(7) });
  const ocr = makeOcr({
    chat: [
      { text: "在吗", x: 150, y: 260, w: 120, h: 40 },
      { text: "没死，刚缓过一口气", x: 200, y: 700, w: 520, h: 46 },
      { text: "阿瓜", x: 253, y: 952, w: 150, h: 29 },
    ],
  });
  let ctx = null;
  const auto = new AutoChat({
    device,
    actuator,
    ocr,
    graph: GRAPH,
    world,
    brain: new ScriptedBrain({ template: "x" }),
    config: {
      policy: { quietHours: null, whitelist: [], requireOtherSide: false },
      rowTapX: 300,
      handoff: async (c) => {
        ctx = c;
        return "pending-green";
      },
    },
  });

  const result = await auto.tick();
  assert.equal(result.acted, true, result.reason);
  assert.ok(ctx, "应挂起给主模型");
  assert.ok(ctx.messages.every((m) => !m.text.startsWith("[链接]")), "绿气泡不能被标成链接");
});
