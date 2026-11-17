#!/usr/bin/env node
/**
 * 3.0 一键激活：起引擎 → 开桥接 → 停旧轮询。
 *
 *   node tools/activate-3.0.cjs --adb "<adb>" [--dry-run]
 *
 * 之后需要**重启一次 DSH**：桥接代码在插件的 index.js 里，只有重启才会加载。
 * 引擎 daemon 是独立进程，重启 DSH 不会影响它。
 *
 * 回滚：node tools/activate-3.0.cjs --off
 */
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const DRY = process.argv.includes("--dry-run");
const OFF = process.argv.includes("--off");

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i >= 0 && next && !next.startsWith("--") ? next : fallback;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const cfgPath = "<dsh-wechat-usb>/wechat-usb.config.json";
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

function editCfg(mutate) {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const before = JSON.stringify(cfg);
  mutate(cfg);
  if (JSON.stringify(cfg) === before) return "已是最新";
  if (!DRY) {
    copyFileSync(cfgPath, `${cfgPath}.bak-${stamp}`);
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }
  return DRY ? "会改" : "已改";
}

async function pluginApi(path, body) {
  try {
    const res = await fetch(`http://127.0.0.1:65470${path}`, body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }
      : { signal: AbortSignal.timeout(5000) });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const engineUp = async () => {
  try {
    const res = await fetch("http://127.0.0.1:65480/health", { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
};

if (OFF) {
  const r1 = editCfg((c) => {
    c.bridge = { ...(c.bridge || {}), enabled: false };
  });
  console.log(`bridge.enabled=false：${r1}`);
  console.log("（引擎 daemon 如果还在跑，用 curl -X POST localhost:65480/control -d '{\"action\":\"pause\"}' 暂停）");
  process.exit(0);
}

if (!existsSync(cfgPath)) {
  console.error(`找不到插件配置：${cfgPath}`);
  process.exit(1);
}

// 1) 引擎起来了吗
const up = await engineUp();
console.log(`引擎：${up ? "已在运行" : "没在跑"}`);

if (!up) {
  if (DRY) {
    console.log("  （dry-run：会执行 node tools/daemon.ts --interval 20）");
  } else {
    const child = spawn(process.execPath, ["tools/daemon.ts", "--adb", adbPath, "--interval", "20"], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    });
    child.unref();
    console.log(`  已启动 daemon（pid ${child.pid}），日志：data/daemon.out`);
    // 等它就绪
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await engineUp()) break;
    }
    console.log(`  健康检查：${(await engineUp()) ? "ok" : "还没起来（看日志）"}`);
  }
}

// 2) 开桥接
const r2 = editCfg((c) => {
  c.bridge = {
    engineUrl: "http://127.0.0.1:65480",
    intervalMs: 8000,
    ...(c.bridge || {}),
    enabled: true, // 必须放在 spread 后面，否则会被旧值覆盖
  };
});
console.log(`bridge.enabled=true：${r2}`);

// 3) 停旧轮询（两个执行者不能同时碰手机）
const stop = DRY ? { ok: true, dryRun: true } : await pluginApi("/poll", { action: "stop" });
console.log(`旧轮询停止：${stop.ok ? (DRY ? "（dry-run，未执行）" : "ok") : JSON.stringify(stop).slice(0, 80)}`);

console.log("");
console.log("下一步（必须做）：重启一次 DSH，插件才会加载桥接。");
console.log("重启后验证：");
console.log("  curl -s localhost:65480/health          # 引擎在线、paused=false");
console.log("  curl -s localhost:65470/status          # 插件在线");
console.log("  在微信里发一条消息 → curl -s localhost:65480/pending   # 应看到待办");
console.log("");
console.log("回滚：node tools/activate-3.0.cjs --off");