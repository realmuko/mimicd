/**
 * 事件回放：把 JSONL 事件流变成人能读的时间线。
 *
 *   node tools/replay.ts data/events/2026-11-17/run-xxx.jsonl
 *   node tools/replay.ts <file> --kind message.seen,intent.decided
 *   node tools/replay.ts <file> --json
 *
 * 只读。用来回答「那一轮她为什么没回」「那条消息是什么时候看到的」。
 */

import { readFileSync } from "node:fs";

import { readEvents } from "../src/eventlog.ts";
import type { EventEnvelope } from "../src/events.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("用法: node tools/replay.ts <run.jsonl> [--kind a,b] [--json]");
  process.exit(1);
}

const kinds = arg("kind")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const events = readEvents(file, kinds.length > 0 ? { kinds } : {});

if (flag("json")) {
  console.log(JSON.stringify(events, null, 2));
  process.exit(0);
}

const t0 = events[0]?.mono ?? 0;
for (const event of events) {
  console.log(formatEvent(event, t0));
}

console.log("");
console.log(summarize(events));

/** 一行一条：+1234ms  message.seen  chat=张三 from=other "在吗" */
export function formatEvent(event: EventEnvelope, baseMono = 0): string {
  const rel = String(Math.round(event.mono - baseMono)).padStart(6, " ");
  const kind = event.kind.padEnd(16, " ");
  const detail = formatData(event.data);
  return `+${rel}ms ${kind} ${detail}`;
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue; // 大对象不铺开
    if (typeof value === "string" && value.length > 80) {
      parts.push(`${key}="${value.slice(0, 80)}…"`);
    } else if (typeof value === "string") {
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(" ");
}

/** 汇总：每类事件几条、每个会话几条、有没有发送失败。 */
export function summarize(events: EventEnvelope[]): string {
  const counts = new Map<string, number>();
  const chats = new Map<string, { seen: number; decided: number; sent: number }>();
  let failed = 0;

  for (const e of events) {
    counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const chat = typeof e.data["chat"] === "string" ? e.data["chat"] : "";
    if (chat) {
      const row = chats.get(chat) ?? { seen: 0, decided: 0, sent: 0 };
      if (e.kind === "message.seen") row.seen++;
      if (e.kind === "intent.decided") row.decided++;
      if (e.kind === "send.succeeded") row.sent++;
      chats.set(chat, row);
    }
    if (e.kind === "send.failed") failed++;
  }

  const lines: string[] = [];
  lines.push(`共 ${events.length} 条事件，${counts.size} 种类型：`);
  for (const [kind, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind.padEnd(18)} ${n}`);
  }
  if (chats.size > 0) {
    lines.push("按会话：");
    for (const [chat, row] of chats) {
      lines.push(`  ${chat.padEnd(14)} 看到 ${row.seen} · 判定 ${row.decided} · 发出 ${row.sent}`);
    }
  }
  lines.push(failed > 0 ? `⚠ 有 ${failed} 次发送失败` : "没有发送失败");

  // 顺便把第一屏 OCR 与最后一条消息带出来，方便人工核对
  const firstFrame = events.find((e) => e.kind === "frame.captured" && e.data["tag"] === "list");
  if (firstFrame && Array.isArray(firstFrame.data["rows"])) {
    lines.push(`列表未读行：${(firstFrame.data["rows"] as string[]).join("、") || "(无)"}`);
  }
  return lines.join("\n");
}

/** 调试用：把文件大小打出来，确认没读错文件 */
if (flag("verbose")) {
  console.log(`文件 ${file} · ${readFileSync(file).length} 字节`);
}