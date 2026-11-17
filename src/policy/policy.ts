/**
 * 策略：决定「这一条要不要回」。
 *
 * 全部是硬规则，不放在 prompt 里（反模式 7）。每条拒绝都要给出可解释的 reason，
 * 这样事件流里能回答「她为什么没理我」。
 */

import type { ChatState, SeenMessage } from "../world/state.ts";
import { mentionsMe } from "../monitor/chat.ts";

export interface PolicyConfig {
  /** 只理这些会话；空数组表示不限 */
  whitelist: string[];
  /** 静默时段（小时，支持跨零点，如 [23, 8]） */
  quietHours: [number, number] | null;
  /** 同一个会话两次回复的最小间隔 */
  minGapMs: number;
  /** 每小时最多主动回复几条 */
  maxPerHour: number;
  /** 只回对方说的话（自己刚发过就不接） */
  requireOtherSide: boolean;
  /** 单条回复最长字符数 */
  maxReplyChars: number;
  /** 群聊里只回 @ 我的 */
  groupMentionOnly: boolean;
  /** 我自己的昵称（用于识别 @） */
  selfNames: string[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  whitelist: [],
  quietHours: [23, 8],
  minGapMs: 5 * 60 * 1000,
  maxPerHour: 6,
  requireOtherSide: true,
  maxReplyChars: 200,
  groupMentionOnly: true,
  selfNames: [],
};

export interface Decision {
  reply: boolean;
  reason: string;
}

export interface DecideInput {
  now: number;
  chat: ChatState;
  /** 本轮新看到的消息 */
  fresh: SeenMessage[];
  config?: Partial<PolicyConfig>;
}

function inQuietHours(hour: number, range: [number, number]): boolean {
  const [start, end] = range;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // 跨零点，例如 23..8
  return hour >= start || hour < end;
}

export function decide(input: DecideInput): Decision {
  const cfg = { ...DEFAULT_POLICY, ...input.config };
  const chat = input.chat;
  const now = input.now;

  if (input.fresh.length === 0) return { reply: false, reason: "没有新消息" };

  if (cfg.whitelist.length > 0 && !cfg.whitelist.includes(chat.name)) {
    return { reply: false, reason: `「${chat.name}」不在白名单` };
  }

  if (cfg.quietHours) {
    const hour = new Date(now).getHours();
    if (inQuietHours(hour, cfg.quietHours)) {
      return { reply: false, reason: `静默时段（${cfg.quietHours[0]}–${cfg.quietHours[1]} 点）` };
    }
  }

  if (chat.kind === "group" && cfg.groupMentionOnly) {
    const mentioned = input.fresh.some((m) => m.from === "other" && mentionsMe(m.text, cfg.selfNames));
    if (!mentioned) return { reply: false, reason: "群里没 @ 我" };
  }

  if (cfg.requireOtherSide) {
    const last = input.fresh[input.fresh.length - 1]!;
    if (last.from === "me") return { reply: false, reason: "最后一条是我自己发的" };
    if (!input.fresh.some((m) => m.from === "other")) {
      return { reply: false, reason: "这轮没有对方的新消息" };
    }
  }

  if (chat.repliedTo && input.fresh.every((m) => m.id === chat.repliedTo)) {
    return { reply: false, reason: "这条已经回过了" };
  }

  if (chat.cooldownUntil > now) {
    return { reply: false, reason: `会话冷却到 ${new Date(chat.cooldownUntil).toISOString()}` };
  }

  const lastReply = chat.replies[chat.replies.length - 1] ?? 0;
  if (now - lastReply < cfg.minGapMs) {
    return { reply: false, reason: `距上次回复不足 ${Math.round(cfg.minGapMs / 60000)} 分钟` };
  }

  const hourAgo = now - 60 * 60 * 1000;
  const recent = chat.replies.filter((t) => t >= hourAgo).length;
  if (recent >= cfg.maxPerHour) {
    return { reply: false, reason: `这一小时已回 ${recent} 条，到上限` };
  }

  return { reply: true, reason: "可以回" };
}

/** 从会话列表里挑一个该处理的（白名单优先、未读优先）。 */
export function pickChat(rows: Array<{ name: string; unread: number }>, whitelist: string[]): string | null {
  const pool = whitelist.length > 0 ? rows.filter((r) => whitelist.includes(r.name)) : rows;
  const unread = pool.filter((r) => r.unread > 0);
  return (unread[0] ?? pool[0])?.name ?? null;
}