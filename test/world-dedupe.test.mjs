import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { World, looksSameText } from "../src/world/state.ts";

const T0 = new Date(2026, 10, 18, 12, 0, 0).getTime();

function msg(text, from = "other", y = 500, sender) {
  return { text, from, y, source: "ocr", ...(sender ? { sender } : {}) };
}

test("去重：id 稳定，不含读取时间 —— 同一句话隔多久读都是同一条", () => {
  const a = new World();
  const b = new World();
  const [m1] = a.ingest("张三", [msg("在吗")], T0);
  const [m2] = b.ingest("张三", [msg("在吗")], T0 + 24 * 60 * 60 * 1000);
  assert.equal(m1.id, m2.id, "同一条消息在隔一天读到也必须是同一个 id");
  assert.doesNotMatch(m1.id, /\d{13}/, "id 里不能掺时间戳");

  // 同一世界隔一分钟重读：不算新
  assert.equal(a.ingest("张三", [msg("在吗")], T0 + 60_000).length, 0);
});

test("去重：窗口 30 分钟（原来 120 秒），窗口外的旧消息才会重新算新", () => {
  const w = new World();
  assert.equal(w.ingest("张三", [msg("在吗")], T0).length, 1);
  // 29 分钟内重读：同一条
  assert.equal(w.ingest("张三", [msg("在吗")], T0 + 29 * 60_000).length, 0);
  // 一直没人再读它、超过 30 分钟：窗口过期，允许重新算一条（避免永久卡死）
  const later = new World();
  assert.equal(later.ingest("张三", [msg("在吗")], T0).length, 1);
  assert.equal(later.ingest("张三", [msg("在吗")], T0 + 31 * 60_000).length, 1);
});

test("去重：同一条消息在不同位置（新消息）仍然算新的", () => {
  const w = new World();
  w.ingest("群", [msg("哈哈", "other", 300)], T0);
  const added = w.ingest("群", [msg("哈哈", "other", 300), msg("哈哈", "other", 900)], T0 + 1000);
  assert.equal(added.length, 1);
  assert.equal(added[0].y, 900);
});

test("模糊匹配：OCR 读歪一两个字算同一条，短句不启用", () => {
  assert.equal(looksSameText("今天下午一起去吃饭吧", "今天下午一起吃饭吧"), true);
  assert.equal(looksSameText("今天下午一起去吃饭吧", "明天上午一起去看电影吧"), false);
  // 短句差一个字就是另一个意思，不启用模糊
  assert.equal(looksSameText("好的", "好滴"), false);
  assert.equal(looksSameText("哈哈", "哈哈"), false);

  const w = new World();
  assert.equal(w.ingest("张三", [msg("今天下午一起去吃饭吧")], T0).length, 1);
  assert.equal(w.ingest("张三", [msg("今天下午一起吃饭吧")], T0 + 5000).length, 0, "读歪一字的同一条不该再触发");
  // 但短句读歪算新消息
  assert.equal(w.ingest("张三", [msg("好的")], T0 + 6000).length, 1);
  assert.equal(w.ingest("张三", [msg("好滴")], T0 + 7000).length, 1);
});

test("模糊匹配：不同发送者的同一句话不能互相抵消", () => {
  const w = new World();
  w.ingest("群", [msg("今天下午一起去吃饭吧", "other", 300, "小明")], T0);
  const added = w.ingest("群", [msg("今天下午一起去吃饭吧", "other", 900, "小红")], T0 + 5000);
  assert.equal(added.length, 1, "群里两个人说了同样的话，第二条是新的");
});

test("去重：同一屏两条一模一样的长消息，位置不同也算两条", () => {
  const w = new World();
  const added = w.ingest("群", [
    msg("今天下午一起去吃饭吧", "other", 300, "小明"),
    msg("今天下午一起去吃饭吧", "other", 900, "小明"),
  ]);
  assert.equal(added.length, 2, "同一屏两个位置各一条，不能合并成一条");
  assert.notEqual(added[0].id, added[1].id);
});

test("去重：dm 升成群后，同一屏重新读到（现在带 sender）不算新消息", () => {
  const w = new World();
  w.ingest(
    "某个群",
    [msg("今天谁做饭我来做吧", "other", 300), msg("那我去买菜", "other", 400)],
    T0,
  );
  // 下一拍正文读到昵称、同时判成群：整屏老消息不能因为多了 sender 就再算一遍新的
  const again = w.ingest(
    "某个群",
    [msg("今天谁做饭我来做吧", "other", 300, "小明"), msg("那我去买菜", "other", 400, "小红")],
    T0 + 20_000,
  );
  assert.equal(again.length, 0, "dm→group 升级不能把整屏老消息当成新消息");
  assert.equal(w.chat("某个群").kind, "group");
});

test("发言时刻快照：回复前就在屏幕上的消息被重新读到，不算新消息", () => {
  // 关掉多重集窗口，单独验证「发言时刻快照」这一层
  const w = new World({ dedupeWindowMs: 0 });
  w.ingest("群", [msg("今天谁做饭呢我来做吧", "other", 300, "小明")], T0);
  w.markReplied("群", undefined, T0);

  // 同一句被读歪（预算层已经关了），快照层必须认出来
  const old = w.ingest("群", [msg("今天谁做饭我来做吧", "other", 300, "小明")], T0 + 5000);
  assert.equal(old.length, 0, "回复前就在屏幕上的旧消息不能再回一遍");

  // 真正的新消息要放行
  const freshMsg = w.ingest("群", [msg("那我去买菜了", "other", 600, "小红")], T0 + 6000);
  assert.deepEqual(freshMsg.map((m) => m.text), ["那我去买菜了"]);
});

test("发言时刻快照：自己刚说的被读成「对方」时不算新消息", () => {
  const w = new World();
  w.ingest("张三", [msg("在吗")], T0);
  w.markReplied("张三", undefined, T0, "在的，怎么啦");

  const misread = w.ingest("张三", [msg("在的，怎么啦", "other", 900)], T0 + 10_000);
  assert.equal(misread.length, 0, "自己刚发出去的话被 OCR 读成对方的，不能对着自己回");

  // 绿色气泡识别正常（from=me）时，正常进世界
  const asMe = w.ingest("张三", [msg("在的，怎么啦", "me", 900)], T0 + 20_000);
  assert.equal(asMe.length, 1);
  assert.equal(asMe[0].from, "me");
});

test("判群：patch 只升不降，显式 force 才能降级", () => {
  const w = new World();
  w.patch("某个群", { kind: "dm" });
  assert.equal(w.chat("某个群").kind, "dm", "dm → dm 正常");
  w.patch("某个群", { kind: "group" });
  assert.equal(w.chat("某个群").kind, "group", "dm → group 允许升级");

  // 每拍都会重新判类型；标题 OCR 丢了「(23)」时不能把群降成私聊（旧插件头条教训）
  w.patch("某个群", { kind: "dm" });
  assert.equal(w.chat("某个群").kind, "group", "group 不能被一次误判降级");
  w.patch("某个群", { kind: "unknown" });
  assert.equal(w.chat("某个群").kind, "group", "降成 unknown 也不行");

  w.patch("某个群", { kind: "dm" }, { force: true });
  assert.equal(w.chat("某个群").kind, "dm", "人工纠错可以显式 force");
});

test("判群：一次 ingest 出现 ≥2 个不同发送者就是群（不依赖标题）", () => {
  const w = new World();
  w.patch("某个群", { kind: "dm" });
  w.ingest(
    "某个群",
    [msg("今天谁做饭", "other", 300, "小明"), msg("我来做吧", "other", 400, "小红")],
    T0,
  );
  assert.equal(w.chat("某个群").kind, "group");

  const single = new World();
  single.patch("某个人", { kind: "dm" });
  single.ingest("某个人", [msg("在吗", "other", 300, "张三")], T0);
  assert.equal(single.chat("某个人").kind, "dm", "只有一个发送者不能判成群");

  assert.equal(w.noteGroupEvidence("另一个", ["a", "b"]), true);
  assert.equal(w.noteGroupEvidence("另一个", ["a"]), false);
});

test("待补发队列：按 id 幂等入队，take 取走后清空", () => {
  const w = new World();
  const [m1] = w.ingest("张三", [msg("第一句")], T0);
  const [m2] = w.ingest("张三", [msg("第二句")], T0 + 1000);

  assert.equal(w.queueUnsent("张三", [m1, m2]), 2);
  assert.equal(w.queueUnsent("张三", [m2]), 2, "重复入队不能翻倍");
  assert.equal(w.peekUnsent("张三").length, 2);
  assert.equal(w.chat("张三").unsent.length, 2);

  const taken = w.takeUnsent("张三");
  assert.deepEqual(taken.map((m) => m.text), ["第一句", "第二句"]);
  assert.equal(w.peekUnsent("张三").length, 0, "取走后队列清空");
  assert.equal(w.takeUnsent("张三").length, 0);

  // 巡场用：还有哪个会话欠着消息（红点没了也要回去补）
  assert.deepEqual(w.listUnsent(), []);
  const [m3] = w.ingest("李四", [msg("第三句")], T0 + 2000);
  w.queueUnsent("张三", [m1, m2]);
  w.queueUnsent("李四", [m3]);
  const owed = w.listUnsent();
  assert.equal(owed.length, 2);
  assert.equal(owed.find((o) => o.name === "张三")?.count, 2);
  assert.equal(owed.find((o) => o.name === "李四")?.count, 1);
});

test("待补发队列：持久化后能读回来", () => {
  const dir = mkdtempSync(join(tmpdir(), "world-unsent-"));
  const file = join(dir, "world.json");
  const w = new World({ file });
  const [m] = w.ingest("张三", [msg("在吗")], T0);
  w.queueUnsent("张三", [m]);
  w.save();

  const w2 = new World({ file });
  w2.load();
  assert.equal(w2.peekUnsent("张三").length, 1);
  assert.equal(w2.peekUnsent("张三")[0].id, m.id, "id 稳定，跨重启也能对上");
});