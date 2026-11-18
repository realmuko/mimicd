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

test("标题核对：归一化后短于 4 个字的名字必须完全相等（「阿鲤」不能匹配「钓鱼群」）", () => {
  assert.equal(titleMatches("阿鲤", "钓鱼群(23)"), false, "短名不能靠包含关系混过去");
  assert.equal(titleMatches("阿鲤", "鱼"), true, "完全相等还是认的");
  assert.equal(titleMatches("钓鱼群", "钓鱼群(23)"), true, "够长的名字仍可以包含");
  assert.equal(titleMatches("群", "周末爬山小分队(50)"), false);
  assert.equal(titleMatches("摸鱼闲聊群", "摸鱼闲聊群(23)"), true);
});

test("标题栏取标题：把区域里所有行拼起来（私聊「对方正在输入…」不再挤掉名字）", () => {
  const lines = [
    { text: "12:30", x: 0, y: 0, w: 40, h: 20 },
    { text: "张三", x: 400, y: 90, w: 100, h: 40 },
    // 私聊里对方正在打字时，标题栏会多出这一行；以前「取最长的一条」会选中它
    { text: "对方正在输入…", x: 400, y: 120, w: 260, h: 30 },
  ];
  const title = titleFromOcr(lines);
  assert.equal(title, "张三", "占位行不是标题：拼起来时要丢掉，否则短名核对永远失败");
  assert.equal(titleMatches("张三", title), true);
  assert.equal(titleFromOcr([]), "");
  assert.equal(titleFromOcr([{ text: "12:30", x: 0, y: 0, w: 40, h: 20 }]), "", "只有时间等于没读到标题");
});

test("标题栏取标题：名字被 OCR 拆成两行也能拼回去核对", () => {
  const lines = [
    { text: "摸鱼翘嘴软饭", x: 300, y: 90, w: 300, h: 40 },
    { text: "群 (23)", x: 600, y: 92, w: 160, h: 36 },
  ];
  const title = titleFromOcr(lines);
  assert.equal(title, "摸鱼翘嘴软饭 群 (23)");
  assert.equal(titleMatches("摸鱼闲聊群", title), true, "拼起来 + 归一化之后应该对上");
});

test("@ 检测：@昵称 与「有人@我」都算", () => {
  assert.equal(mentionsMe("@阿鲤 在吗", ["阿鲤"]), true);
  assert.equal(mentionsMe("@ 阿鲤 在吗", ["阿鲤"]), true);
  assert.equal(mentionsMe("有人@我", []), true);
  assert.equal(mentionsMe("@张三 在吗", ["阿鲤"]), false);
  assert.equal(mentionsMe("在吗", ["阿鲤"]), false);
  assert.equal(mentionsMe("@阿鲤", []), false, "没有昵称配置时不能瞎认");
});