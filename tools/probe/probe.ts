/**
 * 设备探针：一次跑完「微信到底给了我们什么」的五个问题，产出可读报告。
 *
 *   node tools/probe/probe.ts --adb "D:/.../adb.exe" [--serial XXX] [--out data/probe]
 *
 * 五问（对应 docs/behavior-layer.md §7）：
 *   1. a11y：uiautomator 能拿到几个节点、几段文本？（旧插件结论是「只有一个空节点」，要复核）
 *   2. 剪贴板：shell 有没有办法读到？（读不到就得走 IME / 截图两条路）
 *   3. 通知栏：微信通知里有没有正文？（有的话低频巡场不必点亮屏幕）
 *   4. 稳定帧：两次截图之间画面变没变、gfxinfo 帧号涨没涨、一帧多少毫秒？
 *   5. 环境：分辨率/密度/输入法/前台/微信版本——页面图与坐标表的基准。
 *
 * 纪律：**只读**。不点击、不输入、不滚动、不发消息。跑完手机还在原来的页面。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { Adb, AdbError } from "./adb.ts";
import {
  parseA11yXml,
  parseFramestats,
  parseNotifications,
  type A11ySummary,
  type FrameStats,
  type NoticeItem,
} from "./parse.ts";

interface Capture {
  ok: boolean;
  ms?: number;
  bytes?: number;
  sha256?: string;
  file?: string;
  error?: string;
}

interface Step<T> {
  ok: boolean;
  ms: number;
  data?: T;
  error?: string;
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = "true";
  }
  return out;
}

async function step<T>(fn: () => Promise<T>): Promise<Step<T>> {
  const t0 = performance.now();
  try {
    const data = await fn();
    return { ok: true, ms: Math.round(performance.now() - t0), data };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: (err as Error).message };
  }
}

function stamp(at = Date.now()): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const a = args();
  const adbPath = a["adb"] ?? process.env["ADB_PATH"] ?? "adb";
  const serial = a["serial"] ?? "";
  const outDir = resolve(a["out"] ?? "data/probe", stamp());
  await mkdir(outDir, { recursive: true });

  const adb = new Adb(adbPath, serial);

  const devices = await step(() => adb.devices());
  const online = devices.data?.filter((d) => d.state === "device") ?? [];
  if (online.length === 0) {
    console.error("没有在线设备：", JSON.stringify(devices.data ?? devices.error));
    process.exit(2);
  }

  const results: Record<string, unknown> = {};

  // ---------- 1. 环境 ----------
  const info = await step(async () => {
    const get = async (k: string) => (await adb.shell(`getprop ${k}`, 8000)).trim();
    const [model, release, sdk, size, density] = await Promise.all([
      get("ro.product.model"),
      get("ro.build.version.release"),
      get("ro.build.version.sdk"),
      adb.shell("wm size", 8000).then((s) => s.trim()),
      adb.shell("wm density", 8000).then((s) => s.trim()),
    ]);
    const wechat = await adb
      .shell("dumpsys package com.tencent.mm | grep -m2 -E 'versionName|versionCode'", 15000)
      .then((s) => s.trim());
    return { model, release, sdk, size, density, wechat };
  });
  results["device"] = info;

  // ---------- 2. 当前状态 ----------
  const state = await step(async () => {
    const wake = await adb.shell("dumpsys power | grep -m1 mWakefulness=", 10000);
    const focus = await adb.shell("dumpsys window | grep -m2 -E 'mCurrentFocus|mFocusedApp'", 10000);
    const ime = await adb.shell("settings get secure default_input_method", 8000);
    const imeList = await adb.shell("ime list -s", 10000);
    return {
      wakefulness: wake.trim(),
      focus: focus.trim().replace(/\s+/g, " "),
      ime: ime.trim(),
      imeList: imeList.trim().split("\n").filter(Boolean),
    };
  });
  results["state"] = state;

  // ---------- 3. 截图成本 ----------
  const shot1 = await step(async () => {
    const t0 = performance.now();
    const { buf } = await adb.screencap();
    const file = join(outDir, "screen-1.png");
    await writeFile(file, buf);
    return { bytes: buf.length, sha256: sha(buf), file, wallMs: Math.round(performance.now() - t0) };
  });
  results["screencap"] = shot1;

  // ---------- 4. 稳定帧：等 300ms 再截一次 ----------
  await sleep(300);
  const shot2 = await step(async () => {
    const { buf } = await adb.screencap();
    const file = join(outDir, "screen-2.png");
    await writeFile(file, buf);
    return { bytes: buf.length, sha256: sha(buf), file };
  });
  results["screencap2"] = shot2;

  const stable = {
    identical: Boolean(
      (shot1.data as { sha256?: string } | undefined)?.sha256 &&
        (shot1.data as { sha256?: string }).sha256 === (shot2.data as { sha256?: string } | undefined)?.sha256,
    ),
  };
  results["stability"] = stable;

  // ---------- 5. gfxinfo 帧号 ----------
  const gfx1 = await step(async () => parseFramestats(await adb.shell("dumpsys gfxinfo com.tencent.mm framestats", 20000)));
  await sleep(400);
  const gfx2 = await step(async () => parseFramestats(await adb.shell("dumpsys gfxinfo com.tencent.mm framestats", 20000)));
  results["framestats"] = { before: gfx1, after: gfx2 };

  // ---------- 6. a11y ----------
  const a11y = await step(async () => {
    const { xml, ms } = await adb.dumpUi();
    await writeFile(join(outDir, "a11y.xml"), xml, "utf8");
    return { summary: parseA11yXml(xml), xmlBytes: Buffer.byteLength(xml), readMs: ms };
  });
  results["a11y"] = a11y;

  // ---------- 7. 通知栏 ----------
  const notices = await step(async () => {
    const dump = await adb.shell("dumpsys notification --noredact", 25000);
    await writeFile(join(outDir, "notifications.txt"), dump, "utf8");
    return { items: parseNotifications(dump), bytes: Buffer.byteLength(dump) };
  });
  results["notifications"] = notices;

  // ---------- 8. 剪贴板（三种可能，逐个试） ----------
  const clipboard: Record<string, string> = {};
  for (const cmd of ["cmd clipboard get", "service call clipboard 2", "dumpsys clipboard"]) {
    const r = await step(async () => adb.shell(cmd, 10000));
    clipboard[cmd] = r.ok
      ? (r.data as string).trim().slice(0, 300)
      : `失败：${String(r.error).slice(0, 200)}`;
  }
  results["clipboard"] = clipboard;

  // ---------- 报告 ----------
  await writeFile(join(outDir, "raw.json"), JSON.stringify(results, null, 2), "utf8");
  const md = renderReport(results);
  await writeFile(join(outDir, "report.md"), md, "utf8");

  console.log(md);
  console.log(`\n原始数据：${join(outDir, "raw.json")}`);
}

function renderReport(r: Record<string, unknown>): string {
  const L: string[] = [];
  const dev = r["device"] as Step<Record<string, string>> | undefined;
  const st = r["state"] as Step<Record<string, unknown>> | undefined;
  const a11y = r["a11y"] as Step<{ summary: A11ySummary; xmlBytes: number }> | undefined;
  const notice = r["notifications"] as Step<{ items: NoticeItem[] }> | undefined;
  const clip = r["clipboard"] as Record<string, string> | undefined;
  const gfx = r["framestats"] as
    | { before: Step<FrameStats>; after: Step<FrameStats> }
    | undefined;
  const shot = r["screencap"] as Step<{ bytes: number; wallMs: number }> | undefined;
  const stable = r["stability"] as { identical: boolean } | undefined;

  L.push("# 设备探针报告", "");
  if (dev?.data) {
    const d = dev.data;
    L.push("## 环境", "");
    L.push("| 项 | 值 |", "|---|---|");
    L.push(`| 型号 | ${d["model"]} |`);
    L.push(`| Android | ${d["release"]} (sdk ${d["sdk"]}) |`);
    L.push(`| 分辨率/密度 | ${d["size"]} · ${d["density"]} |`);
    L.push(`| 微信 | ${(d["wechat"] ?? "").replace(/\n/g, " / ")} |`);
    L.push("");
  }
  if (st?.data) {
    L.push("## 当前状态", "");
    L.push("```");
    L.push(String(st.data["wakefulness"] ?? ""));
    L.push(String(st.data["focus"] ?? ""));
    L.push(`IME: ${st.data["ime"]}`);
    L.push(`可用输入法: ${(st.data["imeList"] as string[]).join(", ")}`);
    L.push("```", "");
  }

  L.push("## 五问结论", "");
  L.push("| 问题 | 结论 | 依据 |", "|---|---|---|");

  // 1 a11y
  const s = a11y?.data?.summary;
  const a11yVerdict = !s
    ? `失败：${a11y?.error}`
    : s.nodes >= 5 && s.withText > 0
      ? `可用（${s.nodes} 节点 / ${s.withText} 段文本）`
      : `基本不可用（${s.nodes} 节点 / ${s.withText} 段文本）：聊天类控件拿不到`;
  L.push(`| a11y | ${a11yVerdict} | ${s ? `xml ${a11y?.data?.xmlBytes}B，class 前几：${topClasses(s)}` : ""} |`);

  // 2 剪贴板
  const clipOk = clip
    ? Object.entries(clip).filter(([, v]) => v && !v.startsWith("失败") && !/Unknown|Error|Exception/i.test(v))
    : [];
  L.push(
    `| 剪贴板 | ${clipOk.length > 0 ? `shell 可读：${clipOk[0]![0]}` : "shell 读不到（需要 IME 或自己的 app）"} | ${clip ? Object.entries(clip).map(([k, v]) => `${k} → ${v.slice(0, 60)}`).join("；") : ""} |`,
  );

  // 3 通知
  const items = notice?.data?.items ?? [];
  L.push(
    `| 通知栏 | ${items.length > 0 ? `可读（${items.length} 条微信通知有正文）` : "没读到微信通知正文"} | ${items[0] ? `${items[0].title}: ${items[0].text}` : notice?.error ?? ""} |`,
  );

  // 4 稳定帧
  const f1 = gfx?.before?.data?.frames;
  const f2 = gfx?.after?.data?.frames;
  const advanced = typeof f1 === "number" && typeof f2 === "number" ? f2 - f1 : undefined;
  L.push(
    `| 稳定帧 | ${stable?.identical ? "静置时两帧哈希相同（可用）" : "两帧不同（页面在动或截图不稳定）"}；gfxinfo 帧数 ${advanced ?? "?"} | 一帧 ${shot?.data?.wallMs ?? "?"}ms，${shot?.data?.bytes ?? "?"}B |`,
  );

  // 5 环境
  L.push(`| 环境 | 已记录 | 作为页面图基准 |`, "");

  if (s && s.texts.length > 0) {
    L.push("## a11y 读到的文本（前 40 条）", "", "```");
    for (const t of s.texts) L.push(t.slice(0, 120));
    L.push("```", "");
  }
  if (items.length > 0) {
    L.push("## 微信通知", "");
    for (const n of items.slice(0, 10)) L.push(`- **${n.title}**：${n.text}`);
    L.push("");
  }
  if (clip) {
    L.push("## 剪贴板尝试", "", "```");
    for (const [k, v] of Object.entries(clip)) L.push(`$ ${k}\n${v}\n`);
    L.push("```", "");
  }
  return L.join("\n");
}

function topClasses(s: A11ySummary): string {
  return Object.entries(s.classes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k.split(".").pop()}×${v}`)
    .join(" ");
}

main().catch((err) => {
  if (err instanceof AdbError) {
    console.error(err.message);
    process.exit(3);
  }
  console.error(err);
  process.exit(1);
});