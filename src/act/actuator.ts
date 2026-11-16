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

  async tapPoint(x: number, y: number, downMs = 65): Promise<ActionRecord> {
    return this.#enqueue(async () => {
      const t0 = Date.now();
      if (!this.#dryRun) await this.#dev.injector.tap(x, y, downMs);
      const rec: ActionRecord = { kind: "tap", ms: Date.now() - t0, detail: { x, y, downMs, dryRun: this.#dryRun } };
      this.#emit(rec);
      return rec;
    });
  }

  async tapRect(rect: Rect): Promise<ActionRecord> {
    const plan = planTap(rect, this.#rng, this.#humanizer);
    return this.#enqueue(async () => {
      const t0 = Date.now();
      if (!this.#dryRun) await this.#dev.injector.tap(plan.x, plan.y, plan.downMs);
      const rec: ActionRecord = {
        kind: "tap",
        ms: Date.now() - t0,
        detail: { ...plan, rect, dryRun: this.#dryRun },
      };
      this.#emit(rec);
      return rec;
    });
  }

  async holdRect(rect: Rect): Promise<ActionRecord> {
    const plan = planHold(rect, this.#rng, this.#humanizer);
    return this.#enqueue(async () => {
      const t0 = Date.now();
      if (!this.#dryRun) await this.#dev.injector.hold(plan.x, plan.y, plan.ms);
      const rec: ActionRecord = {
        kind: "hold",
        ms: Date.now() - t0,
        detail: { ...plan, rect, dryRun: this.#dryRun },
      };
      this.#emit(rec);
      return rec;
    });
  }

  async swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs?: number): Promise<ActionRecord> {
    const plan = planSwipe(from, to, this.#rng, { durationMs });
    return this.#enqueue(async () => {
      const t0 = Date.now();
      if (!this.#dryRun) await this.#dev.injector.path(plan.points);
      const rec: ActionRecord = {
        kind: "swipe",
        ms: Date.now() - t0,
        detail: { from, to, durationMs: plan.durationMs, points: plan.points.length, dryRun: this.#dryRun },
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