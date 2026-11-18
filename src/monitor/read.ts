/**
 * 把 OCR 行变成「谁说了什么」。
 *
 * 微信里没有 a11y，判断「这句是我发的还是对方发的」只能靠横坐标：
 *  - 我的气泡靠右（
 *  - 对方靠左。
 * 时间分隔、系统提示、纯符号都要过滤掉，否则会被当成消息喂给模型。
 */

import type { OcrLine } from "../perception/ocr.ts";
import type { Bitmap } from "../image/image.ts";
import type { Side } from "../world/state.ts";

export interface ReadMessage {
  text: string;
  from: Side;
  y: number;
  /** OCR 置信度代理：字高。太小的行多半是时间/预览 */
  h: number;
  /** 群聊里这条消息是谁发的（气泡上方的昵称）；私聊/自己的消息没有 */
  sender?: string;
}

/**
 * 判断这句话是谁说的。
 *
 * 只靠左右分边在长气泡上会翻车（长句横跨大半屏，中心点跑到左边），
 * 所以优先看**气泡底色**：微信里我说的是绿色 (#95EC69)，对方是白色。
 */
export function bubbleSide(bmp: Bitmap, line: OcrLine): Side | null {
  const y = Math.min(bmp.height - 1, Math.max(0, Math.round(line.y + line.h / 2)));
  const x0 = Math.max(0, Math.round(line.x) - 14);
  const x1 = Math.min(bmp.width - 1, Math.round(line.x + line.w) + 14);
  let green = 0;
  let white = 0;
  let total = 0;
  for (let x = x0; x <= x1; x += 2) {
    const p = (y * bmp.width + x) * 4;
    const r = bmp.data[p]!;
    const g = bmp.data[p + 1]!;
    const b = bmp.data[p + 2]!;
    total++;
    if (g > 195 && r > 105 && r < 195 && b < 160) green++;
    else if (r > 238 && g > 238 && b > 238) white++;
  }
  if (total === 0) return null;
  if (green / total > 0.25) return "me";
  if (white / total > 0.25) return "other";
  return null;
}

export interface ReadOptions {
  /** 屏幕宽，用来算左右 */
  width: number;
  /** 气泡中心 x 超过这个比例算「我发的」 */
  meRatio?: number;
  /** 小于这个字高的行当噪声 */
  minHeight?: number;
  /** 有截图时优先用气泡颜色判左右 */
  bmp?: Bitmap;
  /** 群聊：气泡上方那行小字是发送者昵称，要收下来归属给下面那条消息 */
  group?: boolean;
}

/**
 * 时间分隔行。旧插件 poller.js:225-231 的 NOISE_LINE 比这里多几条，都补上了：
 *  - 「星期X / 周X」：微信整点分隔会写成「星期三」这种，一条数字都不带；
 *    **整行锚定**（`^…$`）：聊天里说「星期一我们去吧」是内容，只有一行只有「星期三」才算分隔行；
 *  - 「早上 / 傍晚 / 深夜」：旧表里只有上午/下午/凌晨/晚上/中午，实测还有「早上 8:15」；
 *  - 「昨天 12:22」「前天 12:22」：以「昨天/前天」开头的行本来就是旧表的判据，保留。
 * 其余分支只认**句首**（`^`），不认句中 —— 句中的时间词是正常聊天内容。
 */
const TIME_LIKE =
  /^(\d{1,2}[:：]\d{2}|\d{4}年|\d{1,2}月\d{1,2}日|昨天|今天|前天|上午|下午|凌晨|晚上|中午|早上|傍晚|深夜|(星期|周)[一二三四五六日天]$)/;

/**
 * 系统提示（句中匹配）：撤回、入群、拍一拍、@我提示……
 * 这些出现在气泡上方，且任何位置出现都不像正常聊天内容。
 */
const SYSTEM_LIKE = /(以下为新消息|撤回|加入了群聊|邀请.*加入|被移出|拍了拍|对方正在输入|有人\s*[@＠]\s*我)/;

/**
 * 界面噪声（旧插件 poller.js:154-163 的 UI_NOISE）：**整行锚定**。
 *
 * 补这几条是因为真机上它们会被 OCR 当消息读进来：
 *  - 「微信：刚刚」这类是**浮层横幅**（不是聊天内容，出现在屏幕顶部）；
 *  - 「[16条]」是会话预览里的未读数，整行只有它；
 *  - 「查看更多消息 / 回到顶部 / 查看更早消息 / 收起 / 展开」是列表与浮层上的按钮文字。
 * 全部用 `^...$` 整行锚定：聊天里说「展开说说」「回到顶部那段」是正常内容，
 * 只要不是一行只有这几个字就不算噪声 —— 这就是「别误伤正常聊天内容」的边界。
 */
const UI_NOISE =
  /^(微信\s*[:：].*|\[?\d+\s*条\]?|查看更多消息|查看更早消息|回到顶部|收起|展开|以下是新消息|以下为新消息)$/;

export function messagesFromOcr(lines: OcrLine[], opts: ReadOptions): ReadMessage[] {
  const meRatio = opts.meRatio ?? 0.55;
  const minHeight = opts.minHeight ?? 20;
  const out: ReadMessage[] = [];
  /** 群里刚读到、还没归属出去的发送者昵称 */
  let pendingSender: string | undefined;

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (line.h < minHeight) continue;
    // 群聊里气泡上方那行是发送者昵称（小字、靠左），头像附近还有数字噪声。
    // 以前这里直接 continue，把昵称整个丢掉了 —— 模型只看到一整屏「对方：...」，
    // 根本不知道是群里哪个人说的，接话自然就接不准。
    // 现在收下来，挂到它下面那条消息上；时间、系统提示、纯数字仍然丢掉。
    if (line.h < 34 && line.x < opts.width * 0.25) {
      if (opts.group && !/^\d+$/.test(text) && !TIME_LIKE.test(text) && !SYSTEM_LIKE.test(text) && !UI_NOISE.test(text)) {
        pendingSender = text;
      }
      continue;
    }
    if (/^\d+$/.test(text)) continue;
    if (TIME_LIKE.test(text)) continue;
    if (SYSTEM_LIKE.test(text)) continue;
    // 界面噪声（浮层横幅 / [16条] / 查看更多消息 …），整行锚定，不会误伤聊天内容
    if (UI_NOISE.test(text)) continue;
    // 纯符号/单字符（OCR 噪声）
    if (text.replace(/[\s\p{P}\p{S}]/gu, "").length === 0) continue;

    const byColor = opts.bmp ? bubbleSide(opts.bmp, line) : null;
    const centerX = line.x + line.w / 2;
    const from: Side = byColor ?? (centerX > opts.width * meRatio ? "me" : "other");
    // OCR 有时把「昵称：内容」读成一整行（群里昵称就在气泡上方，字高接近时会合并）。
    // 旧插件在 lineKey 里专门剥过这个前缀；不剥的话"谁说的"就混进正文，模型会当成
    // 对方在说"某某：xxx"。只在群聊、只在对方消息上剥，前缀不允许带空白。
    let body = text;
    let senderFromPrefix: string | undefined;
    if (opts.group && from === "other") {
      const m = /^([^\s：:]{1,12})[：:]\s*(.+)$/.exec(text);
      if (m && !/^我$/.test(m[1]!) && !/^\d+$/.test(m[1]!)) {
        senderFromPrefix = m[1]!;
        body = m[2]!;
      }
    }
    const sender = from === "other" ? senderFromPrefix ?? pendingSender : undefined;
    out.push({ text: body, from, y: line.y, h: line.h, ...(sender ? { sender } : {}) });
    // 自己发的消息没有昵称行，别把上一个人的名字留给后面
    if (from === "me") pendingSender = undefined;
  }

  out.sort((a, b) => a.y - b.y);
  return out;
}

/** 把同一侧的连续行合并成一条消息（气泡换行会被 OCR 拆成多行）。 */
export function mergeBubbles(messages: ReadMessage[], lineGap = 34): ReadMessage[] {
  const out: ReadMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    // 同一个气泡里的换行：同侧、纵向间隔小于「行距阈值」与「0.9 倍字高」中较大的那个
    const gap = prev ? msg.y - (prev.y + prev.h) : Number.POSITIVE_INFINITY;
    if (prev && prev.from === msg.from && gap < Math.max(lineGap, prev.h * 0.9)) {
      prev.text = `${prev.text}${needsSpace(prev.text, msg.text) ? " " : ""}${msg.text}`;
      // 气泡换行合并，发送者要跟着走（同一气泡只可能是一个人）
      if (!prev.sender && msg.sender) prev.sender = msg.sender;
      // 合并后把 y/h 更新到「最后一行」，否则下一行的间隔是按第一行算的，永远合不上
      prev.y = msg.y;
      prev.h = msg.h;
      continue;
    }
    out.push({ ...msg });
  }
  return out;
}

function needsSpace(a: string, b: string): boolean {
  const last = a.slice(-1);
  const first = b.slice(0, 1);
  return /[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(first);
}