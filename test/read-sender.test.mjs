import { test } from "node:test";
import assert from "node:assert/strict";

import { messagesFromOcr, mergeBubbles } from "../src/monitor/read.ts";

const W = 1080;

/** 一行 OCR。默认按「气泡正文」的尺寸（h=42、靠左），昵称行自己传小字号 */
function line(text, { x = 180, y = 0, w = 600, h = 42 } = {}) {
  return { text, x, y, w, h };
}

/** 群里的昵称行：小字、靠左 */
function nick(text, y) {
  return line(text, { x: 120, y, w: 220, h: 26 });
}

test("群聊：昵称行要归属给下面那条消息", () => {
  const lines = [
    nick("阿蓝", 100),
    line("开始思考怎么配装备", { y: 140 }),
    nick("阿瓜", 220),
    line("自刎归天！", { y: 260, w: 300 }),
  ];
  const msgs = mergeBubbles(messagesFromOcr(lines, { width: W, group: true, minHeight: 20 }));
  assert.equal(msgs.length, 2, `应该解析出 2 条消息，实际 ${msgs.length}`);
  assert.equal(msgs[0].text, "开始思考怎么配装备");
  assert.equal(msgs[0].sender, "阿蓝", "第一条要挂在阿蓝名下");
  assert.equal(msgs[1].text, "自刎归天！");
  assert.equal(msgs[1].sender, "阿瓜", "第二条要挂在阿瓜名下");
});

test("群聊：同一个人连发两条时，昵称只出现一次也能继承", () => {
  const lines = [
    nick("阿蓝", 100),
    line("第一句", { y: 140 }),
    line("第二句", { y: 220 }),
  ];
  const msgs = mergeBubbles(messagesFromOcr(lines, { width: W, group: true, minHeight: 20 }));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].sender, "阿蓝");
  assert.equal(msgs[1].sender, "阿蓝");
});

test("群聊：自己发的消息不继承上一个人的名字", () => {
  const lines = [
    nick("阿蓝", 100),
    line("他说的话", { y: 140 }),
    // 绿色气泡靠右 -> 我发的（没有昵称行）
    line("我接一句", { y: 220, x: 600, w: 400 }),
  ];
  const msgs = mergeBubbles(messagesFromOcr(lines, { width: W, group: true, minHeight: 20 }));
  const mine = msgs.find((m) => m.from === "me");
  assert.ok(mine, "应该认出那条是我发的");
  assert.equal(mine.sender, undefined, "自己发的消息不能带别人的名字");
});

test("私聊：不认昵称行（私聊里没有发送者昵称）", () => {
  const lines = [
    line("小字一句", { x: 120, y: 100, w: 220, h: 26 }),
    line("正常消息", { y: 140 }),
  ];
  const msgs = mergeBubbles(messagesFromOcr(lines, { width: W, minHeight: 20 }));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].sender, undefined);
});

test("群聊：时间戳行不会被当成昵称", () => {
  const lines = [
    line("下午3:09", { x: 120, y: 90, w: 200, h: 26 }),
    line("消息正文", { y: 150 }),
  ];
  const msgs = mergeBubbles(messagesFromOcr(lines, { width: W, group: true, minHeight: 20 }));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, "消息正文");
  assert.equal(msgs[0].sender, undefined, "时间戳不能被当成发送者");
});