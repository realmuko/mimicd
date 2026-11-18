/**
 * dsh-mimicd-wechat — DSH 与 mimicd 引擎之间的瘦适配层。
 *
 * 只做三件事：
 *   1. wechat_* 工具：走引擎的 HTTP（/health /state /pending /stickers /say /observe/link …）；
 *   2. bridge：轮询 /pending，用 schedule.create 叫醒一个 DSH 会话；主模型回话后把内容交回引擎；
 *   3. 设置页的本机 API（127.0.0.1:65482）：给 client.js 提供数据、转控制动作、读写插件配置。
 *
 * 设备（ADB/OCR/点击/发送）完全归引擎；插件不碰手机，
 * 所以这里没有 wechat_shot / wechat_send / wechat_open 这类工具。
 */

import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, configInfo, engineConfigInfo, loadConfig, saveConfig } from "./lib/config.js";
import { MimicdEngine } from "./lib/engine.js";
import { PendingBridge } from "./lib/bridge.js";
import { startApi } from "./lib/api.js";
import { listSessions } from "./lib/sessions.js";
import {
  formatClock,
  formatUptime,
  relativeTime,
  summarizeChats,
  summarizeEvent,
  summarizePending,
} from "./lib/format.js";

export const name = "dsh-mimicd-wechat";
export const inject = ["tools"];

const VERSION = "0.1.0";
const ENGINE_TOKEN = String(process.env.MIMICD_TOKEN || "");
const MAX_LOG_BYTES = 1024 * 1024;

/** 引擎 /control 实际支持的动作（见 mimicd tools/daemon.ts 的 control）。 */
const CONTROL_ACTIONS = new Set(["pause", "resume", "dry_run", "wet", "tick"]);

const text = (t) => [{ type: "text", text: String(t) }];

let scheduleRef = null;
let bridge = null;
let apiServer = null;
let disposed = false;

/* ------------------------------ 日志 ------------------------------ */

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, "plugin.log");
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 没有旧日志/轮换失败都无所谓 */
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    /* 写不了日志不能影响主流程 */
  }
  console.log(`[dsh-mimicd-wechat] ${message}`);
}

/* ------------------------------ 引擎 ------------------------------ */

function makeEngine(cfg = loadConfig()) {
  return new MimicdEngine({
    baseUrl: cfg?.bridge?.engineUrl || "http://127.0.0.1:65480",
    token: ENGINE_TOKEN,
  });
}

/** 让返回值可无损序列化：undefined / NaN / Infinity 会让工具调用直接失败。 */
function lossless(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(lossless).filter((v) => v !== undefined);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const l = lossless(v);
      if (l !== undefined) out[k] = l;
    }
    return out;
  }
  return undefined;
}

/* ------------------------------ 桥接生命周期 ------------------------------ */

function stopBridge() {
  if (!bridge) return;
  try {
    bridge.stop();
    log("桥接已停止");
  } catch (err) {
    log(`桥接停止时出错：${err?.message || err}`);
  }
  bridge = null;
}

function startBridge(reason = "") {
  if (bridge) return;
  const cfg = loadConfig();
  const suffix = reason ? `（${reason}）` : "";

  if (cfg.bridge?.enabled !== true) return log(`桥接未启动：配置里 enabled=false${suffix}`);
  if (!cfg.bridge?.sessionId) return log("桥接未启动：bridge.sessionId 为空 —— 去设置页选一个要唤醒的 DSH 会话");
  if (cfg.tools?.enabled === false) return log("桥接未启动：tools.enabled=false，唤醒后没有回话工具");
  if (!scheduleRef) return log("桥接未启动：schedule 服务还没就绪");

  try {
    bridge = new PendingBridge({
      engine: makeEngine(cfg),
      sessionId: cfg.bridge.sessionId,
      chatSessions: cfg.bridge.chatSessions ?? {},
      schedule: scheduleRef,
      intervalMs: cfg.bridge.intervalMs,
      log,
    });
    bridge.start();
    const mapped = Object.values(cfg.bridge.chatSessions ?? {}).filter(Boolean).length;
    log(
      `桥接已启动${suffix}：默认会话 ${String(cfg.bridge.sessionId).slice(0, 12)}` +
        `${mapped ? ` · ${mapped} 个群有专属会话` : ""} · 引擎 ${cfg.bridge.engineUrl}`,
    );
  } catch (err) {
    bridge = null;
    log(`桥接启动失败：${err?.message || err}`);
  }
}

function restartBridge(reason = "") {
  stopBridge();
  startBridge(reason);
}

function bridgeView() {
  const cfg = loadConfig();
  const st = bridge?.status() ?? null;
  let reason = "";
  if (!cfg.bridge?.enabled) reason = "配置里未启用";
  else if (!cfg.bridge?.sessionId) reason = "还没选唤醒会话";
  else if (cfg.tools?.enabled === false) reason = "tools.enabled=false";
  else if (!scheduleRef) reason = "schedule 服务不可用";
  else if (!st?.running) reason = "未启动";

  return {
    running: Boolean(st?.running),
    reason,
    configEnabled: Boolean(cfg.bridge?.enabled),
    sessionId: cfg.bridge?.sessionId || "",
    chatSessions: cfg.bridge?.chatSessions ?? {},
    intervalMs: cfg.bridge?.intervalMs || 8000,
    scheduleAvailable: Boolean(scheduleRef),
    ...(st
      ? {
          wakeTimeoutMs: st.wakeTimeoutMs,
          stallMs: st.stallMs,
          lastPollAt: st.lastPollAt,
          lastWakeAt: st.lastWakeAt,
          lastError: st.lastError,
          watchdogResets: st.watchdogResets,
          polls: st.polls,
          wakes: st.wakes,
          pendingSeen: st.pendingSeen,
          busy: st.busy,
        }
      : {}),
  };
}

/* ------------------------------ 引擎配置（只读展示） ------------------------------ */

function engineConfigView() {
  const info = engineConfigInfo();
  const data = info.data || {};
  const policy = data.policy || {};
  const autochat = data.autochat || {};
  const proactive = data.proactive || {};
  const reply = data.reply || {};
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  return {
    path: info.path,
    exists: info.exists,
    mtime: info.mtime || 0,
    error: info.error || null,
    note: info.exists ? null : "还没有 data/config.json：下面按引擎默认值显示。",
    policy: {
      whitelist: Array.isArray(policy.whitelist) ? policy.whitelist.filter((x) => typeof x === "string") : [],
      groupStrategy:
        policy.groupMentionOnly === true || policy.groupStrategy === "mention" ? "mention" : "judge",
      quietHours:
        Array.isArray(policy.quietHours) && policy.quietHours.length === 2
          ? policy.quietHours.map((n) => Number(n) || 0)
          : [23, 8],
      minGapMs: num(policy.minGapMs, 5 * 60 * 1000),
      maxPerHour: num(policy.maxPerHour, 6),
      maxReplyChars: num(policy.maxReplyChars, 200),
      mergeWindowMs: num(policy.mergeWindowMs, 6000),
      maxMergeWaitMs: num(policy.maxMergeWaitMs, 18000),
      requireOtherSide: policy.requireOtherSide !== false,
      selfNames: Array.isArray(policy.selfNames) ? policy.selfNames : [],
    },
    autochat: {
      perChatCooldownMs: num(autochat.perChatCooldownMs, 5 * 60 * 1000),
      collectStickers: autochat.collectStickers !== false,
      collectEveryMin: num(autochat.collectEveryMin, 10),
    },
    proactive: {
      maxPerHour: num(proactive.maxPerHour, 2),
      maxPerDay: num(proactive.maxPerDay, 6),
      minGapMs: num(proactive.minGapMs, 20 * 60 * 1000),
      allowGroups: proactive.allowGroups === true,
    },
    reply: {
      stickerChance: num(reply.stickerChance, 0.8),
      stickerCooldownMin: num(reply.stickerCooldownMin, 5),
    },
    brainKind: data.brain?.kind || "scripted",
  };
}

/* ------------------------------ 设置页 API 的后端 ------------------------------ */

async function overview() {
  const info = configInfo();
  const cfg = info.cfg;
  const engine = makeEngine(cfg);
  const base = {
    ok: true,
    now: Date.now(),
    plugin: { id: name, version: VERSION, apiPort: apiServer?.port ?? null },
    configPath: info.path,
    config: cfg,
    configError: info.error || null,
    engineConfig: engineConfigView(),
    bridge: bridgeView(),
  };

  const results = await Promise.allSettled([
    engine.health(),
    engine.state(),
    engine.pending(),
    engine.stickers(),
    engine.events(60),
  ]);
  const [healthR, stateR, pendingR, stickersR, eventsR] = results;

  if (healthR.status !== "fulfilled") {
    return {
      ...base,
      engine: {
        online: false,
        url: cfg.bridge.engineUrl,
        error: String(healthR.reason?.message || healthR.reason),
      },
      chats: [],
      pending: { count: 0, items: [] },
      stickers: { total: 0, moods: {} },
      events: [],
    };
  }

  const health = healthR.value;
  const degraded = results
    .map((r, i) => (r.status === "rejected" ? `${["health", "state", "pending", "stickers", "events"][i]}：${r.reason?.message || r.reason}` : null))
    .filter(Boolean);

  const items = pendingR.status === "fulfilled" ? pendingR.value?.items ?? [] : [];
  const stickers = stickersR.status === "fulfilled" ? stickersR.value ?? {} : {};
  const events = eventsR.status === "fulfilled" ? eventsR.value?.events ?? [] : [];

  return {
    ...base,
    engine: {
      online: true,
      url: cfg.bridge.engineUrl,
      health: {
        ok: health?.ok !== false,
        paused: Boolean(health?.paused),
        dryRun: Boolean(health?.dryRun),
        uptimeMs: Number(health?.uptimeMs) || 0,
        uptime: formatUptime(health?.uptimeMs),
        lastTick: health?.lastTick ?? null,
        device: health?.device ?? null,
        run: health?.run ?? "",
      },
      ...(degraded.length ? { degraded } : {}),
    },
    chats: stateR.status === "fulfilled" ? summarizeChats(stateR.value?.world, { limit: 60 }) : [],
    pending: { count: items.length, items: summarizePending(items) },
    stickers: {
      total: Number(stickers.total) || 0,
      moods: stickers.moods && typeof stickers.moods === "object" ? stickers.moods : {},
    },
    events: events.slice(-60).map(summarizeEvent),
  };
}

function buildService() {
  return {
    overview,
    sessions(limit) {
      return listSessions({ limit });
    },
    configInfo() {
      const info = configInfo();
      return { path: info.path, mtime: info.mtime, config: info.cfg, error: info.error || null };
    },
    async saveConfig(patch) {
      const saved = saveConfig(patch);
      const mapped = Object.values(saved.cfg.bridge.chatSessions ?? {}).filter(Boolean).length;
      log(
        `设置页保存配置：bridge.enabled=${saved.cfg.bridge.enabled} · intervalMs=${saved.cfg.bridge.intervalMs} · tools.enabled=${saved.cfg.tools.enabled}` +
          `${mapped ? ` · ${mapped} 个群有专属会话` : ""}`,
      );
      restartBridge("设置页保存配置");
      return { path: saved.path, mtime: saved.mtime, config: saved.cfg };
    },
    async control(action) {
      const a = String(action || "").trim();
      if (!CONTROL_ACTIONS.has(a)) {
        throw Object.assign(new Error(`引擎不支持的动作：${a}`), { status: 400 });
      }
      const result = await makeEngine().control(a);
      log(`控制：${a} → ${result?.message || "ok"}`);
      return { action: a, message: result?.message || "已执行" };
    },
    async tick() {
      const response = await makeEngine().tick();
      const result = response?.result ?? response;
      const summary = result?.acted ? `有动作：${result.reason || ""}` : `不动：${result?.reason || ""}`;
      log(`强制跑一轮 → ${summary}`);
      return { result, message: `跑完一轮 · ${summary}` };
    },
    async skip(id, reason) {
      await makeEngine().skip(id, reason);
      log(`跳过待办 ${String(id).slice(0, 8)}：${reason || ""}`);
      return { id, message: `已跳过 ${String(id).slice(0, 8)}` };
    },
  };
}

/* ------------------------------ 工具注册 ------------------------------ */

function registerTool(ctx, definition) {
  const run = definition.execute;
  const tool = {
    ...definition,
    async execute(args, exec) {
      const cfg = loadConfig();
      if (cfg.tools?.enabled === false) {
        throw new Error(
          "微信工具已关闭（wechat-mimicd.config.json 的 tools.enabled=false）。去设置页打开，或把它改成 true。",
        );
      }
      return lossless(await run(args ?? {}, exec, cfg));
    },
  };
  ctx.effect(() => ctx.tools.register(tool), `dsh-mimicd-wechat: ${definition.name}`);
}

function renderStatus(v) {
  if (!v?.online) return text(`引擎 ${v?.engineUrl || ""} 连不上：${v?.error || "未知错误"}`);
  const lastTick = v.lastTick
    ? `${formatClock(v.lastTick.at)} · ${v.lastTick.acted ? "有动作" : "不动"} · ${v.lastTick.reason || ""}${v.lastTick.chat ? ` · ${v.lastTick.chat}` : ""}`
    : "还没跑过";
  const device = v.device
    ? `${v.device.online ? "在线" : "离线"} · 页面 ${v.device.page || "?"} · 焦点 ${String(v.device.focus || "").split("/").pop() || "?"}`
    : "未知";
  return text(
    [
      `引擎 ${v.engineUrl}：在线 · ${v.paused ? "已暂停" : "运行中"}${v.dryRun ? " · dry-run" : ""} · 已跑 ${v.uptime}`,
      `设备：${device}`,
      `上一轮：${lastTick}`,
      `待办：${v.pendingCount ?? 0} 条`,
      `桥接：${v.bridge?.running ? `运行中（每 ${Math.round((v.bridge.intervalMs || 8000) / 1000)}s 轮询）` : `未运行（${v.bridge?.reason || "未知"}）`}`,
    ].join("\n"),
  );
}

export function apply(ctx) {
  // 热重载时先把上一实例的定时器/端口收掉，避免两个桥接同时叫醒、或 API 端口占用
  try {
    globalThis.__dshMimicdWechat?.dispose?.();
  } catch {
    /* ignore */
  }
  disposed = false;

  const initialConfig = configInfo();
  log(
    `插件加载 v${VERSION} · 配置 ${initialConfig.path}` +
      (initialConfig.error ? ` · 配置有问题（先用默认值）：${initialConfig.error}` : ""),
  );

  /* ---- 工具 ---- */
  registerTool(ctx, {
    name: "wechat_engine_status",
    description:
      "看 mimicd 引擎是否在线、是否暂停/干跑、设备焦点与页面、最后一轮为什么动/不动、待办几条。开始任何微信操作前先调它。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => renderStatus(value),
    },
    isConcurrencySafe: () => true,
    async execute(_args, _exec, cfg) {
      const engine = makeEngine(cfg);
      try {
        const health = await engine.health();
        let pendingCount = null;
        try {
          const pending = await engine.pending();
          pendingCount = Array.isArray(pending?.items) ? pending.items.length : 0;
        } catch {
          /* 待办取不到不影响健康状态 */
        }
        return {
          ok: true,
          online: true,
          engineUrl: engine.baseUrl,
          paused: Boolean(health?.paused),
          dryRun: Boolean(health?.dryRun),
          uptimeMs: Number(health?.uptimeMs) || 0,
          uptime: formatUptime(health?.uptimeMs),
          lastTick: health?.lastTick ?? null,
          device: health?.device ?? null,
          run: health?.run ?? "",
          pendingCount,
          bridge: bridgeView(),
        };
      } catch (err) {
        return {
          ok: false,
          online: false,
          engineUrl: engine.baseUrl,
          error: String(err?.message || err),
          bridge: bridgeView(),
        };
      }
    },
  });

  registerTool(ctx, {
    name: "wechat_reply_pending",
    description:
      "把你要发的一句话（或一个表情）交给引擎发出。只在收到「微信消息」唤醒时用：id 用提示词里给的那个，text 是你要发出去的原话（≤60 字，不要加引号）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "待办 id" },
        text: { type: "string", description: "要发出的那句话（可以不给，只发表情）" },
        stickerMood: {
          type: "string",
          description: "想补一个表情时给：开心/无语/敷衍/惊讶/亲昵/嘲讽/委屈（可与 text 同时给，先文字后表情）",
        },
      },
      required: ["id"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => text(`已发到「${value.chat}」：${value.text}`),
    },
    isConcurrencySafe: () => false,
    async execute(args, _exec, cfg) {
      if (!args.text && !args.stickerMood) throw new Error("text 和 stickerMood 至少给一个");
      return makeEngine(cfg).reply(String(args.id), {
        text: args.text ? String(args.text) : "",
        stickerMood: args.stickerMood ? String(args.stickerMood) : undefined,
      });
    },
  });

  registerTool(ctx, {
    name: "wechat_skip_pending",
    description: "这条消息不接（聊不上/不该你说/没把握）。理由会写进引擎事件，方便以后调策略。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "待办 id" },
        reason: { type: "string", description: "为什么不回" },
      },
      required: ["id"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => text(value.ok ? "已跳过" : `跳过失败：${value.error || ""}`),
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec, cfg) {
      return makeEngine(cfg).skip(String(args.id), String(args.reason || ""));
    },
  });

  registerTool(ctx, {
    name: "wechat_say",
    description:
      "主动搭话专用：给某个会话发一句话或一个表情。引擎会按安静时段、每小时/每天上限、群聊开关拒绝；被拒绝就说明原因，别硬发。",
    parameters: {
      type: "object",
      properties: {
        chat: { type: "string", description: "会话标题（先用 wechat_chats 看有哪些）" },
        text: { type: "string", description: "要发的那句话（可以不给，只发表情）" },
        stickerMood: { type: "string", description: "发表情时用：开心/无语/敷衍/惊讶/亲昵/嘲讽/委屈" },
      },
      required: ["chat"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => text(value.ok ? `已发到「${value.chat}」：${value.text}` : `没发出去：${value.error || ""}`),
    },
    isConcurrencySafe: () => false,
    async execute(args, _exec, cfg) {
      if (!args.text && !args.stickerMood) throw new Error("text 和 stickerMood 至少给一个");
      return makeEngine(cfg).say(String(args.chat), {
        text: args.text ? String(args.text) : undefined,
        stickerMood: args.stickerMood ? String(args.stickerMood) : undefined,
      });
    },
  });

  registerTool(ctx, {
    name: "wechat_stickers",
    description: "看看表情库里现在有哪些情绪、各几张（发表情前先看这个，别凭想象挑情绪）。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) =>
        text(
          `共 ${value.total ?? 0} 张：` +
            Object.entries(value.moods || {})
              .map(([mood, count]) => `${mood} ${count}`)
              .join("、"),
        ),
    },
    isConcurrencySafe: () => true,
    async execute(_args, _exec, cfg) {
      return makeEngine(cfg).stickers();
    },
  });

  registerTool(ctx, {
    name: "wechat_chats",
    description: "看看最近聊过谁（主动搭话前用它挑会话）：返回会话名、群聊/私聊、最后一条消息和时间。",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", description: "最多几条（默认 8）" } },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) =>
        text(
          (value.chats || [])
            .map(
              (chat) =>
                `${chat.name}（${chat.kind === "group" ? "群" : "私聊"}）${chat.lastText ? "：" + chat.lastText : ""} · ${relativeTime(chat.lastSeenAt)}`,
            )
            .join("\n"),
        ),
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec, cfg) {
      const state = await makeEngine(cfg).state();
      const limit = Math.min(30, Math.max(1, Math.round(Number(args.limit) || 8)));
      return { ok: true, chats: summarizeChats(state?.world, { limit }) };
    },
  });

  registerTool(ctx, {
    name: "wechat_read_link",
    description:
      "让引擎打开会话里的链接/文章，读回标题与正文（AI 摘要优先）。消息里是链接、页面看不懂时先调它。会占用手机几十秒。",
    parameters: {
      type: "object",
      properties: {
        chat: { type: "string", description: "会话标题" },
        which: { type: "integer", description: "第几张卡片（不填=最后一张）" },
      },
      required: ["chat"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => text((value.text ?? value.error ?? "").slice(0, 4000)),
    },
    isConcurrencySafe: () => false,
    async execute(args, _exec, cfg) {
      return makeEngine(cfg).readLink(String(args.chat), args.which ? Number(args.which) : undefined);
    },
  });

  /* ---- schedule 注入：schedule 就绪后再起桥接 ---- */
  ctx.inject(["schedule"], (sctx) => {
    try {
      scheduleRef = sctx.schedule || sctx.get?.("schedule") || null;
    } catch {
      scheduleRef = null;
    }
    log(`schedule 服务：${scheduleRef ? "可用" : "不可用（桥接无法叫醒会话）"}`);
    startBridge("schedule 注入");
  });

  /* ---- 设置页 API ---- */
  try {
    apiServer = startApi(buildService(), { log });
  } catch (err) {
    apiServer = null;
    log(`设置页 API 启动失败：${err?.message || err}`);
  }

  /* ---- 卸载/热重载：停桥接、关端口 ---- */
  ctx.effect(
    () => () => dispose(),
    "dsh-mimicd-wechat: dispose",
  );

  const handle = {
    dispose,
  };
  globalThis.__dshMimicdWechat = handle;
}

function dispose() {
  if (disposed) return;
  disposed = true;
  stopBridge();
  scheduleRef = null;
  if (apiServer) {
    try {
      apiServer.close();
    } catch {
      /* ignore */
    }
    apiServer = null;
  }
  try {
    if (globalThis.__dshMimicdWechat?.dispose === dispose) delete globalThis.__dshMimicdWechat;
  } catch {
    /* ignore */
  }
}