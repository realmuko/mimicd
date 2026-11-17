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
import { World } from "../src/world/state.ts";
import { AutoChat, DEFAULT_AUTOCHAT, type AutoChatConfig } from "../src/daemon/autochat.ts";
import { startDaemonServer, type DaemonState } from "../src/daemon/server.ts";
import { PendingQueue } from "../src/daemon/pending.ts";
import { HttpBrain, ScriptedBrain, type Brain } from "../src/brain/brain.ts";
import type { PolicyConfig } from "../src/policy/policy.ts";

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
  autochat?: Partial<AutoChatConfig>;
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

const auto = new AutoChat({
  device: { adb, injector, ime },
  actuator,
  ocr,
  graph,
  world,
  brain,
  collectSticker: async () => {
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

async function enterChat(name: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const f = await adb.screencap();
    if (detectPage(decodeFrame(f), await adb.focus()).page === "list") break;
    await adb.shell("input keyevent KEYCODE_BACK", 15000);
    await new Promise((r) => setTimeout(r, 400));
  }
  const shot = await adb.screencap();
  const area = rectOf(graph, "list", "list_area", graph.device.screen.w, graph.device.screen.h);
  const listOcr = await ocr.recognize(shot.png, area);
  const want = name.replace(/\s+/g, "");
  const line = listOcr.lines.find((l) => isNameLine(l) && cleanName(l.text).includes(want));
  if (!line) {
    console.log(`[enterChat] 列表里没找到「${name}」，OCR 到: ${listOcr.lines.filter(isNameLine).map((l) => cleanName(l.text)).slice(0, 8).join(" / ")}`);
    return false;
  }
  await injector.tap(Math.round(graph.device.screen.w * 0.3), Math.round(line.y + line.h / 2), 70);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const f = await adb.screencap();
    if (detectPage(decodeFrame(f), await adb.focus()).page === "chat") return true;
  }
  console.log(`[enterChat] 点了「${name}」但没进会话页`);
  return false;
}

// 设备互斥：同一时刻只允许一个「长动作」（tick / 发送 / 读链接）碰手机
let deviceBusy = false;
let deviceBusySince = 0;
let deviceBusyLabel = "";
const BUSY_STALE_MS = 120000;

async function exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (deviceBusy && now - deviceBusySince > BUSY_STALE_MS) {
    console.log(`[lock] 强制释放疑似卡死的锁（${deviceBusyLabel}，${Math.round((now - deviceBusySince) / 1000)}s）`);
    deviceBusy = false;
  }
  if (deviceBusy) throw new Error(`设备忙（${deviceBusyLabel} 正在跑，${Math.round((now - deviceBusySince) / 1000)}s）`);
  deviceBusy = true;
  deviceBusySince = now;
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
  return exclusive("send", () => sendReplyInner(chat, kind));
}

async function sendReplyInner(chat: string, kind: ReplyKind): Promise<{ ok: boolean; reason?: string }> {
  if (!(await enterChat(chat))) return { ok: false, reason: `进不到会话「${chat}」` };
  // 发表情不走输入法，也不需要切 IME
  if (kind.stickerMood !== undefined && kind.text === undefined) {
    const skill = registry.get("wechat.send_sticker_mood");
    if (!skill) return { ok: false, reason: "没有 send_sticker_mood 技能" };
    const result = await skillsRunner.run(skill, { mood: kind.stickerMood });
    return { ok: result.ok, reason: result.reason };
  }
  const skill = registry.get("wechat.send_text");
  if (!skill) return { ok: false, reason: "没有 wechat.send_text 技能" };
  const text = kind.text ?? "";
  return withAutomationIme(async () => {
    const result = await skillsRunner.run(skill, { text });
    return { ok: result.ok, reason: result.reason };
  });
}

/** 读链接：进会话 → 先试微信自带 AI 摘要 → 不行再读正文 → 回到会话 */
async function readLink(chat: string, which?: number): Promise<{ ok: boolean; text?: string; reason?: string; via?: string }> {
  return exclusive("read-link", () => readLinkInner(chat, which));
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
  { world, auto, registry, runner: skillsRunner, eventLog, eventFile, state, control, probe, pending, sendReply, readLink, allowPendingInject: flag("allow-pending-inject"), exclusive, token: fileConfig.token },
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
    state.lastTick = { at: Date.now(), acted: result.acted, reason: result.reason, replied: result.replied, chat: result.chat };
    console.log(`[tick] ${new Date().toISOString()} acted=${result.acted} replied=${result.replied ?? false} chat=${result.chat ?? "-"} ${result.reason} (${result.ms}ms)`);
  } catch (err) {
    console.log(`[tick] 出错：${(err as Error).message}`);
  }
  if (!stopping) timer = setTimeout(loop, intervalSec * 1000);
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