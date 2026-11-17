import { test } from "node:test";
import assert from "node:assert/strict";

import { findLinkCards } from "../src/perception/cards.ts";

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
