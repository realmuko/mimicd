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
    list: { elements: { list_area: { x: 0, y: 0.06, w: 1, h: 0.86 } } },
    chat: {
      elements: {
        message_area: { x: 0, y: 0.08, w: 1, h: 0.86 },
        title_strip: { x: 0.25, y: 0.03, w: 0.5, h: 0.05 },
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
          pkg: "com.tencent.mm",
          activity: state.page === "list" ? "com.tencent.mm.ui.LauncherUI" : "com.tencent.mm.ui.chatting.ChattingUI",
          component: "",
        };
      },
      async shell(cmd) {
        calls.push(["shell", cmd]);
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

test("进会话：第一次点进某个群，退回来重试，对上标题才算成功", async () => {
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
  assert.match(result.reason, /群/);
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