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
}

const TIME_LIKE = /^(\d{1,2}[:：]\d{2}|\d{4}年|\d{1,2}月\d{1,2}日|昨天|今天|前天|上午|下午|凌晨|晚上|中午)/;
const SYSTEM_LIKE = /(以下为新消息|撤回|加入了群聊|邀请.*加入|被移出|拍了拍|对方正在输入|有人\s*[@＠]\s*我)/;

export function messagesFromOcr(lines: OcrLine[], opts: ReadOptions): ReadMessage[] {
  const meRatio = opts.meRatio ?? 0.55;
  const minHeight = opts.minHeight ?? 20;
  const out: ReadMessage[] = [];

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (line.h < minHeight) continue;
    // 群聊里气泡上方有发送者昵称（小字、靠左），头像附近还有数字噪声 —— 都不是消息正文
    if (line.h < 34 && line.x < opts.width * 0.25) continue;
    if (/^\d+$/.test(text)) continue;
    if (TIME_LIKE.test(text)) continue;
    if (SYSTEM_LIKE.test(text)) continue;
    // 纯符号/单字符（OCR 噪声）
    if (text.replace(/[\s\p{P}\p{S}]/gu, "").length === 0) continue;

    const byColor = opts.bmp ? bubbleSide(opts.bmp, line) : null;
    const centerX = line.x + line.w / 2;
    const from: Side = byColor ?? (centerX > opts.width * meRatio ? "me" : "other");
    out.push({ text, from, y: line.y, h: line.h });
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