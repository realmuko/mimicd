/**
 * 稳定帧复用（T3）与滑动停稳（T2）。
 *
 * 这里的重点不是「能跑」，而是两条真机结论：
 *  1. waitStable 拍到的帧就是调用方接下来要用的那一帧（lastFrame / lastPng），别为了 OCR 再拍一张；
 *  2. 判「滚停没停」只能看静区（标题栏/输入栏）——这台机器聊天页的动图一直在播，整帧永远不稳。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { waitScrollSettle, waitStable } from "../src/perception/stable.ts";
import { encode } from "../src/image/image.ts";

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

const W = 200;
const H = 400;
/** 静区：标题栏 + 输入栏；脏区：消息区 */
const HEADER = { x: 0, y: 0, w: W, h: 40 };
const INPUT = { x: 0, y: H - 40, w: W, h: 40 };
const MESSAGE = { x: 0, y: 60, w: W, h: H - 120 };

/** 假设备：按顺序吐帧，用完停在最后一帧（和真机「画面不再变」一致）。 */
function makeAdb(frames, opts = {}) {
  let i = 0;
  const adb = {
    shots: 0,
    async screencap() {
      const bmp = frames[Math.min(i++, frames.length - 1)];
      adb.shots++;
      const frame = { png: encode(bmp), width: bmp.width, height: bmp.height, ms: 1 };
      // 一半用例走「Adb 顺手解好的 bmp」，一半走「假设备没填 bmp 的退回路径」
      return opts.withBmp ? { ...frame, bmp } : frame;
    },
  };
  return adb;
}

function frameWith(messageColor) {
  const bmp = blank(W, H, [237, 237, 237]);
  fill(bmp, HEADER, [255, 255, 255]);
  fill(bmp, INPUT, [250, 250, 250]);
  fill(bmp, MESSAGE, messageColor);
  return bmp;
}

test("waitStable：把稳定帧交回来（lastFrame + lastPng 是同一帧）", async () => {
  const a = frameWith([10, 10, 10]);
  const b = frameWith([10, 10, 10]);
  const adb = makeAdb([a, b, b, b]);
  const r = await waitStable(adb, { frames: 2, intervalMs: 1, timeoutMs: 500 });
  assert.equal(r.stable, true);
  assert.ok(r.lastFrame, "必须带稳定帧，调用方用它做像素判断");
  assert.ok(Buffer.isBuffer(r.lastPng), "必须带 PNG，调用方直接喂 OCR，不用再截图");
  assert.deepEqual([r.lastFrame.width, r.lastFrame.height], [W, H]);
  // 最后一帧就是交回来的那一帧（而不是第一帧）
  assert.deepEqual([...r.lastFrame.data.subarray(0, 4)], [...b.data.subarray(0, 4)]);
});

test("waitStable：Adb 已经解好的 bmp 直接用，不再解第二遍", async () => {
  const same = frameWith([30, 200, 30]);
  const adb = makeAdb([same, same, same], { withBmp: true });
  const r = await waitStable(adb, { frames: 2, intervalMs: 1, timeoutMs: 500 });
  assert.equal(r.stable, true);
  assert.equal(r.lastFrame, same, "frame.bmp 是现成的，lastFrame 应该就是它（同一个对象）");
});

test("waitStable：一直不稳也要把最后一帧交回来（超时也得出图）", async () => {
  const frames = [];
  for (let i = 0; i < 10; i++) frames.push(frameWith([i * 20, 0, 0]));
  const adb = makeAdb(frames);
  const r = await waitStable(adb, { frames: 2, intervalMs: 1, timeoutMs: 30 });
  assert.equal(r.stable, false);
  assert.ok(r.lastFrame && Buffer.isBuffer(r.lastPng));
  assert.ok(r.ratio > 0.002);
});

test("waitScrollSettle：静区一致就算停（消息区的动图/新消息不影响）", async () => {
  // 消息区每帧都在变（动图），标题栏和输入栏不变
  const frames = [frameWith([0, 0, 0]), frameWith([90, 0, 0]), frameWith([180, 0, 0])];
  const adb = makeAdb(frames);
  const r = await waitScrollSettle(adb, {
    regions: [HEADER, INPUT],
    frames: 2,
    intervalMs: 1,
    timeoutMs: 300,
  });
  assert.equal(r.settled, true, "只看静区，不能被动图拖到超时");
  assert.ok(r.ratio < 0.002);
  assert.ok(r.lastFrame && Buffer.isBuffer(r.lastPng));
});

test("waitScrollSettle：还在滚（标题栏在变）就等到超时，返回 settled:false", async () => {
  const frames = [];
  for (let i = 0; i < 40; i++) {
    const bmp = blank(W, H, [237, 237, 237]);
    fill(bmp, HEADER, [Math.min(255, i * 20), Math.min(255, i * 20), Math.min(255, i * 20)]); // 标题栏一直在动 = 还在滚
    fill(bmp, INPUT, [250, 250, 250]);
    frames.push(bmp);
  }
  const adb = makeAdb(frames);
  const r = await waitScrollSettle(adb, { regions: [HEADER, INPUT], frames: 2, intervalMs: 1, timeoutMs: 25 });
  assert.equal(r.settled, false);
  assert.ok(r.ratio > 0.002);
});

test("waitScrollSettle：连续两帧一致就返回（不白等）", async () => {
  const same = frameWith([50, 50, 50]);
  const adb = makeAdb([same, same, same, same]);
  const r = await waitScrollSettle(adb, { regions: [HEADER, INPUT], frames: 2, intervalMs: 1, timeoutMs: 1000 });
  assert.equal(r.settled, true);
  assert.equal(r.samples, 2, "两帧一致即停，多采一帧都是浪费");
});
test("waitStable：每次采样都先作废截图复用窗口（否则一上来就假稳定）", async () => {
  // 模拟「Adb 开了 captureReuseMs」：不作废就永远返回同一帧
  const frames = [frameWith([0, 0, 0]), frameWith([120, 0, 0]), frameWith([200, 0, 0])];
  let cursor = 0;
  const adb = {
    invalidated: 0,
    invalidateFrame() {
      this.invalidated++;
    },
    async screencap() {
      const bmp = frames[Math.min(cursor++, frames.length - 1)];
      return { png: encode(bmp), width: W, height: H, ms: 1 };
    },
  };
  const r = await waitStable(adb, { frames: 2, intervalMs: 1, timeoutMs: 20 });
  assert.equal(r.stable, false, "画面每帧都在变，不能被复用窗口骗成稳定");
  assert.ok(adb.invalidated >= r.samples, `每次采样前都该作废（采样 ${r.samples} 次，作废 ${adb.invalidated} 次）`);
});

test("waitScrollSettle：同样每次采样先作废复用窗口", async () => {
  const same = frameWith([50, 50, 50]);
  const adb = {
    invalidated: 0,
    invalidateFrame() {
      this.invalidated++;
    },
    async screencap() {
      return { png: encode(same), width: W, height: H, ms: 1 };
    },
  };
  const r = await waitScrollSettle(adb, { regions: [HEADER, INPUT], frames: 2, intervalMs: 1, timeoutMs: 50 });
  assert.equal(r.settled, true);
  assert.equal(adb.invalidated, r.samples);
});
