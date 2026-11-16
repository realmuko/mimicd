import { test } from "node:test";
import assert from "node:assert/strict";

import {
  colorHist,
  crop,
  dhash,
  decode,
  encode,
  hamming,
  meanColor,
  contentBox,
  stickerFeatures,
  stickerSimilarity,
  regionDiff,
} from "../src/image/image.ts";

/** 造一张纯色/渐变图，避免依赖外部素材。 */
function make(width, height, fn) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

test("PNG 编解码往返后像素一致", () => {
  const src = make(32, 24, (x, y) => [x * 7, y * 9, (x + y) * 3]);
  const back = decode(encode(src));
  assert.equal(back.width, 32);
  assert.equal(back.height, 24);
  assert.deepEqual([...back.data], [...src.data]);
});

test("裁剪：越界自动夹住，不抛异常", () => {
  const src = make(10, 10, () => [1, 2, 3]);
  const mid = crop(src, { x: 2, y: 3, w: 4, h: 5 });
  assert.equal(mid.width, 4);
  assert.equal(mid.height, 5);
  assert.equal(mid.data.length, 4 * 5 * 4);
  for (let p = 0; p < mid.data.length; p += 4) {
    assert.deepEqual([...mid.data.subarray(p, p + 3)], [1, 2, 3]);
  }
  const edge = crop(src, { x: 8, y: 8, w: 10, h: 10 });
  assert.equal(edge.width, 2);
  assert.equal(edge.height, 2);
  const outside = crop(src, { x: 100, y: 100, w: 10, h: 10 });
  assert.equal(outside.width, 0);
});

test("regionDiff：局部变化能被定位到外接框", () => {
  const a = make(100, 100, () => [200, 200, 200]);
  const b = Buffer.from(a.data);
  // 把 (30..49, 40..49) 涂黑
  for (let y = 40; y < 50; y++) {
    for (let x = 30; x < 50; x++) {
      const p = (y * 100 + x) * 4;
      b[p] = b[p + 1] = b[p + 2] = 0;
    }
  }
  const diff = regionDiff(a, { width: 100, height: 100, data: b });
  assert.equal(diff.changed, 200);
  assert.deepEqual(diff.bbox, { x: 30, y: 40, w: 20, h: 10 });
  assert.ok(Math.abs(diff.ratio - 0.02) < 1e-9);
});

test("regionDiff：小于容差的编码噪声不算变化", () => {
  const a = make(20, 20, () => [100, 100, 100]);
  const b = make(20, 20, () => [103, 97, 101]);
  assert.equal(regionDiff(a, b, undefined, 8).changed, 0);
  assert.ok(regionDiff(a, b, undefined, 2).changed > 0);
});

test("dhash：同一张图缩放后仍然匹配（贴纸在气泡里被放大）", () => {
  const pattern = (x, y) => {
    const on = (x < 32) !== (y < 32) ? 255 : 30;
    return [on, on, on];
  };
  const big = make(64, 64, pattern);
  const small = make(24, 24, (x, y) => pattern(Math.floor((x * 64) / 24), Math.floor((y * 64) / 24)));
  const d = hamming(dhash(big), dhash(small));
  assert.ok(d <= 8, `缩放后汉明距离应很小，实际 ${d}`);
});

test("dhash：两张不同图案要有明显距离", () => {
  const a = make(64, 64, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]));
  const b = make(64, 64, (x, y) => (y < 32 ? [0, 0, 0] : [255, 255, 255]));
  assert.ok(hamming(dhash(a), dhash(b)) >= 12);
});

test("meanColor / colorHist 能区分空白格与彩色贴纸", () => {
  const white = make(20, 20, () => [250, 250, 250]);
  const colorful = make(20, 20, (x) => [200, (x * 12) % 255, 40]);
  assert.ok(meanColor(white)[0] > 240);
  assert.ok(meanColor(colorful)[1] > 0);
  const hw = colorHist(white);
  const hc = colorHist(colorful);
  assert.ok(Math.abs(hw.reduce((s, v) => s + v, 0) - 1) < 1e-9);
  assert.ok(hc.filter((v) => v > 0).length > hw.filter((v) => v > 0).length);
});

test("crop 的结果能直接喂给 dhash（贴纸格子 → 特征）", () => {
  const src = make(200, 200, (x, y) => [x % 255, y % 255, 128]);
  const r = { x: 20, y: 20, w: 60, h: 60 };
  const cell = crop(src, r);
  assert.equal(cell.width, 60);
  assert.equal(dhash(cell).length, 16);
});
test("contentBox：从白底里切出内容，返回外接框与背景色", () => {
  const src = make(100, 100, () => [255, 255, 255]);
  for (let y = 15; y < 45; y++) {
    for (let x = 10; x < 30; x++) {
      const p = (y * 100 + x) * 4;
      src.data[p] = 220;
      src.data[p + 1] = 30;
      src.data[p + 2] = 40;
    }
  }
  const box = contentBox(src);
  assert.deepEqual({ x: box.x, y: box.y, w: box.w, h: box.h }, { x: 10, y: 15, w: 20, h: 30 });
  assert.equal(box.filled, 600);
  assert.deepEqual(box.bg, [255, 255, 255]);
});

test("contentBox：全空时退化为整张图，不返回负尺寸", () => {
  const blank = make(30, 30, () => [240, 240, 240]);
  const box = contentBox(blank);
  assert.deepEqual({ x: box.x, y: box.y, w: box.w, h: box.h }, { x: 0, y: 0, w: 30, h: 30 });
  assert.equal(box.filled, 0);
});

test("stickerSimilarity：同一张图缩放后判同，不同配色判异", () => {
  const art = (w, h) => {
    const bmp = make(w, h, () => [245, 245, 245]);
    for (let y = 0; y < Math.floor(h * 0.8); y++) {
      for (let x = 0; x < Math.floor(w * 0.6); x++) {
        const p = (y * w + x) * 4;
        bmp.data[p] = 40;
        bmp.data[p + 1] = 90;
        bmp.data[p + 2] = 200;
      }
    }
    return bmp;
  };
  const big = stickerFeatures(art(120, 160));
  const small = stickerFeatures(art(60, 80));
  const same = stickerSimilarity(big, small);
  assert.ok(same.hist > 0.95, `同图 hist 应接近 1，实际 ${same.hist}`);
  assert.equal(same.same, true);

  const other = stickerFeatures(
    make(120, 160, (x) => (x < 60 ? [250, 220, 40] : [250, 220, 40])),
  );
  const diff = stickerSimilarity(big, other);
  assert.equal(diff.same, false);
});
