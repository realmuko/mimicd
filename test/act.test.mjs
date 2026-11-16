import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRng } from "../src/core/rng.ts";
import { planHold, planSwipe, planTap, pointInRect } from "../src/act/humanizer.ts";
import { Actuator } from "../src/act/actuator.ts";
import { EventLog, readEvents } from "../src/eventlog.ts";

const RECT = { x: 100, y: 2000, w: 200, h: 100 };

test("落点始终在框内、离边 8px 以内不漏", () => {
  const rng = createRng(42);
  for (let i = 0; i < 500; i++) {
    const p = pointInRect(RECT, rng);
    assert.ok(p.x >= 108 && p.x <= 292, `x 越界：${p.x}`);
    assert.ok(p.y >= 2008 && p.y <= 2092, `y 越界：${p.y}`);
  }
});

test("同一种子 → 同一串动作（可重放）", () => {
  const a = [planTap(RECT, createRng(7)), planTap(RECT, createRng(7))];
  assert.deepEqual(a[0], a[1]);
  const b = planTap(RECT, createRng(8));
  assert.notDeepEqual(a[0], b);
});

test("轻点：按压 40–180ms，压力在合理区间", () => {
  const rng = createRng(1);
  for (let i = 0; i < 200; i++) {
    const plan = planTap(RECT, rng);
    assert.ok(plan.downMs >= 40 && plan.downMs <= 180, `downMs=${plan.downMs}`);
    assert.ok(plan.pressure >= 0.25 && plan.pressure <= 0.95);
    assert.ok(plan.size >= 0.05 && plan.size <= 0.3);
  }
});

test("长按：落在 600–850ms（高于平台 500ms 阈值）", () => {
  const rng = createRng(2);
  for (let i = 0; i < 100; i++) {
    const p = planHold(RECT, rng);
    assert.ok(p.ms >= 600 && p.ms <= 850, `ms=${p.ms}`);
  }
});

test("滑动：时间单调、起点对、终点带一点 overscroll", () => {
  const rng = createRng(3);
  const plan = planSwipe({ x: 540, y: 1800 }, { x: 540, y: 900 }, rng, { durationMs: 300 });
  assert.ok(Math.abs(plan.points[0].x - 540) <= 3, `起点 x 抖动过大：${plan.points[0].x}`);
  assert.ok(Math.abs(plan.points[0].y - 1800) <= 2, `起点 y 抖动过大：${plan.points[0].y}`);
  assert.equal(plan.points[0].t, 0);
  for (let i = 1; i < plan.points.length; i++) {
    assert.ok(plan.points[i].t > plan.points[i - 1].t, "时间必须递增");
    assert.ok(plan.points[i].y <= plan.points[i - 1].y + 2, "方向应向上");
  }
  const last = plan.points[plan.points.length - 1];
  // 终点允许 ±2px 抖动，overscroll 最多 60px
  assert.ok(last.y <= 902, `终点没到位：${last.y}`);
  assert.ok(last.y >= 900 - 70, `overscroll 不该超过 60px：${last.y}`);
});

// ---------- actuator ----------

function fakeDevice(calls) {
  return {
    adb: {
      async exec() {
        return Buffer.alloc(0);
      },
      async shell() {
        return "";
      },
      async screencap() {
        throw new Error("不用");
      },
      async focus() {
        throw new Error("不用");
      },
      async forward() {},
      async push() {},
    },
    injector: {
      async tap(x, y, ms) {
        calls.push(["tap", x, y, ms]);
      },
      async hold(x, y, ms) {
        calls.push(["hold", x, y, ms]);
      },
      async swipe(x1, y1, x2, y2, ms) {
        calls.push(["swipe", x1, y1, x2, y2, ms]);
      },
      async path(points) {
        calls.push(["path", points.length]);
      },
      async press() {},
      async info() {
        return "ok";
      },
      async ping() {},
    },
    ime: {
      async ping() {
        return "ok ime=true";
      },
      async readClipboard() {
        return "剪贴板内容";
      },
      async readInput() {
        return { before: "打进去的字", after: "" };
      },
      async type(text) {
        calls.push(["type", text]);
      },
      async setClipboard(text) {
        calls.push(["clip", text]);
      },
      async clear() {},
    },
  };
}

test("actuator：动作真的发到设备，并落 action.executed 事件", async () => {
  const calls = [];
  const root = mkdtempSync(join(tmpdir(), "act-"));
  const log = new EventLog({ file: join(root, "run.jsonl"), run: "r-test" });
  const act = new Actuator(fakeDevice(calls), { rng: createRng(11), eventLog: log });

  await act.tapRect(RECT);
  await act.holdRect(RECT);
  await act.swipe({ x: 540, y: 1800 }, { x: 540, y: 900 }, 300);
  await act.typeText("你好");
  await act.drain();

  assert.deepEqual(calls.map((c) => c[0]), ["tap", "hold", "path", "type"]);
  const events = readEvents(log.file);
  const actions = events.filter((e) => e.kind === "action.executed");
  assert.equal(actions.length, 4);
  assert.equal(actions[0].data.kind, "tap");
  assert.ok(actions[0].data.detail.downMs >= 40);
});

test("actuator：dryRun 只记录计划，不碰设备", async () => {
  const calls = [];
  const act = new Actuator(fakeDevice(calls), { rng: createRng(1), dryRun: true });
  await act.tapRect(RECT);
  await act.holdRect(RECT);
  await act.typeText("不该出现");
  await act.drain();
  assert.deepEqual(calls, []);
  assert.equal(act.count, 3);
});

test("actuator：单写者 —— 并发调用按顺序执行，不交错", async () => {
  const order = [];
  const dev = fakeDevice([]);
  dev.injector.tap = async (x) => {
    order.push(`start-${x}`);
    await new Promise((r) => setTimeout(r, 30));
    order.push(`end-${x}`);
  };
  const act = new Actuator(dev, { rng: createRng(1) });

  await Promise.all([act.tapPoint(1, 1), act.tapPoint(2, 2), act.tapPoint(3, 3)]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
});

test("actuator：一个动作失败不会卡死后续动作", async () => {
  const calls = [];
  const dev = fakeDevice(calls);
  let first = true;
  dev.injector.tap = async () => {
    if (first) {
      first = false;
      throw new Error("inject 失败");
    }
    calls.push(["tap-ok"]);
  };
  const act = new Actuator(dev, { rng: createRng(1) });
  await assert.rejects(() => act.tapPoint(1, 1));
  await act.tapPoint(2, 2);
  assert.deepEqual(calls, [["tap-ok"]]);
});