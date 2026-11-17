/**
 * 给表情打标签：把一张裁好的表情图交给本地视觉模型（qwen3-vl），要一个 JSON。
 *
 * 提示词刻意收窄：只允许它从固定情绪表里选，外加 3 个标签和一个「好玩程度」评分。
 * 模型输出不合法时给保守默认值（未知 / 0.5），**不让它把没看懂的东西标成「开心」**。
 */

import { colorHist, dhash, type Bitmap } from "../image/image.ts";
import { encode } from "../image/image.ts";

export const MOODS = ["开心", "无语", "敷衍", "惊讶", "亲昵", "嘲讽", "委屈", "其他"] as const;
export type Mood = (typeof MOODS)[number];

export interface LabelResult {
  mood: Mood;
  tags: string[];
  funny: number;
  /** 模型原始输出，便于排查 */
  raw?: string;
}

export interface LabelerOptions {
  /** Ollama 地址，默认本机 */
  url?: string;
  model?: string;
  timeoutMs?: number;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
}

const PROMPT = [
  "这是一个微信表情包的缩略图。请只输出 JSON，不要解释。",
  "格式：{\"mood\":\"...\",\"tags\":[\"...\",\"...\"],\"funny\":0.0}",
  `mood 只能取：${MOODS.join(" / ")}`,
  "tags：3 个中文短词，描述这个表情在什么场合用（例如 打招呼 / 敷衍 / 震惊）。",
  "funny：0 到 1 之间，越有意思越高；看不懂就给 0.3。",
].join("\n");

export class StickerLabeler {
  readonly #opts: Required<Pick<LabelerOptions, "url" | "model" | "timeoutMs">> & { fetchImpl: typeof fetch };

  constructor(opts: LabelerOptions = {}) {
    this.#opts = {
      url: opts.url ?? "http://127.0.0.1:11434",
      model: opts.model ?? "qwen3-vl:4b-instruct",
      timeoutMs: opts.timeoutMs ?? 60000,
      fetchImpl: opts.fetchImpl ?? fetch,
    };
  }

  async label(bmp: Bitmap): Promise<LabelResult> {
    const png = encode(bmp);
    const base64 = png.toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#opts.timeoutMs);
    try {
      const res = await this.#opts.fetchImpl(`${this.#opts.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.#opts.model,
          stream: false,
          format: "json",
          messages: [{ role: "user", content: PROMPT, images: [base64] }],
          options: { temperature: 0.2 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`视觉模型 HTTP ${res.status}`);
      const data = (await res.json()) as { message?: { content?: string } };
      const raw = data.message?.content ?? "";
      return parseLabel(raw);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 解析模型输出；坏输出给保守默认值。 */
export function parseLabel(raw: string): LabelResult {
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 有些模型会套一层 ```json
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) {
      try {
        obj = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        obj = null;
      }
    }
  }
  if (!obj) return { mood: "其他", tags: [], funny: 0.5, raw };

  const mood = MOODS.includes(String(obj["mood"]) as Mood) ? (String(obj["mood"]) as Mood) : "其他";
  const tags = Array.isArray(obj["tags"])
    ? (obj["tags"] as unknown[]).map((t) => String(t).trim()).filter((t) => t.length > 0).slice(0, 5)
    : [];
  const funnyRaw = Number(obj["funny"]);
  const funny = Number.isFinite(funnyRaw) ? Math.min(1, Math.max(0, funnyRaw)) : 0.5;
  return { mood, tags, funny, raw };
}

/** 从裁剪图算入库用的特征。 */
export function featuresOf(bmp: Bitmap): { dhash: string; hist: number[] } {
  return { dhash: dhash(bmp), hist: colorHist(bmp) };
}