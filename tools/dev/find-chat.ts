/**
 * 开发用：验证「进会话」这条路（列表点 + 搜索框兜底）。
 *
 *   node tools/dev/find-chat.ts --adb "<adb>" --name "摸鱼闲聊群"
 *   node tools/dev/find-chat.ts --adb "<adb>" --name "摸鱼" --search-only
 *
 * --search-only 只走搜索框那条路，用来验兜底本身。
 * 不会发任何消息，进错了会退回来。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Adb } from "../../src/device/adb.ts";
import { InjectorClient } from "../../src/device/injector.ts";
import { ImeClient } from "../../src/device/ime.ts";
import { Ocr } from "../../src/perception/ocr.ts";
import type { PageGraph } from "../../src/perception/page.ts";
import { enterChat, searchChat } from "../../src/daemon/navigate.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const name = arg("name", "");
const searchOnly = process.argv.includes("--search-only");
if (!name) {
  console.error('用法: node tools/dev/find-chat.ts --adb "<adb>" --name "会话名" [--search-only]');
  process.exit(1);
}

const graph = JSON.parse(readFileSync(resolve(arg("graph", "profiles/wechat/pages.json")), "utf8")) as PageGraph;
const adb = new Adb({ adbPath });
const injector = new InjectorClient({ port: 7801 });
const ime = new ImeClient(adb);
const ocr = new Ocr({ script: resolve("tools/ocr/ocr.ps1"), workDir: resolve("data/tmp"), scale: 4 });

await adb.forward(7801, 7801);
await injector.ping();

// 和 daemon 一样的输入法切换（搜索框要打中文）
const IME_AUTO = "mimic.probe/.ProbeIme";
const IME_USER = arg("ime-restore", "com.android.adbkeyboard/.AdbIME");
async function withAutomationIme<T>(fn: () => Promise<T>): Promise<T> {
  const before = (await adb.shell("settings get secure default_input_method", 8000)).trim();
  if (before !== IME_AUTO) {
    await adb.shell(`ime enable ${IME_AUTO}`, 8000).catch(() => "");
    await adb.shell(`ime set ${IME_AUTO}`, 8000);
  }
  try {
    return await fn();
  } finally {
    const restore = before && before !== IME_AUTO ? before : IME_USER;
    await adb.shell(`ime set ${restore}`, 8000).catch(() => "");
  }
}

const deps = { adb, injector, ocr, graph, ime, withIme: withAutomationIme, log: (m: string) => console.log(m) };

if (searchOnly) {
  const ok = await searchChat(deps, name);
  console.log(JSON.stringify({ searchOnly: true, ok }, null, 2));
  process.exit(ok ? 0 : 2);
}

const result = await enterChat(deps, name);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);