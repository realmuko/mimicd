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
  /** chat + 文本 + 时间桶的哈希 */
  id: string;
  text: string;
  from: Side;
  firstSeenAt: number;
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
}

export class World {
  readonly #file?: string;
  readonly #history: number;
  #chats: Record<string, ChatState> = {};
  #updatedAt = 0;

  constructor(opts: WorldOptions = {}) {
    this.#file = opts.file;
    this.#history = opts.history ?? 40;
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
      };
      this.#chats[name] = state;
    }
    return state;
  }

  list(): ChatState[] {
    return Object.values(this.#chats);
  }

  patch(name: string, patch: Partial<Omit<ChatState, "name" | "seen">>): ChatState {
    const state = this.chat(name);
    Object.assign(state, patch);
    return state;
  }

  /**
   * 把「这一屏读到的消息」并进世界。
   * 返回**新增**的那些（按屏幕从上到下）。去重靠文本 + 时间桶：
   * 同一句话在 10 分钟内重复出现只算一次（群里刷屏除外，那种按行数计）。
   */
  ingest(name: string, incoming: Array<Omit<SeenMessage, "id" | "firstSeenAt">>, now = Date.now()): SeenMessage[] {
    const state = this.chat(name);
    const added: SeenMessage[] = [];

    // 多重集去重：把「最近 20 条、2 分钟内」的文本数出来，本轮读到几次就抵扣几次。
    // 这样既能吸收「同一屏被重复 OCR」，又不会把新出现的第二句「哈哈」吃掉。
    const budget = new Map<string, number>();
    for (const m of state.seen.slice(-20)) {
      if (now - m.firstSeenAt > 120_000) continue;
      budget.set(m.text, (budget.get(m.text) ?? 0) + 1);
    }

    for (const msg of incoming) {
      const left = budget.get(msg.text) ?? 0;
      if (left > 0) {
        budget.set(msg.text, left - 1);
        continue;
      }
      const seen: SeenMessage = {
        ...msg,
        id: makeId(name, msg.text, now, state.seen.length),
        firstSeenAt: now,
      };
      state.seen.push(seen);
      added.push(seen);
      state.lastText = msg.text;
      state.lastFrom = msg.from;
      state.lastSeenAt = now;
    }

    if (state.seen.length > this.#history) {
      state.seen = state.seen.slice(-this.#history);
    }
    return added;
  }

  markReplied(name: string, messageId: string | undefined, now = Date.now()): void {
    const state = this.chat(name);
    if (messageId) state.repliedTo = messageId;
    state.replies.push(now);
    state.replies = state.replies.slice(-50);
    state.lastFrom = "me";
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

function makeId(chat: string, text: string, at: number, seq: number): string {
  return createHash("sha1").update(`${chat}|${text}|${at}|${seq}`).digest("hex").slice(0, 16);
}