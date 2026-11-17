/**
 * 会话页的标题与类型。
 *
 * 用途有两个：
 *  1. 进会话后**核对标题**——点错行、界面没切过去时，宁可不回（旧插件发错窗口就是这么出的）；
 *  2. 判断群/私聊：群标题带成员数「群名(23)」，私聊是「昵称」。
 */

import type { OcrLine } from "../perception/ocr.ts";

export type ChatKind = "group" | "dm" | "unknown";

/** 群标题的成员数后缀：(23) / （23） */
const GROUP_SUFFIX = /[（(]\s*\d+\s*[)）]\s*$/;

export function detectChatKind(title: string): ChatKind {
  if (!title.trim()) return "unknown";
  return GROUP_SUFFIX.test(title.trim()) ? "group" : "dm";
}

/** 归一化：去空格、去成员数后缀，用于标题与行名的模糊核对。 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\s+/g, "")
    .replace(GROUP_SUFFIX, "")
    .replace(/^[（(]\s*\d+\s*[)）]/, "")
    .trim();
}

/**
 * 从标题栏区域的 OCR 行里取标题。
 * 标题栏通常只有一条短文本（返回箭头与「…」不是文本），取最长的一条最稳。
 */
export function titleFromOcr(lines: OcrLine[]): string {
  const candidates = lines
    .map((l) => l.text.trim())
    .filter((t) => t.length > 0 && !/^\d{1,2}[:：]\d{2}$/.test(t));
  if (candidates.length === 0) return "";
  return candidates.sort((a, b) => b.length - a.length)[0]!;
}

/** 进入的会话是不是我们要的那一个（模糊匹配：包含即可）。 */
export function titleMatches(wanted: string, got: string): boolean {
  const a = normalizeTitle(wanted);
  const b = normalizeTitle(got);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

/**
 * 群里有没有 @ 我。
 *
 * 微信的 @ 显示为「@昵称」，我们自己的昵称从配置里来；
 * 另外「有人@我」是微信自己的系统行，也算。
 */
export function mentionsMe(text: string, selfNames: string[]): boolean {
  if (/有人\s*[@＠]\s*我/.test(text)) return true;
  if (!/[@＠]/.test(text)) return false;
  const compact = text.replace(/\s+/g, "").replace(/＠/g, "@");
  return selfNames.some((name) => {
    const n = name.replace(/\s+/g, "");
    return n.length > 0 && compact.includes(`@${n}`);
  });
}