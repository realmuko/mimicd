import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRng } from "../src/core/rng.ts";
import { Actuator } from "../src/act/actuator.ts";
import { EventLog, readEvents } from "../src/eventlog.ts";
import { detectPage, looksLikeInputBar, looksLikeTabBar, pageFromFocus, rectOf } from "../src/perception/page.ts";
import { SkillRunner } from "../src/skills/runner.ts";
import { encode } from "../src/image/image.ts";

// ---------- 造图 ----------

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

/** 造一张「聊天页」：灰底 + 底部白盒输入栏 + 左右三个图标。 */
function chatScreen(w = 1080, h = 2160) {
  const bmp = blank(w, h, [237, 237, 237]);
  fill(bmp, { x: Math.round(w * 0.14), y: Math.round(h * 0.952), w: Math.round(w * 0.55), h: Math.round(h * 0.035) }, [255, 255, 255]);
  // 输入栏左右图标
  fill(bmp, { x: Math.round(w * 0.03), y: Math.round(h * 0.965), w: 40, h: 40 }, [40, 40, 40]);
  fill(bmp, { x: Math.round(w * 0.8), y: Math.round(h * 0.965), w: 40, h: 40 }, [40, 40, 40]);
  fill(bmp, { x: Math.round(w * 0.9), y: Math.round(h * 0.965), w: 40, h: 40 }, [40, 40, 40]);
  return bmp;
}

/** 造一张「列表页」：灰底 + 底部四簇 tab 图标。 */
function listScreen(w = 1080, h = 2160) {
  const bmp = blank(w, h, [237, 237, 237]);
  for (let i = 0; i < 4; i++) {
    const x = Math.round(w * (0.06 + i * 0.25));
    fill(bmp, { x, y: Math.round(h * 0.948), w: Math.round(w * 0.1), h: Math.round(h * 0.02) }, [40, 40, 40]);
  }
  return bmp;
}

const GRAPH = {
  schema: 1,
  profile: "wechat",
  device: { screen: { w: 1080, h: 2160 } },
  pages: {
    chat: {
      elements: {
        header: { x: 0, y: 0.03, w: 1, h: 0.05 },
        input_box: { x: 0.12, y: 0.952, w: 0.62, h: 0.042 },
        send_button: { x: 0.855, y: 0.925, w: 0.1, h: 0.06 },
        message_area: { x: 0, y: 0.08, w: 1, h: 0.86 },
      },
    },
    list: { elements: { first_row: { x: 0, y: 0.075, w: 1, h: 0.08 } } },
  },
};

// ---------- 页面判定 ----------

test("像素判定：白盒输入栏 → chat，四簇 tab → list", () => {
  assert.equal(looksLikeInputBar(chatScreen()), true);
  assert.equal(looksLikeTabBar(chatScreen()), false);
  assert.equal(looksLikeTabBar(listScreen()), true);
  assert.equal(looksLikeInputBar(listScreen()), false);
});

test("活动名优先，LauncherUI 才看像素（聊天页可能渲染在 LauncherUI 里）", () => {
  const launcher = { raw: "", pkg: "com.tencent.mm", activity: "com.tencent.mm.ui.LauncherUI", component: "" };
  assert.equal(detectPage(chatScreen(), launcher).page, "chat");
  assert.equal(detectPage(listScreen(), launcher).page, "list");

  const chatting = { raw: "", pkg: "com.tencent.mm", activity: "com.tencent.mm.ui.chatting.ChattingUI", component: "" };
  assert.equal(detectPage(listScreen(), chatting).page, "chat");

  const other = { raw: "", pkg: "com.android.settings", activity: "x", component: "" };
  assert.equal(detectPage(chatScreen(), other).page, "other");
});

test("pageFromFocus：文章与小微能认出来", () => {
  assert.equal(pageFromFocus({ raw: "", pkg: "com.tencent.mm", activity: "com.tencent.mm.plugin.brandservice.ui.timeline.preload.ui.TmplWebViewMMUI", component: "" }).page, "article");
  assert.equal(pageFromFocus({ raw: "", pkg: "com.tencent.mm", activity: "com.tencent.mm.plugin.flutter.ui.MMFlutterViewActivity", component: "" }).page, "xiaowei");
  assert.equal(pageFromFocus({ raw: "", pkg: "com.tencent.mm", activity: "com.tencent.mm.ui.LauncherUI", component: "" }), null);
});

test("rectOf：比例换算成像素，缺元素报清楚", () => {
  assert.deepEqual(rectOf(GRAPH, "chat", "send_button", 1080, 2160), {
    x: Math.round(0.855 * 1080),
    y: Math.round(0.925 * 2160),
    w: Math.round(0.1 * 1080),
    h: Math.round(0.06 * 2160),
  });
  assert.throws(() => rectOf(GRAPH, "chat", "nope", 1080, 2160), /没有元素 nope/);
});

// ---------- runner ----------

function makeDevice(opts = {}) {
  const calls = [];
  const screen = opts.screen ?? chatScreen();
  const png = encode(screen);
  const device = {
    adb: {
      async exec() {
        return Buffer.alloc(0);
      },
      async shell(cmd) {
        calls.push(["shell", cmd]);
        if (cmd.includes("dumpsys input_method")) return "mInputShown=false";
        return "";
      },
      async screencap() {
        calls.push(["screencap"]);
        return { png, width: screen.width, height: screen.height, ms: 600 };
      },
      async focus() {
        return {
          raw: "",
          pkg: opts.focusPkg ?? "com.tencent.mm",
          activity: opts.focusActivity ?? "com.tencent.mm.ui.chatting.ChattingUI",
          component: "",
        };
      },
      async forward() {},
      async push() {},
    },
    injector: {
      async tap(x, y, ms) {
        calls.push(["tap", x, y, ms]);
      },
      async hold(x, y, ms) {
        calls.push(["hold", x, y, ms]);
      },
      async swipe() {
        calls.push(["swipe"]);
      },
      async path() {
        calls.push(["path"]);
      },
      async press() {},
      async info() {
        return "ok";
      },
      async ping() {},
    },
    ime: {
      async ping() {
        return "ok ime=true";
      },
      async readClipboard() {
        return opts.clipboard ?? "";
      },
      async readInput() {
        return { before: opts.input ?? "", after: "" };
      },
      async type(text) {
        calls.push(["type", text]);
      },
      async setClipboard() {},
      async clear() {},
    },
  };
  return { device, calls };
}

const SKILL = {
  id: "wechat.send_text",
  version: 1,
  title: "发一条文本",
  page: "chat",
  intent: "reply",
  params: { text: { type: "string" } },
  pre: [{ kind: "page", value: "chat" }],
  steps: [
    { op: "act.tap", target: { page: "chat", element: "input_box" } },
    { op: "act.type", args: { text: "$text" } },
    { op: "check", args: { kind: "input_contains", value: "$text" } },
    { op: "act.tap", target: { page: "chat", element: "send_button" } },
  ],
  post: [{ kind: "page", value: "chat" }],
  budget: { maxSteps: 8, maxMs: 20000 },
  idempotency: "unsafe",
  dryRun: "supported",
};

test("runner：跑通一条发消息技能，顺序与参数都对", async () => {
  const { device, calls } = makeDevice({ input: "你好呀" });
  const root = mkdtempSync(join(tmpdir(), "run-"));
  const log = new EventLog({ file: join(root, "run.jsonl"), run: "r-skill" });
  const actuator = new Actuator(device, { rng: createRng(5), eventLog: log });
  const runner = new SkillRunner({ device, actuator, graph: GRAPH, eventLog: log });

  const result = await runner.run(SKILL, { text: "你好呀" });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.steps, 4);

  const kinds = calls.map((c) => c[0]);
  assert.deepEqual(kinds, ["screencap", "tap", "type", "tap", "screencap"]);

  // 打字内容来自参数，不是写死的
  assert.deepEqual(calls.find((c) => c[0] === "type"), ["type", "你好呀"]);

  const events = readEvents(log.file).map((e) => e.kind);
  assert.ok(events.includes("plan.planned"));
  assert.ok(events.includes("action.executed"));
  assert.ok(events.includes("action.verified"));
});

test("runner：前置条件不满足就不动设备", async () => {
  const { device, calls } = makeDevice({ screen: listScreen(), focusActivity: "com.tencent.mm.ui.LauncherUI" });
  const actuator = new Actuator(device, { rng: createRng(5) });
  const runner = new SkillRunner({ device, actuator, graph: GRAPH });

  const result = await runner.run(SKILL, { text: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, "pre");
  assert.equal(calls.some((c) => c[0] === "tap" || c[0] === "type"), false);
});

test("runner：检查失败会指出是哪一步、差在哪", async () => {
  const { device } = makeDevice({ input: "别的内容" });
  const actuator = new Actuator(device, { rng: createRng(5) });
  const runner = new SkillRunner({ device, actuator, graph: GRAPH });

  const result = await runner.run(SKILL, { text: "你好呀" });
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, "steps");
  assert.match(result.reason, /输入框里没有「你好呀」/);
  assert.match(result.reason, /别的内容/);
});

test("runner：预算超了要停（不跑完全部步骤）", async () => {
  const { device, calls } = makeDevice({ input: "hi" });
  const actuator = new Actuator(device, { rng: createRng(5) });
  const runner = new SkillRunner({ device, actuator, graph: GRAPH });
  const tight = { ...SKILL, budget: { maxSteps: 2, maxMs: 20000 } };

  const result = await runner.run(tight, { text: "hi" });
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, "budget");
  assert.equal(calls.filter((c) => c[0] === "tap").length, 1);
});

test("runner：obs.ocr 没配置 OCR 时明确报错", async () => {
  const { device } = makeDevice();
  const actuator = new Actuator(device, { rng: createRng(5) });
  const runner = new SkillRunner({ device, actuator, graph: GRAPH });
  const skill = {
    ...SKILL,
    pre: [{ kind: "page", value: "chat" }],
    steps: [{ op: "obs.ocr", args: { region: "chat.message_area" } }],
  };
  const result = await runner.run(skill, { text: "x" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /没有配置 OCR/);
});
test("runner：配了 OCR 就跑 obs.ocr，并把文本放进 outputs", async () => {
  const { device } = makeDevice();
  const actuator = new Actuator(device, { rng: createRng(5) });
  const ocr = {
    async recognize(png, region) {
      return { text: "引擎冒烟测试", lines: [{ text: "引擎冒烟测试", x: 0, y: 0, w: 10, h: 10 }], ms: 12 };
    },
  };
  const runner = new SkillRunner({ device, actuator, graph: GRAPH, ocr });
  const skill = { ...SKILL, pre: [{ kind: "page", value: "chat" }], steps: [{ op: "obs.ocr", args: { region: "chat.message_area" } }], post: [] };
  const result = await runner.run(skill, { text: "x" });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.outputs.step1.text, "引擎冒烟测试");
});
