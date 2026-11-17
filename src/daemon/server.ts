/**
 * 引擎的 HTTP 接口：给插件（DSH）、监控页、人用的。
 *
 * 契约（DECISIONS D5）：只监听 127.0.0.1；受理 ≠ 发出，
 * 执行结果从 /events 里读；引擎离线时调用方只读降级，不许自己发。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { readEvents } from "../eventlog.ts";
import type { EventLog } from "../eventlog.ts";
import type { SkillRegistry } from "../skills/registry.ts";
import type { SkillRunner } from "../skills/runner.ts";
import type { World } from "../world/state.ts";
import type { AutoChat } from "./autochat.ts";
import type { PendingQueue } from "./pending.ts";

export interface DaemonState {
  paused: boolean;
  dryRun: boolean;
  startedAt: number;
  lastTick?: { at: number; acted: boolean; reason: string; replied?: boolean; chat?: string };
}

export interface DaemonDeps {
  world: World;
  auto: AutoChat;
  registry: SkillRegistry;
  runner: SkillRunner;
  eventLog: EventLog;
  eventFile: string;
  state: DaemonState;
  /** 控制：暂停/继续/干跑/立即跑一轮 */
  control: (action: string, opts?: { chat?: string }) => Promise<{ ok: boolean; message: string }>;
  /** 设备与页面现状 */
  probe: () => Promise<{ focus: string; page: string; online: boolean }>;
  /** 交接模式下的待回复队列 */
  pending?: PendingQueue;
  /** 把一句话发出去（交接模式回复用） */
  sendText?: (text: string, chat: string) => Promise<{ ok: boolean; reason?: string }>;
  token?: string;
}

export interface DaemonServer {
  server: Server;
  close: () => Promise<void>;
  port: number;
}

export async function startDaemonServer(deps: DaemonDeps, opts: { port: number; host?: string }): Promise<DaemonServer> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void handle(req, res, deps);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: DaemonDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (code: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  };

  // 可选 token（放在 Authorization: Bearer 或 ?token=）
  if (deps.token) {
    const header = String(req.headers.authorization ?? "");
    const given = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
    if (given !== deps.token) return send(401, { ok: false, error: "unauthorized" });
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const probe = await deps.probe().catch(() => ({ focus: "", page: "unknown", online: false }));
      return send(200, {
        ok: true,
        paused: deps.state.paused,
        dryRun: deps.state.dryRun,
        uptimeMs: Date.now() - deps.state.startedAt,
        lastTick: deps.state.lastTick ?? null,
        device: probe,
        run: deps.eventLog.run,
      });
    }

    if (req.method === "GET" && url.pathname === "/state") {
      return send(200, {
        ok: true,
        paused: deps.state.paused,
        dryRun: deps.state.dryRun,
        world: deps.world.snapshot(),
      });
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
      const all = readEvents(deps.eventFile, { afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0 });
      return send(200, { ok: true, run: deps.eventLog.run, events: all.slice(-limit) });
    }

    if (req.method === "GET" && url.pathname === "/skills") {
      return send(200, {
        ok: true,
        issues: deps.registry.issues,
        skills: [...deps.registry.skills.values()].map((s) => ({
          id: s.id,
          version: s.version,
          title: s.title,
          intent: s.intent,
          idempotency: s.idempotency,
        })),
      });
    }

    if (req.method === "POST" && url.pathname === "/intent") {
      const body = await readJson(req);
      const skill = String(body["skill"] ?? "");
      const params = (body["params"] ?? {}) as Record<string, unknown>;
      const { skill: resolved, params: parsed } = deps.registry.resolve(skill, params);
      const result = await deps.runner.run(resolved, parsed);
      return send(result.ok ? 200 : 422, { ok: result.ok, result });
    }

    if (req.method === "GET" && url.pathname === "/pending") {
      if (!deps.pending) return send(200, { ok: true, items: [], note: "未开启交接模式" });
      return send(200, { ok: true, items: deps.pending.list() });
    }

    if (req.method === "POST" && url.pathname === "/pending/reply") {
      if (!deps.pending) return send(400, { ok: false, error: "未开启交接模式" });
      if (!deps.sendText) return send(400, { ok: false, error: "没有配置发送器" });
      const body = await readJson(req);
      const id = String(body["id"] ?? "");
      const text = String(body["text"] ?? "").trim();
      const item = deps.pending.get(id);
      if (!item || item.status !== "open") return send(404, { ok: false, error: `没有待回复项 ${id}（可能已过期）` });
      if (!text) return send(400, { ok: false, error: "text 不能为空" });
      const result = await deps.sendText(text, item.chat);
      if (!result.ok) return send(422, { ok: false, error: result.reason ?? "发送失败" });
      deps.pending.reply(id, text);
      deps.eventLog.append("send.succeeded", { chat: item.chat, text, via: "handoff" }, { src: "handoff" });
      return send(200, { ok: true, id, chat: item.chat, text });
    }

    if (req.method === "POST" && url.pathname === "/pending/skip") {
      const body = await readJson(req);
      const id = String(body["id"] ?? "");
      const item = deps.pending?.skip(id);
      return item ? send(200, { ok: true, id }) : send(404, { ok: false, error: "没有这个待回复项" });
    }

    if (req.method === "POST" && url.pathname === "/control") {
      const body = await readJson(req);
      const action = String(body["action"] ?? "");
      const result = await deps.control(action, { chat: body["chat"] ? String(body["chat"]) : undefined });
      return send(result.ok ? 200 : 400, result);
    }

    if (req.method === "POST" && url.pathname === "/tick") {
      const result = await deps.auto.tick();
      deps.state.lastTick = { at: Date.now(), acted: result.acted, reason: result.reason, replied: result.replied, chat: result.chat };
      return send(200, { ok: true, result });
    }

    return send(404, { ok: false, error: `没有这个接口：${req.method} ${url.pathname}` });
  } catch (err) {
    return send(500, { ok: false, error: (err as Error).message });
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}