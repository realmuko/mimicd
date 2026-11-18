import { test } from "node:test";
import assert from "node:assert/strict";

import { detectPage } from "../src/perception/page.ts";

// ---------- 造图：只画页面判定关心的那几块像素 ----------

const W = 1080;
const H = 2160;
const BG = 237; // 微信列表/会话底色

const focus = {
  pkg: "com.tencent.mm",
  activity: "com.tencent.mm.ui.LauncherUI",
  component: "com.tencent.mm/.ui.LauncherUI",
};

function frame() {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = BG;
    data[i * 4 + 1] = BG;
    data[i * 4 + 2] = BG;
    data[i * 4 + 3] = 255;
  }
  return { width: W, height: H, data };
}

function fill(bmp, x, y, w, h, v) {
  const x1 = Math.min(W, Math.round(x + w));
  const y1 = Math.min(H, Math.round(y + h));
  for (let yy = Math.max(0, Math.round(y)); yy < y1; yy++) {
    for (let xx = Math.max(0, Math.round(x)); xx < x1; xx++) {
      const p = (yy * W + xx) * 4;
      bmp.data[p] = v;
      bmp.data[p + 1] = v;
      bmp.data[p + 2] = v;
      bmp.data[p + 3] = 255;
    }
  }
}

/** 底部四簇图标：tab 栏采样带（y 0.945–0.973） */
function drawTabClusters(bmp, value = 60) {
  for (let i = 0; i < 4; i++) {
    fill(bmp, W * (0.06 + i * 0.25), H * 0.945, W * 0.13, H * 0.028, value);
  }
}

/**
 * 白盒输入栏。真机实测：上半截 255，下半截 247（微信输入框有轻微渐变），
 * 整条铺在 y 0.952–0.987。
 */
function drawInputBar(bmp) {
  fill(bmp, W * 0.14, H * 0.952, W * 0.55, H * 0.013, 255);
  fill(bmp, W * 0.14, H * 0.965, W * 0.55, H * 0.022, 247);
}

/**
 * 输入框里有草稿：语音图标 / 文字 / 表情按钮 / 发送按钮，四簇墨迹落进 tab 采样带。
 * 真机上文字压在输入框偏下的位置（实测 y≈0.968 起），所以采样带 0.952–0.965 是干净的。
 */
function drawDraftMarks(bmp) {
  for (let i = 0; i < 4; i++) {
    fill(bmp, W * (0.06 + i * 0.25), H * 0.968, W * 0.13, H * 0.017, 30);
  }
}

/** ADBKeyboard 的「{ON}」状态条：切过输入法后会常驻在屏幕最底下 */
function drawAdbKeyboardBar(bmp) {
  fill(bmp, 0, H - 33, W, 33, 87);
}

// ---------- 会话页 ----------

test("会话页：输入框里有草稿时不能被判成列表页", () => {
  const bmp = frame();
  drawInputBar(bmp);
  drawDraftMarks(bmp);
  const g = detectPage(bmp, focus);
  assert.equal(g.page, "chat", `有草稿的会话页被判成 ${g.page}（${g.reason}）`);
});

test("会话页：空输入框仍然判 chat", () => {
  const bmp = frame();
  drawInputBar(bmp);
  const g = detectPage(bmp, focus);
  assert.equal(g.page, "chat", `空输入框的会话页被判成 ${g.page}（${g.reason}）`);
});

test("会话页：底部压着 ADB Keyboard 状态条时仍然判 chat", () => {
  const bmp = frame();
  drawInputBar(bmp);
  drawDraftMarks(bmp);
  drawAdbKeyboardBar(bmp);
  const g = detectPage(bmp, focus);
  assert.equal(g.page, "chat", `带 ADBKeyboard 状态条的会话页被判成 ${g.page}（${g.reason}）`);
});

// ---------- 列表页 ----------

test("列表页：没有输入框 + 四簇 tab 判 list", () => {
  const bmp = frame();
  drawTabClusters(bmp);
  const g = detectPage(bmp, focus);
  assert.equal(g.page, "list", `列表页被判成 ${g.page}（${g.reason}）`);
});

test("列表页：底部压着 ADB Keyboard 状态条时仍然判 list", () => {
  const bmp = frame();
  drawTabClusters(bmp);
  drawAdbKeyboardBar(bmp);
  const g = detectPage(bmp, focus);
  assert.equal(g.page, "list", `带 ADBKeyboard 状态条的列表页被判成 ${g.page}（${g.reason}）`);
});

// ---------- 误判防线 ----------

test("表情墙（表情铺到底、底部不亮）不能被判成列表页", () => {
  const bmp = frame();
  // 表情网格一直在播，四簇位置有内容，但整条铺到底、底部是彩色的深色
  fill(bmp, 0, H * 0.90, W, H * 0.10, 120);
  drawTabClusters(bmp, 40);
  const g = detectPage(bmp, focus);
  assert.notEqual(g.page, "list", `表情墙被判成列表页（${g.reason}）`);
});