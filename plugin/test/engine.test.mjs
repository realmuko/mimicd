import test from "node:test";
import assert from "node:assert/strict";

import { MimicdEngine, timeoutFor } from "../lib/engine.js";

function recorder(handler) {
  const calls = [];
  const request = async (options) => {
    calls.push(options);
    return handler(options, calls.length);
  };
  return { calls, request };
}

test("GET 请求：URL 与 query 拼对，token 走 Authorization", async () => {
  const { calls, request } = recorder(() => ({ status: 200, body: { ok: true, items: [] } }));
  const engine = new MimicdEngine({ baseUrl: "http://127.0.0.1:65480/", token: "t0k", request });

  await engine.events(9999);
  assert.equal(calls[0].url, "http://127.0.0.1:65480/events?limit=500");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.authorization, "Bearer t0k");
});

test("reply 把 id/text/stickerMood 一起交给引擎", async () => {
  const { calls, request } = recorder(() => ({ status: 200, body: { ok: true } }));
  const engine = new MimicdEngine({ request });

  await engine.reply("abc", { text: "在", stickerMood: "无语" });
  assert.equal(calls[0].url, "http://127.0.0.1:65480/pending/reply");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), { id: "abc", text: "在", stickerMood: "无语" });
});

test("reply 参数不全时本地就拒绝，不发请求", async () => {
  const { calls, request } = recorder(() => ({ status: 200, body: { ok: true } }));
  const engine = new MimicdEngine({ request });

  await assert.rejects(() => engine.reply("abc"), /至少给一个/);
  await assert.rejects(() => engine.reply("", { text: "hi" }), /id 不能为空/);
  assert.equal(calls.length, 0);
});

test("say/readLink 的参数校验", async () => {
  const { calls, request } = recorder(() => ({ status: 200, body: { ok: true } }));
  const engine = new MimicdEngine({ request });

  await assert.rejects(() => engine.say("", { text: "hi" }), /chat 不能为空/);
  await assert.rejects(() => engine.say("群"), /至少给一个/);

  await engine.readLink("群", 2);
  assert.deepEqual(JSON.parse(calls[0].body), { chat: "群", which: 2 });
  assert.equal(calls.length, 1);
});

test("引擎非 2xx 抛 EngineError，带引擎自己的 error 文案", async () => {
  const { request } = recorder(() => ({ status: 422, body: { ok: false, error: "发不出去：手机锁屏" } }));
  const engine = new MimicdEngine({ request });

  await assert.rejects(
    () => engine.say("群", { text: "hi" }),
    (err) => err.name === "EngineError" && err.status === 422 && /手机锁屏/.test(err.message),
  );
});

test("连不上引擎时提示清楚（带 ECONNREFUSED）", async () => {
  const { request } = recorder(() => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:65480"), { code: "ECONNREFUSED" });
  });
  const engine = new MimicdEngine({ request });

  await assert.rejects(
    () => engine.health(),
    (err) => /连不上引擎/.test(err.message) && /ECONNREFUSED/.test(err.message),
  );
});

test("动作类接口的超时比读接口长", () => {
  assert.equal(timeoutFor("/observe/link"), 240000);
  assert.equal(timeoutFor("/pending/reply"), 180000);
  assert.equal(timeoutFor("/tick"), 180000);
  assert.equal(timeoutFor("/health"), 12000);
});