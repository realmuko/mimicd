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

import { Adb } from "../src/device/adb.ts";
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
const injector = new InjectorClient({ port: 7801 });
const ime = new ImeClient(adb);

try {
  await adb.forward(7801, 7801);
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
const MAX_JUDGMENTS_PER_HOUR = 20; // 用户 2026-11-17：群里可以多接点话

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
}

let offlineStrikes = 0;

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

type ReplyKind = { text?: string; stickerMood?: string };

async function sendReply(chat: string, kind: ReplyKind): Promise<{ ok: boolean; reason?: string }> {
  return exclusive("send", () => sendReplyInner(chat, kind), 90000);
}

async function sendReplyInner(
  chat: string,
  kind: ReplyKind,
): Promise<{ ok: boolean; reason?: string; textSent?: boolean; stickerSent?: boolean }> {
  if (!(await enterChat(chat))) return { ok: false, reason: `进不到会话「${chat}」` };

  let textSent = false;
  let stickerSent = false;
  let reason: string | undefined;

  // 先说话，再补一个表情（用户 2026-11-17：回复后可以带个对应情绪的表情）
  const text = (kind.text ?? "").trim();
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

  // 发表情不走输入法，也不需要切 IME；但发完文字键盘还开着，
  // 表情按钮/面板的位置会被顶上去 —— 先收键盘（真机踩过：面板没打开，扫的是聊天区）
  if (kind.stickerMood !== undefined) {
    try {
      const imeDump = await adb.shell("dumpsys input_method", 20000);
      const shown = /mInputShown=true/.test(imeDump);
      eventLog.append("note", { stage: "ime-guard", shown, back: shown }, { src: "handoff" });
      if (shown) {
        await adb.shell("input keyevent KEYCODE_BACK", 15000);
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch {
      // 收不掉就算了，后面的面板检查会兜底
    }
    const skill = registry.get("wechat.send_sticker_mood");
    if (!skill) return { ok: textSent, reason: textSent ? "文字已发，但没有 send_sticker_mood 技能" : "没有 send_sticker_mood 技能", textSent };
    const result = await skillsRunner.run(skill, { mood: kind.stickerMood });
    if (!result.ok) {
      reason = textSent ? `文字已发，表情没发出去：${result.reason ?? "未知原因"}` : result.reason;
      return { ok: false, reason, textSent, stickerSent };
    }
    stickerSent = true;
  }

  if (!textSent && !stickerSent) return { ok: false, reason: "text 和 stickerMood 都是空的" };
  return { ok: true, textSent, stickerSent };
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
  { world, auto, registry, runner: skillsRunner, eventLog, eventFile, state, control, probe, pending, sendReply, readLink, say, allowPendingInject: flag("allow-pending-inject"), exclusive, stickers, token: fileConfig.token },
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
    const offline = /no devices|offline|device .*not found/i.test(message);
    if (offline) {
      offlineStrikes++;
      if (offlineStrikes === 1) console.log(`[tick] 设备掉线（第 1 次）：${message.slice(0, 120)} —— 开始每 60s 试一次重连`);
      if (offlineStrikes % 3 === 1) {
        await adb.exec(["reconnect", "offline"]).catch(() => {});
      }
    } else {
      console.log(`[tick] 出错：${message}`);
    }
  }
  if (!stopping) timer = setTimeout(loop, (offlineStrikes > 0 ? 60 : intervalSec) * 1000);
}

const shutdown = async () => {
  stopping = true;
  if (timer) clearTimeout(timer);
  world.save();
  eventLog.close();
  await daemon.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

void loop();