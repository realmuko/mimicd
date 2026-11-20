import { test } from "node:test";
import assert from "node:assert/strict";

import { enterChat } from "../src/daemon/navigate.ts";
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
function listScreen() {
  const bmp = blank(1080, 2160, [237, 237, 237]);
  for (let i = 0; i < 4; i++) {
    fill(bmp, { x: Math.round(1080 * (0.06 + i * 0.25)), y: 2045, w: 100, h: 40 }, [40, 40, 40]);
  }
  return bmp;
}
function chatScreen() {
  const bmp = blank(1080, 2160, [237, 237, 237]);
  fill(bmp, { x: 150, y: 2056, w: 600, h: 76 }, [255, 255, 255]);
  fill(bmp, { x: 40, y: 2085, w: 40, h: 40 }, [40, 40, 40]);
  fill(bmp, { x: 860, y: 2085, w: 40, h: 40 }, [40, 40, 40]);
  fill(bmp, { x: 970, y: 2085, w: 40, h: 40 }, [40, 40, 40]);
  return bmp;
}
const LIST_PNG = encode(listScreen());
const CHAT_PNG = encode(chatScreen());

const GRAPH = {
  schema: 1,
  profile: "wechat",
  device: { screen: { w: 1080, h: 2160 } },
  pages: {
    list: {
      elements: {
        list_area: { x: 0, y: 0.06, w: 1, h: 0.86 },
        search_icon: { x: 0.822, y: 0.041, w: 0.06, h: 0.03 },
      },
    },
    // 搜索页：进搜索页后要先点搜索框再清空（旧插件 core.openChat 的做法）
    search: {
      elements: {
        search_field: { x: 0.18, y: 0.055, w: 0.66, h: 0.038 },
        results_area: { x: 0, y: 0.12, w: 1, h: 0.8 },
      },
    },
    chat: {
      elements: {
        message_area: { x: 0, y: 0.08, w: 1, h: 0.86 },
        title_strip: { x: 0.25, y: 0.03, w: 0.5, h: 0.05 },
        mention_tag: { x: 0, y: 0.048, w: 1, h: 0.13 },
      },
    },
  },
};

const LIST_LINES = [
  { text: "摸鱼闲聊群", x: 200, y: 240, w: 300, h: 40 },
  { text: "周末爬山小分队", x: 200, y: 420, w: 300, h: 40 },
];

/** 假设备：titles 是每次「读标题」依次返回的内容；"" 表示这次读不出来。 */
function makeNav(opts = {}) {
  const calls = [];
  const state = { page: "list", titleReads: 0 };
  const titles = opts.titles ?? ["摸鱼闲聊群(23)"];
  const device = {
    adb: {
      async screencap() {
        calls.push(["screencap", state.page]);
        return { png: state.page === "list" ? LIST_PNG : CHAT_PNG, width: 1080, height: 2160, ms: 5 };
      },
      async focus() {
        return {
          raw: "",
          pkg: state.pkg,
          activity: state.page === "list" ? "com.tencent.mm.ui.LauncherUI" : "com.tencent.mm.ui.chatting.ChattingUI",
          component: "",
        };
      },
      async shell(cmd) {
        calls.push(["shell", cmd]);
        if (cmd.includes("am start") && opts.launchable !== false) state.pkg = "com.tencent.mm";
        if (cmd.includes("KEYCODE_BACK")) state.page = "list";
        return "";
      },
    },
    injector: {
      async tap(x, y, ms) {
        calls.push(["tap", x, y, ms]);
        if (state.page === "list") state.page = "chat";
      },
    },
    ocr: {
      async recognize(png, region) {
        if (png === LIST_PNG) return { lines: opts.listLines ?? LIST_LINES, text: "", ms: 5 };
        if (region && region.y < 100) {
          const t = titles[Math.min(state.titleReads, titles.length - 1)];
          state.titleReads++;
          return { lines: t ? [{ text: t, x: 400, y: 80, w: 200, h: 40 }] : [], text: t ?? "", ms: 5 };
        }
        return { lines: [], text: "", ms: 5 };
      },
    },
    graph: GRAPH,
  };
  return { device, calls, state };
}

test("进会话：标题对上就成功（群标题的 (23) 不影响）", async () => {
  const { device, calls } = makeNav();
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.attempts, 1);
  assert.equal(calls.filter((c) => c[0] === "tap").length, 1);
});

test("进会话：第一次点进爬山群，退回来重试，对上标题才算成功", async () => {
  const { device, calls } = makeNav({ titles: ["周末爬山小分队(50)", "摸鱼闲聊群(23)"] });
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.attempts, 2);
  assert.ok(calls.some((c) => c[0] === "shell" && String(c[1]).includes("KEYCODE_BACK")), "进错要退回来");
});

test("进会话：一直进错就失败，绝不返回 true（宁可不发）", async () => {
  const { device } = makeNav({ titles: ["周末爬山小分队(50)"] });
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.match(result.reason, /进错会话/);
  assert.match(result.reason, /爬山/);
});

test("进会话：标题认不出来也算失败（不猜）", async () => {
  const { device } = makeNav({ titles: ["", "", ""] });
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, false);
  assert.match(result.reason, /认不出标题/);
});

test("进会话：列表里没有这个会话，直接说清楚", async () => {
  const { device } = makeNav({ listLines: [{ text: "张三", x: 200, y: 240, w: 100, h: 40 }] });
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, false);
  assert.match(result.reason, /列表里没找到/);
  assert.equal(result.attempts, 1);
});
/** 假设备：支持「列表 → 搜索 → 搜索结果」那条兜底路。 */
function makeSearchNav(opts = {}) {
  const calls = [];
  const state = { page: "list", titleReads: 0 };
  // T1 之后「列表只赌一次」：第一次点行进错（爬山），第二次就应该走搜索拿到对的那个
  const titles = opts.titles ?? ["周末爬山小分队(50)", "摸鱼闲聊群(23)"];
  const typed = [];
  const device = {
    adb: {
      async screencap() {
        return { png: state.page === "chat" ? CHAT_PNG : LIST_PNG, width: 1080, height: 2160, ms: 5 };
      },
      async focus() {
        return {
          raw: "",
          pkg: "com.tencent.mm",
          activity:
            state.page === "list"
              ? "com.tencent.mm.ui.LauncherUI"
              : state.page === "search"
                ? "com.tencent.mm.plugin.fts.ui.FTSMainUI"
                : "com.tencent.mm.ui.chatting.ChattingUI",
          component: "",
        };
      },
      async shell(cmd) {
        calls.push(["shell", cmd]);
        // 只有 KEYCODE_BACK 换页；清空输入框的 keyevent 67 不能动页面
        if (cmd.includes("KEYCODE_BACK")) state.page = "list";
        return "";
      },
      // 模拟 Adb 的截图复用窗口：navigate 每次轮询前必须先把它作废
      invalidateFrame() {
        calls.push(["invalidateFrame"]);
      },
    },
    injector: {
      async tap(x, y) {
        calls.push(["tap", x, y]);
        if (state.page === "list") state.page = y < 160 ? "search" : "chat"; // 顶部是搜索图标，中间是会话行
        // 搜索页里点搜索框（y≈160）不换页；点结果行（y>300）才进会话
        else if (state.page === "search" && y > 300) state.page = "chat";
      },
    },
    ocr: {
      async recognize(png, region) {
        if (state.page === "list" && png === LIST_PNG) {
          return { lines: opts.listLines ?? LIST_LINES, text: "", ms: 5 };
        }
        if (state.page === "chat" && region && region.y < 100) {
          const t = titles[Math.min(state.titleReads, titles.length - 1)];
          state.titleReads++;
          return { lines: t ? [{ text: t, x: 400, y: 80, w: 200, h: 40 }] : [], text: t ?? "", ms: 5 };
        }
        if (state.page === "search") {
          const lines = opts.resultLines ?? [{ text: "摸鱼闲聊群", x: 200, y: 400, w: 400, h: 40 }];
          return { lines, text: "", ms: 5 };
        }
        return { lines: [], text: "", ms: 5 };
      },
    },
    ime: {
      async type(text) {
        typed.push(text);
      },
    },
    withIme: async (fn) => {
      calls.push(["withIme"]);
      return fn();
    },
    graph: GRAPH,
  };
  return { device, calls, state, typed };
}

const tapsOf = (calls) => calls.filter((c) => c[0] === "tap");

test("进会话：列表点一次没进对就转搜索，搜到后核对标题成功（不再试满三次）", async () => {
  const { device, calls, typed } = makeSearchNav();
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.via, "search");
  // 列表 1 次 + 搜索 1 次 = 2（以前是列表 3 次 + 搜索 1 次 = 4）
  assert.equal(result.attempts, 2, "attempts 要如实回报列表与搜索各自试了几次");
  assert.deepEqual(typed, ["摸鱼闲聊群"], "搜索框里要打的是会话名");
  assert.ok(calls.some((c) => c[0] === "withIme"), "打字前后要切/还输入法");
  // 列表行只点过一下（tap y=260 是列表行；y=160 是搜索框；y≈420 是搜索结果）
  assert.equal(calls.filter((c) => c[0] === "tap" && c[2] === 260).length, 1, "列表只赌一次，别盲点第二次");
  // 轮询「页面切过去了没有」时会反复截图，每次都必须先作废复用窗口，否则一直在看旧帧
  assert.ok(
    calls.filter((c) => c[0] === "invalidateFrame").length >= 3,
    "每次轮询截图前都要 invalidateFrame（不然 captureReuseMs 会把旧帧喂回来）",
  );
});

test("进会话：搜索前先把输入框清空（一条 shell 里连按 25 次退格）", async () => {
  const { device, calls } = makeSearchNav();
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, true, result.reason);
  const clear = calls.find((c) => c[0] === "shell" && /seq 1 25/.test(String(c[1])) && /keyevent 67/.test(String(c[1])));
  assert.ok(clear, "不清空的话，上次的查询会拼成垃圾串（旧插件 core.openChat 踩过）");
});

test("进会话：搜索结果里优先点精确匹配的那一行", async () => {
  const { device, calls } = makeSearchNav({
    resultLines: [
      // 模糊结果排在前面：只做包含匹配就会点到这一行
      { text: "摸鱼闲聊群文件传输助手", x: 200, y: 400, w: 600, h: 40 },
      { text: "摸鱼闲聊群", x: 200, y: 500, w: 400, h: 40 },
    ],
  });
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, true, result.reason);
  const taps = tapsOf(calls).map((c) => c[2]);
  assert.ok(taps.includes(520), `应该点精确那一行的中心（y=520），实际 tap y: ${taps.join(",")}`);
  assert.ok(!taps.includes(420), "不能点模糊匹配的那一行");
});

test("进会话：搜索框也找不到就不硬发，把原因说清楚", async () => {
  // 列表里没有、搜索也搜不出（resultsArea 里只有不相干的一行）
  const { device } = makeSearchNav({
    listLines: [{ text: "张三", x: 200, y: 240, w: 100, h: 40 }],
    resultLines: [{ text: "张三的电脑", x: 200, y: 400, w: 300, h: 40 }],
  });
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, false);
  assert.match(result.reason, /搜索|没找到/);
  assert.equal(result.via, undefined, "没进去就没有 via");
});


test("在手机桌面：先拉回微信，再进会话（不会在桌面乱点）", async () => {
  const { device, calls } = makeNav({ startPkg: "com.huawei.android.launcher" });
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, true, result.reason);
  assert.ok(calls.some((c) => c[0] === "shell" && String(c[1]).includes("am start")), "应该先把微信拉起来");
  assert.ok(calls.some((c) => c[0] === "tap"), "拉起来之后才点");
});

test("在手机桌面且拉不起微信：什么都不点，直接说清楚", async () => {
  const { device, calls } = makeNav({ startPkg: "com.huawei.android.launcher", launchable: false });
  const result = await enterChat(device, "摸鱼闲聊群");
  assert.equal(result.ok, false);
  assert.match(result.reason, /前台不是微信/);
  assert.equal(calls.filter((c) => c[0] === "tap").length, 0, "桌面上一次都不许点");
  assert.equal(calls.filter((c) => c[0] === "shell" && String(c[1]).includes("KEYCODE_BACK")).length, 0, "桌面上也不许按返回");
});

// ---------- T2：进群后滑到底 / 「有人@我」提示条 ----------

const { scrollToBottom, findMentionTag } = await import("../src/daemon/navigate.ts");

test("滑到底：按比例往上滑 maxScreens 次（旧插件滚 3 屏 320ms）", async () => {
  const calls = [];
  const adb = {
    async shell(cmd) {
      calls.push(cmd);
      return "";
    },
  };
  const r = await scrollToBottom(adb, 3, { screen: { w: 1080, h: 2160 }, gapMs: 0, settleMs: 0 });
  assert.equal(r.screens, 3);
  assert.deepEqual(calls, [
    "input swipe 540 1685 540 713 200",
    "input swipe 540 1685 540 713 200",
    "input swipe 540 1685 540 713 200",
  ]);
});

test("滑到底：maxScreens=0 就一次都不滑（没未读就别乱动）", async () => {
  const calls = [];
  const adb = { async shell(cmd) { calls.push(cmd); return ""; } };
  const r = await scrollToBottom(adb, 0, { screen: { w: 1080, h: 2160 }, gapMs: 0, settleMs: 0 });
  assert.equal(r.screens, 0);
  assert.deepEqual(calls, []);
});

test("有人@我：只 OCR 屏幕顶部窄条，返回提示条中心点", async () => {
  const png = encode(blank(1080, 2160, [237, 237, 237]));
  const regions = [];
  const ocr = {
    async recognize(p, region) {
      regions.push(region);
      return { lines: [{ text: "有人@我", x: 400, y: 200, w: 200, h: 40 }], text: "", ms: 5 };
    },
  };
  const tag = await findMentionTag(png, ocr);
  assert.deepEqual(tag, { x: 500, y: 220, text: "有人@我" }, "要返回中心点，不是上沿");
  assert.equal(regions.length, 1);
  const r = regions[0];
  assert.ok(r.y < 2160 * 0.1 && r.y + r.h < 2160 * 0.25, `只该 OCR 顶部一条，实际 ${JSON.stringify(r)}`);
  assert.equal(r.w, 1080);
});

test("有人@我：没有提示条就返回 null（别乱点）", async () => {
  const png = encode(blank(1080, 2160, [237, 237, 237]));
  const ocr = { async recognize() { return { lines: [{ text: "摸鱼闲聊群(23)", x: 400, y: 80, w: 300, h: 40 }], text: "", ms: 5 }; } };
  assert.equal(await findMentionTag(png, ocr), null);
});

test("有人@我：认得「提到我」这种说法，也接受调用方传进来的区域", async () => {
  const png = encode(blank(1080, 2160, [237, 237, 237]));
  const regions = [];
  const ocr = {
    async recognize(p, region) {
      regions.push(region);
      return { lines: [{ text: "张三 提到我", x: 100, y: 300, w: 300, h: 40 }], text: "", ms: 5 };
    },
  };
  const area = { x: 0, y: 110, w: 1080, h: 260 };
  const tag = await findMentionTag(png, ocr, area);
  assert.deepEqual(tag, { x: 250, y: 320, text: "张三 提到我" });
  assert.deepEqual(regions[0], area, "传了区域就用传进来的（页面图 chat.mention_tag）");
});

// ---------- 页面图：mention_tag / 搜索页元素（Lead 接线时按 rectOf 取）----------

const { readFileSync } = await import("node:fs");
const { rectOf, hasElement } = await import("../src/perception/page.ts");

const PROFILE = JSON.parse(readFileSync(new URL("../profiles/wechat/pages.json", import.meta.url), "utf8"));

test("页面图：chat 里有 mention_tag（顶部窄条，比例坐标）", () => {
  assert.equal(hasElement(PROFILE, "chat", "mention_tag"), true);
  const r = rectOf(PROFILE, "chat", "mention_tag", 1080, 2160);
  assert.ok(r.y > 0 && r.y < 2160 * 0.1, `mention_tag 应该贴在顶部，实际 y=${r.y}`);
  assert.ok(r.y + r.h < 2160 * 0.25, "不要一路吃进消息区（会把正文里的「@我」当成提示条）");
  assert.equal(r.w, 1080);
});

test("页面图：搜索页有 search_field 与 results_area（进搜索页先点框再清空）", () => {
  assert.equal(hasElement(PROFILE, "search", "search_field"), true);
  assert.equal(hasElement(PROFILE, "search", "results_area"), true);
  const field = rectOf(PROFILE, "search", "search_field", 1080, 2160);
  // 旧插件 wechat-usb.config.json 的 searchField 是 (570,160)：中心要落在搜索框上
  assert.ok(Math.abs(field.x + field.w / 2 - 570) < 60, `搜索框中心 x=${field.x + field.w / 2}`);
  assert.ok(Math.abs(field.y + field.h / 2 - 160) < 40, `搜索框中心 y=${field.y + field.h / 2}`);
});

test("页面图里的 mention_tag 区域可以直接喂给 findMentionTag", async () => {
  const png = encode(blank(1080, 2160, [237, 237, 237]));
  const regions = [];
  const ocr = {
    async recognize(p, region) {
      regions.push(region);
      return { lines: [{ text: "有人@我", x: 480, y: 200, w: 120, h: 36 }], text: "", ms: 5 };
    },
  };
  const area = rectOf(PROFILE, "chat", "mention_tag", 1080, 2160);
  const tag = await findMentionTag(png, ocr, area);
  assert.deepEqual(tag, { x: 540, y: 218, text: "有人@我" });
  assert.deepEqual(regions[0], area);
});
