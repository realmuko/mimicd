import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { startApi } from "../lib/api.js";

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeApi() {
  const service = {
    async overview() {
      return { ok: true, marker: "overview", pending: { count: 1, items: [{ id: "x" }] } };
    },
    sessions(limit) {
      return [{ id: "session-1", title: "测试", cwd: "D:/x", lastAt: 1, limitSeen: limit }];
    },
    configInfo() {
      return { path: "<repo>/plugin/wechat-mimicd.config.json", mtime: 1, config: { bridge: { enabled: true } }, error: null };
    },
    async saveConfig(patch) {
      return { path: "p", mtime: 2, config: patch };
    },
    async control(action) {
      return { action, message: `done:${action}` };
    },
    async tick() {
      return { message: "tick done" };
    },
    async skip(id, reason) {
      return { id, message: `skip:${reason}` };
    },
  };
  return startApi(service, { port: 0, log: () => {} });
}

test("设置页 API：健康检查、overview、配置读写、控制、跳过", async (t) => {
  const api = makeApi();
  const ready = await api.ready;
  assert.equal(ready.ok, true);
  const base = `http://127.0.0.1:${ready.port}`;
  t.after(() => api.close());

  const health = JSON.parse((await request(`${base}/health`)).body);
  assert.equal(health.ok, true);
  assert.equal(health.plugin, "dsh-mimicd-wechat");

  const overview = JSON.parse((await request(`${base}/overview`)).body);
  assert.equal(overview.marker, "overview");
  assert.equal(overview.pending.count, 1);

  const sessions = JSON.parse((await request(`${base}/sessions?limit=7`)).body);
  assert.equal(sessions.sessions[0].limitSeen, 7);

  const config = JSON.parse((await request(`${base}/config`)).body);
  assert.equal(config.ok, true);
  assert.match(config.path, /wechat-mimicd\.config\.json$/);

  const saved = JSON.parse(
    (await request(`${base}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bridge: { intervalMs: 9000 } }),
    })).body,
  );
  assert.deepEqual(saved.config, { bridge: { intervalMs: 9000 } });

  const control = JSON.parse(
    (await request(`${base}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    })).body,
  );
  assert.equal(control.message, "done:pause");

  const tick = JSON.parse((await request(`${base}/tick`, { method: "POST" })).body);
  assert.equal(tick.message, "tick done");

  const skip = JSON.parse(
    (await request(`${base}/pending/skip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc", reason: "不想回" }),
    })).body,
  );
  assert.equal(skip.message, "skip:不想回");
});

test("设置页 API：只放行本机 Origin，非法 origin 直接 403", async (t) => {
  const api = makeApi();
  const ready = await api.ready;
  const base = `http://127.0.0.1:${ready.port}`;
  t.after(() => api.close());

  const ok = await request(`${base}/health`, { headers: { origin: "http://127.0.0.1:59975" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["access-control-allow-origin"], "http://127.0.0.1:59975");

  const bad = await request(`${base}/health`, { headers: { origin: "http://evil.example" } });
  assert.equal(bad.status, 403);
});

test("设置页 API：缺 action / 缺 id 返回 400，未知路由 404", async (t) => {
  const api = makeApi();
  const ready = await api.ready;
  const base = `http://127.0.0.1:${ready.port}`;
  t.after(() => api.close());

  const badControl = await request(`${base}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(badControl.status, 400);

  const notFound = await request(`${base}/nope`);
  assert.equal(notFound.status, 404);
});