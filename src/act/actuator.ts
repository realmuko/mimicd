/**
 * Actuator：唯一能改设备状态的地方。
 *
 * 三条纪律：
 *  1. **单写者**：所有动作排在同一条链上，绝不并发（并发注入会让长按和滑动互相打断）。
 *  2. **每个动作发事件**：`action.executed` 带计划参数，回放时能原样重演。
 *  3. **dryRun 只计划不执行**：影子跑（M3）和离线测试都靠它。
 */

import { EventLog } from "../eventlog.ts";
import type { Rect } from "../image/image.ts";
import type { DevicePorts } from "../device/types.ts";
import { planHold, planSwipe, planTap, type HumanizerOptions } from "./humanizer.ts";
import type { Rng } from "../core/rng.ts";

export interface ActuatorOptions {
  rng: Rng;
  humanizer?: HumanizerOptions;
  eventLog?: EventLog;
  /** true = 只记录计划，不碰设备 */
  dryRun?: boolean;
}

export interface ActionRecord {
  kind: string;
  ms: number;
  detail: Record<string, unknown>;
}

export class Actuator {
  readonly #dev: DevicePorts;
  readonly #rng: Rng;
  readonly #humanizer: HumanizerOptions;
  readonly #log?: EventLog;
  #dryRun: boolean;
  #chain: Promise<unknown> = Promise.resolve();
  #count = 0;

  constructor(dev: DevicePorts, opts: ActuatorOptions) {
    this.#dev = dev;
    this.#rng = opts.rng;
    this.#humanizer = opts.humanizer ?? {};
    this.#log = opts.eventLog;
    this.#dryRun = opts.dryRun ?? false;
  }

  get dryRun(): boolean {
    return this.#dryRun;
  }

  setDryRun(value: boolean): void {
    this.#dryRun = value;
  }

  get count(): number {
    return this.#count;
  }

  /** 串行化：所有动作排在同一条 promise 链上。 */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(task, task);
    // 链本身吞掉异常，保证后续动作还能跑
    this.#chain = next.catch(() => undefined);
    return next;
  }

  #emit(record: ActionRecord): void {
    this.#count++;
    this.#log?.append("action.executed", { ...record }, { src: "act.actuator" });
  }

  /**
   * 触摸动作的统一出口：先走手机上的注入器（app_process，压力/时长可控），
   * 注入器挂了（被系统杀掉 / 端口没了）就退回 adb shell input —— 慢一点、少了拟真参数，
   * 但不会因为一个后台进程死掉就整条链路瘫痪（2026-11-19 早上的教训）。
   */
  async #touch(kind: "tap" | "hold" | "swipe", run: () => Promise<void>, fallback: () => Promise<void>): Promise<string> {
    try {
      await run();
      return "injector";
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).slice(0, 140);
      this.#log?.append("note", { stage: "injector-fallback", op: kind, error: msg }, { src: "act.actuator" });
      await fallback();
      return "adb";
    }
  }

  async tapPoint(x: number, y: number, downMs = 65): Promise<ActionRecord> {
    return this.#enqueue(async () => {
      const t0 = Date.now();
      const via = this.#dryRun
        ? "dry"
        : await this.#touch(
            "tap",
            () => this.#dev.injector.tap(x, y, downMs),
            () => this.#dev.adb.shell(`input tap ${Math.round(x)} ${Math.round(y)}`, 20000).then(() => undefined),
          );
      const rec: ActionRecord = { kind: "tap", ms: Date.now() - t0, detail: { x, y, downMs, via, dryRun: this.#dryRun } };
      this.#emit(rec);
      return rec;
    });
  }

  async tapRect(rect: Rect): Promise<ActionRecord> {
    const plan = planTap(rect, this.#rng, this.#humanizer);
    return this.#enqueue(async () => {
      const t0 = Date.now();
      const via = this.#dryRun
        ? "dry"
        : await this.#touch(
            "tap",
            () => this.#dev.injector.tap(plan.x, plan.y, plan.downMs),
            () => this.#dev.adb.shell(`input tap ${Math.round(plan.x)} ${Math.round(plan.y)}`, 20000).then(() => undefined),
          );
      const rec: ActionRecord = {
        kind: "tap",
        ms: Date.now() - t0,
        detail: { ...plan, rect, via, dryRun: this.#dryRun },
      };
      this.#emit(rec);
      return rec;
    });
  }

  async holdRect(rect: Rect): Promise<ActionRecord> {
    const plan = planHold(rect, this.#rng, this.#humanizer);
    return this.#enqueue(async () => {
      const t0 = Date.now();
      const via = this.#dryRun
        ? "dry"
        : await this.#touch(
            "hold",
            () => this.#dev.injector.hold(plan.x, plan.y, plan.ms),
            () => this.#dev.adb.shell(`input swipe ${Math.round(plan.x)} ${Math.round(plan.y)} ${Math.round(plan.x)} ${Math.round(plan.y)} ${Math.round(plan.ms)}`, 20000).then(() => undefined),
          );
      const rec: ActionRecord = {
        kind: "hold",
        ms: Date.now() - t0,
        detail: { ...plan, rect, via, dryRun: this.#dryRun },
      };
      this.#emit(rec);
      return rec;
    });
  }

  async swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs?: number): Promise<ActionRecord> {
    const plan = planSwipe(from, to, this.#rng, { durationMs });
    return this.#enqueue(async () => {
      const t0 = Date.now();
      const first = plan.points[0]!;
      const last = plan.points[plan.points.length - 1]!;
      const via = this.#dryRun
        ? "dry"
        : await this.#touch(
            "swipe",
            () => this.#dev.injector.path(plan.points),
            () => this.#dev.adb.shell(`input swipe ${Math.round(first.x)} ${Math.round(first.y)} ${Math.round(last.x)} ${Math.round(last.y)} ${Math.round(plan.durationMs)}`, 20000).then(() => undefined),
          );
      const rec: ActionRecord = {
        kind: "swipe",
        ms: Date.now() - t0,
        detail: { from, to, durationMs: plan.durationMs, points: plan.points.length, via, dryRun: this.#dryRun },
      };
      this.#emit(rec);
      return rec;
    });
  }

  /** 直接提交文本（走自建输入法，不经过键盘 UI）。 */
  async typeText(text: string): Promise<ActionRecord> {
    return this.#enqueue(async () => {
      const t0 = Date.now();
      if (!this.#dryRun) await this.#dev.ime.type(text);
      const rec: ActionRecord = {
        kind: "type",
        ms: Date.now() - t0,
        detail: { chars: text.length, dryRun: this.#dryRun },
      };
      this.#emit(rec);
      return rec;
    });
  }

  /** 读当前输入框内容（用来确认「字打进去了」）。 */
  async readInput(): Promise<{ before: string; after: string }> {
    return this.#enqueue(() => this.#dev.ime.readInput());
  }

  /** 读剪贴板（配合「长按气泡 → 复制」拿到零误差原文）。 */
  async readClipboard(): Promise<string> {
    return this.#enqueue(() => this.#dev.ime.readClipboard());
  }

  async setClipboard(text: string): Promise<void> {
    await this.#enqueue(() => this.#dev.ime.setClipboard(text));
  }

  /** 等设备安静下来：等链上所有动作跑完。 */
  async drain(): Promise<void> {
    await this.#chain;
  }
}