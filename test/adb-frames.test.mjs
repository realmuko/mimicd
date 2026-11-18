/**
 * 设备层的帧复用与电源/僵死自愈（T3、T7）。
 *
 * 全部用 `FakeAdb extends Adb` 顶掉 exec/shell —— 不碰手机、不启 adb。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Adb, parseWakefulness, touchesScreen } from "../src/device/adb.ts";
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

const PNG = encode(blank(320, 240, [10, 20, 30]));

/**
 * 不碰手机的 Adb：只顶掉最底层的 exec。
 * exec 只做两件事：`shell xxx` 交给 shellReturns 编输出；其它（screencap）返回固定 PNG。
 * 这样 Adb.shell 自己的逻辑（截图复用失效）仍然是真的在被测。
 */
class FakeAdb extends Adb {
  constructor(opts = {}) {
    super({ adbPath: "adb", ...opts });
    this.shotCalls = 0;
    this.shellCalls = [];
    this.shellReturns = opts.shellReturns ?? (() => "");
    this.focusPkg = opts.focusPkg ?? "com.tencent.mm";
  }
  async exec(args) {
    if (args[0] === "shell") {
      const cmd = String(args[1]);
      this.shellCalls.push(cmd);
      return Buffer.from(String(this.shellReturns(cmd) ?? ""), "utf8");
    }
    this.shotCalls++;
    return PNG;
  }
  async focus() {
    return { raw: "", pkg: this.focusPkg, activity: "", component: "" };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- T3：screencap 顺手解码 + 复用窗口 ----------

test("screencap：顺手把 bmp 填进 Frame（调用方不用再 decode 一遍）", async () => {
  const adb = new FakeAdb();
  const f = await adb.screencap();
  assert.equal(f.png, PNG);
  assert.equal(f.width, 320);
  assert.equal(f.height, 240);
  assert.ok(f.bmp, "Frame.bmp 必须有，否则调用方还得 decode 第二次");
  assert.equal(f.bmp.width, 320);
  assert.equal(f.bmp.height, 240);
});

test("screencap：默认**不**复用（否则 waitStable 一上来就判稳定）", async () => {
  const adb = new FakeAdb();
  await adb.screencap();
  await adb.screencap();
  assert.equal(adb.shotCalls, 2, "默认 captureReuseMs=0，每次都真的去拍");
});

test("screencap：复用窗口内返回同一帧，窗口外重新拍", async () => {
  const adb = new FakeAdb({ captureReuseMs: 300 });
  const a = await adb.screencap();
  const b = await adb.screencap();
  assert.equal(a, b, "300ms 内应该是同一帧（同一个对象）");
  assert.equal(adb.shotCalls, 1, "第二次不该再走 adb");

  adb.invalidateFrame();
  await adb.screencap();
  assert.equal(adb.shotCalls, 2, "invalidateFrame 之后必须重新拍");
});

test("screencap：窗口过期就重新拍", async () => {
  const adb = new FakeAdb({ captureReuseMs: 5 });
  await adb.screencap();
  await sleep(20);
  await adb.screencap();
  assert.equal(adb.shotCalls, 2);
});

test("screencap：点过/滑过/按过之后，复用窗口里的帧必须作废", async () => {
  const adb = new FakeAdb({ captureReuseMs: 300 });
  await adb.screencap();
  await adb.shell("input tap 540 800");
  await adb.screencap();
  assert.equal(adb.shotCalls, 2, "点完还返回旧帧，页面判定会读到点击前的画面");

  await adb.shell("input swipe 540 1680 540 720 200");
  adb.invalidateFrame();
  await adb.screencap();
  assert.equal(adb.shotCalls, 3);
});

test("screencap：只读命令不动复用窗口（dumpsys 不该害我们重拍）", async () => {
  const adb = new FakeAdb({ captureReuseMs: 300 });
  await adb.screencap();
  await adb.shell("dumpsys window");
  const again = await adb.screencap();
  assert.equal(adb.shotCalls, 1, "dumpsys 不改屏幕，没必要作废");
  assert.ok(again.width === 320);
});

test("touchesScreen：只会改屏幕的命令才算", () => {
  assert.equal(touchesScreen("input tap 540 800"), true);
  assert.equal(touchesScreen("input swipe 1 2 3 4 200"), true);
  assert.equal(touchesScreen("input keyevent KEYCODE_BACK"), true);
  assert.equal(touchesScreen("am start -n com.tencent.mm/.ui.LauncherUI"), true);
  assert.equal(touchesScreen("am force-stop com.tencent.mm"), true);
  assert.equal(touchesScreen("am broadcast -a ADB_INPUT_TEXT --es msg 在吗"), true);
  assert.equal(touchesScreen("monkey -p com.tencent.mm -c android.intent.category.LAUNCHER 1"), true);
  assert.equal(touchesScreen("dumpsys window"), false);
  assert.equal(touchesScreen("dumpsys power"), false);
  assert.equal(touchesScreen("cat /sdcard/x.png"), false);
});

// ---------- T7：锁屏与微信僵死 ----------

const POWER_AWAKE = "Power Manager State:\n  mWakefulness=Awake\n  mWakefulnessChanging=false\n";
const POWER_ASLEEP = "Power Manager State:\n  mWakefulness=Asleep\n";

test("parseWakefulness：Awake / Dreaming 算醒着，Asleep 算锁着", () => {
  assert.deepEqual(parseWakefulness(POWER_AWAKE), { awake: true, state: "Awake" });
  assert.equal(parseWakefulness(POWER_ASLEEP).awake, false);
  assert.equal(parseWakefulness("mWakefulness=Dreaming").awake, true, "微光/屏保也算醒着（旧插件同口径）");
});

test("parseWakefulness：认不出来当醒着（别因为查不到把整条链路停掉）", () => {
  assert.deepEqual(parseWakefulness(""), { awake: true, state: "" });
  assert.equal(parseWakefulness("error: no devices").awake, true);
});

test("screenAwake：读 dumpsys power", async () => {
  const awake = new FakeAdb({ shellReturns: () => POWER_AWAKE });
  assert.equal(await awake.screenAwake(), true);
  assert.match(awake.shellCalls[0], /dumpsys power/);

  const asleep = new FakeAdb({ shellReturns: () => POWER_ASLEEP });
  assert.equal(await asleep.screenAwake(), false);
});

test("screenAwake：命令失败时当作醒着，不抛", async () => {
  const adb = new FakeAdb({
    shellReturns: () => {
      throw new Error("error: device offline");
    },
  });
  assert.equal(await adb.screenAwake(), true);
});

test("restartWeChat：force-stop → monkey 拉起 → 等冷启动（旧插件 poller.js:392-407）", async () => {
  const adb = new FakeAdb({ focusPkg: "com.tencent.mm" });
  const r = await adb.restartWeChat({ forceStopWaitMs: 0, launchWaitMs: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(adb.shellCalls, [
    "am force-stop com.tencent.mm",
    "monkey -p com.tencent.mm -c android.intent.category.LAUNCHER 1",
  ]);
  assert.match(r.log, /force-stop/);
  assert.match(r.log, /monkey/);
});

test("restartWeChat：焦点没回到微信就 ok=false（让调用方自己决定下一步）", async () => {
  const adb = new FakeAdb({ focusPkg: "com.huawei.android.launcher" });
  const r = await adb.restartWeChat({ forceStopWaitMs: 0, launchWaitMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.log, /com\.huawei\.android\.launcher/);
});

test("restartWeChat：命令失败也把日志带回来，不抛", async () => {
  const adb = new FakeAdb({
    shellReturns: () => {
      throw new Error("error: closed");
    },
  });
  const r = await adb.restartWeChat({ forceStopWaitMs: 0, launchWaitMs: 0, checkFocus: false });
  assert.equal(r.ok, true, "没检查焦点时只负责把命令跑完");
  assert.match(r.log, /force-stop 失败/);
  assert.match(r.log, /monkey 失败/);
});