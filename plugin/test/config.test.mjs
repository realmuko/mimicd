import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, mergeConfig } from "../lib/config.js";

test("默认配置包含 bridge/tools 两段", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {});
  assert.equal(cfg.bridge.engineUrl, "http://127.0.0.1:65480");
  assert.equal(cfg.bridge.intervalMs, 8000);
  assert.equal(cfg.tools.enabled, true);
});

test("intervalMs 有上下限，脏值被夹到范围内", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { bridge: { intervalMs: 50 } }).bridge.intervalMs, 2000);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { bridge: { intervalMs: 999999 } }).bridge.intervalMs, 120000);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { bridge: { intervalMs: "abc" } }).bridge.intervalMs, 8000);
});

test("sessionId 允许清空；enabled 只接受 boolean", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { bridge: { sessionId: "  session-abc  ", enabled: "yes" } });
  assert.equal(cfg.bridge.sessionId, "session-abc");
  assert.equal(cfg.bridge.enabled, true);

  const cleared = mergeConfig(cfg, { bridge: { sessionId: "" } });
  assert.equal(cleared.bridge.sessionId, "");
});

test("engineUrl 去尾斜杠，非法 URL 保留原值", () => {
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { bridge: { engineUrl: "http://127.0.0.1:65480///" } }).bridge.engineUrl,
    "http://127.0.0.1:65480",
  );
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { bridge: { engineUrl: "file:///etc/passwd" } }).bridge.engineUrl,
    DEFAULT_CONFIG.bridge.engineUrl,
  );
});

test("未知字段不会写进结果", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { evil: { x: 1 }, bridge: { evil: true } });
  assert.equal(cfg.evil, undefined);
  assert.equal(cfg.bridge.evil, undefined);
});

test("tools.enabled 可以关掉", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { tools: { enabled: false } }).tools.enabled, false);
});
test("会话对齐表：只收像会话 id 的值；空值 = 清掉（回到默认会话）", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {
    bridge: {
      chatSessions: {
        "周末爬山小分队": "session-abc123",
        "摸鱼闲聊群": "  ",
        "坏值": "not a session id!!",
        "": "session-x",
      },
    },
  });
  assert.equal(cfg.bridge.chatSessions["周末爬山小分队"], "session-abc123");
  assert.equal(cfg.bridge.chatSessions["摸鱼闲聊群"], "");
  assert.equal(cfg.bridge.chatSessions["坏值"], undefined, "不像会话 id 的直接丢掉");
  assert.equal(cfg.bridge.chatSessions[""], undefined, "空群名丢掉");
  assert.deepEqual(Object.keys(cfg.bridge.chatSessions).sort(), ["周末爬山小分队", "摸鱼闲聊群"].sort());
});
