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

const DASHBOARD_HTML = "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>mimicd · 运行状态</title>\n<style>\n  :root{--ink:#16202e;--muted:#5b6b80;--line:#d7dee8;--bg:#f5f7fb;--blue:#2f6df6;--green:#15906b;--red:#c0392b}\n  *{box-sizing:border-box}\n  body{margin:0;background:var(--bg);font-family:\"Microsoft YaHei\",system-ui,sans-serif;color:var(--ink)}\n  .wrap{max-width:1180px;margin:0 auto;padding:20px}\n  h1{font-size:20px;margin:0 0 4px}\n  .sub{color:var(--muted);font-size:12px;margin-bottom:14px}\n  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}\n  .card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 12px}\n  .card .k{font-size:11px;color:var(--muted);margin-bottom:4px}\n  .card .v{font-size:14px;font-weight:600;word-break:break-all}\n  .toolbar{display:flex;gap:8px;align-items:center;margin:14px 0 8px;font-size:12px;color:var(--muted)}\n  button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer}\n  button:hover{border-color:var(--blue);color:var(--blue)}\n  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:12.5px}\n  th,td{padding:7px 9px;border-bottom:1px solid #eef1f6;text-align:left;vertical-align:top}\n  th{background:#fafbfd;color:var(--muted);font-weight:600;font-size:11.5px}\n  tr:last-child td{border-bottom:none}\n  .t{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}\n  .kind{white-space:nowrap}\n  .k-intent{color:var(--blue)} .k-send{color:var(--green)} .k-note{color:#c46a12} .k-msg{color:#6d4ad6}\n  .noise{display:none}\n  .ok{color:var(--green)} .bad{color:var(--red)}\n</style></head><body><div class=\"wrap\">\n<h1>mimicd · 运行状态</h1>\n<div class=\"sub\">每 3 秒自动刷新 · 原始数据：<a href=\"/health\">/health</a> · <a href=\"/state\">/state</a> · <a href=\"/pending\">/pending</a> · <a href=\"/stickers\">/stickers</a> · <a href=\"/events?limit=200\">/events</a></div>\n\n<div class=\"cards\">\n  <div class=\"card\"><div class=\"k\">引擎</div><div class=\"v\" id=\"engine\">—</div></div>\n  <div class=\"card\"><div class=\"k\">设备</div><div class=\"v\" id=\"device\">—</div></div>\n  <div class=\"card\"><div class=\"k\">上一轮</div><div class=\"v\" id=\"tick\">—</div></div>\n  <div class=\"card\"><div class=\"k\">待办</div><div class=\"v\" id=\"pending\">—</div></div>\n</div>\n\n<div class=\"toolbar\">\n  <button id=\"btnPause\">暂停</button><button id=\"btnResume\">继续</button>\n  <label style=\"margin-left:8px\"><input type=\"checkbox\" id=\"showAll\"> 显示全部（动作/截图/消息）</label>\n  <span id=\"status\" style=\"margin-left:auto\"></span>\n</div>\n\n<table><thead><tr><th style=\"width:86px\">时间</th><th style=\"width:140px\">类型</th><th>内容 / 原因</th></tr></thead>\n<tbody id=\"rows\"></tbody></table>\n</div>\n<script>\nvar KIND = {\n  \"intent.decided\":[\"决定\",\"k-intent\",1],\n  \"intent.pending\":[\"挂起待办\",\"k-intent\",1],\n  \"intent.skipped\":[\"跳过\",\"k-intent\",1],\n  \"send.succeeded\":[\"发出\",\"k-send\",1],\n  \"send.failed\":[\"发送失败\",\"k-send\",1],\n  \"message.seen\":[\"看到消息\",\"k-msg\",0],\n  \"action.executed\":[\"动作\",\"\",0],\n  \"action.verified\":[\"动作完成\",\"\",0],\n  \"frame.captured\":[\"截图\",\"\",0],\n  \"plan.planned\":[\"计划\",\"\",0],\n  \"note\":[\"备注\",\"k-note\",1]\n};\nfunction esc(s){return String(s==null?\"\":s).replace(/[&<>\"]/g,function(c){return {\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\"}[c];});}\nfunction summary(e){\n  var d=e.data||{};\n  if(e.kind===\"intent.decided\") return (d.chat||\"\")+\" · 回复=\"+d.reply+\" · \"+(d.reason||\"\");\n  if(e.kind===\"intent.pending\") return (d.chat||\"\")+\" · 已交给主模型\";\n  if(e.kind===\"intent.skipped\") return (d.chat||\"\")+\" · \"+(d.reason||\"\");\n  if(e.kind===\"send.succeeded\") return (d.chat||\"\")+\" · \"+(d.text?(\"文字：\"+d.text):\"\")+(d.stickerMood?(\" 表情：\"+d.stickerMood):\"\");\n  if(e.kind===\"message.seen\") return (d.chat||\"\")+\" · \"+(d.from===\"me\"?\"我\":\"对方\")+\"：\"+(d.text||\"\");\n  if(e.kind===\"action.executed\") return (d.kind||\"\")+\" (\"+(d.detail&&d.detail.x!=null?d.detail.x+\",\"+d.detail.y:\"\")+\")\";\n  if(e.kind===\"action.verified\") return (d.skill?(\"技能 \"+d.skill+\" \"+(d.ok?\"成功\":\"失败\")+\" \"+(d.reason||\"\")):(d.check||\"\")+\" \"+(d.ok?\"ok\":\"fail\"));\n  if(e.kind===\"frame.captured\") return (d.tag||\"\")+\" \"+(d.page||\"\")+\" 未读行=\"+(d.unreadRows!=null?d.unreadRows:\"\");\n  if(e.kind===\"plan.planned\") return \"技能 \"+(d.skill||\"\")+\" \"+JSON.stringify(d.params||{});\n  if(e.kind===\"note\") return (d.stage||d.op||\"\")+\" \"+JSON.stringify(d);\n  return JSON.stringify(d);\n}\nfunction ref(id){return document.getElementById(id);}\nfunction refresh(){\n  fetch(\"/health\").then(function(r){return r.json();}).then(function(h){\n    var e = ref(\"engine\");\n    e.textContent = (h.ok?\"在线\":\"离线\")+\" · \"+(h.paused?\"已暂停\":\"运行中\")+\" · 已跑 \"+Math.round((h.uptimeMs||0)/1000)+\"s\";\n    e.className=\"v \"+(h.ok?\"ok\":\"bad\");\n    ref(\"device\").textContent = (h.device&&h.device.online?\"在线\":\"离线\")+\" · \"+(h.device&&h.device.page||\"\")+\" · \"+(h.device&&h.device.focus||\"\").split(\"/\").pop();\n    var t=h.lastTick;\n    ref(\"tick\").textContent = t? (new Date(t.at).toLocaleTimeString(\"zh-CN\",{hour12:false})+\" · \"+(t.acted?\"有动作\":\"不动\")+\" · \"+(t.reason||\"\")) : \"还没有跑过\";\n  }).catch(function(){ref(\"engine\").textContent=\"连不上引擎\";});\n  fetch(\"/pending\").then(function(r){return r.json();}).then(function(p){\n    var items=(p.items||[]);\n    ref(\"pending\").textContent = items.length===0? \"无\" : items.map(function(x){return x.chat+\"（\"+x.kind+\"）\";}).join(\"、\");\n  }).catch(function(){});\n  fetch(\"/events?limit=160\").then(function(r){return r.json();}).then(function(j){\n    var all=(j.events||[]).slice(-120).reverse();\n    var showAll=ref(\"showAll\").checked;\n    var html=\"\";\n    var lastSeqAt=0;\n    for(var i=0;i<all.length;i++){\n      var e=all[i]; var meta=KIND[e.kind]||[e.kind,\"\",1];\n      var noise = meta[2]===0 || (e.kind===\"note\" && ((e.data||{}).wait || (e.data||{}).region));\n      if(!showAll && noise) continue;\n      var t=new Date(e.t||e.time).toLocaleTimeString(\"zh-CN\",{hour12:false});\n      html += \"<tr class='\"+(meta[2]===0?\"noise\":\"\")+\"'><td class='t'>\"+t+\"</td><td class='kind \"+meta[1]+\"'>\"+esc(meta[0])+\"</td><td>\"+esc(summary(e))+\"</td></tr>\";\n    }\n    ref(\"rows\").innerHTML = html || \"<tr><td colspan=3 style='color:#888'>还没有事件</td></tr>\";\n    ref(\"status\").textContent = \"最后刷新 \" + new Date().toLocaleTimeString(\"zh-CN\",{hour12:false}) + \" · 当前 run \" + (j.run||\"\");\n  }).catch(function(){});\n}\nfunction control(action){ fetch(\"/control\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify({action:action})}).then(refresh); }\nref(\"btnPause\").onclick=function(){control(\"pause\");};\nref(\"btnResume\").onclick=function(){control(\"resume\");};\nref(\"showAll\").onchange=refresh;\nrefresh(); setInterval(refresh,3000);\n</script></body></html>\n"; // 运行状态页（GET /），每 3 秒自动刷新

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
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dash")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(DASHBOARD_HTML);
      return;
    }

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