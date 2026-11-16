/**
 * 输入法开关：把自建输入法切成默认（或切回去）。
 *
 *   node tools/ime-mode.ts --adb "<adb>" on     # 切到 mimic.probe（读剪贴板/读输入框/打字）
 *   node tools/ime-mode.ts --adb "<adb>" off    # 切回 ADBKeyboard
 *   node tools/ime-mode.ts --adb "<adb>" status
 *
 * 为什么要单独一个脚本：`ime set` 改的是**全局**默认输入法，
 * 用完不切回去，用户自己打字会打到探针里。这条必须显式、可见、可恢复。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const serial = arg("serial");
const target = arg("restore", "com.android.adbkeyboard/.AdbIME");
const mode = (process.argv.slice(2).find((a) => a === "on" || a === "off" || a === "status") ?? "status").trim();

async function adb(args: string[]): Promise<string> {
  const full = serial ? ["-s", serial, ...args] : args;
  const { stdout } = await run(adbPath, full, { encoding: "utf8", timeout: 20000 });
  return stdout;
}

const current = (await adb(["shell", "settings get secure default_input_method"])).trim();

if (mode === "status") {
  console.log(current);
  process.exit(0);
}

if (mode === "on") {
  await adb(["shell", "ime enable mimic.probe/.ProbeIme"]);
  await adb(["shell", "ime set mimic.probe/.ProbeIme"]);
  const now = (await adb(["shell", "settings get secure default_input_method"])).trim();
  if (now !== "mimic.probe/.ProbeIme") {
    console.error(`切换失败，当前仍是 ${now}`);
    process.exit(2);
  }
  console.log(`输入法：${current} → ${now}`);
  process.exit(0);
}

if (mode === "off") {
  await adb(["shell", `ime set ${target}`]);
  await adb(["shell", "ime disable mimic.probe/.ProbeIme"]);
  const now = (await adb(["shell", "settings get secure default_input_method"])).trim();
  if (now !== target) {
    console.error(`没能切回 ${target}，当前是 ${now}`);
    process.exit(2);
  }
  console.log(`输入法已切回 ${now}`);
  process.exit(0);
}

console.error("用法：node tools/ime-mode.ts --adb <adb> on|off|status");
process.exit(1);