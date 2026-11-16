/**
 * 注入器部署脚本：推送 dex、停掉旧进程、启动、端口转发、自检。
 *
 *   node tools/inject/deploy.ts --adb "<dsh>/.tools/platform-tools/adb.exe"
 *   node tools/inject/deploy.ts --adb <adb> --port 7801 --restart
 *
 * 为什么要有它：手工 adb 拼命令踩过三个坑（MSYS 路径被转换、pkill 把自己杀掉、
 * & 后台进程的日志被吞）。这三件事都收进脚本里，一次做对。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const run = promisify(execFile);

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const serial = arg("serial");
const port = arg("port", "7801");
const dex = resolve(arg("dex", "android/injector/build/dex/classes.dex"));
const remote = "/data/local/tmp/mimic-injector.dex";

async function adb(args: string[], timeoutMs = 30000): Promise<string> {
  const full = serial ? ["-s", serial, ...args] : args;
  try {
    const { stdout } = await run(adbPath, full, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`adb ${full.join(" ")} 失败：${(e.stderr || e.message || "").trim().slice(0, 300)}`);
  }
}

function send(command: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(port) }, () => socket.write(command + "\n"));
    let buf = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`注入器 ${timeoutMs}ms 没回复`));
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        socket.end();
        resolvePromise(buf.slice(0, nl).trim());
      }
    });
    socket.on("error", (e) => reject(new Error(`连不上注入器：${e.message}`)));
  });
}

if (!existsSync(dex)) {
  console.error(`dex 不存在：${dex}\n先跑 bash android/injector/build.sh`);
  process.exit(1);
}

// 1) 找到并停掉旧进程（用 [m] 写法避免把自己这条命令行也匹配进去）
const ps = await adb(["shell", "ps -A -o PID,ARGS"]);
const stale = ps
  .split("\n")
  .filter((line) => line.includes("mimic.Injector"))
  .map((line) => line.trim().split(/\s+/)[0])
  .filter(Boolean);
for (const pid of stale) {
  await adb(["shell", `kill ${pid}`]).catch(() => {});
  console.log(`已停掉旧注入器 pid=${pid}`);
  await new Promise((r) => setTimeout(r, 600));
}

// 2) 推送
await adb(["push", dex, remote]);
console.log(`已推送 ${dex} → ${remote}`);

// 3) 启动（nohup + 重定向，确保 adb shell 退出后进程还在）
const cmd = `nohup env CLASSPATH=${remote} app_process /system/bin mimic.Injector ${port} > /data/local/tmp/mimic-injector.log 2>&1 &`;
await adb(["shell", cmd]);
await new Promise((r) => setTimeout(r, 2000));

const log = (await adb(["shell", "cat /data/local/tmp/mimic-injector.log"])).trim();
console.log(`设备日志：${log || "(空)"}`);

// 4) 端口转发 + 自检
await adb(["forward", `tcp:${port}`, `tcp:${port}`]);
try {
  const pong = await send("ping");
  const info = await send("info");
  console.log(`自检：${pong} · ${info}`);
} catch (err) {
  console.error(`自检失败：${(err as Error).message}`);
  console.error("看设备日志：adb shell cat /data/local/tmp/mimic-injector.log");
  process.exit(2);
}