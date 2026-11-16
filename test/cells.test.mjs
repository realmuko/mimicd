import { test } from "node:test";
import assert from "node:assert/strict";

import { findStickerCells, screenGrid } from "../src/perception/cells.ts";

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

// 600×600 的假面板：首格中心 (100,100)，格距 120，格 100×100
const GRID = {
  firstCenterX: 100 / 600,
  firstCenterY: 100 / 600,
  pitchX: 120 / 600,
  pitchY: 120 / 600,
  cellW: 100 / 600,
  cellH: 100 / 600,
  areaX: 0,
  areaY: 0,
  areaW: 0.8,
  areaH: 0.9,
  maxRows: 2,
};

test("screenGrid：比例换算成像素", () => {
  const g = screenGrid(GRID, 600, 600);
  assert.equal(Math.round(g.firstX), 100);
  assert.equal(Math.round(g.pitchX), 120);
  assert.equal(Math.round(g.cellW), 100);
  assert.equal(Math.round(g.right), 480);
});

test("格子识别：实心贴纸被认出，「+」虚线框被排除", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  // 第 1 格：虚线框（只画边框）
  const c1 = { x: 50, y: 50, w: 100, h: 100 };
  fill(bmp, { x: c1.x, y: c1.y, w: c1.w, h: 2 }, [150, 150, 150]);
  fill(bmp, { x: c1.x, y: c1.y + c1.h - 2, w: c1.w, h: 2 }, [150, 150, 150]);
  fill(bmp, { x: c1.x, y: c1.y, w: 2, h: c1.h }, [150, 150, 150]);
  fill(bmp, { x: c1.x + c1.w - 2, y: c1.y, w: 2, h: c1.h }, [150, 150, 150]);
  // 第 2 格：实心彩色
  fill(bmp, { x: 170, y: 50, w: 100, h: 100 }, [40, 90, 200]);
  // 第 3 格：空白
  // 第 4 格在 area 外（x=410+50=460 < 480，仍在范围内）→ 造一块内容验证边界
  fill(bmp, { x: 410, y: 50, w: 100, h: 100 }, [200, 40, 40]);

  const cells = findStickerCells(bmp, GRID);
  // 只有第 2 格（实心彩色）在扫描区内且不是虚线框；第 4 格中心超出右边界被跳过
  assert.equal(cells.length, 1, `应认出 1 张实心图，实际 ${cells.length}`);
  assert.ok(cells[0].fill > 0.9);
  // 第一个识别到的是「实心彩色」，不是虚线框
  assert.ok(cells[0].hist.some((v) => v > 0));
});

test("格子识别：面积阈值能挡掉「几乎全空」的格子", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  fill(bmp, { x: 170, y: 50, w: 100, h: 100 }, [40, 90, 200]);
  assert.equal(findStickerCells(bmp, GRID, { minFill: 0.5 }).length, 1);
  assert.equal(findStickerCells(bmp, GRID, { minFill: 0.99 }).length, 1);
  assert.equal(findStickerCells(bmp, { ...GRID, areaW: 0.03 }, {}).length, 0);
});

test("格子识别：返回的 rect 是整格（点击用），不是内缩后的", () => {
  const bmp = blank(600, 600, [237, 237, 237]);
  fill(bmp, { x: 170, y: 50, w: 100, h: 100 }, [40, 90, 200]);
  const [cell] = findStickerCells(bmp, GRID);
  assert.deepEqual(cell.rect, { x: 170, y: 50, w: 100, h: 100 });
});