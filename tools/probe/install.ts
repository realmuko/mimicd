/**
 * 装 APK，自动点掉华为的两次「风险提示」。
 *
 *   node tools/probe/install.ts --adb "<adb>" [--apk android/probe/mimic-probe.apk]
 *
 * 背景：这台 Honor 的 ROM 把 sideload 拦成两步确认（风险提示 → 未经华为市场检测），
 * adb install 会一直等这个框，看起来像卡死。安装器的无障碍树是好的（系统应用），
 * 所以这里直接 dump + 按 text="继续安装" 的 bounds 点，不猜坐标。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const run = promisify(execFile);

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const apk = resolve(arg("apk", "android/probe/mimic-probe.apk"));
const pkg = arg("pkg", "mimic.probe");

if (!existsSync(apk)) {
  console.error(`APK 不存在：${apk}\n先跑 bash android/probe/build.sh`);
  process.exit(1);
}

async function adb(args: string[], timeoutMs = 30000): Promise<string> {
  try {
    const { stdout } = await run(adbPath, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
    return stdout;
  } catch (err) {
    // grep 没匹配到时 exit 1，不算失败
    return String((err as { stdout?: string }).stdout ?? "");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function installed(): Promise<boolean> {
  const out = await adb(["shell", `pm list packages | grep ${pkg}`]);
  return out.includes(pkg);
}

/** 从当前界面的 a11y 树里找可点的「继续安装」，返回中心点。 */
async function findContinue(): Promise<{ x: number; y: number } | null> {
  await adb(["shell", "uiautomator dump /sdcard/install.xml"], 20000).catch(() => "");
  const xml = await adb(["shell", "cat /sdcard/install.xml"], 20000).catch(() => "");
  const nodes = xml.match(/<node[^>]*>/g) ?? [];
  for (const node of nodes) {
    const text = /text="([^"]*)"/.exec(node)?.[1] ?? "";
    const clickable = /clickable="true"/.test(node);
    if (!clickable) continue;
    if (text !== "继续安装" && text !== "安装") continue;
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])];
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  }
  return null;
}

console.log(`推送 ${apk}`);
await adb(["push", apk, "/data/local/tmp/mimic-probe.apk"]);

console.log("开始在设备上安装（后台），自动处理华为确认框…");
// 让 pm install 在设备端后台跑；它会被两个确认框挡住，我们负责点
adb(["shell", "pm install -r /data/local/tmp/mimic-probe.apk > /data/local/tmp/install.log 2>&1 &"]).catch(() => "");

let clicked = 0;
for (let i = 0; i < 15; i++) {
  await sleep(2000);
  if (await installed()) {
    console.log(`已安装 ${pkg}（点了 ${clicked} 次确认）`);
    process.exit(0);
  }
  const point = await findContinue();
  if (point) {
    await adb(["shell", `input tap ${point.x} ${point.y}`]);
    clicked++;
    console.log(`  点「继续安装」@ ${point.x},${point.y}`);
    await sleep(1500);
  }
}

console.error("安装没成功。设备端日志：adb shell cat /data/local/tmp/install.log");
process.exit(2);