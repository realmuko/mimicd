/**
 * 真机跑一条技能。
 *
 *   node tools/run-skill.ts --adb "<adb>" --skill wechat.send_text --param text="你好"
 *
 * 做四件事：连设备（adb + 注入器转发 + 输入法广播）、加载页面图与技能、
 * 起事件日志、跑 runner，最后把结果打出来。
 *
 * 不做的事：不切输入法。跑需要打字的技能前，先用 tools/ime-mode.ts on。
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
import { detectPage, decodeFrame, type PageGraph } from "../src/perception/page.ts";
import { Ocr } from "../src/perception/ocr.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}

function params(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--param") continue;
    const pair = process.argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

const adbPath = arg("adb", process.env["ADB_PATH"] ?? "adb");
const serial = arg("serial");
const skillId = arg("skill", "wechat.send_text");
const dryRun = process.argv.includes("--dry-run");
const seed = Number(arg("seed", String(Date.now() % 100000)));
const graphPath = resolve(arg("graph", "profiles/wechat/pages.json"));
const skillsDir = resolve(arg("skills", "skills/wechat"));
const dataDir = resolve(arg("data", "data"));

const graph = JSON.parse(readFileSync(graphPath, "utf8")) as PageGraph;

const adb = new Adb({ adbPath, serial });
const injector = new InjectorClient({ port: 7801 });
const ime = new ImeClient(adb);

// 注入器的端口转发每次重连一下，防止 adb server 重启后失效
await adb.forward(7801, 7801);
await injector.ping().catch(async () => {
  console.error("注入器没响应。先跑：node tools/inject/deploy.ts --adb \"<adb>\"");
  process.exit(3);
});

const runId = makeRunId();
const logFile = join(dataDir, "events", dayStamp(), `run-${runId}.jsonl`);
mkdirSync(join(dataDir, "events", dayStamp()), { recursive: true });
const eventLog = new EventLog({ file: logFile, run: runId });

const actuator = new Actuator(
  { adb, injector, ime },
  { rng: createRng(seed), eventLog, dryRun },
);

const registry = SkillRegistry.loadDir(skillsDir);
if (registry.issues.length > 0) {
  console.error("技能有问题：\n" + registry.issues.join("\n"));
}
// 命令行参数都是字符串：按技能声明的类型转一下，否则 integer 参数会被拒
const preview = registry.get(skillId);
const rawParams = params();
const coerced: Record<string, unknown> = {};
for (const [k, v] of Object.entries(rawParams)) {
  const spec = preview?.params?.[k];
  if (spec?.type === "integer") coerced[k] = Number(v);
  else if (spec?.type === "boolean") coerced[k] = v === "true";
  else coerced[k] = v;
}
const { skill, params: resolved } = registry.resolve(skillId, coerced);

// 先看一眼现在在哪一页，写进事件流，出问题时好对照
const before = decodeFrame(await adb.screencap());
const focus = await adb.focus();
eventLog.append(
  "frame.captured",
  { tag: "before-run", page: detectPage(before, focus).page, focus: focus.component },
  { src: "run-skill" },
);

const ocr = new Ocr({ script: resolve(arg("ocr-script", "tools/ocr/ocr.ps1")), workDir: join(dataDir, "tmp"), scale: Number(arg("ocr-scale", "3")) });
const runner = new SkillRunner({ device: { adb, injector, ime }, actuator, graph, eventLog, ocr });
const result = await runner.run(skill, resolved);
eventLog.close();

console.log(JSON.stringify({ ...result, runId, seed, log: logFile, dryRun }, null, 2));
process.exit(result.ok ? 0 : 1);