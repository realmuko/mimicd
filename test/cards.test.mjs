import { test } from "node:test";
import assert from "node:assert/strict";

import { findCardTitle, findLinkCards } from "../src/perception/cards.ts";

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
const AREA = { x: 0, y: 0, w: 600, h: 600 };

/** 一张真卡片：白底 + 深色标题 + **右侧彩色缩略图** */
function drawCard(bmp, rect) {
  fill(bmp, rect, [255, 255, 255]);
  fill(bmp, { x: rect.x + 20, y: rect.y + 30, w: 260, h: 16 }, [40, 40, 40]);
  fill(bmp, { x: rect.x + rect.w - 110, y: rect.y + 20, w: 90, h: 80 }, [180, 150, 90]); // 彩色图
}

test("卡片识别：白底 + 彩色缩略图才算卡片", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  drawCard(bmp, { x: 90, y: 200, w: 420, h: 120 });
  const cards = findLinkCards(bmp, AREA);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].rect.w, 420);
});

test("卡片识别：纯白文字气泡（没有彩色块）不算卡片", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  fill(bmp, { x: 90, y: 200, w: 420, h: 120 }, [255, 255, 255]);
  fill(bmp, { x: 110, y: 230, w: 300, h: 16 }, [40, 40, 40]);
  assert.equal(findLinkCards(bmp, AREA).length, 0);
});

test("卡片识别：宽度阈值真的在起作用（真机卡片约 0.6–0.7 屏宽）", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  drawCard(bmp, { x: 100, y: 100, w: 400, h: 80 });
  assert.equal(findLinkCards(bmp, AREA, { minWidthRatio: 0.7 }).length, 0);
  assert.equal(findLinkCards(bmp, AREA, { minWidthRatio: 0.6 }).length, 1);
});

test("卡片识别：绿色气泡（自己发的）不算", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  fill(bmp, { x: 120, y: 200, w: 400, h: 120 }, [149, 236, 105]);
  assert.equal(findLinkCards(bmp, AREA).length, 0);
});

test("卡片识别：多张按 y 排序", () => {
  const bmp = blank(600, 800, [237, 237, 237]);
  drawCard(bmp, { x: 90, y: 550, w: 420, h: 100 });
  drawCard(bmp, { x: 90, y: 150, w: 420, h: 100 });
  const cards = findLinkCards(bmp, { x: 0, y: 0, w: 600, h: 800 });
  assert.equal(cards.length, 2);
  assert.ok(cards[0].rect.y < cards[1].rect.y);
});

test("OCR 定位卡片：标题 + 来源（左对齐、字更小、相隔 120–400）", () => {
  const lines = [
    { text: "在的", x: 787, y: 834, w: 87, h: 43 },
    { text: "搞得定吗，搞不定重做啦。", x: 203, y: 1127, w: 528, h: 46 },
    { text: "昨天晚上 11： 53", x: 435, y: 1427, w: 211, h: 29 },
    { text: "你，想家了吗？", x: 198, y: 1564, w: 302, h: 46 },
    { text: "人民网", x: 253, y: 1816, w: 91, h: 29 },
  ];
  const title = findCardTitle(lines);
  assert.ok(title, "应认出卡片标题");
  assert.equal(title.text, "你，想家了吗？");
});

test("OCR 定位卡片：普通气泡 + 时间行不算（Δx 太大）", () => {
  const lines = [
    { text: "搞得定吗，搞不定重做啦。", x: 203, y: 1127, w: 528, h: 46 },
    { text: "昨天晚上 11： 53", x: 435, y: 1427, w: 211, h: 29 },
  ];
  assert.equal(findCardTitle(lines), null);
});

test("OCR 定位卡片：两条普通气泡不算（后缀行字太大）", () => {
  const lines = [
    { text: "第一句比较长的话在这里", x: 200, y: 600, w: 500, h: 44 },
    { text: "第二句也比较长", x: 203, y: 900, w: 300, h: 44 },
  ];
  assert.equal(findCardTitle(lines), null);
});

test("OCR 定位卡片：把来源一起带回来（主模型要知道这是哪个号发的）", () => {
  const lines = [
    { text: "你，想家了吗？", x: 198, y: 1564, w: 302, h: 46 },
    { text: "人民网", x: 253, y: 1816, w: 91, h: 29 },
  ];
  const card = findCardTitle(lines);
  assert.ok(card);
  assert.equal(card.text, "你，想家了吗？");
  assert.equal(card.source, "人民网");
});
