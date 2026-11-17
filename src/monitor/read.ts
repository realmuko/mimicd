/**
 * 把 OCR 行变成「谁说了什么」。
 *
 * 微信里没有 a11y，判断「这句是我发的还是对方发的」只能靠横坐标：
 *  - 我的气泡靠右（
 *  - 对方靠左。
 * 时间分隔、系统提示、纯符号都要过滤掉，否则会被当成消息喂给模型。
 */

import type { OcrLine } from "../perception/ocr.ts";
import type { Side } from "../world/state.ts";

export interface ReadMessage {
  text: string;
  from: Side;
  y: number;
  /** OCR 置信度代理：字高。太小的行多半是时间/预览 */
  h: number;
}

export interface ReadOptions {
  /** 屏幕宽，用来算左右 */
  width: number;
  /** 气泡中心 x 超过这个比例算「我发的」 */
  meRatio?: number;
  /** 小于这个字高的行当噪声 */
  minHeight?: number;
}

const TIME_LIKE = /^(\d{1,2}[:：]\d{2}|\d{4}年|\d{1,2}月\d{1,2}日|昨天|今天|前天|上午|下午|凌晨|晚上|中午)/;
const SYSTEM_LIKE = /(以下为新消息|撤回|加入了群聊|邀请.*加入|被移出|拍了拍|对方正在输入)/;

export function messagesFromOcr(lines: OcrLine[], opts: ReadOptions): ReadMessage[] {
  const meRatio = opts.meRatio ?? 0.55;
  const minHeight = opts.minHeight ?? 20;
  const out: ReadMessage[] = [];

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (line.h < minHeight) continue;
    if (TIME_LIKE.test(text)) continue;
    if (SYSTEM_LIKE.test(text)) continue;
    // 纯符号/单字符（OCR 噪声）
    if (text.replace(/[\s\p{P}\p{S}]/gu, "").length === 0) continue;

    const centerX = line.x + line.w / 2;
    out.push({
      text,
      from: centerX > opts.width * meRatio ? "me" : "other",
      y: line.y,
      h: line.h,
    });
  }

  out.sort((a, b) => a.y - b.y);
  return out;
}

/** 把同一侧的连续行合并成一条消息（气泡换行会被 OCR 拆成多行）。 */
export function mergeBubbles(messages: ReadMessage[], lineGap = 24): ReadMessage[] {
  const out: ReadMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.from === msg.from && msg.y - (prev.y + prev.h) < lineGap) {
      prev.text = `${prev.text}${needsSpace(prev.text, msg.text) ? " " : ""}${msg.text}`;
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