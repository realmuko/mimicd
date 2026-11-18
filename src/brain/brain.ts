/**
 * 脑子：把「最近的对话」变成「一句回复」。
 *
 * 可插拔：
 *  - ScriptedBrain：确定性，给测试与冒烟用；
 *  - HttpBrain：任何 OpenAI 兼容的 /chat/completions（DeepSeek、本地 vLLM、网关都行）。
 *
 * 引擎不关心是谁在说话——它只要一段文本，发不发由策略管。
 */

import type { Side } from "../world/state.ts";

export interface BrainMessage {
  from: Side;
  text: string;
  /** 群聊里的发送者昵称，用来区分「对方」到底是群里哪个人 */
  sender?: string;
}

export interface BrainContext {
  chat: string;
  messages: BrainMessage[];
  /** 会话是群还是私聊，影响称呼与语气 */
  kind?: "group" | "dm" | "unknown";
  /** 群聊里没 @ 我，需要自己判断要不要接话 */
  needsJudgment?: boolean;
}

export interface Brain {
  readonly name: string;
  reply(ctx: BrainContext): Promise<string>;
}

export interface ScriptedBrainOptions {
  /** 模板：{chat} {last} {n} */
  template?: string;
  /** 附加延迟，模拟思考 */
  delayMs?: number;
}

export class ScriptedBrain implements Brain {
  readonly name = "scripted";
  readonly #template: string;
  readonly #delayMs: number;

  constructor(opts: ScriptedBrainOptions = {}) {
    this.#template = opts.template ?? "收到「{last}」，我想想怎么说～";
    this.#delayMs = opts.delayMs ?? 0;
  }

  async reply(ctx: BrainContext): Promise<string> {
    if (this.#delayMs > 0) await new Promise((r) => setTimeout(r, this.#delayMs));
    const last = [...ctx.messages].reverse().find((m) => m.from === "other")?.text ?? "";
    return this.#template
      .replace(/\{chat\}/g, ctx.chat)
      .replace(/\{last\}/g, last)
      .replace(/\{n\}/g, String(ctx.messages.length));
  }
}

export interface HttpBrainOptions {
  /** 完整的 chat/completions 地址，或到 /v1 为止的 base */
  url: string;
  model: string;
  apiKey?: string;
  /** 人设与说话风格 */
  system?: string;
  timeoutMs?: number;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  maxTokens?: number;
  temperature?: number;
}

export class HttpBrain implements Brain {
  readonly name = "http";
  readonly #opts: HttpBrainOptions;

  constructor(opts: HttpBrainOptions) {
    this.#opts = opts;
  }

  async reply(ctx: BrainContext): Promise<string> {
    const fetchImpl = this.#opts.fetchImpl ?? fetch;
    const url = this.#opts.url.endsWith("/chat/completions")
      ? this.#opts.url
      : `${this.#opts.url.replace(/\/$/, "")}/chat/completions`;

    const transcript = ctx.messages
      .slice(-8)
      .map((m) => `${m.from === "me" ? "我" : m.from === "other" ? "对方" : "系统"}：${m.text}`)
      .join("\n");
    const last = ctx.messages[ctx.messages.length - 1];

    const system =
      this.#opts.system ??
      "你在手机上用自己的微信号和人聊天。只回一句自然的口语，不要解释、不要加引号、不要超过 60 字。";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#opts.timeoutMs ?? 20000);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#opts.apiKey ? { authorization: `Bearer ${this.#opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.#opts.model,
          temperature: this.#opts.temperature ?? 0.7,
          max_tokens: this.#opts.maxTokens ?? 120,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: [
                `会话：${ctx.chat}（${ctx.kind ?? "unknown"}）`,
                transcript,
                "",
                `最后一条是${last?.from === "me" ? "我" : "对方"}说的。`,
                ctx.needsJudgment ? "这是群聊，对方没有 @ 你：只有你觉得这句话适合你接，才回；不想接就回空字符串。" : "如果最后一条是对方说的，直接给出你要回的那一句；如果是我说的，回复空字符串。",
              ].join("\n"),
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) throw new Error("模型返回空内容");
      return sanitizeReply(text);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 模型爱加引号/前缀，这里统一收拾干净；顺手压掉换行。 */
export function sanitizeReply(text: string): string {
  let out = text.trim().replace(/^["'「『]|["'」』]$/g, "").replace(/\s*\n+\s*/g, " ").trim();
  out = out.replace(/^(回复|答复)[:：]\s*/, "");
  return out.slice(0, 200);
}