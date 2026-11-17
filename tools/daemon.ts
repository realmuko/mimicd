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
import { detectPage, decodeFrame, type PageGraph } from "../src/perception/page.ts";
import { World } from "../src/world/state.ts";
import { AutoChat, DEFAULT_AUTOCHAT, type AutoChatConfig } from "../src/daemon/autochat.ts";
import { startDaemonServer, type DaemonState } from "../src/daemon/server.ts";
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
const once = flag("once");
const dataDir = resolve(arg("data", "data"));
const graphPath = resolve(arg("graph", "profiles/wechat/pages.json"));
const skillsDir = resolve(arg("skills", "skills/wechat"));

interface FileConfig {
  policy?: Partial<PolicyConfig>;
  autochat?: Partial<AutoChatConfig>;
  brain?:
    | { kind: "scripted"; template?: string }
    | { kind: "http"; url: string; model: string; apiKey?: string; system?: string };
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

const graph = JSON.parse(readFileSync(graphPath, "utf8")) as PageGraph;
const registry = SkillRegistry.loadDir(skillsDir);
if (registry.issues.length > 0) console.error("技能问题：\n" + registry.issues.join("\n"));

const adb = new Adb({ adbPath, serial });
const injector = new InjectorClient({ port: 7801 });
const ime = new ImeClient(adb);
await adb.forward(7801, 7801);
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

const skillsRunner = new SkillRunner({ device: { adb, injector, ime }, actuator, graph, eventLog, ocr });

const brain: Brain =
  fileConfig.brain?.kind === "http"
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
};

const auto = new AutoChat({
  device: { adb, injector, ime },
  actuator,
  ocr,
  graph,
  world,
  brain,
  sendReply: async (text: string) => {
    const skill = registry.get("wechat.send_text");
    if (!skill) return { ok: false, reason: "没有 wechat.send_text 技能" };
    const result = await skillsRunner.run(skill, { text });
    return { ok: result.ok, reason: result.reason };
  },
  eventLog,
  config: autoCfg,
});

const state: DaemonState = { paused: false, dryRun, startedAt: Date.now() };

const control = async (action: string): Promise<{ ok: boolean; message: string }> => {
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
      const r = await auto.tick();
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

const daemon = await startDaemonServer(
  { world, auto, registry, runner: skillsRunner, eventLog, eventFile, state, control, probe, token: fileConfig.token },
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
    const result = await auto.tick();
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