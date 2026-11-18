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

/** 模糊匹配的最短长度：归一化后短于这个长度就必须完全相等（否则「阿鲤」会匹配「钓鱼群(23)」）。 */
const MIN_FUZZY_LEN = 4;

/**
 * 标题栏里**不是标题**的行：私聊对方正在打字时的占位。
 *
 * 为什么必须滤掉：标题栏现在是把所有行拼起来比对，占位行混进来会变成
 * 「张三 对方正在输入…」；而短名（<4 字）按规矩必须完全相等，于是「张三」
 * 永远核对不上，私聊就再也进不去了。占位行本身不携带任何会话身份，滤掉最干净。
 */
const TITLE_PLACEHOLDER = /^(对方正在输入|对方正在讲话|正在输入)/;

/**
 * 从标题栏区域的 OCR 行里取标题。
 *
 * 以前取「最长的一条」，私聊里对方正在输入时标题栏会多出「对方正在输入…」这一行，
 * 有时比名字还长，于是取到的不是会话名 → 核对失败 / 进错会话。
 * 旧插件的做法是把标题区域内所有行**拼起来**再比对（poller.readChatTitle：
 * `lines.map(l => l.text).join(" ")`），名字被 OCR 拆成两半、或者名字旁边还挂着
 * 「(23)」时都能对上；拼之前先把纯占位行（对方正在输入…）丢掉。
 */
export function titleFromOcr(lines: OcrLine[]): string {
  const parts = lines
    .map((l) => l.text.trim())
    .filter((t) => t.length > 0 && !/^\d{1,2}[:：]\d{2}$/.test(t) && !TITLE_PLACEHOLDER.test(t));
  if (parts.length === 0) return "";
  // 只是把行拼起来；成员数「(23)」与空格交给 normalizeTitle 处理
  return parts.join(" ").trim();
}

/**
 * 进入的会话是不是我们要的那一个（宽松包含匹配）。
 *
 * 必须加长度下限：只做包含判断时，白名单里的短名「阿鲤」会匹配上「钓鱼群(23)」，
 * 于是「点错行」被当成「进对了」，话就说到别人群里（这是本模块存在的唯一理由）。
 * 归一化后短于 4 个字的名，必须**完全相等**才认。
 */
export function titleMatches(wanted: string, got: string): boolean {
  const a = normalizeTitle(wanted);
  const b = normalizeTitle(got);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < MIN_FUZZY_LEN || b.length < MIN_FUZZY_LEN) return false;
  return b.includes(a) || a.includes(b);
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