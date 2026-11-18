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
  /** 群聊策略：mention = 只回 @ 我；judge = 交给主模型判断要不要接话 */
  groupStrategy: "mention" | "judge";
  /** 兼容旧配置：等价于 groupStrategy=mention */
  groupMentionOnly?: boolean;
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
  groupStrategy: "mention",
  selfNames: [],
};

export interface Decision {
  reply: boolean;
  reason: string;
  /** 群聊里没 @、但按 judge 策略放行，让主模型决定说不说 */
  needsJudgment?: boolean;
}

export interface DecideInput {
  now: number;
  chat: ChatState;
  /** 本轮新看到的消息 */
  fresh: SeenMessage[];
  config?: Partial<PolicyConfig>;
}

export function inQuietHours(hour: number, range: [number, number]): boolean {
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

  let needsJudgment = false;
  if (chat.kind === "group") {
    const mentioned = input.fresh.some((m) => m.from === "other" && mentionsMe(m.text, cfg.selfNames));
    const strategy = cfg.groupMentionOnly === true ? "mention" : cfg.groupStrategy;
    if (!mentioned) {
      if (strategy === "mention") return { reply: false, reason: "群里没 @ 我（mention 策略）" };
      needsJudgment = true;
    }
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

  return { reply: true, reason: needsJudgment ? "群里没 @，交给主模型判断" : "可以回", ...(needsJudgment ? { needsJudgment } : {}) };
}

/** 会话名归一：去空白与常见标点（OCR 会带进来「[]（）:，」这些）。 */
function normChatName(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/[\[\]（）()【】·,，.。:：!！?？]/g, "");
}

/**
 * 两个会话名是不是同一个。
 *
 * 不能要求一字不差：列表里带「有人@我」时，OCR 实测会把群名读成「以摸鱼闲聊群」，
 * 严格比较就永远不在白名单里，群里 @ 了也不回（2026-11-18 真机撞到）。
 */
export function sameChatName(a: string, b: string): boolean {
  const x = normChatName(a);
  const y = normChatName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 只允许"包含"这种容错，且短的那个至少 3 个字，免得一个「以」把什么都匹配上
  if (x.length >= 3 && y.includes(x)) return true;
  if (y.length >= 3 && x.includes(y)) return true;
  return false;
}

/** 从会话列表里挑一个该处理的（白名单优先、未读优先）。返回白名单里的规范名字。 */
export function pickChat(rows: Array<{ name: string; unread: number }>, whitelist: string[]): string | null {
  if (whitelist.length === 0) {
    const unread = rows.filter((r) => r.unread > 0);
    return (unread[0] ?? rows[0])?.name ?? null;
  }
  const matched = rows
    .map((row) => ({ row, canon: whitelist.find((w) => sameChatName(row.name, w)) ?? null }))
    .filter((x): x is { row: { name: string; unread: number }; canon: string } => x.canon !== null);
  const unread = matched.filter((x) => x.row.unread > 0);
  return (unread[0] ?? matched[0])?.canon ?? null;
}