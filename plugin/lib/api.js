/**
 * 设置页的本机 API（127.0.0.1:65482）。
 *
 * 为什么需要它：引擎的 HTTP 只给插件/脚本用，没有 CORS 头；
 * 浏览器里的设置页直接 fetch 127.0.0.1:65480 会被跨域拦掉。
 * 这个服务只做三件事：代理引擎的读接口、转发控制动作、读写插件自己的配置。
 * 只监听回环；只允许本机 GUI 的 Origin（和 dsh-app:// 桌面壳）。
 */

import http from "node:http";

export const API_PORT = 65482;

const PLUGIN_ID = "dsh-mimicd-wechat";
const VERSION = "0.1.0";

const ALLOWED_ORIGIN =
  /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+|dsh-app:\/\/\S*|null)$/i;

const MAX_BODY = 256 * 1024;

function send(res, code, payload, origin = "") {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {{
 *   overview: () => Promise<object>,
 *   sessions: (limit?: number) => object[],
 *   configInfo: () => object,
 *   saveConfig: (patch: object) => Promise<object>,
 *   control: (action: string) => Promise<object>,
 *   tick: () => Promise<object>,
 *   skip: (id: string, reason?: string) => Promise<object>,
 * }} service
 */
export function startApi(service, { port = API_PORT, host = "127.0.0.1", log = () => {} } = {}) {
  let actualPort = port;
  let settled = false;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const markReady = (value) => {
    if (settled) return;
    settled = true;
    resolveReady(value);
  };

  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || "");
    if (origin && !ALLOWED_ORIGIN.test(origin)) {
      return send(res, 403, { ok: false, error: "origin not allowed" });
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
      });
      res.end();
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/health") {
        return send(res, 200, { ok: true, plugin: PLUGIN_ID, version: VERSION, apiPort: actualPort }, origin);
      }

      if (req.method === "GET" && pathname === "/overview") {
        return send(res, 200, await service.overview(), origin);
      }

      if (req.method === "GET" && pathname === "/sessions") {
        const limit = Number(url.searchParams.get("limit")) || 200;
        return send(res, 200, { ok: true, sessions: service.sessions(limit) }, origin);
      }

      if (req.method === "GET" && pathname === "/config") {
        return send(res, 200, { ok: true, ...service.configInfo() }, origin);
      }

      if (req.method === "POST" && pathname === "/config") {
        const body = await readJsonBody(req);
        const saved = await service.saveConfig(body);
        return send(res, 200, { ok: true, ...saved }, origin);
      }

      if (req.method === "POST" && pathname === "/control") {
        const body = await readJsonBody(req);
        const action = String(body.action || "").trim();
        if (!action) throw Object.assign(new Error("action 不能为空"), { status: 400 });
        const result = await service.control(action);
        return send(res, 200, { ok: true, ...result }, origin);
      }

      if (req.method === "POST" && pathname === "/tick") {
        return send(res, 200, { ok: true, ...(await service.tick()) }, origin);
      }

      if (req.method === "POST" && pathname === "/pending/skip") {
        const body = await readJsonBody(req);
        const id = String(body.id || "").trim();
        if (!id) throw Object.assign(new Error("id 不能为空"), { status: 400 });
        const result = await service.skip(id, String(body.reason || "设置页手动忽略"));
        return send(res, 200, { ok: true, ...result }, origin);
      }

      return send(res, 404, { ok: false, error: `没有这个接口：${req.method} ${pathname}` }, origin);
    } catch (err) {
      const status = Number(err?.status);
      const code = status >= 400 && status <= 599 ? status : 500;
      const message = String(err?.message || err);
      if (code >= 500) log(`设置页 API 出错：${req.method} ${pathname} → ${message}`);
      return send(res, code, { ok: false, error: message }, origin);
    }
  });

  // 热重载时上一实例可能还在关端口：EADDRINUSE 先退避重试几次
  let attempts = 0;
  const listen = () => {
    server.listen(port, host, () => {
      const address = server.address();
      actualPort = typeof address === "object" && address ? address.port : port;
      log(`设置页 API 已监听 http://${host}:${actualPort}`);
      markReady({ ok: true, port: actualPort });
    });
  };

  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE" && attempts < 3) {
      attempts++;
      const wait = 300 * attempts;
      log(`设置页 API 端口 ${port} 被占用，${wait}ms 后重试（${attempts}/3）`);
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* not listening */
        }
        listen();
      }, wait);
      return;
    }
    log(`设置页 API 监听 ${host}:${port} 失败：${err?.message || err}`);
    markReady({ ok: false, error: String(err?.message || err), port: null });
  });

  listen();

  return {
    server,
    ready,
    get port() {
      return actualPort;
    },
    close() {
      return new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}