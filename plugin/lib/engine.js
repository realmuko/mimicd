/**
 * mimicd 引擎的 HTTP 客户端（只碰 HTTP，不碰手机）。
 *
 * 引擎契约：只监听 127.0.0.1；POST 返回 2xx 只代表「受理」，
 * 真正的执行结果要从 /events 里看。所以这里不做轮询/重试，
 * 只把一次请求的结果和错误原样交给调用方。
 *
 * 用 node:http 而不是全局 fetch：DSH 进程里访问 loopback 时
 * 全局 fetch（undici）出过连不上的问题；node:http 是稳的。
 */

import http from "node:http";

const DEFAULT_TIMEOUT_MS = 12000;

/** 动作类请求会真的在手机上跑，给足时间（超时了会话会以为失败，引擎却已经发出去了）。 */
const PATH_TIMEOUTS = [
  [/^\/observe\/link(\?|$)/, 240000],
  [/^\/(pending\/reply|say|control|tick)(\?|$)/, 180000],
];

export class EngineError extends Error {
  constructor(message, { status = 0, body = null, url = "" } = {}) {
    super(message);
    this.name = "EngineError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function timeoutFor(pathname, fallback = DEFAULT_TIMEOUT_MS) {
  for (const [re, ms] of PATH_TIMEOUTS) if (re.test(pathname)) return ms;
  return fallback;
}

/**
 * 默认传输：node:http，返回 `{ status, body }`（body 已 JSON.parse）。
 * 测试可以把自己实现的同名函数注入 MimicdEngine，完全不联网。
 */
export function requestJson({ url, method = "GET", body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let req = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    try {
      req = http.request(
        url,
        {
          method,
          headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => {
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = { raw: text };
            }
            finish(resolve, { status: res.statusCode || 0, body: parsed });
          });
        },
      );
    } catch (err) {
      finish(reject, err);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    req.on("error", (err) => {
      if (timedOut) finish(reject, new Error(`引擎 ${Math.round(timeoutMs / 1000)}s 没响应`));
      else finish(reject, err);
    });

    if (body) req.write(body);
    req.end();
  });
}

export class MimicdEngine {
  constructor({
    baseUrl = "http://127.0.0.1:65480",
    token = "",
    request = requestJson,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.baseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new Error(`引擎地址不像 URL：${JSON.stringify(baseUrl)}`);
    }
    this.token = String(token || "");
    this.request = request;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** 发一次请求；2xx 以外抛 EngineError（带引擎自己给的 error）。 */
  async call(pathname, { method = "GET", body, headers = {}, timeoutMs } = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const req = {
      url,
      method,
      headers: this.token ? { authorization: `Bearer ${this.token}`, ...headers } : headers,
      timeoutMs: timeoutMs ?? timeoutFor(pathname, this.defaultTimeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let res;
    try {
      res = await this.request(req);
    } catch (err) {
      const detail = err?.cause?.code || err?.code || "";
      throw new EngineError(
        `连不上引擎（${this.baseUrl}）${detail ? `[${detail}]` : ""}：${err?.message || err}`,
        { url },
      );
    }

    const data = res?.body ?? {};
    const status = Number(res?.status) || 0;
    if (status < 200 || status >= 300) {
      throw new EngineError(data?.error || `引擎返回 HTTP ${status}`, { status, body: data, url });
    }
    return data;
  }

  health() {
    return this.call("/health");
  }

  state() {
    return this.call("/state");
  }

  events(limit = 100) {
    const n = Math.min(500, Math.max(1, Math.round(Number(limit) || 100)));
    return this.call(`/events?limit=${n}`);
  }

  skills() {
    return this.call("/skills");
  }

  stickers() {
    return this.call("/stickers");
  }

  pending() {
    return this.call("/pending");
  }

  async reply(id, { text, stickerMood } = {}) {
    const payload = { id: String(id ?? "").trim() };
    if (text) payload.text = String(text);
    if (stickerMood) payload.stickerMood = String(stickerMood);
    if (!payload.id) throw new EngineError("id 不能为空");
    if (!payload.text && !payload.stickerMood) throw new EngineError("text 或 stickerMood 至少给一个");
    return this.call("/pending/reply", { method: "POST", body: payload });
  }

  async skip(id, reason = "") {
    const trimmed = String(id ?? "").trim();
    if (!trimmed) throw new EngineError("id 不能为空");
    return this.call("/pending/skip", { method: "POST", body: { id: trimmed, reason: String(reason ?? "") } });
  }

  async say(chat, { text, stickerMood } = {}) {
    const payload = { chat: String(chat ?? "").trim() };
    if (text) payload.text = String(text);
    if (stickerMood) payload.stickerMood = String(stickerMood);
    if (!payload.chat) throw new EngineError("chat 不能为空");
    if (!payload.text && !payload.stickerMood) throw new EngineError("text 或 stickerMood 至少给一个");
    return this.call("/say", { method: "POST", body: payload });
  }

  async readLink(chat, which) {
    const payload = { chat: String(chat ?? "").trim() };
    if (!payload.chat) throw new EngineError("chat 不能为空");
    const n = Number(which);
    if (Number.isFinite(n) && n > 0) payload.which = Math.round(n);
    return this.call("/observe/link", { method: "POST", body: payload });
  }

  control(action, { chat } = {}) {
    const payload = { action: String(action ?? "").trim() };
    if (!payload.action) throw new EngineError("action 不能为空");
    if (chat) payload.chat = String(chat);
    return this.call("/control", { method: "POST", body: payload });
  }

  tick() {
    return this.call("/tick", { method: "POST" });
  }
}