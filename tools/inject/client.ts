/**
 * 注入器客户端：往设备上的注入器发一条命令，打印回复。
 *
 *   node tools/inject/client.ts "info"
 *   node tools/inject/client.ts "tap 540 1200 65"
 *   node tools/inject/client.ts "path 540,1800,0 545,1500,30 560,1200,90 570,900,170"
 *
 * 前置：
 *   adb push build/dex/classes.dex /data/local/tmp/mimic-injector.dex
 *   adb shell "CLASSPATH=/data/local/tmp/mimic-injector.dex app_process /system/bin mimic.Injector 7801 &"
 *   adb forward tcp:7801 tcp:7801
 */

import { connect } from "node:net";

const port = Number(process.env["INJECT_PORT"] ?? 7801);
const host = process.env["INJECT_HOST"] ?? "127.0.0.1";
const command = process.argv.slice(2).join(" ").trim();

if (!command) {
  console.error('用法: node tools/inject/client.ts "<命令>"，例如 "info"');
  process.exit(1);
}

const socket = connect({ host, port }, () => {
  socket.write(command + "\n");
});

let buf = "";
socket.setEncoding("utf8");
socket.on("data", (chunk: string) => {
  buf += chunk;
  const nl = buf.indexOf("\n");
  if (nl >= 0) {
    const reply = buf.slice(0, nl).trim();
    socket.end();
    console.log(reply);
    process.exit(reply.startsWith("ok") ? 0 : 2);
  }
});

socket.on("error", (err) => {
  console.error(`连不上注入器（${host}:${port}）：${err.message}`);
  console.error("检查：adb forward tcp:7801 tcp:7801；设备上 app_process 是否还在跑");
  process.exit(3);
});

socket.setTimeout(15000, () => {
  console.error("注入器 15s 没回复（长按/长滑动可能比较慢）");
  socket.destroy();
  process.exit(4);
});