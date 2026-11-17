/**
 * 交接模式的命令行：看有哪些「该回了」，并把主模型写好的那句话发出去。
 *
 *   node tools/reply-pending.ts --list
 *   node tools/reply-pending.ts --id <id> --text "回的话"
 *   node tools/reply-pending.ts --skip <id>
 *
 * 这条路径的意义：引擎只负责「发现 + 决定要回」，话由主模型（DSH 会话）写，
 * 既有记忆和人格，也不用为了聊天在本地跑一个 4B。
 */

import { readFileSync } from "node:fs";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i >= 0 && next && !next.startsWith("--") ? next : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const base = (() => {
  try {
    const cfg = JSON.parse(readFileSync("data/config.json", "utf8")) as { daemonUrl?: string };
    return cfg.daemonUrl ?? "http://127.0.0.1:65480";
  } catch {
    return "http://127.0.0.1:65480";
  }
})();

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 保持原文
  }
  return { status: res.status, body };
}

interface PendingItem {
  id: string;
  chat: string;
  kind: string;
  createdAt: number;
  expiresAt: number;
  messages: Array<{ from: string; text: string }>;
}

if (flag("list") || process.argv.length <= 2) {
  const { status, body } = await call("/pending");
  if (status !== 200) {
    console.error(`引擎返回 ${status}：${JSON.stringify(body)}`);
    process.exit(1);
  }
  const items = ((body as { items?: PendingItem[] }).items ?? []) as PendingItem[];
  if (items.length === 0) {
    console.log("没有待回复。");
    process.exit(0);
  }
  for (const item of items) {
    const age = Math.round((Date.now() - item.createdAt) / 1000);
    console.log(`\n[${item.id.slice(0, 8)}] ${item.chat}（${item.kind}）${age}s 前`);
    for (const m of item.messages.slice(-6)) {
      console.log(`   ${m.from === "me" ? "我" : "对方"}：${m.text.slice(0, 80)}`);
    }
  }
  process.exit(0);
}

const id = arg("id");
const text = arg("text");

if (flag("skip")) {
  const target = arg("skip");
  const { status, body } = await call("/pending/skip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: target }),
  });
  console.log(status === 200 ? `已跳过 ${target.slice(0, 8)}` : `失败：${JSON.stringify(body)}`);
  process.exit(status === 200 ? 0 : 2);
}

if (!id || !text) {
  console.error("用法：--list | --id <id> --text \"...\" | --skip <id>");
  process.exit(1);
}

const { status, body } = await call("/pending/reply", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id, text }),
});
if (status === 200) {
  const result = body as { chat?: string; text?: string };
  console.log(`已发到「${result.chat}」：${result.text}`);
  process.exit(0);
}
console.error(`没发出去（${status}）：${JSON.stringify(body)}`);
process.exit(2);