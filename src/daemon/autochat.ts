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
import { cleanName, isNameLine, scanList } from "../monitor/scan.ts";
import { detectChatKind, titleFromOcr, titleMatches } from "../monitor/chat.ts";
import { decide, pickChat, type PolicyConfig } from "../policy/policy.ts";
import type { Brain, BrainContext } from "../brain/brain.ts";

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
  /** 定向跑一个会话（不看未读；只允许配合 no-send/dry-run 使用） */
  forceChat?: string;
  /** 只走流程不真发：允许点击/翻页/读屏，但绝不打字和按发送 */
  noSend?: boolean;
  /** 前台不是微信时是否把它拉到前台（默认不拉，避免打断人） */
  allowLaunch?: boolean;
  /** 看到对方发的贴纸就自动收藏（按好玩程度筛选） */
  collectStickers?: boolean;
  /** 每小时最多自动收藏几张 */
  collectPerHour?: number;
  /** 交接模式：policy 决定要回后，把上下文交给主模型，引擎不自己编话也不发 */
  handoff?: (ctx: BrainContext) => Promise<string>;
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
  /** 收藏对方发的贴纸（daemon 里接到 collect_sticker 技能） */
  collectSticker?: () => Promise<{ ok: boolean; reason?: string }>;
  eventLog?: EventLog;
  config?: Partial<AutoChatConfig>;
}

export class AutoChat {
  readonly #d: AutoChatDeps;
  readonly #cfg: AutoChatConfig;
  #busy = false;
  #collectTimes: number[] = [];

  constructor(deps: AutoChatDeps) {
    this.#d = deps;
    this.#cfg = { ...DEFAULT_AUTOCHAT, ...deps.config };
  }

  async tick(): Promise<TickResult> {
    if (this.#busy) return { acted: false, reason: "上一轮还没跑完", ms: 0 };
    this.#busy = true;
    try {
      return await this.#tick(0);
    } finally {
      this.#busy = false;
    }
  }

  async #tick(attempt: number): Promise<TickResult> {
    const d = this.#d;
    const t0 = Date.now();

    // 1) 回到列表
    const atList = await this.#ensureList();
    if (!atList) {
      return { acted: false, reason: "前台不是微信（或回不到列表），本轮跳过", ms: Date.now() - t0 };
    }

    // 2) 扫列表：红点 + OCR（先等列表稳定，刚拉起微信时还在加载）
    await waitStable(d.device.adb, { frames: 2, timeoutMs: 4000 });
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

    let name: string | null;
    let rowY: number;

    if (this.#cfg.forceChat) {
      // 定向模式：不要求未读，直接在列表 OCR 里找这个名字
      const want = this.#cfg.forceChat.replace(/\s+/g, "");
      const hit = listOcr.lines.find((l) => isNameLine(l) && cleanName(l.text).includes(want));
      if (!hit) return { acted: false, reason: `列表里没找到「${this.#cfg.forceChat}」`, ms: Date.now() - t0 };
      name = cleanName(hit.text);
      rowY = hit.y + hit.h / 2;
      d.eventLog?.append("note", { stage: "force-chat", hit: { text: hit.text, y: hit.y, h: hit.h }, tapY: Math.round(rowY) }, { src: "monitor" });
    } else {
      if (scan.rows.length === 0) {
        return { acted: false, reason: "列表里没有未读", ms: Date.now() - t0 };
      }
      name = pickChat(scan.rows, (this.#cfg.policy.whitelist ?? []).slice());
      if (!name) return { acted: false, reason: "未读都不在白名单", ms: Date.now() - t0 };
      rowY = scan.rows.find((r) => r.name === name)!.y;
    }

    // 4) 进去
    await d.actuator.tapPoint(this.#cfg.rowTapX, Math.round(rowY), 60);
    const entered = await this.#waitPage("chat", 6000);
    if (!entered) {
      await this.#backToList();
      return { acted: false, chat: name, reason: "点了会话行但没进到聊天页", ms: Date.now() - t0 };
    }
    await waitStable(d.device.adb, { frames: 2, timeoutMs: 4000 });

    // 5) 核对标题（点错行/界面没切过去就别回），顺便定群/私聊
    const chatShot = await d.device.adb.screencap();
    const chatBmp: Bitmap = decode(chatShot.png);
    // 标题只在中间那条带里：整条头栏会把「〈 未读数」也读进来，最长的那行反而不是标题
    const headerArea = rectOf(d.graph, "chat", "title_strip", screen.w, screen.h);
    const headerOcr = await d.ocr.recognize(chatShot.png, headerArea);
    const title = titleFromOcr(headerOcr.lines);
    if (title && !titleMatches(name, title)) {
      d.eventLog?.append("note", { stage: "enter-chat", wanted: name, got: title }, { src: "monitor" });
      await this.#backToList();
      if (this.#cfg.forceChat && attempt < 1) {
        await this.#backToList();
        return this.#tick(attempt + 1);
      }
      return { acted: false, chat: name, reason: `进错会话：想进「${name}」，实际「${title}」`, ms: Date.now() - t0 };
    }
    const kind = detectChatKind(title || name);
    d.world.patch(name, { kind });

    const chatArea = rectOf(d.graph, "chat", "message_area", screen.w, screen.h);
    const chatOcr = await d.ocr.recognize(chatShot.png, chatArea);
    const parsed = mergeBubbles(
      messagesFromOcr(chatOcr.lines, { width: screen.w, meRatio: 0.55, minHeight: 20, bmp: chatBmp }),
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
      await this.#maybeCollect(name, fresh.length);
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reason: decision.reason, ms: Date.now() - t0 };
    }

    // 7) 想一句（交接模式下挂起，等主模型给文本）
    let replyText: string;
    const brainCtx: BrainContext = {
      chat: name,
      kind: d.world.chat(name).kind,
      messages: d.world.context(name, 12).map((m) => ({ from: m.from, text: m.text })),
    };

    if (this.#cfg.handoff) {
      const id = await this.#cfg.handoff(brainCtx);
      d.eventLog?.append("intent.pending", { chat: name, id, reason: "交给主模型" }, { src: "handoff" });
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reason: `已挂起等主模型（${id.slice(0, 8)}）`, ms: Date.now() - t0 };
    }

    try {
      replyText = await d.brain.reply(brainCtx);
    } catch (err) {
      d.eventLog?.append("note", { stage: "brain", chat: name, error: (err as Error).message }, { src: "brain" });
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reason: `脑子出错：${(err as Error).message}`, ms: Date.now() - t0 };
    }

    // 模型可以明确表示「这句不用接」（返回空串），那就真不接
    if (replyText.trim() === "") {
      d.eventLog?.append("note", { stage: "brain", chat: name, skip: "empty-reply" }, { src: "brain" });
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reason: "模型判断这句不用接", ms: Date.now() - t0 };
    }

    const text = replyText.slice(0, this.#cfg.policy.maxReplyChars ?? 200);

    // 8) 发（干跑/不发送模式只记账，不真发）
    if (d.actuator.dryRun || this.#cfg.noSend) {
      d.eventLog?.append("note", { stage: "send", dryRun: true, noSend: Boolean(this.#cfg.noSend), chat: name, text }, { src: "monitor" });
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reply: text, reason: `干跑/不发送：本想回「${text}」`, ms: Date.now() - t0 };
    }

    const result = await d.sendReply(text);

    if (!result.ok) {
      d.eventLog?.append("send.failed", { chat: name, text, reason: result.reason ?? null }, { src: "monitor" });
      await this.#backToList();
      return { acted: true, chat: name, replied: false, reason: `没发出去：${result.reason ?? "未知原因"}`, ms: Date.now() - t0 };
    }

    const lastOther = [...fresh].reverse().find((m) => m.from === "other");
    await this.#maybeCollect(name, fresh.length);
    d.world.markReplied(name, lastOther?.id, Date.now());
    d.world.patch(name, { cooldownUntil: Date.now() + this.#cfg.perChatCooldownMs });
    d.world.save();
    d.eventLog?.append("send.succeeded", { chat: name, text }, { src: "monitor" });

    await this.#backToList();
    return { acted: true, chat: name, replied: true, reply: text, reason: "已回复", ms: Date.now() - t0 };
  }

  /** 自动收藏：每轮最多一次，每小时有额度；失败只记事件，不打断主流程。 */
  async #maybeCollect(chat: string, freshCount: number): Promise<void> {
    if (!this.#cfg.collectStickers || !this.#d.collectSticker) return;
    if (freshCount === 0) return;
    const now = Date.now();
    const perHour = this.#cfg.collectPerHour ?? 2;
    this.#collectTimes = this.#collectTimes.filter((t) => now - t < 60 * 60 * 1000);
    if (this.#collectTimes.length >= perHour) return;
    try {
      const result = await this.#d.collectSticker();
      if (result.ok) {
        this.#collectTimes.push(now);
        this.#d.eventLog?.append("note", { stage: "collect-sticker", chat, ok: true }, { src: "stickers" });
      } else if (result.reason) {
        this.#d.eventLog?.append("note", { stage: "collect-sticker", chat, skipped: result.reason }, { src: "stickers" });
      }
    } catch (err) {
      this.#d.eventLog?.append("note", { stage: "collect-sticker", chat, error: (err as Error).message }, { src: "stickers" });
    }
  }

  /** 确保停在会话列表：不是列表就 back，最多 maxBackSteps 次。 */
  async #ensureList(): Promise<boolean> {
    for (let i = 0; i <= this.#cfg.maxBackSteps; i++) {
      const frame = await this.#d.device.adb.screencap();
      const guess = detectPage(decode(frame.png), await this.#d.device.adb.focus());
      if (guess.page === "list") return true;
      if (guess.page === "other" || guess.page === "unknown") {
        // 前台不是微信：默认不抢焦点，直接放弃这一轮（人手正在用别的东西）
        if (!this.#cfg.allowLaunch) return false;
        await this.#d.device.adb.shell("am start -n com.tencent.mm/.ui.LauncherUI", 15000);
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      await this.#d.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  async #backToList(): Promise<void> {
    const frame = await this.#d.device.adb.screencap();
    const guess = detectPage(decode(frame.png), await this.#d.device.adb.focus());
    if (guess.page === "chat") {
      await this.#d.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** 轮询直到页面变成目标页（点击后界面切换需要时间，不能只等画面静止）。 */
  async #waitPage(target: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = await this.#d.device.adb.screencap();
      const guess = detectPage(decode(frame.png), await this.#d.device.adb.focus());
      if (guess.page === target) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }
}