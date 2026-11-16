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

test("卡片识别：能找出白色大圆角块（链接卡片）", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  // 一张卡片：宽 420，高 120
  fill(bmp, { x: 90, y: 200, w: 420, h: 120 }, [255, 255, 255]);
  // 卡片里一条深色标题
  fill(bmp, { x: 110, y: 230, w: 260, h: 16 }, [40, 40, 40]);

  const cards = findLinkCards(bmp, AREA);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].rect, { x: 90, y: 200, w: 420, h: 120 });
});

test("卡片识别：普通白色气泡（窄）不算卡片", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  // 340/600 = 0.57，够宽到能被行投影看到，但达不到卡片的 0.6 宽度线
  fill(bmp, { x: 150, y: 100, w: 340, h: 80 }, [255, 255, 255]);
  assert.equal(findLinkCards(bmp, AREA, { minWidthRatio: 0.6 }).length, 0);
  // 放宽宽度阈值就能找到，证明挡它的是宽度条件
  assert.equal(findLinkCards(bmp, AREA, { minWidthRatio: 0.5 }).length, 1);
});

test("卡片识别：绿色气泡（自己发的）不算", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  fill(bmp, { x: 120, y: 200, w: 400, h: 120 }, [149, 236, 105]);
  assert.equal(findLinkCards(bmp, AREA).length, 0);
});

test("卡片识别：多张卡片按 y 排序，位置都对", () => {
  const bmp = blank(600, 800, [237, 237, 237]);
  fill(bmp, { x: 90, y: 550, w: 420, h: 100 }, [255, 255, 255]);
  fill(bmp, { x: 90, y: 150, w: 420, h: 100 }, [255, 255, 255]);
  const cards = findLinkCards(bmp, { x: 0, y: 0, w: 600, h: 800 });
  assert.equal(cards.length, 2);
  assert.ok(cards[0].rect.y < cards[1].rect.y);
});