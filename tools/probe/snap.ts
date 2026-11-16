/**
 * 单页快照：截图 + a11y + 一行摘要。
 *
 *   node tools/probe/snap.ts --label list --adb <adb>
 *
 * 与 probe.ts 的分工：probe 是「体检」，只跑一次；snap 是「取样本」，
 * 每到位一个页面拍一张，用来补页面图。命名空间 data/probe/snaps/<label>/。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { Adb } from "./adb.ts";
import { parseA11yXml } from "./parse.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const serial = arg("serial");
const label = arg("label", "snap");
const outRoot = resolve(arg("out", "data/probe/snaps"));
const outDir = join(outRoot, label);

const adb = new Adb(adbPath, serial);
await mkdir(outDir, { recursive: true });

const t0 = performance.now();
const { buf } = await adb.screencap();
await writeFile(join(outDir, "screen.png"), buf);
const shotMs = Math.round(performance.now() - t0);

const t1 = performance.now();
const { xml } = await adb.dumpUi();
const dumpMs = Math.round(performance.now() - t1);
await writeFile(join(outDir, "a11y.xml"), xml, "utf8");

const s = parseA11yXml(xml, 200);
const focus = (await adb.shell("dumpsys window | grep -m1 mCurrentFocus", 10000)).trim();

const summary = {
  label,
  at: new Date().toISOString(),
  focus,
  screenshot: { file: join(outDir, "screen.png"), bytes: buf.length, ms: shotMs },
  a11y: { ...s, ms: dumpMs, xmlBytes: Buffer.byteLength(xml) },
};
await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

console.log(`# ${label}`);
console.log(`截图 ${shotMs}ms ${buf.length}B · dump ${dumpMs}ms ${Buffer.byteLength(xml)}B`);
console.log(focus.replace(/\s+/g, " ").slice(0, 200));
console.log(`节点 ${s.nodes} · 文本 ${s.withText} · desc ${s.withDesc} · 可点 ${s.clickable} · 包 ${s.packages.join(",")}`);
console.log("classes:", Object.entries(s.classes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k.split(".").pop()}×${v}`).join(" "));
if (s.texts.length) {
  console.log("--- texts ---");
  for (const t of s.texts.slice(0, 60)) console.log(t.slice(0, 100));
}