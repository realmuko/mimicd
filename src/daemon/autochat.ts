/**
 * 自动聊天循环：一次 tick = 看一眼列表 → 进会话 → 读尾部 → 判要不要回 → 回 → 回列表。
 *
 * 每个 tick 只处理**一个**会话：单窗口是物理约束（同一时刻只有一个聊天页），
 * 多会话只在时间上轮流。所有判断都落事件，失败也落，方便事后复盘。
 */

import type { DevicePorts } from "../device/types.ts";
import type { EventLog } from "../eventlog.ts";
import type { Bitmap, Rect } from "../image/image.ts";
import { decode } from "../image/image.ts";
import type { Ocr } from "../perception/ocr.ts";
import { detectPage, rectOf, type PageGraph } from "../perception/page.ts";
import { waitStable } from "../perception/stable.ts";
import { messagesFromOcr, mergeBubbles } from "../monitor/read.ts";
import { scanList } from "../monitor/scan.ts";
import { decide, pickChat, type PolicyConfig } from "../policy/policy.ts";
import type { Brain } from "../brain/brain.ts";

import type { World } from "../world/state.ts";
import type { Actuator } from "../act/actuator.ts";

export interface AutoChatConfig {
  policy: Partial<PolicyConfig>;
  /** 点击列表行的 x 像素 */
  rowTapX: number;
  /** 同一会话两次处理之间的最小间隔 */
  perChatCooldownMs: number;
  /** 一轮里最多退几次回到列表 */
  maxBackSteps: number;
}

export const DEFAULT_AUTOCHAT: AutoChatConfig = {
  policy: {},
  rowTapX: 300,
  perChatCooldownMs: 5 * 60 * 1000,
  maxBackSteps: 3,
};

export interface TickResult {
  acted: boolean;
  chat?: string;
  replied?: boolean;
  reply?: string;
  reason: string;
  ms: number;
}

export interface AutoChatDeps {
  device: DevicePorts;
  actuator: Actuator;
  ocr: Ocr;
  graph: PageGraph;
  world: World;
  brain: Brain;
  /** 真正把一句话发出去（daemon 里接到 send_text 技能） */
  sendReply: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  eventLog?: EventLog;
  config?: Partial<AutoChatConfig>;
}

export class AutoChat {
  readonly #d: AutoChatDeps;
  readonly #cfg: AutoChatConfig;
  #busy = false;

  constructor(deps: AutoChatDeps) {
    this.#d = deps;
    this.#cfg = { ...DEFAULT_AUTOCHAT, ...deps.config };
  }

  async tick(): Promise<TickResult> {
    if (this.#busy) return { acted: false, reason: "上一轮还没跑完", ms: 0 };
    this.#busy = true;
    const t0 = Date.now();
    try {
      return await this.#tick();
    } finally {
      this.#busy = false;
      void t0;
    }
  }

  async #tick(): Promise<TickResult> {
    const d = this.#d;
    const t0 = Date.now();

    // 1) 回到列表
    const atList = await this.#ensureList();
    if (!atList) {
      return { acted: false, reason: "回不到会话列表（可能有浮层/搜索页）", ms: Date.now() - t0 };
    }

    // 2) 扫列表：红点 + OCR
    const listShot = await d.device.adb.screencap();
    const listBmp = decode(listShot.png);
    const screen = d.graph.device.screen;
    const listArea = rectOf(d.graph, "list", "list_area", screen.w, screen.h);
    const listOcr = await d.ocr.recognize(listShot.png, listArea);
    const scan = scanList(listBmp, listOcr.lines, listArea);

    d.eventLog?.append(
      "frame.captured",
      { tag: "list", unreadRows: scan.rows.length, badges: scan.badges, rows: scan.rows.map((r) => r.name) },
      { src: "monitor" },
    );

    if (scan.rows.length === 0) {
      return { acted: false, reason: "列表里没有未读", ms: Date.now() - t0 };
    }

    // 3) 选一个会话
    const name = pickChat(scan.rows, (this.#cfg.policy.whitelist ?? []).slice());
    if (!name) return { acted: false, reason: "未读都不在白名单", ms: Date.now() - t0 };
    const row = scan.rows.find((r) => r.name === name)!;

    // 4) 进去
    await d.actuator.tapPoint(this.#cfg.rowTapX, Math.round(row.y), 60);
    const stable = await waitStable(d.device.adb, { frames: 2, timeoutMs: 5000 });
    if (!stable.stable) {
      await this.#backToList();
      return { acted: false, chat: name, reason: "进会话后画面没稳定", ms: Date.now() - t0 };
    }

    // 5) 读尾部消息
    const chatShot = await d.device.adb.screencap();
    const chatBmp: Bitmap = decode(chatShot.png);
    const chatArea = rectOf(d.graph, "chat", "message_area", screen.w, screen.h);
    const chatOcr = await d.ocr.recognize(chatShot.png, chatArea);
    const parsed = mergeBubbles(
      messagesFromOcr(chatOcr.lines, { width: screen.w, meRatio: 0.55, minHeight: 20 }),
    );

    const fresh = d.world.ingest(name, parsed.map((m) => ({ text: m.text, from: m.from, y: m.y, source: "ocr" as const })));
    for (const m of fresh) {
      d.eventLog?.append(
        "message.seen",
        { chat: name, text: m.text.slice(0, 200), from: m.from, source: m.source, y: m.y },
        { src: "monitor" },
      );
    }

    // 6) 决定
    const now = Date.now();
    const decision = decide({ now, chat: d.world.chat(name), fresh, config: this.#cfg.policy });
    d.eventLog?.append(
      "intent.decided",
      { chat: name, reply: decision.reply, reason: decision.reason, fresh: fresh.length },
      { src: "policy" },
    );

    if (!decision.reply) {
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reason: decision.reason, ms: Date.now() - t0 };
    }

    // 7) 想一句
    let replyText: string;
    try {
      replyText = await d.brain.reply({
        chat: name,
        kind: d.world.chat(name).kind,
        messages: d.world.context(name, 12).map((m) => ({ from: m.from, text: m.text })),
      });
    } catch (err) {
      d.eventLog?.append("note", { stage: "brain", chat: name, error: (err as Error).message }, { src: "brain" });
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reason: `脑子出错：${(err as Error).message}`, ms: Date.now() - t0 };
    }

    const text = replyText.slice(0, this.#cfg.policy.maxReplyChars ?? 200);

    // 8) 发
    const result = await d.sendReply(text);

    if (!result.ok) {
      d.eventLog?.append("send.failed", { chat: name, text, reason: result.reason ?? null }, { src: "monitor" });
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reason: `没发出去：${result.reason ?? "未知原因"}`, ms: Date.now() - t0 };
    }

    const lastOther = [...fresh].reverse().find((m) => m.from === "other");
    d.world.markReplied(name, lastOther?.id, Date.now());
    d.world.patch(name, { cooldownUntil: Date.now() + this.#cfg.perChatCooldownMs });
    d.world.save();
    d.eventLog?.append("send.succeeded", { chat: name, text }, { src: "monitor" });

    await this.#backToList();
    return { acted: true, chat: name, replied: true, reply: text, reason: "已回复", ms: Date.now() - t0 };
  }

  /** 确保停在会话列表：不是列表就 back，最多 maxBackSteps 次。 */
  async #ensureList(): Promise<boolean> {
    for (let i = 0; i <= this.#cfg.maxBackSteps; i++) {
      const frame = await this.#d.device.adb.screencap();
      const guess = detectPage(decode(frame.png), await this.#d.device.adb.focus());
      if (guess.page === "list") return true;
      await this.#d.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  async #backToList(): Promise<void> {
    await this.#d.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
    await new Promise((r) => setTimeout(r, 400));
  }
}