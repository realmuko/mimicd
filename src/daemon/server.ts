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
import type { StickerLibrary } from "../stickers/library.ts";

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
  /** 交接回复：文本或表情 */
  sendReply?: (chat: string, kind: { text?: string; stickerMood?: string }) => Promise<{ ok: boolean; reason?: string }>;
  /** 主动搭话：dsh-speak-up 掷中后由主模型调过来，引擎负责限额与发送 */
  say?: (chat: string, kind: { text?: string; stickerMood?: string }) => Promise<{ ok: boolean; reason?: string; refused?: string }>;
  /** 读链接（交接模式的「眼睛」） */
  readLink?: (chat: string, which?: number) => Promise<{ ok: boolean; text?: string; reason?: string }>;
  /** 表情库（/stickers 给主模型看「现在有哪些情绪可用」） */
  stickers?: StickerLibrary;
  /** 允许 POST /pending/inject（只在本地测链路时打开） */
  allowPendingInject?: boolean;
  /** 设备互斥：/intent 也是「碰手机」的动作，必须和 tick 排同一条队 */
  exclusive?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
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

    if (req.method === "GET" && url.pathname === "/stickers") {
      if (!deps.stickers) return send(200, { ok: true, total: 0, moods: {}, items: [] });
      const items = deps.stickers.list().map((e) => ({
        mood: e.mood,
        tags: e.tags,
        funny: e.funny,
        collected: Boolean(e.collectedAt),
        sends: e.sends.length,
      }));
      return send(200, { ok: true, total: items.length, moods: deps.stickers.moodCounts(), items });
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
      const run = () => deps.runner.run(resolved, parsed);
      const result = deps.exclusive ? await deps.exclusive("intent", run) : await run();
      return send(result.ok ? 200 : 422, { ok: result.ok, result });
    }

    if (req.method === "GET" && url.pathname === "/pending") {
      if (!deps.pending) return send(200, { ok: true, items: [], note: "未开启交接模式" });
      return send(200, { ok: true, items: deps.pending.list() });
    }

    // 测试用：不等真消息也能验「引擎挂起 → 会话唤醒 → 主模型回话」这一整条链。
    // 只监听 127.0.0.1，且必须显式打开（默认关），不会在产线路径上被误用。
    if (req.method === "POST" && url.pathname === "/say") {
      if (!deps.say) return send(400, { ok: false, error: "没有配置主动搭话" });
      const body = await readJson(req);
      const chat = String(body["chat"] ?? "");
      const text = String(body["text"] ?? "").trim();
      const stickerMood = body["stickerMood"] === undefined ? undefined : String(body["stickerMood"]);
      if (!chat) return send(400, { ok: false, error: "chat 不能为空" });
      if (!text && stickerMood === undefined) return send(400, { ok: false, error: "text 或 stickerMood 至少给一个" });
      const result = await deps.say(chat, {
        ...(text ? { text } : {}),
        ...(stickerMood !== undefined ? { stickerMood } : {}),
      });
      if (!result.ok) {
        deps.eventLog.append("note", { stage: "proactive", chat, refused: result.refused ?? null, reason: result.reason ?? null }, { src: "proactive" });
        return send(422, { ok: false, error: result.reason ?? "发不出去", refused: result.refused });
      }
      return send(200, { ok: true, chat, text: text || `[表情:${stickerMood}]` });
    }

    if (req.method === "POST" && url.pathname === "/pending/inject") {
      if (!deps.pending) return send(400, { ok: false, error: "未开启交接模式" });
      if (!deps.allowPendingInject) return send(403, { ok: false, error: "测试注入没打开（启动时加 --allow-pending-inject）" });
      const body = await readJson(req);
      const chat = String(body["chat"] ?? "");
      if (!chat) return send(400, { ok: false, error: "chat 不能为空" });
      const rawMessages = Array.isArray(body["messages"]) ? body["messages"] : [];
      const messages = rawMessages
        .map((m) => {
          const rec = m as Record<string, unknown>;
          return {
            from: (String(rec["from"] ?? "other") === "me" ? "me" : "other") as "me" | "other",
            text: String(rec["text"] ?? ""),
          };
        })
        .filter((m) => m.text);
      if (messages.length === 0) return send(400, { ok: false, error: "messages 不能为空" });
      const kindRaw = String(body["kind"] ?? "dm");
      const item = deps.pending.add({
        chat,
        kind: kindRaw === "group" ? "group" : "dm",
        needsJudgment: body["needsJudgment"] === true,
        messages,
      });
      deps.eventLog.append("intent.pending", { chat, id: item.id, injected: true }, { src: "handoff" });
      return send(200, { ok: true, item });
    }

    if (req.method === "POST" && url.pathname === "/pending/reply") {
      if (!deps.pending) return send(400, { ok: false, error: "未开启交接模式" });
      if (!deps.sendReply) return send(400, { ok: false, error: "没有配置发送器" });
      const body = await readJson(req);
      const id = String(body["id"] ?? "");
      const text = String(body["text"] ?? "").trim();
      const stickerMood = body["stickerMood"] === undefined ? undefined : String(body["stickerMood"]);
      const item = deps.pending.claim(id);
      if (!item) return send(404, { ok: false, error: `没有待回复项 ${id}（可能已过期）` });
      if (!text && stickerMood === undefined) {
        deps.pending.release(id);
        return send(400, { ok: false, error: "text 或 stickerMood 至少给一个" });
      }
      const kind = {
        ...(text ? { text } : {}),
        ...(stickerMood !== undefined ? { stickerMood } : {}),
      };
      const result = await deps.sendReply(item.chat, kind);
      if (!result.ok) {
        deps.pending.release(id);
        return send(422, { ok: false, error: result.reason ?? "发送失败" });
      }
      deps.pending.finish(id, text || `[表情:${stickerMood}]`);
      deps.eventLog.append(
        "send.succeeded",
        { chat: item.chat, ...(text ? { text } : {}), ...(stickerMood !== undefined ? { stickerMood } : {}), via: "handoff" },
        { src: "handoff" },
      );
      return send(200, { ok: true, id, chat: item.chat, text: text || `[表情:${stickerMood}]` });
    }

    if (req.method === "POST" && url.pathname === "/pending/skip") {
      const body = await readJson(req);
      const id = String(body["id"] ?? "");
      const reason = String(body["reason"] ?? "");
      const item = deps.pending?.skip(id);
      if (item) deps.eventLog.append("intent.skipped", { chat: item.chat, id, reason }, { src: "handoff" });
      return item ? send(200, { ok: true, id }) : send(404, { ok: false, error: "没有这个待回复项" });
    }

    if (req.method === "POST" && url.pathname === "/observe/link") {
      if (!deps.readLink) return send(400, { ok: false, error: "没有配置读链接" });
      const body = await readJson(req);
      const chat = String(body["chat"] ?? "");
      const which = body["which"] === undefined ? undefined : Number(body["which"]);
      if (!chat) return send(400, { ok: false, error: "chat 不能为空" });
      const result = await deps.readLink(chat, which);
      deps.eventLog.append("note", { stage: "read-link", chat, ok: result.ok }, { src: "handoff" });
      return send(result.ok ? 200 : 422, result);
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