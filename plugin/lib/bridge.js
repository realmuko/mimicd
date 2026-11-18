/**
 * 桥接：把引擎（mimicd）的「待办」变成 DSH 会话的唤醒。
 *
 * 分工：
 *   引擎：决定「该回了」——感知、去重、静默时段、频率、发送都在它那边，它不编话。
 *   插件：轮询 /pending，用 schedule.create 叫醒一个会话；主模型回话后，
 *         插件把话 POST 回 /pending/reply，由引擎执行发送。
 *
 * 这一环保留了旧插件最值钱的部分（主模型带着记忆和人格说话），
 * 同时把「怎么操作手机」完全交给引擎。
 *
 * 三处硬伤防护（旧插件踩过，别删）：
 *   1. 叫醒 25s 超时：schedule.create 可能永远不 resolve，不能拖死整条轮询；
 *   2. 同一条待办最多叫醒 3 次：失败就放弃并记日志，免得每 8 秒刷一辈子；
 *   3. #busy 看门狗：某轮超过 60s 没结束就强制复位，否则桥接看着活着其实再没动过。
 */

const WAKE_MAX_ATTEMPTS = 3;

/** 叫醒（schedule.create）最长等多久：超时算这次失败，走重试计数。 */
const WAKE_TIMEOUT_MS = 25000;

/** 一轮轮询最多允许多久：超过就当它卡死，强制复位 #busy 并记日志。 */
const POLL_STALL_MS = 60000;

/** 叫醒的固定语气：让主模型只输出一句能直接发出去的话。 */
const STYLE_HEAD = [
  "你现在用自己的微信号聊天。别暴露你是 AI，别解释你在做什么，只写要发出去的那一句。",
  "回复不超过 60 字，口语，别用书面语，别加引号。",
  "不用每条都写字：被逗笑、无语、敷衍、震惊的时候，直接回一个表情往往更像人（但别每条都发表情）。",
].join("\n");

/** 给一个 promise 套超时；超时抛错，标签进 error.message，方便日志里认出是哪一步。 */
export function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 拼唤醒提示词。纯函数，方便单测。
 *
 * - 群聊消息带 sender 时显示成「昵称：内容」；
 * - 群聊不要求被 @：有自然接话口就接，完全插不上才跳过；
 * - 链接卡片提示调 wechat_read_link；
 * - 告诉主模型有哪些回话工具、待办 id 是哪个。
 */
export function formatPendingPrompt(item, moods = null) {
  const kindLabel = item?.kind === "group" ? "群聊" : item?.kind === "dm" ? "私聊" : "未知";
  const lines = [];

  lines.push(`会话：${item?.chat ?? "?"}（${kindLabel}）`);
  // 上下文隔离：同一个 DSH 会话可能同时接几个群的消息（或者你带着上一个群的记忆），
  // 不写死这条，主模型很容易把别处的话题带进来（2026-11-18 用户明确要求不串话题）。
  lines.push("这条只属于上面这个会话：别把别的群/私聊里的事带进来，也别在这里提别处的聊天内容。");
  lines.push(
    item?.kind === "group"
      ? "最近的对话（「我」是你；其他人名字就是发这句话的人，接话时可以对上人）："
      : "最近的对话（「我」是你，「对方」是聊天对象）：",
  );
  for (const m of (item?.messages || []).slice(-8)) {
    const who = m?.from === "me" ? "我" : m?.sender ? String(m.sender) : "对方";
    lines.push(`  ${who}：${m?.text ?? ""}`);
  }

  if (item?.kind === "group") {
    lines.push("");
    lines.push(
      "这是群聊，不用等 @：有自然的接话口就接（玩梗、吐槽、附和、发个表情都算）；只有完全插不上、或者会打断别人正事时才跳过。",
    );
    lines.push("别人说的话不一定是在问你；拿不准就少说一句，别硬刷存在感。");
    lines.push(
      "轻松的话顺手带一个情绪对得上的表情（text 和 stickerMood 一起给），两三句里带一次就行；正经讨论别带。",
    );
  }

  if (item?.needsJudgment) {
    lines.push("");
    lines.push("这条没有 @ 你。按上面的判断来：有梗可接就接一句或回个表情，不用等被点名。");
  }

  const hasLink = (item?.messages || []).some(
    (m) => typeof m?.text === "string" && m.text.startsWith("[链接]"),
  );
  if (hasLink) {
    lines.push("");
    lines.push("对方发的是链接/文章。想读就调用工具 wechat_read_link：");
    lines.push(`  {"chat":"${item.chat}"}`);
    lines.push("（想读更早的那张再传 which，1 = 最后一张。读回标题与正文再决定怎么接；读不出来就说读不出来，别猜内容。）");
  }

  if (moods && Object.keys(moods).length > 0) {
    lines.push("");
    lines.push(`表情库现有：${Object.entries(moods).map(([mood, n]) => `${mood} ${n} 张`).join("、")}`);
  }

  lines.push("");
  lines.push(`待办 id：${item?.id ?? "?"}`);
  lines.push("");
  lines.push(STYLE_HEAD);
  lines.push("");
  lines.push(
    [
      "要回的话，调用工具 wechat_reply_pending：",
      `  {"id":"${item?.id ?? ""}","text":"你要发的那一句"}`,
      "文字和表情可以一起给（先发文字，再补一个表情）：",
      `  {"id":"${item?.id ?? ""}","text":"这句话说完再补个表情","stickerMood":"无语"}`,
      "只回一个表情也可以（不写字）：",
      `  {"id":"${item?.id ?? ""}","stickerMood":"无语"}`,
      "不确定库里有没有合适的情绪，就先调 wechat_stickers 看一眼。",
      "不想回就调用 wechat_skip_pending：",
      `  {"id":"${item?.id ?? ""}","reason":"为什么不回"}`,
    ].join("\n"),
  );

  return lines.join("\n");
}

/** 从待办列表里挑出没见过的。纯函数。 */
export function pickNewItems(seen, items) {
  const out = [];
  for (const item of items || []) {
    if (!item || !item.id) continue;
    if (seen.has(item.id)) continue;
    out.push(item);
  }
  return out;
}

/** 会话名归一：去空白与常见标点（列表 OCR 会带进来这些）。 */
function normChat(text) {
  return String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/[\[\]（）()【】·,，.。:：!！?？]/g, "");
}

/**
 * 从「会话对齐表」里找这个会话该用哪个 DSH 会话。
 * 先精确匹配，再按包含匹配（手机上群名会被截断，映射一般写前缀），取最长命中。
 * 纯函数，方便单测。
 */
export function resolveChatSession(chatSessions, chat) {
  const want = normChat(chat);
  if (!want) return "";
  let best = null;
  for (const [key, sid] of Object.entries(chatSessions || {})) {
    if (!sid) continue;
    const k = normChat(key);
    if (!k) continue;
    if (k === want) return sid;
    if (k.length >= 4 && (want.includes(k) || k.includes(want))) {
      if (!best || k.length > best.len) best = { len: k.length, sid };
    }
  }
  return best?.sid ?? "";
}

export class PendingBridge {
  #engine;
  #sessionId;
  /** 会话对齐表：群名（或前缀）→ 会话 id；命中时优先用，避免多个群混进同一条对话 */
  #chatSessions = {};
  #schedule;
  #intervalMs;
  #wakeTimeoutMs;
  #stallMs;
  #log;
  #onEvent;

  #seen = new Set();
  /** 叫醒失败次数：id -> 次数 */
  #attempts = new Map();
  #timer = null;
  #busy = false;
  /** #busy 是什么时候置上的：看门狗靠它判断这一轮是不是已经卡死 */
  #busySince = 0;
  /** 轮次序号：看门狗复位后，旧轮次的 finally 不许清掉新轮次的 #busy */
  #runToken = 0;

  #polls = 0;
  #wakes = 0;
  #watchdogResets = 0;
  #lastPollAt = 0;
  #lastWakeAt = 0;
  #lastError = "";
  /** stop() 之后，已经在飞的轮询不许再叫醒新会话（config 改了/插件卸载了） */
  #stopped = false;

  constructor({
    engine,
    sessionId,
    chatSessions = {},
    schedule,
    intervalMs = 8000,
    wakeTimeoutMs = WAKE_TIMEOUT_MS,
    stallMs = POLL_STALL_MS,
    log,
    onEvent,
  } = {}) {
    if (!engine || typeof engine.pending !== "function") throw new Error("桥接缺少 engine（要能调 pending/stickers）");
    this.#engine = engine;
    this.#sessionId = String(sessionId || "");
    this.#chatSessions = chatSessions && typeof chatSessions === "object" ? { ...chatSessions } : {};
    this.#schedule = schedule || null;
    this.intervalMs = Math.max(2000, Math.min(120000, Number(intervalMs) || 8000));
    this.#intervalMs = this.intervalMs;
    this.#wakeTimeoutMs = Number(wakeTimeoutMs) || WAKE_TIMEOUT_MS;
    this.#stallMs = Number(stallMs) || POLL_STALL_MS;
    this.#log = typeof log === "function" ? log : () => {};
    this.#onEvent = typeof onEvent === "function" ? onEvent : () => {};
  }

  status() {
    const now = Date.now();
    return {
      running: Boolean(this.#timer),
      sessionId: this.#sessionId,
      chatSessions: { ...this.#chatSessions },
      intervalMs: this.#intervalMs,
      wakeTimeoutMs: this.#wakeTimeoutMs,
      stallMs: this.#stallMs,
      busy: this.#busy,
      busyMs: this.#busy ? now - this.#busySince : 0,
      lastPollAt: this.#lastPollAt,
      lastWakeAt: this.#lastWakeAt,
      lastError: this.#lastError,
      polls: this.#polls,
      wakes: this.#wakes,
      watchdogResets: this.#watchdogResets,
      pendingSeen: this.#seen.size,
      attempts: this.#attempts.size,
    };
  }

  /** 会话轮换后用：不重建桥接实例，直接切到新会话。 */
  setSessionId(id) {
    const v = String(id || "").trim();
    if (!v) return false;
    this.#sessionId = v;
    return true;
  }

  /** 会话对齐表热更新（设置页保存后调用）。 */
  setChatSessions(map) {
    this.#chatSessions = map && typeof map === "object" ? { ...map } : {};
    return true;
  }

  /** 这条待办该叫醒哪个会话：先看会话对齐表，再退回默认会话。 */
  sessionFor(chat) {
    return resolveChatSession(this.#chatSessions, chat) || this.#sessionId;
  }

  /** 叫醒一次会话；返回 schedule 的结果（失败抛错）。 */
  async wake(item) {
    const schedule = this.#schedule;
    if (!schedule || typeof schedule.create !== "function") throw new Error("schedule 服务不可用");
    // 会话对齐：这个群有专属会话就用它，否则退回默认会话。
    // 两个群共用一个会话时，主模型会把两个群的话混在一起（用户明确要求不能串话题）。
    const targetSession = this.sessionFor(item?.chat);
    if (!targetSession) {
      throw new Error("没有配置唤醒会话（设置页里选默认会话，或给这个群指定专属会话）");
    }

    let moods = null;
    try {
      moods = (await this.#engine.stickers())?.moods ?? null;
    } catch {
      moods = null;
    }

    const prompt = formatPendingPrompt(item, moods);
    const at = new Date(Date.now() + 800).toISOString();
    const modern = {
      title: `微信消息 · ${item.chat}`,
      prompt,
      timing: { kind: "at", at },
      target: { kind: "session", sessionId: targetSession },
    };

    try {
      return await withTimeout(
        schedule.create(modern),
        this.#wakeTimeoutMs,
        `叫醒超时：${Math.round(this.#wakeTimeoutMs / 1000)}s 内 schedule.create 没返回`,
      );
    } catch (err) {
      // 超时的场合不要再用旧签名重试：create 可能只是慢，再叫一次等于重复唤醒。
      if (/叫醒超时/.test(String(err?.message))) throw err;
      return await withTimeout(
        schedule.create(targetSession, { title: modern.title, prompt, at }),
        this.#wakeTimeoutMs,
        `叫醒超时（旧签名）：${Math.round(this.#wakeTimeoutMs / 1000)}s 内 schedule.create 没返回`,
      );
    }
  }

  /** 一轮：取待办 → 对新的逐个唤醒 → 清掉已经消失的 id。 */
  async pollOnce() {
    if (this.#busy) return 0;
    this.#busy = true;
    this.#busySince = Date.now();
    const token = ++this.#runToken;
    this.#polls++;

    try {
      const body = await this.#engine.pending();
      const items = Array.isArray(body?.items) ? body.items : [];
      this.#lastPollAt = Date.now();
      this.#lastError = "";

      const fresh = pickNewItems(this.#seen, items);
      let woke = 0;

      for (const item of fresh) {
        if (this.#stopped) break;
        try {
          await this.wake(item);
          this.#seen.add(item.id);
          this.#attempts.delete(item.id);
          this.#wakes++;
          this.#lastWakeAt = Date.now();
          // 记上叫醒的是哪个会话：多群对齐后，排查「串话题」第一眼看的就是这个
          const target = this.sessionFor(item.chat);
          const tag = target === this.#sessionId ? "" : "（专属会话）";
          this.#log(`已叫醒会话处理「${item.chat}」（${String(item.id).slice(0, 8)}）${tag} → ${String(target).slice(0, 20)}`);
          this.#onEvent({ type: "wake", id: item.id, chat: item.chat });
          woke++;
        } catch (err) {
          // 叫醒失败不能当成「已处理」：失败一次就永远没人回是不行的。
          // 允许重试，但要有上限，免得一条坏待办每 8 秒刷一辈子日志。
          const n = (this.#attempts.get(item.id) ?? 0) + 1;
          this.#attempts.set(item.id, n);
          const reason = String(err?.message || err);
          if (n >= WAKE_MAX_ATTEMPTS) {
            this.#seen.add(item.id);
            this.#attempts.delete(item.id);
            this.#log(`叫醒失败 ${n} 次，放弃这条「${item.chat}」（${String(item.id).slice(0, 8)}）：${reason}`);
          } else {
            this.#log(`叫醒失败（第 ${n}/${WAKE_MAX_ATTEMPTS} 次，下次重试）：${reason}`);
          }
          this.#onEvent({ type: "wake-error", id: item.id, error: reason });
        }
      }

      // 待办里已经消失的 id 清掉，避免两个 Map/Set 无限增长
      const alive = new Set(items.map((i) => i.id));
      for (const id of this.#seen) if (!alive.has(id)) this.#seen.delete(id);
      for (const id of this.#attempts.keys()) if (!alive.has(id)) this.#attempts.delete(id);

      return woke;
    } catch (err) {
      this.#lastError = String(err?.message || err);
      throw err;
    } finally {
      // 看门狗可能已经把 #busy 复位、并让新一轮接管：只有当前轮次能清 #busy
      if (this.#runToken === token) {
        this.#busy = false;
        this.#busySince = 0;
      }
    }
  }

  /**
   * 卡死的轮询：强制把 #busy 复位，让下一拍能重新开始。
   * 返回是否真的复位了。
   */
  unstick() {
    if (!this.#busy) return false;
    const stuckMs = Date.now() - this.#busySince;
    if (stuckMs < this.#stallMs) return false;
    this.#busy = false;
    this.#busySince = 0;
    this.#watchdogResets++;
    this.#runToken++;
    this.#log(`看门狗：上一轮轮询卡了 ${Math.round(stuckMs / 1000)}s 没结束，强制复位重来`);
    this.#onEvent({ type: "watchdog-reset", stuckMs });
    return true;
  }

  start() {
    if (this.#timer) return false;
    this.#stopped = false;
    this.#log(
      `桥接启动：轮询 ${this.#intervalMs}ms · 叫醒超时 ${Math.round(this.#wakeTimeoutMs / 1000)}s · 看门狗 ${Math.round(this.#stallMs / 1000)}s · 会话 ${this.#sessionId.slice(0, 8)}`,
    );
    const tick = () => {
      // 先看上一轮是不是早该结束了；卡死就复位，否则这一拍又是空转。
      try {
        this.unstick();
      } catch {
        /* ignore */
      }
      this.pollOnce().catch((err) => this.#log(`轮询失败：${err?.message || err}`));
    };
    tick();
    this.#timer = setInterval(tick, this.#intervalMs);
    if (this.#timer.unref) this.#timer.unref();
    return true;
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#busy = false;
    this.#busySince = 0;
    this.#runToken++;
  }
}