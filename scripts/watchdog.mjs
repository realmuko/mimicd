/**
 * mimicd 看门狗：保证 65480 那个引擎**一直活着、而且在动**。
 *
 * 为什么需要它（2026-11-18 的教训）：引擎是独立进程，没有服务托管 —— 电脑重启、
 * 进程崩了、或者活着但 tick 卡住，都没人拉起。bridge 那边还在每 8 秒轮询，
 * 日志里只留下一串 ECONNREFUSED，整条链路静默死亡，群里的人只会觉得突然哑了。
 *
 * 判定（任一命中算一次失败）：
 *   1. GET /health 连不上 / 超时（8s）
 *   2. /health 里的 lastTick.at 超过 3 分钟没前进（进程活着但不干活）
 * 连续 3 次失败（约 90s）→ 杀掉占着 65480 的进程 → 重新拉起 run-daemon.cmd。
 *
 * 安全性：只按端口找 PID，绝不 taskkill /IM node.exe —— 这台机器上还有别的 node。
 * 重启后 120 秒冷却，避免端口释放慢时疯狂重启。
 *
 * 手动跑：node scripts/watchdog.mjs
 * 无窗口：scripts/launch-watchdog.vbs（开机自启指它）
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:\\mimicd";
const PORT = 65480;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const DATA = path.join(ROOT, "data");
const LOG = path.join(DATA, "watchdog.log");
const PID_FILE = path.join(DATA, "watchdog.pid");
const RUN_CMD = path.join(ROOT, "scripts", "run-daemon.cmd");

/**
 * 拉起引擎：**直接 spawn node，不经过 cmd 和 `>>` 重定向**。
 *
 * 为什么（2026-11-18 踩的）：走 `cmd /c run-daemon.cmd` 时，日志是靠 cmd 的
 * `>> data\daemon.log` 打开的。那个写句柄会跟着启动它的 shell/job 一起泄漏，
 * 进程死了句柄还在 —— 下一次拉起就报「另一个程序正在使用此文件」，
 * 看门狗明明执行了"拉起"，日志里却一个字都没有。
 * 现在自己 open fd 交给子进程、父进程马上 close，句柄只跟着引擎走。
 *
 * 参数要和 run-daemon.cmd 保持一致（手动启动走那边，自动拉起走这边）。
 */
const NODE = "D:\\nodejs\\node.exe";
const DAEMON_LOG = path.join(DATA, "daemon.log");
const ADB = "D:\\deepseek harness\\.tools\\platform-tools\\adb.exe";
const SERIAL = "<serial>";
const IME_RESTORE = "com.baidu.input_huawei/.ImeService";
const DAEMON_ARGS = [
  path.join(ROOT, "tools", "daemon.ts"),
  "--adb",
  ADB,
  "--serial",
  SERIAL,
  "--launch-wechat",
  "--ime-restore",
  IME_RESTORE,
];

const CHECK_MS = 30_000;
const FAIL_TO_RESTART = 3;
const TICK_STALE_MS = 180_000;
const HTTP_TIMEOUT_MS = 8_000;
const RESTART_COOLDOWN_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOG, line);
  } catch {
    /* ignore */
  }
  try {
    process.stdout.write(line);
  } catch {
    /* ignore */
  }
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, "utf8").trim()) || null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 单实例：已经有活的看门狗就退出（开机自启 + 手动启动不会变成两只狗抢着重启）
const existing = readPid();
if (existing && existing !== process.pid && alive(existing)) {
  log(`已有看门狗在跑（pid ${existing}），本实例退出`);
  process.exit(0);
}
try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
} catch {
  /* ignore */
}

async function checkHealth() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const body = await res.json();
    const at = body?.lastTick?.at;
    if (typeof at === "number" && at > 0) {
      const stale = Date.now() - at;
      if (stale > TICK_STALE_MS) {
        return { ok: false, why: `lastTick 停在 ${Math.round(stale / 1000)}s 前（引擎活着但不动）` };
      }
    }
    return { ok: true, body };
  } catch (err) {
    const name = err?.name || "";
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, why: "健康检查超时" };
    return { ok: false, why: err?.message || String(err) };
  }
}

/** 占着 65480 的进程 PID（只看 LISTENING，按端口，不按进程名） */
function pidOnPort() {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${PORT}`)) continue;
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function restart(reason) {
  log(`判定引擎不可用：${reason} —— 开始重启`);
  const pid = pidOnPort();
  if (pid) {
    log(`杀掉占用 ${PORT} 的进程 pid=${pid}`);
    try {
      execFileSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
    } catch {
      /* ignore */
    }
  }
  // 等端口真的释放（run-daemon.cmd 要往 daemon-current.out 里写，旧进程没死透会失败）
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    if (!pidOnPort()) break;
  }
  const leftover = pidOnPort();
  if (leftover) {
    log(`端口 ${PORT} 仍被 pid=${leftover} 占着，放弃本次重启（等下一轮）`);
    return false;
  }
  try {
    log("拉起 daemon（直接 node，不经 cmd）");
    const fd = fs.openSync(DAEMON_LOG, "a");
    const child = spawn(NODE, DAEMON_ARGS, {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.on("error", (e) => log(`拉起失败：${e?.message || e}`));
    child.unref();
    // 子进程已经拿到自己的副本，父进程这份马上还回去（别把句柄又漏出去）
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    return true;
  } catch (err) {
    log(`拉起失败：${err?.message || err}`);
    return false;
  }
}

let fails = 0;
let lastRestartAt = 0;

async function tick() {
  const h = await checkHealth();
  if (h.ok) {
    if (fails > 0) log(`恢复健康（之前连续失败 ${fails} 次）`);
    fails = 0;
    return;
  }
  fails++;
  log(`健康检查失败 ${fails}/${FAIL_TO_RESTART}：${h.why}`);
  if (fails < FAIL_TO_RESTART) return;
  if (Date.now() - lastRestartAt < RESTART_COOLDOWN_MS) {
    log("冷却中，本轮不重启");
    return;
  }
  const done = await restart(h.why);
  if (done) lastRestartAt = Date.now();
  fails = 0;
}

log(`看门狗启动 pid=${process.pid} · 每 ${CHECK_MS / 1000}s 检查 ${HEALTH_URL} · 连续 ${FAIL_TO_RESTART} 次失败重启`);
tick().catch((e) => log(`检查出错：${e?.message || e}`));
setInterval(() => {
  tick().catch((e) => log(`检查出错：${e?.message || e}`));
}, CHECK_MS);
process.on("uncaughtException", (e) => log(`未捕获异常（继续跑）：${e?.message || e}`));
process.on("unhandledRejection", (e) => log(`未处理的 rejection（继续跑）：${e?.message || e}`));