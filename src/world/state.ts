/**
 * 世界模型：每个会话「现在是什么样」。
 *
 * 只存**判断需要的东西**：最近消息、谁说的、回过没有、冷却到什么时候。
 * 真相仍然是事件流（data/events/*.jsonl），这里只是加速与跨重启的落脚点。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Side = "me" | "other" | "unknown";

export interface SeenMessage {
  /** chat + 谁说的 + 文本 + 位置桶的哈希（稳定：同一句话不会因为读它的时候不同就换 id） */
  id: string;
  text: string;
  from: Side;
  /** 群聊里的发送者昵称（气泡上方那行小字）；私聊和自己的消息没有 */
  sender?: string;
  firstSeenAt: number;
  /**
   * 最近一次在屏幕上看到它的时间。去重窗口按它算，firstSeenAt 留给策略判断「新不新」。
   * （同一条消息在屏幕上挂半小时，不能每半小时就当新的再回一次 —— 旧插件用 seen TTL 续期解决。）
   */
  lastSeenAt?: number;
  source: "ocr" | "copy";
  /** 屏幕上的纵坐标，用来判断先后 */
  y: number;
}

export interface ChatState {
  name: string;
  kind: "group" | "dm" | "unknown";
  unread: number;
  lastText: string;
  lastFrom: Side;
  lastSeenAt: number;
  /** 已经回到哪条消息（消息 id） */
  repliedTo?: string;
  /** 最近的回复时间戳，用于限频 */
  replies: number[];
  /** 这个会话在这个时间之前不回复 */
  cooldownUntil: number;
  /** 最近看到的消息（去重用） */
  seen: SeenMessage[];
  /**
   * 没处理掉的消息（冷却/合并窗口/静默期里攒下的）。
   * 旧插件叫 pendingText：冷却没到时消息一条都不能丢 —— 它们已经进 seen，
   * 120 秒的预算会把它们抵掉，等冷却解除、再进会话时微信又清了未读，就永久丢了。
   */
  unsent?: SeenMessage[];
  /** 回复那一刻屏幕上最后一条消息的 id（旧插件的 preSend：比我们发言还早的行不算新消息） */
  preReplyTailId?: string;
  /** 回复时刻：这之前就在屏幕上的行，之后被重新读到也不算新 */
  preReplyAt?: number;
  /** 回复那一刻屏幕上的文本快照（OCR 读歪一两个字也能认回来） */
  preReplyTexts?: string[];
  /** 自己最近发过的话：绿色气泡被 OCR 读成「对方」时，靠它认出「这是我刚说的」 */
  ownReplies?: Array<{ text: string; at: number }>;
}

export interface WorldSnapshot {
  updatedAt: number;
  chats: Record<string, ChatState>;
}

export interface WorldOptions {
  /** 持久化文件；不给就只在内存里 */
  file?: string;
  /** 每个会话保留多少条历史（去重窗口） */
  history?: number;
  /**
   * 去重窗口。旧插件 SEEN_TTL_MS = 30 分钟；这里原来只有 120 秒 ——
   * 太短：读过的消息被微信清掉未读后重进会话，整屏会重新读一遍，两分钟后就又「新」了。
   */
  dedupeWindowMs?: number;
}

/** 去重窗口默认 30 分钟（旧插件真机验证过的值） */
const DEFAULT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
/** 发言时刻快照的有效期：旧插件 preSend 保留 20 分钟 */
const PRE_REPLY_TTL_MS = 20 * 60 * 1000;
/** 自己发过的话保留多久（旧插件 recentSends 用 15 分钟） */
const OWN_REPLY_TTL_MS = 15 * 60 * 1000;
/** 未处理队列上限：够补一小波，不能被刷屏撑爆 */
const UNSENT_CAP = 20;

/** 稳定 id 的 y 分桶：同一位置的同一条消息 id 不变，不同位置的两句「哈哈」不会撞成一条 */
const Y_BUCKET_PX = 40;

export class World {
  readonly #file?: string;
  readonly #history: number;
  readonly #dedupeWindowMs: number;
  #chats: Record<string, ChatState> = {};
  #updatedAt = 0;

  constructor(opts: WorldOptions = {}) {
    this.#file = opts.file;
    this.#history = opts.history ?? 40;
    this.#dedupeWindowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  }

  load(): void {
    if (!this.#file || !existsSync(this.#file)) return;
    try {
      const snap = JSON.parse(readFileSync(this.#file, "utf8")) as WorldSnapshot;
      this.#chats = snap.chats ?? {};
      this.#updatedAt = snap.updatedAt ?? 0;
    } catch {
      // 坏文件就当没有，不要让监控起不来
      this.#chats = {};
    }
  }

  save(): void {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const snap: WorldSnapshot = { updatedAt: Date.now(), chats: this.#chats };
    writeFileSync(this.#file, JSON.stringify(snap, null, 2), "utf8");
    this.#updatedAt = snap.updatedAt;
  }

  get updatedAt(): number {
    return this.#updatedAt;
  }

  chat(name: string): ChatState {
    let state = this.#chats[name];
    if (!state) {
      state = {
        name,
        kind: "unknown",
        unread: 0,
        lastText: "",
        lastFrom: "unknown",
        lastSeenAt: 0,
        replies: [],
        cooldownUntil: 0,
        seen: [],
        unsent: [],
      };
      this.#chats[name] = state;
    }
    return state;
  }

  list(): ChatState[] {
    return Object.values(this.#chats);
  }

  /**
   * 局部更新。group 不允许被一次误判降级成 dm —— 旧插件的头条教训：
   * 群被当成私聊 → 没人 @ 也在群里回话。真机里标题 OCR 偶尔会丢「(23)」后缀，
   * 而每一拍都会重新判一次类型，所以这里必须有「只升不降」的记忆。
   * dm → group 允许升级；要显式降级就传 { force: true }（人工纠错用）。
   */
  patch(
    name: string,
    patch: Partial<Omit<ChatState, "name" | "seen">>,
    opts: { force?: boolean } = {},
  ): ChatState {
    const state = this.chat(name);
    const next: Partial<Omit<ChatState, "name" | "seen">> = { ...patch };
    if (!opts.force && state.kind === "group" && next.kind !== undefined && next.kind !== "group") {
      delete next.kind;
    }
    Object.assign(state, next);
    return state;
  }

  /**
   * 群聊的硬证据：一次 ingest 里出现 ≥2 个不同的发送者昵称 —— 私聊里
   * 只有对方一个人说话（而且私聊气泡没有昵称行），所以这是不依赖标题的判群线索。
   * 标题只是第一层线索；旧插件三层里的第二层（正文人名数）就是它。
   */
  noteGroupEvidence(name: string, distinctSenders: string[] | number): boolean {
    const count = typeof distinctSenders === "number" ? distinctSenders : new Set(distinctSenders.filter(Boolean)).size;
    if (!Number.isFinite(count) || count < 2) return false;
    const state = this.chat(name);
    if (state.kind === "group") return false;
    state.kind = "group";
    return true;
  }

  /**
   * 把「这一屏读到的消息」并进世界。
   * 返回**新增**的那些（按屏幕从上到下）。
   *
   * 去重是三层（旧插件真机验证过的顺序）：
   *  ① 多重集抵扣：最近 30 分钟读到过的同一条文本，本轮读到几次就抵扣几次；
   *  ② 发言时刻快照：回复之前就在屏幕上的行，之后重新读到不算新消息；
   *  ③ 模糊匹配：OCR 读歪一两个字仍算同一条（只对 ≥6 字的文本启用）。
   * 这里原来只有「20 条 / 120 秒」的一层，且 makeId 掺了 Date.now() —— 同一条消息
   * 每读一次就换一个 id，policy 里「这条已经回过了」的判断在真实链路上永远不成立。
   */
  ingest(name: string, incoming: Array<Omit<SeenMessage, "id" | "firstSeenAt" | "lastSeenAt">>, now = Date.now()): SeenMessage[] {
    const state = this.chat(name);
    const added: SeenMessage[] = [];
    const windowMs = this.#dedupeWindowMs;

    // ① 多重集抵扣：把窗口内「同一个人说的同一句话」数出来，本轮读到几次就抵扣几次。
    // 这样既能吸收「同一屏被重复 OCR」，又不会把新出现的第二句「哈哈」吃掉。
    // 用「打勾」而不是计数表：sender 可能这一拍没读到、下一拍才读到（dm 升群就是这种情况），
    // 计数表要求键完全一致会把整屏老消息又当成新消息。
    const pool = state.seen
      .filter((m) => now - seenAt(m) <= windowMs)
      .map((m) => ({ m, used: false }));
    const recentSeen: SeenMessage[] = pool.map((p) => p.m);

    // ② 发言时刻快照：只有 20 分钟内有效（旧插件 preSend 同窗口）
    const snapshotActive = state.preReplyAt !== undefined && now - state.preReplyAt <= PRE_REPLY_TTL_MS;
    const snapshotTexts = snapshotActive ? (state.preReplyTexts ?? []) : [];

    // 自己最近说过的话：绿色气泡被读成「对方」时不算新消息
    const ownTexts = (state.ownReplies ?? []).filter((r) => now - r.at <= OWN_REPLY_TTL_MS);

    // 同一屏里完全相同的重复条目才用 seq 消解（id 本身不含时间，重复读同一屏 id 不变）
    const seqOf = new Map<string, number>();
    const senders = new Set<string>();

    for (const msg of incoming) {
      if (!msg || !msg.text) continue;
      if (msg.sender) senders.add(msg.sender);

      const norm = normText(msg.text);
      // 同一个身份（谁、谁说的、同一句话）的旧条目，一条只抵扣一次
      let hit = pool.find(
        (p) => !p.used && p.m.from === msg.from && sameSender(p.m.sender, msg.sender) && normText(p.m.text) === norm,
      );
      if (!hit && msg.sender) {
        // dm 升成群之后，老条目没有 sender（那时候还没从正文里读到昵称）；
        // 只要同侧、同一句话，就当作同一条，别把整屏重读一遍。
        hit = pool.find((p) => !p.used && !p.m.sender && p.m.from === msg.from && normText(p.m.text) === norm);
      }
      if (hit) {
        // 同一条消息又读到一次：不算新，但续一下去重窗口（屏幕上挂着就一直别当新的）
        hit.used = true;
        hit.m.lastSeenAt = now;
        continue;
      }

      const baseId = makeId(name, msg.from, msg.sender, msg.text, msg.y);

      // 她自己刚发的那条被重新读成「对方」：认出来，别对着自己的话回
      if (msg.from !== "me" && ownTexts.some((r) => sameText(r.text, msg.text))) continue;

      // 回复前就在屏幕上的旧消息（包括被 OCR 读歪一点的版本）：记进 seen 续窗口，但不算新
      if (snapshotTexts.length > 0 && (baseId === state.preReplyTailId || snapshotTexts.some((t) => sameText(t, msg.text)))) {
        const old = remember(state, msg, baseId, now, seqOf);
        recentSeen.push(old);
        continue;
      }

      // ③ 模糊匹配：OCR 读歪一两个字 —— 同一个人、同一侧、≥6 字才比。
      //   文本完全相同的不走模糊：那是同一屏里两条真的一样的消息（不同位置），
      //   交给上面的 y 分桶 + 多重集去区分，别把两条合成一条。
      //   sender 允许一边缺失：昵称行这一拍没读到时，仍要认得出是同一条。
      const fuzzy = recentSeen.find(
        (m) =>
          m.from === msg.from &&
          (sameSender(m.sender, msg.sender) || !m.sender || !msg.sender) &&
          normText(m.text) !== norm &&
          looksSameText(m.text, msg.text),
      );
      if (fuzzy) {
        fuzzy.lastSeenAt = now;
        continue;
      }

      const seenMsg = remember(state, msg, baseId, now, seqOf);
      added.push(seenMsg);
      // 同一屏里后面的行也要能和刚才这条比（同一条消息的两个 OCR 变体只算一条）
      recentSeen.push(seenMsg);
      state.lastText = msg.text;
      state.lastFrom = msg.from;
      state.lastSeenAt = now;
    }

    // 判群的第二层线索：一屏里有两个以上不同发送者 → 这是群。
    // 升级之后 patch() 也不会再把它降回 dm。
    if (senders.size >= 2) this.noteGroupEvidence(name, [...senders]);

    if (state.seen.length > this.#history) {
      state.seen = state.seen.slice(-this.#history);
    }
    return added;
  }

  /**
   * 记「回过这条」。
   *
   * 同时拍一张**发言时刻快照**：屏幕上最后一条消息的 id + 当时整屏文本。
   * 之后 ingest 到的消息如果与快照重合（或 id 就是那条尾巴），说明它比回复还早，
   * 只是滚动/重绘/OCR 抖动又冒出来了 —— 不当作新消息。
   * replyText 是这次发出去的内容（可选）：有的微信把绿色气泡读成「对方」，
   * 记下来就能在 ingest 里认回去（旧插件 ownList 就是干这个的）。
   */
  markReplied(name: string, messageId: string | undefined, now = Date.now(), replyText?: string): void {
    const state = this.chat(name);
    if (messageId) state.repliedTo = messageId;
    state.replies.push(now);
    state.replies = state.replies.slice(-50);
    state.lastFrom = "me";

    const tail = state.seen[state.seen.length - 1];
    state.preReplyTailId = tail?.id;
    state.preReplyAt = now;
    state.preReplyTexts = [...new Set(state.seen.slice(-40).map((m) => m.text))].filter(Boolean);

    const said = String(replyText ?? "").trim();
    if (said) {
      state.ownReplies = [...(state.ownReplies ?? []), { text: said, at: now }]
        .filter((r) => now - r.at <= 24 * 60 * 60 * 1000)
        .slice(-30);
    }
  }

  /** 把这一拍没处理掉的消息攒起来（冷却/合并窗口/静默期）。按 id 幂等，重复入队不会翻倍。 */
  queueUnsent(name: string, msgs: SeenMessage[]): number {
    const state = this.chat(name);
    if (!state.unsent) state.unsent = [];
    const ids = new Set(state.unsent.map((m) => m.id));
    for (const m of msgs) {
      if (!m || !m.id || ids.has(m.id)) continue;
      state.unsent.push(m);
      ids.add(m.id);
    }
    if (state.unsent.length > UNSENT_CAP) state.unsent = state.unsent.slice(-UNSENT_CAP);
    return state.unsent.length;
  }

  /** 看一眼待补发队列（不清空）。policy.decide 不传 unsent 时会自己读 chat.unsent。 */
  peekUnsent(name: string): SeenMessage[] {
    return [...(this.chat(name).unsent ?? [])];
  }

  /** 取走并清空待补发队列：这一波已经整体回过了。 */
  takeUnsent(name: string): SeenMessage[] {
    const state = this.chat(name);
    const list = state.unsent ?? [];
    state.unsent = [];
    return list;
  }

  clearUnsent(name: string): void {
    this.chat(name).unsent = [];
  }

  /**
   * 从待补发队列里挑出已处理过的删掉，返回删了几条。
   * 「主模型说这条不接」时用：判过的消息还留在队列里，冷却一过又会被捞出来问一遍，
   * 5 分钟一次、一小时上限 20 次，全在问同一批垃圾消息（2026-11-18 真机撞到）。
   */
  dropUnsent(name: string, drop: (m: SeenMessage) => boolean): number {
    const state = this.chat(name);
    const list = state.unsent ?? [];
    const kept = list.filter((m) => !drop(m));
    const removed = list.length - kept.length;
    if (removed > 0) state.unsent = kept;
    return removed;
  }

  /**
   * 还有待补发消息的会话。给巡场用：静默期/冷却期攒下的消息，
   * 等回到列表时红点已经被微信清掉了，列表扫描发现不了它们 —— 得靠这里把人叫回去补。
   */
  listUnsent(): Array<{ name: string; count: number }> {
    return Object.values(this.#chats)
      .filter((c) => (c.unsent?.length ?? 0) > 0)
      .map((c) => ({ name: c.name, count: c.unsent!.length }));
  }

  /** 该会话最近的对话（给脑子看上下文），按屏幕顺序。 */
  context(name: string, limit = 12): SeenMessage[] {
    return this.chat(name).seen.slice(-limit);
  }

  snapshot(): WorldSnapshot {
    return { updatedAt: Date.now(), chats: JSON.parse(JSON.stringify(this.#chats)) as Record<string, ChatState> };
  }

  /** 测试用 */
  reset(): void {
    this.#chats = {};
  }
}

/** 把一条消息记进 seen；同屏完全相同的条目用 #n 后缀区分（id 的 base 本身是稳定的）。 */
function remember(
  state: ChatState,
  msg: Omit<SeenMessage, "id" | "firstSeenAt" | "lastSeenAt">,
  baseId: string,
  now: number,
  seqOf: Map<string, number>,
): SeenMessage {
  const seq = seqOf.get(baseId) ?? 0;
  seqOf.set(baseId, seq + 1);
  const seenMsg: SeenMessage = {
    ...msg,
    id: seq === 0 ? baseId : `${baseId}#${seq}`,
    firstSeenAt: now,
    lastSeenAt: now,
  };
  state.seen.push(seenMsg);
  return seenMsg;
}

function seenAt(m: SeenMessage): number {
  return m.lastSeenAt ?? m.firstSeenAt;
}

/** 同一个人（群昵称）才可能是「同一条消息被读歪」。私聊两边都没昵称。 */
function sameSender(a?: string, b?: string): boolean {
  return (a ?? "") === (b ?? "");
}

/**
 * 稳定身份 id：chat | from | sender | 规范化文本 | y 分桶。
 * **不掺时间戳**：同一条消息今天读、明天读都必须是同一个 id，
 * 否则 policy 的 repliedTo 判断（这条回没回过）在真实链路上永远不成立。
 */
function makeId(chat: string, from: Side, sender: string | undefined, text: string, y: number): string {
  const bucket = Number.isFinite(y) ? Math.round(y / Y_BUCKET_PX) : 0;
  return createHash("sha1")
    .update(`${chat}|${from}|${sender ?? ""}|${normText(text)}|${bucket}`)
    .digest("hex")
    .slice(0, 16);
}

/** 身份比较用的规范化：去空白、统一大小写（标点靠模糊层兜）。 */
function normText(text: string): string {
  return String(text ?? "").replace(/\s+/g, "").toLowerCase();
}

/** 模糊比较前要去的字符：空白 + 中英文标点（OCR 经常多读/少读一个逗号） */
const PUNCT = /[\s，。！？、：；,.!?:;~～“”"'‘’（）()\[\]【】《》<>…—\-_]/g;

function stripPunct(text: string): string {
  return String(text ?? "").replace(PUNCT, "");
}

function bigrams(text: string): Set<string> {
  const t = stripPunct(text);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 两条文本是不是「同一条被 OCR 读歪一两个字」。
 *
 * 旧插件 poller.js 的做法：去标点后取字符二元组集合，算 Jaccard ≥ 0.5 就算同一条。
 * 只对 ≥6 字的文本启用 —— 短句（「好的」「哈哈」）差一个字就完全是另一个意思，误伤太大。
 */
export function looksSameText(a: string, b: string): boolean {
  const x = stripPunct(a);
  const y = stripPunct(b);
  if (x.length < 6 || y.length < 6) return false;
  const A = bigrams(x);
  const B = bigrams(y);
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter) >= 0.5;
}

/** 精确（去空白）或模糊（≥6 字）比较。 */
function sameText(a: string, b: string): boolean {
  return normText(a) === normText(b) || looksSameText(a, b);
}