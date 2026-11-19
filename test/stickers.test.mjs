import { test } from "node:test";
import assert from "node:assert/strict";

import { StickerLibrary, fingerprint } from "../src/stickers/library.ts";
import { parseLabel } from "../src/stickers/labeler.ts";
import { colorHist, dhash } from "../src/image/image.ts";

function art(w, h, painter) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = painter(x, y);
      const p = (y * w + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function entryArt(kind) {
  if (kind === "blue") return art(80, 120, (x, y) => [40, (x + y) % 120, 200]);
  if (kind === "red") return art(80, 120, (x, y) => [220, (x * 2) % 80, 40]);
  return art(80, 120, (x, y) => [240, 240, 240 - (y % 40)]);
}

function add(lib, kind, mood, funny) {
  const bmp = entryArt(kind);
  return lib.upsert({ dhash: dhash(bmp), hist: colorHist(bmp), mood, tags: [mood], funny, source: "panel" });
}

test("库：upsert 同图不重复，标签可更新", () => {
  const lib = new StickerLibrary();
  const a = add(lib, "blue", "开心", 0.8);
  const b = add(lib, "blue", "无语", 0.9);
  assert.equal(lib.size, 1, "同一张图只存一条");
  assert.equal(b.id, a.id);
  assert.equal(b.mood, "无语", "再次 upsert 更新情绪");
  assert.equal(b.funny, 0.9);
});

test("库：按内容找到同一张（缩放后也能找到）", () => {
  const lib = new StickerLibrary();
  const src = entryArt("blue");
  const e = lib.upsert({ dhash: dhash(src), hist: colorHist(src), mood: "开心", tags: [], funny: 0.7, source: "panel" });
  const bigger = art(160, 240, (x, y) => src.data[((Math.floor(y / 2) * 80) + Math.floor(x / 2)) * 4] !== undefined
    ? [src.data[((Math.floor(y / 2) * 80) + Math.floor(x / 2)) * 4], src.data[((Math.floor(y / 2) * 80) + Math.floor(x / 2)) * 4 + 1], src.data[((Math.floor(y / 2) * 80) + Math.floor(x / 2)) * 4 + 2]]
    : [0, 0, 0]);
  const found = lib.find(bigger);
  assert.ok(found, "放大后应仍能找到");
  assert.equal(found.id, e.id);
});

test("库：按情绪挑，最近发过的先不用", () => {
  const lib = new StickerLibrary();
  const a = add(lib, "blue", "开心", 0.9);
  const b = add(lib, "red", "开心", 0.8);
  add(lib, "white", "无语", 0.95);

  const first = lib.pick("开心");
  assert.ok(first, "应挑出一张");
  assert.equal(first.funny, 0.9, "先挑好玩的");

  lib.markSent(first);
  const second = lib.pick("开心");
  assert.notEqual(second.id, first.id, "刚发过的换一张");

  // 只有一张时，允许重复
  const lib2 = new StickerLibrary();
  const only = add(lib2, "blue", "开心", 0.9);
  lib2.markSent(only);
  assert.equal(lib2.pick("开心").id, only.id);
});

test("库：没有该情绪时退回全部，不返回 null", () => {
  const lib = new StickerLibrary();
  add(lib, "blue", "开心", 0.5);
  const picked = lib.pick("嘲讽");
  assert.ok(picked);
});

test("库：空库 pick 返回 null", () => {
  assert.equal(new StickerLibrary().pick("开心"), null);
});

test("库：持久化后能读回来", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "stickers-")), "index.json");
  const lib = new StickerLibrary(file);
  add(lib, "blue", "开心", 0.7);
  lib.save();

  const lib2 = new StickerLibrary(file);
  lib2.load();
  assert.equal(lib2.size, 1);
  assert.equal(lib2.list()[0].mood, "开心");
});

test("标签解析：合法 JSON / 套代码块 / 越界情绪 / 坏输出", () => {
  assert.deepEqual(parseLabel('{"mood":"开心","tags":["打招呼","卖萌"],"funny":0.8}'), {
    mood: "开心",
    tags: ["打招呼", "卖萌"],
    funny: 0.8,
    raw: '{"mood":"开心","tags":["打招呼","卖萌"],"funny":0.8}',
  });

  const fenced = parseLabel('```json\n{"mood":"无语","tags":[],"funny":0.2}\n```');
  assert.equal(fenced.mood, "无语");
  assert.equal(fenced.funny, 0.2);

  const badMood = parseLabel('{"mood":"暴躁","tags":["x"],"funny":5}');
  assert.equal(badMood.mood, "其他", "不在情绪表里的降级为其他");
  assert.equal(badMood.funny, 1, "评分夹到 0..1");

  const garbage = parseLabel("我觉得挺可爱的");
  assert.equal(garbage.mood, "其他");
  assert.deepEqual(garbage.tags, []);
  assert.equal(garbage.funny, 0.5);
});

test("fingerprint：不同图不同 id，同一图稳定", () => {
  const a = { dhash: "0f0f0f0f0f0f0f0f", hist: [0.5, 0.2, 0.1] };
  assert.equal(fingerprint(a.dhash, a.hist), fingerprint(a.dhash, a.hist));
  assert.notEqual(fingerprint(a.dhash, a.hist), fingerprint("f0f0f0f0f0f0f0f0", a.hist));
});
// 2026-11-19：findByFeatures 以前是「先挑直方图最高的那张，再拿它的 dHash 复核」——
// 只要库里有一张别的高分但 dHash 对不上的贴纸挡在前面，真正那张就永远认不出来，
// 于是同一张贴纸被反复当成新的收进来（用户看到的就是「库里重复收藏」）。
test("认图：高分但 dHash 对不上的条目不能把真正那张挡住", () => {
  const lib = new StickerLibrary();
  // A：直方图和输入完全一致，但 dHash 差 63 位（其实是另一张黑白梗图）
  lib.upsert({
    dhash: "ffffffffffffffff",
    hist: [1, ...Array(63).fill(0)],
    mood: "嘲讽",
    tags: [],
    funny: 0.8,
    source: "received",
  });
  // B：直方图 0.965，dHash 只差 1 位（这才是同一张）
  lib.upsert({
    dhash: "0000000000000000",
    hist: [0.965, Math.sqrt(1 - 0.965 * 0.965), ...Array(62).fill(0)],
    mood: "无语",
    tags: [],
    funny: 0.6,
    source: "received",
  });
  const hit = lib.findByFeatures([1, ...Array(63).fill(0)], "0000000000000001");
  assert.equal(hit?.mood, "无语");
});

test("认图：dHash 都在范围内时还是取直方图最像的", () => {
  const lib = new StickerLibrary();
  lib.upsert({ dhash: "0000000000000002", hist: [0.97, 0.243, ...Array(62).fill(0)], mood: "开心", tags: [], funny: 0.5, source: "received" });
  lib.upsert({ dhash: "0000000000000001", hist: [0.99, 0.141, ...Array(62).fill(0)], mood: "嘲讽", tags: [], funny: 0.5, source: "received" });
  const hit = lib.findByFeatures([1, ...Array(63).fill(0)], "0000000000000000");
  assert.equal(hit?.mood, "嘲讽");
});
