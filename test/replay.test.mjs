import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 直接 import 工具里的纯函数（不会执行 CLI：CLI 在模块顶层读 argv，所以这里用子进程方式测）
import { execFileSync } from "node:child_process";

function makeRun() {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const file = join(dir, "run.jsonl");
  const base = { v: 1, run: "r-test", src: "test" };
  const lines = [
    { ...base, seq: 1, id: "r-test:1", t: 1, mono: 100, kind: "frame.captured", data: { tag: "list", rows: ["张三"], unreadRows: 1 } },
    { ...base, seq: 2, id: "r-test:2", t: 2, mono: 350, kind: "message.seen", data: { chat: "张三", text: "在吗", from: "other" } },
    { ...base, seq: 3, id: "r-test:3", t: 3, mono: 400, kind: "intent.decided", data: { chat: "张三", reply: true, reason: "可以回" } },
    { ...base, seq: 4, id: "r-test:4", t: 4, mono: 900, kind: "send.succeeded", data: { chat: "张三", text: "在的" } },
    { ...base, seq: 5, id: "r-test:5", t: 5, mono: 1000, kind: "send.failed", data: { chat: "张三", text: "x", reason: "boom" } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

function runReplay(args) {
  try {
    return execFileSync(process.execPath, ["tools/replay.ts", ...args], { encoding: "utf8" });
  } catch (err) {
    return String(err.stdout ?? "") + String(err.stderr ?? "");
  }
}

test("replay：时间线带相对毫秒与关键字段", () => {
  const file = makeRun();
  const out = runReplay([file]);
  assert.match(out, /\+ +0ms frame\.captured/);
  assert.match(out, /message\.seen/);
  assert.match(out, /chat="张三"/);
});

test("replay：按 kind 过滤", () => {
  const file = makeRun();
  const out = runReplay([file, "--kind", "message.seen,send.succeeded"]);
  assert.match(out, /message\.seen/);
  assert.match(out, /send\.succeeded/);
  assert.doesNotMatch(out, /intent\.decided/);
});

test("replay：汇总里有会话统计与失败提示", () => {
  const file = makeRun();
  const out = runReplay([file]);
  assert.match(out, /共 5 条事件/);
  assert.match(out, /按会话/);
  assert.match(out, /看到 1 · 判定 1 · 发出 1/);
  assert.match(out, /有 1 次发送失败/);
  assert.match(out, /列表未读行：张三/);
});

test("replay：--json 输出原始事件", () => {
  const file = makeRun();
  const out = runReplay([file, "--json"]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 5);
  assert.equal(parsed[0].kind, "frame.captured");
});