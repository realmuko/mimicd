/**
 * 待回复队列：引擎发现「该回了」，但不自己编话——把上下文挂起，等主模型（DSH 会话）或人来给文本。
 *
 * 为什么要有它：本地 4B 只能把链路跑通，说话质量远不如主模型；
 * 而主模型只能从 DSH 会话里叫醒（旧插件用 schedule.create）。所以引擎把「决定要回」与「说什么」
 * 拆开：决定在引擎（可解释、可回放），文本由主模型给（有记忆、有人格）。
 */

import { randomUUID } from "node:crypto";

import type { BrainContext } from "../brain/brain.ts";

export interface PendingItem {
  id: string;
  chat: string;
  kind: "group" | "dm" | "unknown";
  messages: Array<{ from: string; text: string }>;
  createdAt: number;
  /** 过期时间：太久没回就别回了，避免翻旧账 */
  expiresAt: number;
  /** 已回复 / 已跳过 */
  /** 群聊没 @，等主模型判断要不要接 */
  needsJudgment?: boolean;
  status: "open" | "replied" | "skipped" | "expired";
  reply?: string;
}

export interface PendingOptions {
  /** 挂起多久算过期（默认 5 分钟） */
  ttlMs?: number;
  /** 最多挂几个（防止刷屏） */
  capacity?: number;
}

export class PendingQueue {
  readonly #ttlMs: number;
  readonly #capacity: number;
  #items = new Map<string, PendingItem>();

  constructor(opts: PendingOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.#capacity = opts.capacity ?? 20;
  }

  add(ctx: BrainContext): PendingItem {
    this.sweep();
    const now = Date.now();
    const item: PendingItem = {
      id: randomUUID(),
      chat: ctx.chat,
      kind: ctx.kind ?? "unknown",
      messages: ctx.messages.map((m) => ({ from: m.from, text: m.text })),
      needsJudgment: ctx.needsJudgment,
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      status: "open",
    };
    this.#items.set(item.id, item);
    // 超容量：丢掉最老的
    if (this.#items.size > this.#capacity) {
      const oldest = [...this.#items.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.#items.delete(oldest.id);
    }
    return item;
  }

  list(): PendingItem[] {
    this.sweep();
    return [...this.#items.values()].filter((i) => i.status === "open").sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): PendingItem | undefined {
    this.sweep();
    return this.#items.get(id);
  }

  /**
   * 先占住这条待办再发送：发送要 10–20s，这段窗口里如果又来一条同 id 的回复
   * （插件重载会让 bridge 的去重表清空、真机上就撞到过），两边都会过「状态是不是 open」
   * 的检查、各发一遍。占住之后第二个人直接拿不到。
   */
  claim(id: string): PendingItem | null {
    const item = this.#items.get(id);
    if (!item || item.status !== "open") return null;
    item.status = "replied";
    return item;
  }

  /** 发送失败时把占位还回去，别让这条待办凭空消失。 */
  release(id: string): void {
    const item = this.#items.get(id);
    if (item && item.status === "replied" && !item.reply) item.status = "open";
  }

  /** 便捷：占位 + 记内容（不同步发送；测试和不需要等发送的路径用）。 */
  reply(id: string, text: string): PendingItem | null {
    const item = this.claim(id);
    if (!item) return null;
    item.reply = text;
    return item;
  }

  /** 发送成功后把回的内容记上（claim 已经改过状态）。 */
  finish(id: string, text: string): PendingItem | null {
    const item = this.#items.get(id);
    if (!item) return null;
    item.reply = text;
    return item;
  }

  skip(id: string): PendingItem | null {
    const item = this.#items.get(id);
    if (!item || item.status !== "open") return null;
    item.status = "skipped";
    return item;
  }

  /** 过期的标掉；太久远的直接删，避免无限增长。 */
  sweep(now = Date.now()): void {
    for (const [id, item] of this.#items) {
      if (item.status === "open" && now > item.expiresAt) item.status = "expired";
      if (now - item.createdAt > 30 * 60 * 1000) this.#items.delete(id);
    }
  }

  get size(): number {
    return this.list().length;
  }
}