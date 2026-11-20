/**
 * 启动 daemon：监视微信 → 决定 → 回复，并对外提供 HTTP。
 *
 *   node tools/daemon.ts --adb "<adb>" [--interval 20] [--port 65480] [--dry-run] [--once]
 *
 * 配置优先级：命令行 > data/config.json > 默认值。
 * 脑子默认 scripted（确定、不用 API key）；要真聊天就配 brain.http。
 */

import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { Adb, AdbError, classifyDeviceError } from "../src/device/adb.ts";
import { InjectorClient } from "../src/device/injector.ts";
import { ImeClient } from "../src/device/ime.ts";
import { createRng } from "../src/core/rng.ts";
import { Actuator } from "../src/act/actuator.ts";
import { EventLog } from "../src/eventlog.ts";
import { dayStamp, makeRunId } from "../src/events.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { SkillRunner } from "../src/skills/runner.ts";
import { Ocr } from "../src/perception/ocr.ts";
import { StickerLibrary } from "../src/stickers/library.ts";
import { StickerLabeler } from "../src/stickers/labeler.ts";
import { inferMood } from "../src/stickers/mood.ts";
import { detectPage, decodeFrame, rectOf, type PageGraph } from "../src/perception/page.ts";
import { cleanName, isNameLine } from "../src/monitor/scan.ts";
import { enterChat as navigateEnterChat } from "../src/daemon/navigate.ts";
import { detectChatKind } from "../src/monitor/chat.ts";
import { World } from "../src/world/state.ts";
import { AutoChat, DEFAULT_AUTOCHAT, type AutoChatConfig } from "../src/daemon/autochat.ts";
import { startDaemonServer, type DaemonState } from "../src/daemon/server.ts";
import { PendingQueue } from "../src/daemon/pending.ts";
import { HttpBrain, ScriptedBrain, type Brain } from "../src/brain/brain.ts";
import { inQuietHours, type PolicyConfig } from "../src/policy/policy.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const serial = arg("serial");
const intervalSec = Number(arg("interval", "20"));
const port = Number(arg("port", "65480"));
/** 注入器的 TCP 端口（adb forward 过来），重置 adb server 后要重建 */
const INJECTOR_PORT = 7801;
const dryRun = flag("dry-run");
const forceChat = arg("chat", "");
const noSend = flag("no-send");
if (forceChat && !dryRun && !noSend && !flag("targeted-send-ok")) {
  console.error("定向会话（--chat）默认不允许真发。要真发请显式加 --targeted-send-ok。");
  process.exit(5);
}
const once = flag("once");
const dataDir = resolve(arg("data", "data"));
const graphPath = resolve(arg("graph", "profiles/wechat/pages.json"));
const skillsDir = resolve(arg("skills", "skills/wechat"));

interface FileConfig {
  policy?: Partial<PolicyConfig>;
  /** 主动搭话（dsh-speak-up 掷骰子决定，引擎这边只负责限额与发送） */
  proactive?: { maxPerHour?: number; maxPerDay?: number; minGapMs?: number; allowGroups?: boolean };
  /** 回复里「带表情」的节制：概率 + 同会话冷却 */
  reply?: { stickerChance?: number; stickerCooldownMin?: number; stickerFallback?: boolean; skipCooldownMin?: number };
  autochat?: Partial<AutoChatConfig> & { collectEveryMin?: number };
  brain?:
    | { kind: "scripted"; template?: string }
    | { kind: "http"; url: string; model: string; apiKey?: string; system?: string }
    | { kind: "handoff" };
  ocrScript?: string;
  ocrScale?: number;
  token?: string;
}

let fileConfig: FileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as FileConfig;
} catch {
  // 没有配置文件就用默认值
}

/**
 * 静默时段也能用命令行临时盖掉（优先于 data/config.json 的 policy.quietHours）：
 *   --quiet-hours 2-7    2 点到 7 点不说话（跨零点也行，比如 23-8）
 *   --quiet-hours off    关掉静默时段
 */
const quietArg = arg("quiet-hours", "");
if (quietArg) {
  const parsed = parseQuietHours(quietArg);
  if (parsed === undefined) {
    console.error(`--quiet-hours 参数看不懂："${quietArg}"。用法：2-7（或 23-8、1-6），关掉用 off。`);
    process.exit(6);
  }
  fileConfig.policy = { ...(fileConfig.policy ?? {}), quietHours: parsed };
  console.log(
    parsed ? `[policy] 静默时段（命令行覆盖）：${parsed[0]}–${parsed[1]} 点` : "[policy] 静默时段：关闭",
  );
}

function parseQuietHours(raw: string): [number, number] | null | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "off" || s === "none" || s === "no" || s === "0") return null;
  const m = /^(\d{1,2})\s*(?:-|–|~|～|到)\s*(\d{1,2})$/.exec(s);
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = Number(m[2]) % 24;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > 23) return undefined;
  if (from === to) return undefined; // 起止相同没有意义
  return [from, to];
}

// 安全闸：真发模式下白名单为空 = 什么会话都可能回。先于连设备检查。
const earlyWhitelist = (fileConfig.policy?.whitelist ?? []) as string[];
if (!dryRun && !noSend && earlyWhitelist.length === 0 && !flag("allow-all")) {
  console.error("白名单为空。真发模式下这会回复任何会话（包括群）。");
  console.error("二选一：配置 data/config.json 的 policy.whitelist，或加 --allow-all 明确同意。");
  console.error("先试跑：node tools/daemon.ts --adb \"<adb>\" --once --dry-run");
  process.exit(4);
}

const graph = JSON.parse(readFileSync(graphPath, "utf8")) as PageGraph;
const registry = SkillRegistry.loadDir(skillsDir);
if (registry.issues.length > 0) console.error("技能问题：\n" + registry.issues.join("\n"));

const adb = new Adb({ adbPath, serial });
const injector = new InjectorClient({ port: INJECTOR_PORT });
const ime = new ImeClient(adb);

// 启动先重置一次 adb server：上一轮如果被强杀 / 超时打断，server 那边可能还挂着楔子，
// 换一个新的最省事 —— 也就是人手排查时做的那一下。要跳过加 --no-adb-reset。
if (!flag("no-adb-reset")) {
  const reset = await adb.recover({ timeoutMs: 20000 });
  console.log(`[adb] 启动前重置 server：${reset.log}`);
}

try {
  await adb.forward(INJECTOR_PORT, INJECTOR_PORT);
} catch (err) {
  console.error(`\n连不上手机：${(err as Error).message}`);
  console.error('先确认 adb devices 能看到设备，再跑 node tools/inject/deploy.ts --adb "<adb>"');
  process.exit(3);
}

await injector.ping().catch(() => {
  console.error('注入器没响应：先跑 node tools/inject/deploy.ts --adb "<adb>"');
  process.exit(3);
});

// 事件日志：一次启动一个 run
const runId = makeRunId();
const day = dayStamp();
const eventFile = join(dataDir, "events", day, `run-${runId}.jsonl`);
mkdirSync(join(dataDir, "events", day), { recursive: true });
const eventLog = new EventLog({ file: eventFile, run: runId });

const world = new World({ file: join(dataDir, "world.json") });
world.load();

const actuator = new Actuator({ adb, injector, ime }, { rng: createRng(Date.now() % 100000), eventLog, dryRun });
const ocr = new Ocr({
  script: resolve(fileConfig.ocrScript ?? "tools/ocr/ocr.ps1"),
  workDir: join(dataDir, "tmp"),
  scale: fileConfig.ocrScale ?? 4,
});

const stickers = new StickerLibrary(join(dataDir, "stickers", "index.json"));
stickers.load();
const labeler = new StickerLabeler();
const skillsRunner = new SkillRunner({ device: { adb, injector, ime }, actuator, graph, eventLog, ocr, stickers, labeler });

const handoffMode = fileConfig.brain?.kind === "handoff";
const pending = handoffMode ? new PendingQueue() : undefined;
/** 群聊「交给主模型判断」的次数上限：群里一直有人在聊时，不该每轮都叫醒一次模型 */
const judgmentTimes = new Map<string, number[]>();
// 用户 2026-11-18：上限放多一点 —— 反正主模型已经开始思考了，发不发只是执行；
// 真正的闸是 policy.maxPerHour（每条消息都要过），这里只防「同一个群把人叫太多次」。
const MAX_JUDGMENTS_PER_HOUR = 60;

const brain: Brain =
  handoffMode
    ? new ScriptedBrain({ template: "" })
    : fileConfig.brain?.kind === "http"
    ? new HttpBrain({
        url: fileConfig.brain.url,
        model: fileConfig.brain.model,
        apiKey: fileConfig.brain.apiKey,
        system: fileConfig.brain.system,
      })
    : new ScriptedBrain(
        fileConfig.brain?.kind === "scripted" && fileConfig.brain.template
          ? { template: fileConfig.brain.template }
          : undefined,
      );

const autoCfg: AutoChatConfig = {
  ...DEFAULT_AUTOCHAT,
  ...fileConfig.autochat,
  policy: { ...(fileConfig.autochat?.policy ?? {}), ...(fileConfig.policy ?? {}) },
  rowTapX: fileConfig.autochat?.rowTapX ?? Math.round(graph.device.screen.w * 0.3),
  forceChat: arg("chat", "") || undefined,
  noSend,
  allowLaunch: flag("launch-wechat"),
  handoff: handoffMode && pending
    ? async (ctx) => {
        if (ctx.needsJudgment) {
          const now = Date.now();
          const recent = (judgmentTimes.get(ctx.chat) ?? []).filter((t) => now - t < 60 * 60 * 1000);
          if (recent.length >= MAX_JUDGMENTS_PER_HOUR) {
            judgmentTimes.set(ctx.chat, recent);
            return "";
          }
          recent.push(now);
          judgmentTimes.set(ctx.chat, recent);
        }
        const item = pending.add(ctx);
        return item.id;
      }
    : undefined,
};

// 安全闸：真发模式下白名单为空 = 什么会话都可能回。默认拒绝启动。
const whitelist = autoCfg.policy.whitelist ?? [];
if (!dryRun && !noSend && whitelist.length === 0 && !flag("allow-all")) {
  console.error("白名单为空。真发模式下这会回复任何会话（包括群）。");
  console.error("二选一：配置 data/config.json 的 policy.whitelist，或加 --allow-all 明确同意。");
  console.error("先试跑：node tools/daemon.ts --adb \"<adb>\" --once --dry-run");
  process.exit(4);
}

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

let labelerUp: boolean | null = null;
let visionWarned = false;
async function visionAvailable(): Promise<boolean> {
  if (labelerUp !== null) return labelerUp;
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    labelerUp = res.ok;
  } catch {
    labelerUp = false;
  }
  return labelerUp;
}

/** 空闲时的「收藏巡检」：没有白名单未读时，定时进最近聊过的白名单会话收一遍表情。 */
let lastCollectPass = 0;
const COLLECT_EVERY_MS = (fileConfig.autochat?.collectEveryMin ?? 10) * 60_000;

async function collectPass(): Promise<void> {
  // 手机锁屏/在别的 App 上时不巡检：既收不到，也可能在锁屏上乱点
  const frame = await adb.screencap();
  const focus = await adb.focus();
  const page = detectPage(decodeFrame(frame), focus);
  if (page.page !== "list") return;
  const wl = autoCfg.policy.whitelist ?? [];
  const chats = Object.values(world.snapshot().chats ?? {}) as Array<{ name: string; lastSeenAt: number }>;
  const pool = chats.filter((c) => wl.length === 0 || wl.includes(c.name));
  // 世界还没热起来（刚重启）就退到白名单里的第一个会话，别什么都不做
  const chat = pool.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0]?.name ?? wl[0];
  if (!chat) return;
  if (!(await enterChat(chat))) return;
  const skill = registry.get("wechat.collect_sticker");
  if (!skill) return;
  const result = await skillsRunner.run(skill, { funnyThreshold: "0.7" });
  const collected = Boolean((result.outputs["step1"] as { collected?: boolean } | undefined)?.collected);
  eventLog.append("note", { stage: "collect-pass", chat, collected, reason: result.reason ?? null }, { src: "proactive" });

  // 收完离开这个会话，别把界面留在群里：留在群里（尤其是表情面板还开着）时，
  // 下一轮得先退回列表，浮层一旦认错就会一直空转（2026-11-18 真机撞到过）。
  // 注意 unknown 也算"没收干净"：表情面板就是被认成 unknown 的那种。
  for (let i = 0; i < 3; i++) {
    const g = detectPage(decodeFrame(await adb.screencap()), await adb.focus());
    if (g.page === "list" || g.page === "other") break;
    await adb.shell("input keyevent KEYCODE_BACK", 15000).catch(() => Buffer.alloc(0));
    await new Promise((r) => setTimeout(r, 400));
  }
}

let offlineStrikes = 0;
/** 这一轮掉线是从什么时候开始的（告警里报「已经多久不可用」） */
let offlineSinceAt = 0;
/** 上次自动重置 adb server / 上次明确告警的时间 */
let lastRecoverAt = 0;
let lastAlertAt = 0;

const auto = new AutoChat({
  device: { adb, injector, ime },
  actuator,
  ocr,
  graph,
  world,
  brain,
  collectSticker: async () => {
    // 收藏要先过视觉打标（判断好不好玩）。本机没起 Ollama 时直接说清楚，
    // 不要真去长按气泡、更不要卡 60s 等模型超时 —— 那会把整轮 tick 拖死。
    if (!(await visionAvailable())) {
      const reason = visionWarned ? "" : "本机视觉模型没起（127.0.0.1:11434），表情先不自动收藏";
      visionWarned = true;
      return { ok: false, reason };
    }
    const skill = registry.get("wechat.collect_sticker");
    if (!skill) return { ok: false, reason: "没有 collect_sticker 技能" };
    const result = await skillsRunner.run(skill, { funnyThreshold: "0.7" });
    const collected = Boolean((result.outputs["step1"] as { collected?: boolean } | undefined)?.collected);
    return { ok: collected, reason: result.reason };
  },
  sendReply: async (text: string, chat: string) => sendReply(chat, { text }),
  eventLog,
  // 搜索兜底要打字：把输入法和切换器交给 autochat，navigate.enterChat 点行失败时会走搜索
  ime,
  withIme: withAutomationIme,
  config: autoCfg,
});

const state: DaemonState = { paused: false, dryRun, startedAt: Date.now() };

const control = async (action: string, opts: { chat?: string } = {}): Promise<{ ok: boolean; message: string }> => {
  switch (action) {
    case "pause":
      state.paused = true;
      return { ok: true, message: "已暂停" };
    case "resume":
      state.paused = false;
      return { ok: true, message: "已继续" };
    case "restart":
      // 改完引擎代码要重启才能生效；而 supervisor 是以管理员权限跑的，
      // 普通权限的 shell 杀不掉它拉起来的 daemon（2026-11-19 实测 Stop-Process 静默失败）。
      // 所以给个自尽的开关：退出后 supervisor 2 分钟内会把它拉起来，代码就是新的。
      eventLog.append("note", { stage: "restart-requested", runId }, { src: "control" });
      setTimeout(() => process.exit(0), 1200);
      return { ok: true, message: "收到，1 秒后退出，等 supervisor 拉起新进程" };
    case "dry_run":
      actuator.setDryRun(true);
      state.dryRun = true;
      return { ok: true, message: "干跑模式" };
    case "wet":
      actuator.setDryRun(false);
      state.dryRun = false;
      return { ok: true, message: "恢复真发" };
    case "tick": {
      if (opts.chat) auto.forceChatOnce = opts.chat;
      const r = await exclusive("tick", () => auto.tick());
      state.lastTick = { at: Date.now(), acted: r.acted, reason: r.reason, replied: r.replied, chat: r.chat };
      return { ok: true, message: JSON.stringify(r) };
    }
    default:
      return { ok: false, message: `未知动作 ${action}` };
  }
};

const probe = async () => {
  const frame = await adb.screencap();
  const focus = await adb.focus();
  const guess = detectPage(decodeFrame(frame), focus);
  return { focus: focus.component, page: guess.page, online: true };
};

/** 进会话：点完必须核对标题，进错/认不出标题一律不发（见 src/daemon/navigate.ts）。 */
async function enterChat(name: string): Promise<boolean> {
  const result = await navigateEnterChat(
    { adb, injector, ocr, graph, ime, withIme: withAutomationIme, log: (m) => console.log(m) },
    name,
  );
  if (!result.ok) {
    console.log(`[enterChat] ${result.reason}`);
    eventLog.append("note", { stage: "enter-chat", chat: name, reason: result.reason ?? null }, { src: "handoff" });
  }
  return result.ok;
}

// 设备互斥：同一时刻只允许一个「长动作」（tick / 发送 / 读链接）碰手机
let deviceBusy = false;
let deviceBusySince = 0;
let deviceBusyLabel = "";
const BUSY_STALE_MS = 120000;

/**
 * 设备互斥。waitMs > 0 时排队等锁（send / read-link 这类「主模型等着」的动作必须等，
 * 不能像 tick 一样一撞到忙就放弃 —— 一放弃，模型那边就是一次静默的「没回成」）。
 */
async function exclusive<T>(label: string, fn: () => Promise<T>, waitMs = 0): Promise<T> {
  const deadline = Date.now() + waitMs;
  let waited = 0;
  for (;;) {
    const now = Date.now();
    if (deviceBusy && now - deviceBusySince > BUSY_STALE_MS) {
      console.log(`[lock] 强制释放疑似卡死的锁（${deviceBusyLabel}，${Math.round((now - deviceBusySince) / 1000)}s）`);
      deviceBusy = false;
    }
    if (!deviceBusy) break;
    if (Date.now() >= deadline) {
      throw new Error(`设备忙（${deviceBusyLabel} 正在跑，已等 ${Math.round(waited / 1000)}s）`);
    }
    await new Promise((r) => setTimeout(r, 400));
    waited = Date.now() - (deadline - waitMs);
  }
  deviceBusy = true;
  deviceBusySince = Date.now();
  deviceBusyLabel = label;
  try {
    return await fn();
  } finally {
    deviceBusy = false;
    deviceBusyLabel = "";
  }
}

// 掉线时的节奏：每 60s 试一次；自动重置 adb server 至少隔 30s；每 5 分钟明确告警一次
const OFFLINE_RETRY_MS = 60000;
const RECOVER_MIN_GAP_MS = 30000;
const ALERT_EVERY_MS = 5 * 60 * 1000;

/** adb server 重置后，注入器的端口转发也跟着没了，得重建（否则触摸链路是哑的） */
async function restoreForward(): Promise<void> {
  await adb.forward(INJECTOR_PORT, INJECTOR_PORT);
}

/**
 * 掉线时自动重启 adb server（kill-server → start-server → forward）。
 *
 * 这一步是「人手排查时唯一有用的一下」：能救 server 卡死、孤儿客户端占设备、
 * transport 被截断之后残留的 offline —— 也就是这几天反复出现的那些情况。
 * 设备接口整个不在（手机把 ADB 收走了）时它救不回来，那种只能等人重插线，所以照常告警。
 */
async function maybeRecoverDevice(reason: string): Promise<boolean> {
  const now = Date.now();
  if (now - lastRecoverAt < RECOVER_MIN_GAP_MS) return false;
  lastRecoverAt = now;
  try {
    // 重置和重建转发放在同一把锁里：中间不能被 tick / 发送插进来（那会抢设备）
    const r = await exclusive(
      "adb-recover",
      async () => {
        const res = await adb.recover();
        if (res.ok) {
          await restoreForward().catch((err: Error) => console.log(`[adb] 端口转发没重建起来：${err.message.slice(0, 120)}`));
        }
        return res;
      },
      30000,
    );
    console.log(`[adb] 自动恢复${r.ok ? "成功" : "失败"}（${reason}）：${r.log}`);
    return r.ok;
  } catch (err) {
    console.log(`[adb] 自动恢复没跑成：${(err as Error).message.slice(0, 160)}`);
    return false;
  }
}

type ReplyKind = { text?: string; stickerMood?: string };

// 回复带表情的节制：模型想带，也要过这两道（用户 2026-11-17：别每条都带）
const replyCfg = {
  stickerChance: fileConfig.reply?.stickerChance ?? 0.5,
  stickerCooldownMin: fileConfig.reply?.stickerCooldownMin ?? 10,
  /** 模型没给情绪时，引擎按文字猜一个补上（2026-11-19：爬山群 21 条全军覆没，全是裸文字） */
  stickerFallback: fileConfig.reply?.stickerFallback ?? true,
};
const lastStickerAt = new Map<string, number>();



async function sendReply(
  chat: string,
  kind: ReplyKind,
): Promise<{ ok: boolean; reason?: string; textSent?: boolean; stickerSent?: boolean; mood?: string }> {
  return exclusive("send", () => sendReplyInner(chat, kind), 90000);
}

async function sendReplyInner(
  chat: string,
  kind: ReplyKind,
): Promise<{ ok: boolean; reason?: string; textSent?: boolean; stickerSent?: boolean; mood?: string }> {
  if (!(await enterChat(chat))) return { ok: false, reason: `进不到会话「${chat}」` };

  let textSent = false;
  let stickerSent = false;
  let reason: string | undefined;

  // 先说话，再补一个表情（用户 2026-11-17：回复后可以带个对应情绪的表情）
  const text = (kind.text ?? "").trim();

  // 情绪：模型给了用模型的；没给就按文字兜底猜一个。
  // 2026-11-19 实测：当天 10 条回复里 7 条 mood=null（爬山群 10:40 之后全是裸文字），
  // 概率 0.8 / 冷却 5min 这两道闸一次都没触发 —— 根本没走到那一步。
  // 光在提示词里喊「默认带表情」不够：模型漏给就等于永远没有，兜底得落在引擎这边。
  const mood = kind.stickerMood ?? (replyCfg.stickerFallback && text ? inferMood(text) : undefined);
  if (kind.stickerMood === undefined && mood !== undefined) {
    eventLog.append("note", { stage: "sticker-mood-fallback", chat, mood }, { src: "handoff" });
  }

  if (text) {
    const skill = registry.get("wechat.send_text");
    if (!skill) return { ok: false, reason: "没有 wechat.send_text 技能" };
    const result = await withAutomationIme(async () => {
      const r = await skillsRunner.run(skill, { text });
      return { ok: r.ok, reason: r.reason };
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    textSent = true;
  }

  // 回复里「顺带一个表情」要过概率 + 冷却；只发一个表情（不写字）不过闸，那是模型明确选择
  if (mood !== undefined && text) {
    const last = lastStickerAt.get(chat) ?? 0;
    const cooldownMs = replyCfg.stickerCooldownMin * 60 * 1000;
    const cooling = cooldownMs > 0 && Date.now() - last < cooldownMs;
    const missChance = replyCfg.stickerChance < 1 && Math.random() >= replyCfg.stickerChance;
    if (cooling || missChance) {
      eventLog.append(
        "note",
        {
          stage: "sticker-gate",
          chat,
          skipped: cooling ? "cooldown" : "chance",
          cooldownMin: replyCfg.stickerCooldownMin,
          chance: replyCfg.stickerChance,
        },
        { src: "handoff" },
      );
      if (textSent) return { ok: true, textSent, stickerSent: false, mood };
    }
  }

  // 发表情不走输入法，也不需要切 IME；但发完文字键盘还开着，
  // 表情按钮/面板的位置会被顶上去 —— 先收键盘（真机踩过：面板没打开，扫的是聊天区）
  if (mood !== undefined) {
    try {
      const imeDump = await adb.shell("dumpsys input_method", 20000);
      const shown = /mInputShown=true/.test(imeDump);
      eventLog.append("note", { stage: "ime-guard", shown, back: shown }, { src: "handoff" });
      if (shown) {
        await adb.shell("input keyevent KEYCODE_BACK", 15000);
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch {
      // 收不掉就算了，下面的页面检查会兜底
    }
    // 发表情前必须确认还在会话页：BACK 不一定只收键盘 —— 很多时候发完文字键盘已经被
    // send_text 收掉，这一下 BACK 会把会话页一起退到列表，表情技能的前置条件「期望 chat」
    // 直接失败，于是「文字发出去了、表情永远发不出去」（2026-11-18 真机 18:48/18:49 两次）。
    const beforeSticker = detectPage(decodeFrame(await adb.screencap()), await adb.focus());
    eventLog.append("note", { stage: "sticker-page", page: beforeSticker.page }, { src: "handoff" });
    if (beforeSticker.page !== "chat" && !(await enterChat(chat))) {
      return {
        ok: textSent,
        reason: textSent ? `文字已发；退到 ${beforeSticker.page} 后进不回「${chat}」，表情没发` : `进不到会话「${chat}」`,
        textSent,
        mood,
      };
    }
    const skill = registry.get("wechat.send_sticker_mood");
    if (!skill) return { ok: textSent, reason: textSent ? "文字已发，但没有 send_sticker_mood 技能" : "没有 send_sticker_mood 技能", textSent, mood };
    const result = await skillsRunner.run(skill, { mood });
    if (!result.ok) {
      reason = textSent ? `文字已发，表情没发出去：${result.reason ?? "未知原因"}` : result.reason;
      return { ok: false, reason, textSent, stickerSent, mood };
    }
    stickerSent = true;
    lastStickerAt.set(chat, Date.now());
  }

  if (!textSent && !stickerSent) return { ok: false, reason: "text 和 stickerMood 都是空的" };
  return { ok: true, textSent, stickerSent, ...(mood !== undefined ? { mood } : {}) };
}

// ---- 主动搭话：谁决定开口是 dsh-speak-up 的事，这里只管「限额 + 真的发出去」 ----
const proactiveCfg = {
  maxPerHour: fileConfig.proactive?.maxPerHour ?? 2,
  maxPerDay: fileConfig.proactive?.maxPerDay ?? 6,
  minGapMs: fileConfig.proactive?.minGapMs ?? 20 * 60 * 1000,
  allowGroups: fileConfig.proactive?.allowGroups ?? false,
};
const proactiveTimes: number[] = [];

async function say(
  chat: string,
  kind: ReplyKind,
): Promise<{ ok: boolean; reason?: string; refused?: string }> {
  const now = Date.now();
  const qh = autoCfg.policy.quietHours ?? null;
  if (qh && inQuietHours(new Date(now).getHours(), qh)) {
    return { ok: false, refused: "quiet-hours", reason: `安静时段（${qh[0]}–${qh[1]} 点）不主动开口` };
  }
  const recentHour = proactiveTimes.filter((t) => now - t < 3600_000).length;
  const recentDay = proactiveTimes.filter((t) => now - t < 86400_000).length;
  const last = proactiveTimes[proactiveTimes.length - 1] ?? 0;
  if (recentHour >= proactiveCfg.maxPerHour) {
    return { ok: false, refused: "hour-cap", reason: `这一小时已经主动说过 ${recentHour} 次` };
  }
  if (recentDay >= proactiveCfg.maxPerDay) {
    return { ok: false, refused: "day-cap", reason: `今天已经主动说过 ${recentDay} 次` };
  }
  if (last && now - last < proactiveCfg.minGapMs) {
    return {
      ok: false,
      refused: "gap",
      reason: `距上次主动开口还不到 ${Math.round(proactiveCfg.minGapMs / 60000)} 分钟`,
    };
  }
  const kindOf = world.chat(chat).kind === "unknown" ? detectChatKind(chat) : world.chat(chat).kind;
  if (kindOf === "group" && !proactiveCfg.allowGroups) {
    return { ok: false, refused: "group", reason: "主动搭话默认不进群（proactive.allowGroups=false）" };
  }

  try {
    const result = await exclusive("say", () => sendReplyInner(chat, kind), 45000);
    if (result.ok) {
      proactiveTimes.push(Date.now());
      if (proactiveTimes.length > 200) proactiveTimes.splice(0, proactiveTimes.length - 200);
      eventLog.append(
        "send.succeeded",
        { chat, via: "proactive", ...(kind.text ? { text: kind.text } : { stickerMood: kind.stickerMood }) },
        { src: "proactive" },
      );
    } else {
      eventLog.append("note", { stage: "proactive", chat, error: result.reason ?? "发送失败" }, { src: "proactive" });
    }
    return result;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 读链接：进会话 → 先试微信自带 AI 摘要 → 不行再读正文 → 回到会话 */
async function readLink(chat: string, which?: number): Promise<{ ok: boolean; text?: string; reason?: string; via?: string }> {
  return exclusive("read-link", () => readLinkInner(chat, which), 30000);
}

function collectText(outputs: Record<string, unknown>): string {
  const chunks: string[] = [];
  for (const value of Object.values(outputs)) {
    const text = (value as { text?: unknown } | null)?.text;
    if (typeof text === "string" && text.trim()) chunks.push(text.trim());
  }
  return chunks.join("\n---\n");
}

/** 摘要这条路走不通时，先退回会话页，正文技能的前置条件要求停在 chat。 */
async function backToChat(maxSteps = 3): Promise<boolean> {
  for (let i = 0; i < maxSteps; i++) {
    const frame = await adb.screencap();
    const guess = detectPage(decodeFrame(frame), await adb.focus());
    if (guess.page === "chat") return true;
    await adb.shell("input keyevent KEYCODE_BACK", 15000);
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function readLinkInner(chat: string, which?: number): Promise<{ ok: boolean; text?: string; reason?: string; via?: string }> {
  if (!(await enterChat(chat))) return { ok: false, reason: `进不到会话「${chat}」` };
  const params = which ? { which } : {};

  // AI 摘要是捷径：快一倍、文字也更干净；但有的文章没有这个按钮（视频/非公众号），要能退
  const summary = registry.get("wechat.read_summary");
  if (summary) {
    const result = await skillsRunner.run(summary, params);
    const text = collectText(result.outputs);
    if (result.ok && text) return { ok: true, text: text.slice(0, 6000), via: "summary" };
    eventLog.append("note", { stage: "read-link", chat, fallback: "article", reason: result.reason ?? "摘要为空" }, { src: "handoff" });
    if (!(await backToChat())) return { ok: false, reason: `摘要读不到，也退不回会话：${result.reason ?? "未知"}` };
  }

  const skill = registry.get("wechat.read_article");
  if (!skill) return { ok: false, reason: "没有 read_article 技能" };
  const result = await skillsRunner.run(skill, params);
  const text = collectText(result.outputs);
  if (!result.ok && !text) return { ok: false, reason: result.reason };
  return { ok: true, text: text.slice(0, 6000), via: "article" };
}

const daemon = await startDaemonServer(
  { world, auto, registry, runner: skillsRunner, eventLog, eventFile, state, control, probe, pending, sendReply, readLink, say, allowPendingInject: flag("allow-pending-inject"), exclusive, stickers, token: fileConfig.token,
    // 交接路径（/pending/reply）发出去之后也要挂同一个冷却，否则引擎自己发和
    // 主模型发是两套节奏：交接那边不冷却，就会同一会话连着叫醒好几次。
    perChatCooldownMs: autoCfg.perChatCooldownMs,
    // 判「这条不接」之后冷却多久再看下一批。默认 5 分钟（server 里的 DEFAULT_SKIP_COOLDOWN_MS），
    // 真机上群里一热，5 分钟攒 20 条、再来还是判不接 —— 看着就是一小时没人（2026-11-20 用户连问三次）。
    ...(typeof fileConfig.reply?.skipCooldownMin === "number"
      ? { skipCooldownMs: Math.max(0, fileConfig.reply.skipCooldownMin) * 60_000 }
      : {}),
  },
  { port },
);

console.log(
  JSON.stringify(
    {
      ok: true,
      eventLog: eventFile,
      runId,
      http: `http://127.0.0.1:${daemon.port}`,
      intervalSec,
      dryRun,
      brain: brain.name,
      policy: autoCfg.policy,
      once,
    },
    null,
    2,
  ),
);

if (once) {
  const result = await auto.tick();
  console.log(JSON.stringify(result, null, 2));
  await daemon.close();
  process.exit(result.acted ? 0 : 2);
}

let timer: NodeJS.Timeout | null = null;
let stopping = false;

async function loop(): Promise<void> {
  if (stopping) return;
  if (state.paused) {
    timer = setTimeout(loop, intervalSec * 1000);
    return;
  }
  try {
    if (deviceBusy) {
      timer = setTimeout(loop, intervalSec * 1000);
      return;
    }
    const result = await exclusive("tick", () => auto.tick());
    if (offlineStrikes > 0) {
      console.log(`[tick] 设备恢复（掉线 ${offlineStrikes} 轮后）`);
      offlineStrikes = 0;
      offlineSinceAt = 0;
    }
    state.lastTick = { at: Date.now(), acted: result.acted, reason: result.reason, replied: result.replied, chat: result.chat };
    world.save(); // 每轮落盘：强杀进程时也不至于丢光会话状态
    // 没有白名单未读 → 顺手做一次收藏巡检（不然红点被读掉后永远收不到新表情）
    if (
      !result.acted &&
      /没有未读|未读都不在白名单/.test(result.reason) &&
      (pending?.size ?? 0) === 0 && // 有待办在等主模型时别抢设备
      Date.now() - lastCollectPass > COLLECT_EVERY_MS
    ) {
      lastCollectPass = Date.now();
      try {
        await exclusive("collect-pass", collectPass);
      } catch (err) {
        console.log(`[collect-pass] 出错：${(err as Error).message}`);
      }
    }
    console.log(`[tick] ${new Date().toISOString()} acted=${result.acted} replied=${result.replied ?? false} chat=${result.chat ?? "-"} ${result.reason} (${result.ms}ms)`);
  } catch (err) {
    const message = (err as Error).message;
    const kind = classifyDeviceError(message);
    // 命令被我们半路掐断（超时 / 超 buffer）也算掉线：adb server 那边大概率已经卡了
    const killedMidway = err instanceof AdbError && err.recoverable;
    if (kind !== "none" || killedMidway) {
      offlineStrikes++;
      if (offlineStrikes === 1) {
        offlineSinceAt = Date.now();
        console.log(
          `[tick] 设备掉线（第 1 次，${killedMidway ? "adb 被强杀" : kind}）：${message.slice(0, 140)} —— ` +
            `每 ${OFFLINE_RETRY_MS / 1000}s 重试，必要时自动重启 adb server`,
        );
      }
      // reconnect 只救「server 还知道这台设备」的情况，先试一下便宜的那步
      if (kind === "offline") await adb.exec(["reconnect", "offline"]).catch(() => Buffer.alloc(0));
      // 命令被强杀 → server 大概已经卡了，立刻重置；单纯掉线 → 第 2 轮再动手，别为一次抖动反复 kill
      if (killedMidway || offlineStrikes >= 2) {
        const ok = await maybeRecoverDevice(killedMidway ? "命令被强杀" : kind);
        if (ok) console.log("[tick] adb server 已重置，下一轮应该能连上");
      }
      const now = Date.now();
      if (now - lastAlertAt >= ALERT_EVERY_MS) {
        lastAlertAt = now;
        const mins = Math.max(1, Math.round((now - (offlineSinceAt || now)) / 60000));
        console.log(
          `[alert] 手机不可用 ${mins} 分钟（第 ${offlineStrikes} 轮）：${message.slice(0, 120)} —— ` +
            `自动重置救不回来就得人看一眼：USB 线、手机是否亮屏、USB 调试开关`,
        );
      }
    } else {
      console.log(`[tick] 出错：${message}`);
    }
  }
  if (!stopping) timer = setTimeout(loop, offlineStrikes > 0 ? OFFLINE_RETRY_MS : intervalSec * 1000);
}

const shutdown = async () => {
  stopping = true;
  if (timer) clearTimeout(timer);
  world.save();
  eventLog.close();
  // 收掉还在跑的 adb 客户端：孤儿 adb.exe 会一直占着设备，下次启动就是「no devices」
  const killed = await adb.killAllChildren().catch(() => 0);
  if (killed > 0) console.log(`[adb] 退出前清掉 ${killed} 条 adb 客户端`);
  await daemon.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGBREAK", () => void shutdown());

void loop();