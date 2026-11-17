import { test } from "node:test";
import assert from "node:assert/strict";

import { findImageBubbles } from "../src/perception/bubbles.ts";

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
const AREA = { x: 0, y: 100, w: 1080, h: 1900 };

test("图片气泡：彩色大块能被认出，纯色文字气泡不算", () => {
  const bmp = blank(1080, 2100, [237, 237, 237]);
  // 对方发的一张表情（彩色，300x300）
  for (let y = 300; y < 600; y++) {
    for (let x = 120; x < 420; x++) {
      const p = (y * 1080 + x) * 4;
      bmp.data[p] = (x * 7) % 255;
      bmp.data[p + 1] = (y * 5) % 255;
      bmp.data[p + 2] = 200;
    }
  }
  // 一个白色文字气泡（纯色，大）
  fill(bmp, { x: 120, y: 900, w: 600, h: 180 }, [255, 255, 255]);

  const bubbles = findImageBubbles(bmp, AREA);
  assert.equal(bubbles.length, 1, `应只认出图片气泡，实际 ${bubbles.length}`);
  assert.deepEqual(bubbles[0].rect, { x: 120, y: 300, w: 300, h: 300 });
  assert.equal(bubbles[0].side, "left");
});

test("图片气泡：小图标（<140px）不算", () => {
  const bmp = blank(1080, 2100, [237, 237, 237]);
  for (let y = 300; y < 400; y++) {
    for (let x = 120; x < 220; x++) {
      const p = (y * 1080 + x) * 4;
      bmp.data[p] = 30;
      bmp.data[p + 1] = 200;
      bmp.data[p + 2] = 60;
    }
  }
  assert.equal(findImageBubbles(bmp, AREA).length, 0);
});

test("图片气泡：靠右的判成「我发的」", () => {
  const bmp = blank(1080, 2100, [237, 237, 237]);
  for (let y = 300; y < 600; y++) {
    for (let x = 650; x < 950; x++) {
      const p = (y * 1080 + x) * 4;
      bmp.data[p] = (x * 3) % 255;
      bmp.data[p + 1] = 40;
      bmp.data[p + 2] = (y * 2) % 255;
    }
  }
  const bubbles = findImageBubbles(bmp, AREA);
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].side, "right");
});