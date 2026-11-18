/**
 * 自动聊天循环：一次 tick = 看一眼列表 → 进会话 → 读尾部 → 判要不要回 → 回 → 回列表。
 *
 * 每个 tick 只处理**一个**会话：单窗口是物理约束（同一时刻只有一个聊天页），
 * 多会话只在时间上轮流。所有判断都落事件，失败也落，方便事后复盘。
 */

import type { DevicePorts, Frame } from "../device/types.ts";
import type { EventLog } from "../eventlog.ts";
import type { Bitmap, Rect } from "../image/image.ts";
import { decode } from "../image/image.ts";
import type { Ocr } from "../perception/ocr.ts";
import { detectPage, rectOf, type PageGraph } from "../perception/page.ts";
import { waitStable } from "../perception/stable.ts";
import { bubbleSide, messagesFromOcr, mergeBubbles } from "../monitor/read.ts";
import { findCardTitle } from "../perception/cards.ts";
import { findImageBubbles } from "../perception/bubbles.ts";
import { cleanName, isNameLine, scanList } from "../monitor/scan.ts";
import { detectChatKind, titleFromOcr, titleMatches } from "../monitor/chat.ts";
import { decide, pickChat, sameChatName, type PolicyConfig } from "../policy/policy.ts";
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
  sendReply: (text: string, chat: string) => Promise<{ ok: boolean; reason?: string }>;
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
  /** 一次性定向到某个会话（调试/补跑用） */
  forceChatOnce?: string;

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
    const screen = d.graph.device.screen;
    const listArea = rectOf(d.graph, "list", "list_area", screen.w, screen.h);
    const readList = async () => {
      const shot = await d.device.adb.screencap();
      const ocr = await d.ocr.recognize(shot.png, listArea);
      return { ocr, scan: scanList(decode(shot.png), ocr.lines, listArea) };
    };
    let { ocr: listOcr, scan } = await readList();

    // 兜底：页面判定说"这是列表"，但列表区域里**读到了字、却一行会话名都没有** —— 那是浮层盖住了。
    // （一个字都读不到时不动手：可能只是这一帧还没渲染好，乱按返回会把正常的列表也退了。）
    // 2026-11-18 真机撞到：收藏表情后表情面板留在群里，页面判定把表情网格当成了底部 tab 栏，
    // 于是每一轮都"列表里没有未读"，群里 @ 了半小时没人回。按返回把它收掉再扫一遍。
    const noNamesYet = (o: typeof listOcr) => o.lines.length > 0 && !o.lines.some((l) => isNameLine(l));
    if (scan.rows.length === 0 && noNamesYet(listOcr)) {
      for (let i = 0; i < 2; i++) {
        if (scan.rows.length > 0 || !noNamesYet(listOcr)) break;
        d.eventLog?.append("note", { stage: "scan-empty", recover: "back", attempt: i + 1 }, { src: "monitor" });
        await d.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
        await new Promise((r) => setTimeout(r, 500));
        if (!(await this.#ensureList())) break;
        await waitStable(d.device.adb, { frames: 2, timeoutMs: 3000 });
        ({ ocr: listOcr, scan } = await readList());
      }
      if (scan.rows.length === 0 && noNamesYet(listOcr)) {
        return { acted: false, reason: "回不到列表（界面被浮层盖住）", ms: Date.now() - t0 };
      }
    }

    d.eventLog?.append(
      "frame.captured",
      { tag: "list", unreadRows: scan.rows.length, badges: scan.badges, rows: scan.rows.map((r) => r.name) },
      { src: "monitor" },
    );

    let name: string | null;
    let rowY: number;

    const forced = this.#cfg.forceChat || this.forceChatOnce;
    if (this.forceChatOnce) this.forceChatOnce = undefined;

    if (forced) {
      // 定向模式：不要求未读，直接在列表 OCR 里找这个名字
      const want = forced.replace(/\s+/g, "");
      const hit = listOcr.lines.find((l) => isNameLine(l) && cleanName(l.text).includes(want));
      if (!hit) return { acted: false, reason: `列表里没找到「${forced}」`, ms: Date.now() - t0 };
      name = cleanName(hit.text);
      rowY = hit.y + hit.h / 2;
      d.eventLog?.append("note", { stage: "force-chat", hit: { text: hit.text, y: hit.y, h: hit.h }, tapY: Math.round(rowY) }, { src: "monitor" });
    } else {
      if (scan.rows.length === 0) {
        return { acted: false, reason: "列表里没有未读", ms: Date.now() - t0 };
      }
      name = pickChat(scan.rows, (this.#cfg.policy.whitelist ?? []).slice());
      if (!name) return { acted: false, reason: "未读都不在白名单", ms: Date.now() - t0 };
      const wanted = name;
      // pickChat 返回的是白名单里的规范名；列表里那行可能被 OCR 读歪（「以摸鱼…」），按模糊找
      const row = scan.rows.find((r) => r.name === wanted) ?? scan.rows.find((r) => sameChatName(r.name, wanted));
      if (!row) return { acted: false, reason: `列表里找不到「${wanted}」`, ms: Date.now() - t0 };
      rowY = row.y;
    }

    // 4) 进去并核对标题。列表在「扫描」和「点击」之间会重排，进错会话必须退回来重试 ——
    //    只看「页面是不是 chat」发现不了（别的群也是 chat），标题是唯一的硬证据。
    let entered = false;
    let title: string | null = null;
    let chatShot: Frame | null = null;
    let lastWrongTitle: string | null = null;
    for (let tries = 0; tries < 3; tries++) {
      let tapY = Math.round(rowY);
      if (tries > 0) {
        await this.#ensureList();
        const again = await d.device.adb.screencap();
        const againOcr = await d.ocr.recognize(again.png, listArea);
        const line = againOcr.lines.find((l) => isNameLine(l) && cleanName(l.text).includes(name.replace(/\s+/g, "")));
        if (!line) break;
        tapY = Math.round(line.y + line.h / 2);
      }
      await d.actuator.tapPoint(this.#cfg.rowTapX, tapY, 60);
      entered = await this.#waitPage("chat", 6000);
      if (!entered) continue;
      await waitStable(d.device.adb, { frames: 2, timeoutMs: 4000 });

      const shot = await d.device.adb.screencap();
      // 标题只在中间那条带里：整条头栏会把「〈 未读数」也读进来，最长的那行反而不是标题
      const headerArea = rectOf(d.graph, "chat", "title_strip", screen.w, screen.h);
      const headerOcr = await d.ocr.recognize(shot.png, headerArea);
      const got = titleFromOcr(headerOcr.lines);
      if (!got || titleMatches(name, got)) {
        title = got;
        chatShot = shot;
        break;
      }
      lastWrongTitle = got;
      d.eventLog?.append("note", { stage: "enter-chat", wanted: name, got, tries }, { src: "monitor" });
      entered = false;
      await this.#backToList();
    }

    if (!entered || !chatShot) {
      await this.#backToList();
      return {
        acted: false,
        chat: name,
        reason: lastWrongTitle
          ? `进错会话：想进「${name}」，实际「${lastWrongTitle}」（重试 3 次仍对不上）`
          : "点了会话行但没进到聊天页（重试后仍失败）",
        ms: Date.now() - t0,
      };
    }

    // 5) 顺便定群/私聊
    const kind = detectChatKind(title || name);
    d.world.patch(name, { kind });

    const chatBmp: Bitmap = decode(chatShot.png);
    const chatArea = rectOf(d.graph, "chat", "message_area", screen.w, screen.h);
    const chatOcr = await d.ocr.recognize(chatShot.png, chatArea);
    const parsed = mergeBubbles(
      messagesFromOcr(chatOcr.lines, { width: screen.w, meRatio: 0.55, minHeight: 20, bmp: chatBmp, group: kind === "group" }),
    );

    // 图片/表情气泡没有文字，OCR 出来是空白 —— 主模型会以为对方什么都没发。
    // 标成 [表情]，它才知道「刚才那个是个表情」，也才有可能用表情接表情。
    for (const bubble of findImageBubbles(chatBmp, chatArea)) {
      parsed.push({
        text: "[表情]",
        from: bubble.side === "left" ? "other" : "me",
        y: bubble.rect.y,
        h: bubble.rect.h,
      });
    }
    parsed.sort((a, b) => a.y - b.y);

    // 对方发的链接卡片：OCR 里就是「标题 + 来源」两行，正文把来源当小字滤掉了，
    // 主模型只会看到一句莫名的话。认出卡片后把那条消息标成链接，它才知道可以点进去读。
    const card = findCardTitle(chatOcr.lines);
    // 自己的绿色气泡里也常出现「大字 + 下面一行小字（对方昵称）」，会被误判成卡片。
    // 真卡片是白色底：绿气泡一律不算。
    const cardIsMine = card ? bubbleSide(chatBmp, { text: card.text, x: card.x, y: card.y, w: card.w, h: card.h }) === "me" : false;
    if (card && !cardIsMine) {
      const near = parsed.find((m) => m.from === "other" && Math.abs(m.y - card.y) < card.h * 2.5);
      const label = `[链接] ${card.text}${card.source ? ` · ${card.source}` : ""}`;
      if (near) near.text = label;
      d.eventLog?.append(
        "note",
        { stage: "link-card", chat: name, title: card.text, source: card.source, marked: Boolean(near), ...(cardIsMine ? { skipped: "green-bubble" } : {}) },
        { src: "monitor" },
      );
    }

    const fresh = d.world.ingest(name, parsed.map((m) => ({
      text: m.text,
      from: m.from,
      y: m.y,
      source: "ocr" as const,
      ...(m.sender ? { sender: m.sender } : {}),
    })));
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
      needsJudgment: decision.needsJudgment,
      messages: d.world.context(name, 12).map((m) => ({ from: m.from, text: m.text, ...(m.sender ? { sender: m.sender } : {}) })),
    };

    if (this.#cfg.handoff) {
      await this.#maybeCollect(name, fresh.length);
      const id = await this.#cfg.handoff(brainCtx);
      if (!id) {
        // 交接方可以选择「这一轮不挂待办」（比如群聊判断已经太频繁）
        d.eventLog?.append("note", { chat: name, skip: "handoff-capped" }, { src: "handoff" });
        await this.#backToList();
        return { acted: true, chat: name, replied: false, reason: "群聊判断太频繁，这一轮不挂待办", ms: Date.now() - t0 };
      }
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

    const result = await d.sendReply(text, name);

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
      const focus = await this.#d.device.adb.focus();
      const guess = detectPage(decode(frame.png), focus);
      if (guess.page === "list") return true;
      if (guess.page === "other") {
        // 前台是别的 App：默认不抢焦点，直接放弃这一轮（人手正在用别的东西）
        if (!this.#cfg.allowLaunch) return false;
        await this.#d.device.adb.shell("am start -n com.tencent.mm/.ui.LauncherUI", 15000);
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      // unknown 多数是「浮层盖在微信上」：长按气泡的菜单、权限弹窗、表情面板。
      // 真机上撞到过一次 —— 收藏表情中途引擎重启，菜单留在屏幕上，之后每一轮 tick
      // 都因为「前台不是微信」原地空转，几个小时不干正事。按一次返回把它收掉。
      if (guess.page === "unknown") {
        this.#d.eventLog?.append("note", { stage: "ensure-list", page: "unknown", focus: focus.component, dismiss: "back" }, { src: "monitor" });
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