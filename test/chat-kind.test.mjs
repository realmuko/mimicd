import { test } from "node:test";
import assert from "node:assert/strict";

import { detectChatKind, mentionsMe, normalizeTitle, titleFromOcr, titleMatches } from "../src/monitor/chat.ts";

test("群/私聊：标题带成员数才是群", () => {
  assert.equal(detectChatKind("摸鱼闲聊群(23)"), "group");
  assert.equal(detectChatKind("家庭群（5）"), "group");
  assert.equal(detectChatKind("阿杰"), "dm");
  assert.equal(detectChatKind("文件传输助手"), "dm");
  assert.equal(detectChatKind(""), "unknown");
  // 「(23)」不在结尾的不算（可能是名字本身）
  assert.equal(detectChatKind("(23)号楼"), "dm");
});

test("归一化与标题核对：包含关系即可，容忍成员数", () => {
  assert.equal(normalizeTitle("摸鱼闲聊群(23)"), "摸鱼闲聊群");
  assert.equal(normalizeTitle(" 张三 "), "张三");
  assert.equal(titleMatches("摸鱼闲聊群", "摸鱼闲聊群(23)"), true);
  assert.equal(titleMatches("张三", "张三"), true);
  assert.equal(titleMatches("张三", "李四"), false);
  assert.equal(titleMatches("", "张三"), false);
});

test("标题栏取标题：取最长的一条，忽略时间", () => {
  const lines = [
    { text: "12:30", x: 0, y: 0, w: 40, h: 20 },
    { text: "阿杰", x: 400, y: 100, w: 100, h: 40 },
  ];
  assert.equal(titleFromOcr(lines), "阿杰");
  assert.equal(titleFromOcr([]), "");
});

test("@ 检测：@昵称 与「有人@我」都算", () => {
  assert.equal(mentionsMe("@阿鲤 在吗", ["阿鲤"]), true);
  assert.equal(mentionsMe("@ 阿鲤 在吗", ["阿鲤"]), true);
  assert.equal(mentionsMe("有人@我", []), true);
  assert.equal(mentionsMe("@张三 在吗", ["阿鲤"]), false);
  assert.equal(mentionsMe("在吗", ["阿鲤"]), false);
  assert.equal(mentionsMe("@阿鲤", []), false, "没有昵称配置时不能瞎认");
});