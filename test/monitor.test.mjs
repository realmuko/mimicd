import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanName, findRedBadges, matchNames, scanList, unreadRows } from "../src/monitor/scan.ts";
import { bubbleSide, mergeBubbles, messagesFromOcr } from "../src/monitor/read.ts";

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

const AREA = { x: 0, y: 0, w: 1080, h: 2000 };
const RED = [230, 60, 60];

test("未读检测：红点被找到，位置对", () => {
  const bmp = blank(1080, 2000, [237, 237, 237]);
  fill(bmp, { x: 120, y: 240, w: 36, h: 36 }, RED);
  const badges = findRedBadges(bmp, AREA);
  assert.equal(badges.length, 1);
  assert.deepEqual([badges[0].x, badges[0].y, badges[0].w], [120, 240, 36]);
});

test("未读检测：太小的红点（<10px）和长条红块不算", () => {
  const bmp = blank(1080, 2000, [237, 237, 237]);
  fill(bmp, { x: 100, y: 100, w: 6, h: 6 }, RED);
  fill(bmp, { x: 300, y: 300, w: 120, h: 20 }, RED);
  assert.equal(findRedBadges(bmp, AREA).length, 0);
});

test("未读行：同一行的多个红块合并成一行", () => {
  const bmp = blank(1080, 2000, [237, 237, 237]);
  fill(bmp, { x: 120, y: 240, w: 30, h: 30 }, RED);
  fill(bmp, { x: 160, y: 246, w: 30, h: 30 }, RED);
  const rows = unreadRows(findRedBadges(bmp, AREA));
  assert.equal(rows.length, 1);
});

test("名字匹配：取该行最靠上的 OCR 文本，清掉未读数字", () => {
  const rows = [{ y: 258, badge: { x: 120, y: 240, w: 36, h: 36, area: 1000 } }];
  const lines = [
    { text: "36", x: 122, y: 240, w: 30, h: 30 },
    { text: "摸鱼闲聊群", x: 200, y: 240, w: 400, h: 40 },
    { text: "[有人@我] 除师姐之外天下已经没有好女人了", x: 200, y: 300, w: 700, h: 36 },
  ];
  const matched = matchNames(lines, rows);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, "摸鱼闲聊群");
});

test("cleanName：去掉 [3条] 与首尾括号", () => {
  assert.equal(cleanName("[3条] 张三"), "张三");
  assert.equal(cleanName("  [12条] 群聊 "), "群聊");
  assert.equal(cleanName("李四"), "李四");
});

test("scanList：红点 + OCR 一次出结果", () => {
  const bmp = blank(1080, 2000, [237, 237, 237]);
  fill(bmp, { x: 120, y: 240, w: 36, h: 36 }, RED);
  const lines = [{ text: "张三", x: 200, y: 240, w: 120, h: 40 }];
  const r = scanList(bmp, lines, AREA);
  assert.equal(r.badges, 1);
  assert.deepEqual(r.rows.map((x) => x.name), ["张三"]);
});

// ---------- 读消息 ----------

const LINES = [
  { text: "昨天 晚上 9:29", x: 300, y: 200, w: 300, h: 28 },
  { text: "在吗", x: 150, y: 260, w: 120, h: 40 },
  { text: "在的", x: 700, y: 340, w: 100, h: 40 },
  { text: "明天一起吃饭吗", x: 150, y: 500, w: 400, h: 40 },
  { text: "好呀好呀", x: 150, y: 560, w: 300, h: 40 },
];

test("读消息：按左右分谁说的，过滤时间行", () => {
  const msgs = messagesFromOcr(LINES, { width: 1080 });
  assert.deepEqual(msgs.map((m) => `${m.from}:${m.text}`), [
    "other:在吗",
    "me:在的",
    "other:明天一起吃饭吗",
    "other:好呀好呀",
  ]);
});

test("读消息：同侧连续行合并成一条（气泡换行）", () => {
  const msgs = mergeBubbles(messagesFromOcr(LINES, { width: 1080 }));
  // 中文换行直接拼，不加空格；英文单词之间才加
  assert.deepEqual(msgs.map((m) => m.text), ["在吗", "在的", "明天一起吃饭吗好呀好呀"]);
});

test("读消息：系统提示与纯符号被过滤", () => {
  const msgs = messagesFromOcr(
    [
      { text: "以下为新消息", x: 100, y: 100, w: 200, h: 30 },
      { text: "？", x: 150, y: 200, w: 30, h: 40 },
      { text: "张三撤回了一条消息", x: 100, y: 300, w: 400, h: 30 },
      { text: "真的吗", x: 150, y: 400, w: 100, h: 40 },
    ],
    { width: 1080 },
  );
  assert.deepEqual(msgs.map((m) => m.text), ["真的吗"]);
});
// ---------- 气泡颜色分左右 ----------

function makeBubbleImg(bubbleColor) {
  const bmp = blank(600, 400, [237, 237, 237]);
  fill(bmp, { x: 100, y: 150, w: 400, h: 100 }, bubbleColor);
  return bmp;
}

test("谁说的：绿色气泡算我，白色算对方（长气泡靠颜色不靠左右）", () => {
  const line = { text: "这是一句很长很长的话", x: 120, y: 170, w: 360, h: 40 };
  assert.equal(bubbleSide(makeBubbleImg([149, 236, 105]), line), "me");
  assert.equal(bubbleSide(makeBubbleImg([255, 255, 255]), line), "other");
  // 背景色（灰）判不出来，交给左右兜底
  assert.equal(bubbleSide(blank(600, 400, [237, 237, 237]), line), null);
});

test("messagesFromOcr：有截图时用颜色判，长气泡不会把「我」判成「对方」", () => {
  const bmp = makeBubbleImg([149, 236, 105]);
  const lines = [
    { text: "在的，刚看到你说的一些很长的话，我忙完马上回你", x: 120, y: 170, w: 360, h: 40 },
  ];
  const msgs = messagesFromOcr(lines, { width: 600, bmp });
  assert.equal(msgs[0].from, "me");
  // 不给截图时退回左右判定：这条中心点在 300，600 的 55% 是 330 → 会被判成对方（说明颜色判定的必要性）
  const fallback = messagesFromOcr(lines, { width: 600 });
  assert.equal(fallback[0].from, "other");
});
