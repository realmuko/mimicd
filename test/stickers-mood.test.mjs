import { test } from "node:test";
import assert from "node:assert/strict";

import { inferMood } from "../src/stickers/mood.ts";

test("兜底猜情绪：笑的 → 开心", () => {
  assert.equal(inferMood("笑死我了"), "开心");
  assert.equal(inferMood("哈哈，这也行"), "开心");
});

test("兜底猜情绪：阴阳怪气 → 嘲讽", () => {
  assert.equal(inferMood("你说得对，就这"), "嘲讽");
});

test("兜底猜情绪：离谱 → 惊讶", () => {
  assert.equal(inferMood("真的假的，这也太离谱"), "惊讶");
});

test("兜底猜情绪：亲昵", () => {
  assert.equal(inferMood("抱抱"), "亲昵");
});

test("兜底猜情绪：委屈", () => {
  assert.equal(inferMood("怪我咯"), "委屈");
});

test("兜底猜情绪：认不出来给万金油，别返回空", () => {
  assert.equal(inferMood("GTA首发只有主机，上Steam还得再等一年"), "无语");
  assert.equal(inferMood(""), "无语");
  assert.equal(inferMood(undefined), "无语");
});

test("兜底猜情绪：顺序稳定（笑优先于嘲讽）", () => {
  // 一句里既能命中「笑死」也能命中「就这」时，不能来回抖
  assert.equal(inferMood("就这？笑死"), "开心");
});