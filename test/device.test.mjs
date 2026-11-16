import { test } from "node:test";
import assert from "node:assert/strict";

import { InjectorClient, InjectorError } from "../src/device/injector.ts";
import { ImeClient, ImeError, parseBroadcastResult, parseReadInput, shellQuote } from "../src/device/ime.ts";
import { parseFocus } from "../src/device/adb.ts";

test("注入器：命令格式正确，ok 才算成功", async () => {
  const sent = [];
  const client = new InjectorClient({
    send: async (line) => {
      sent.push(line);
      return "ok tap hold=66ms moves=5";
    },
  });

  await client.tap(540.4, 800.6, 65);
  await client.hold(540, 1200, 700);
  await client.swipe(400, 1600, 700, 1600, 300);
  await client.path([
    { x: 540, y: 1600, t: 0 },
    { x: 538.5, y: 1500, t: 40 },
    { x: 535, y: 1400, t: 90 },
  ]);
  await client.press(0.55, 0.12);
  await client.ping();

  assert.deepEqual(sent, [
    "tap 540.4 800.6 65",
    "hold 540 1200 700",
    "swipe 400 1600 700 1600 300",
    "path 540,1600,0 538.5,1500,40 535,1400,90",
    "press 0.55 0.12",
    "ping",
  ]);
});

test("注入器：err 回复要抛出来，并且带上是哪条命令", async () => {
  const client = new InjectorClient({ send: async () => "err down-rejected" });
  await assert.rejects(() => client.tap(1, 2, 65), (err) => {
    assert.ok(err instanceof InjectorError);
    assert.match(err.message, /tap 1 2 65/);
    assert.match(err.message, /down-rejected/);
    return true;
  });
});

test("注入器：压力越界在客户端就挡住，不发出去", async () => {
  let called = false;
  const client = new InjectorClient({
    send: async () => {
      called = true;
      return "ok";
    },
  });
  await assert.rejects(() => client.press(1.5, 0.1), /0\.\.1/);
  assert.equal(called, false);
});

test("注入器：socket 报错包成 InjectorError", async () => {
  const client = new InjectorClient({
    send: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(() => client.ping(), (err) => {
    assert.ok(err instanceof InjectorError);
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
});

// ---------- 输入法 ----------

class FakeAdb {
  constructor(respond) {
    this.respond = respond;
    this.calls = [];
  }
  async exec() {
    return Buffer.alloc(0);
  }
  async shell(cmd) {
    this.calls.push(cmd);
    return this.respond(cmd);
  }
  async screencap() {
    throw new Error("不用");
  }
  async focus() {
    throw new Error("不用");
  }
  async forward() {}
  async push() {}
}

const DATA = (s) => `Broadcasting: Intent { ... }\nBroadcast completed: result=0, data=${JSON.stringify(s)}`;

test("输入法：广播必须带组件名和 INCLUDE_STOPPED_PACKAGES", async () => {
  const adb = new FakeAdb(() => DATA("ok ime=true"));
  const ime = new ImeClient(adb);
  await ime.ping();
  const cmd = adb.calls[0];
  assert.match(cmd, /am broadcast/);
  assert.match(cmd, /-n mimic\.probe\/\.CommandReceiver/);
  assert.match(cmd, /-f 0x20/);
});

test("输入法：读剪贴板/读输入框的解析", async () => {
  const clipboard = new FakeAdb(() => DATA("CLIP=hello 世界"));
  const ime = new ImeClient(clipboard);
  assert.equal(await ime.readClipboard(), "hello 世界");

  const input = new FakeAdb(() => DATA("BEFORE=abc||AFTER=def"));
  assert.deepEqual(await new ImeClient(input).readInput(), { before: "abc", after: "def" });
});

test("输入法：EMPTY 当空串，ERR 抛错", async () => {
  assert.equal(await new ImeClient(new FakeAdb(() => DATA("EMPTY"))).readClipboard(), "");
  await assert.rejects(
    () => new ImeClient(new FakeAdb(() => DATA("ERR no-ime-instance"))).readClipboard(),
    (err) => {
      assert.ok(err instanceof ImeError);
      assert.match(err.message, /no-ime-instance/);
      return true;
    },
  );
});

test("输入法：文本里的单引号会被正确转义", async () => {
  const adb = new FakeAdb(() => DATA("ok committed=3"));
  const ime = new ImeClient(adb);
  await ime.type("it's ok");
  assert.match(adb.calls[0], /--es text 'it'\\''s ok'/);
});

test("广播结果解析：没有 data 要报清楚，而不是返回 undefined", () => {
  assert.throws(() => parseBroadcastResult("Broadcast completed: result=0"), /没有返回数据/);
  assert.equal(parseBroadcastResult(DATA("ok")), "ok");
});

test("READ_INPUT 解析：带换行与非贪婪边界", () => {
  assert.deepEqual(parseReadInput("BEFORE=a\nb||AFTER=c||d"), { before: "a\nb", after: "c||d" });
  assert.throws(() => parseReadInput("BEFORE=only"), /意外内容/);
});

test("shellQuote：普通与含引号", () => {
  assert.equal(shellQuote("abc"), "'abc'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

// ---------- focus 解析 ----------

test("focus：从 mCurrentFocus 里取包名与活动", () => {
  const f = parseFocus("  mCurrentFocus=Window{23377b9 u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}");
  assert.equal(f.pkg, "com.tencent.mm");
  assert.equal(f.activity, "com.tencent.mm.ui.LauncherUI");
  assert.equal(f.component, "com.tencent.mm/com.tencent.mm.ui.LauncherUI");
});

test("focus：解析不了时给空值，不抛异常", () => {
  const f = parseFocus("  mCurrentFocus=null");
  assert.deepEqual({ pkg: f.pkg, activity: f.activity }, { pkg: "", activity: "" });
});