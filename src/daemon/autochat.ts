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
import { decodeFrame, detectPage, rectOf, type PageGraph } from "../perception/page.ts";
import { waitStable, waitScrollSettle } from "../perception/stable.ts";
import { bubbleSide, messagesFromOcr, mergeBubbles } from "../monitor/read.ts";
import { findCardTitle } from "../perception/cards.ts";
import { findImageBubbles } from "../perception/bubbles.ts";
import { cleanName, isNameLine, scanList } from "../monitor/scan.ts";
import { detectChatKind, titleFromOcr, titleMatches } from "../monitor/chat.ts";
import { decide, pickChat, sameChatName, type PolicyConfig } from "../policy/policy.ts";
import type { Brain, BrainContext } from "../brain/brain.ts";
import { enterChat, findMentionTag, scrollToBottom } from "./navigate.ts";
import type { ImePort } from "../device/types.ts";

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
  /** 搜索兜底要打字（navigate.enterChat 用） */
  ime?: Pick<ImePort, "type">;
  /** 打字前后切/还输入法（daemon 里的 withAutomationIme） */
  withIme?: <T>(fn: () => Promise<T>) => Promise<T>;
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

    // 0) 锁屏/息屏就别折腾了：截图全黑会让页面判定一路 unknown，反复按返回还可能
    //    触发锁屏动效（旧插件 screenAwake 就是干这个的）。查不到状态时按"醒着"处理，别误停。
    if (d.device.adb.screenAwake) {
      const awake = await d.device.adb.screenAwake().catch(() => true);
      if (!awake) return { acted: false, reason: "手机息屏/锁屏，本轮跳过", ms: Date.now() - t0 };
    }

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
      // 用白名单里的规范名：列表那行可能被 OCR 读歪（「以摸鱼…」），
      // 后面所有 patch / 白名单判断都按名字走，用歪名字就进不去。
      const hitName = cleanName(hit.text);
      name = (this.#cfg.policy.whitelist ?? []).find((n) => sameChatName(n, hitName)) ?? hitName;
      rowY = hit.y + hit.h / 2;
      d.eventLog?.append("note", { stage: "force-chat", hit: { text: hit.text, y: hit.y, h: hit.h }, tapY: Math.round(rowY) }, { src: "monitor" });
    } else {
      const wl = (this.#cfg.policy.whitelist ?? []).slice();
      // 「欠着没回」的消息（冷却 / 合并窗口期间攒下的）。微信只要进过一次会话就把红点清了，
      // 列表扫描永远发现不了它们 —— 不主动回去补发，这些消息就再没人理了
      // （旧插件的 flushPending 就是干这个的）。
      const owedFirst = () => {
        const chats = d.world.snapshot().chats ?? {};
        return d.world.listUnsent().find((x) => {
          if (!(wl.length === 0 || wl.some((n) => sameChatName(n, x.name)))) return false;
          // 还在会话冷却里就先别回去：进去了 policy 也只会再判一次「冷却中，先攒着」，
          // 白白多一轮进会话 + 十几张截图（真机每 20 秒重复撞到过一次）。
          const cooldown = chats[x.name]?.cooldownUntil ?? 0;
          return cooldown <= Date.now();
        });
      };

      // 回去补发：靠 forceChatOnce 下一拍定向进这个会话（定向模式不要求红点）。
      const flushOwed = (): TickResult => {
        const owed = owedFirst()!;
        // 会话名可能是 OCR 读歪的（实测读到过「以摸鱼闲聊群」，比真名多了个「以」）。
        // 拿歪名字进会话会一直判「不在白名单」，欠账永远补不出去 —— 死循环。
        // 先归一化到白名单里的规范名，再把欠账迁过去。
        const canonical = wl.find((n) => sameChatName(n, owed.name)) ?? owed.name;
        if (canonical !== owed.name) {
          const moved = d.world.peekUnsent(owed.name);
          if (moved.length > 0) d.world.queueUnsent(canonical, moved);
          d.world.clearUnsent(owed.name);
          d.eventLog?.append(
            "note",
            { stage: "unsent-rename", from: owed.name, to: canonical, count: moved.length || owed.count },
            { src: "policy" },
          );
        }
        this.forceChatOnce = canonical;
        d.eventLog?.append("note", { stage: "unsent-flush", chat: canonical, count: owed.count }, { src: "policy" });
        return { acted: false, reason: `回去补发「${canonical}」欠着的 ${owed.count} 条`, ms: Date.now() - t0 };
      };

      if (scan.rows.length === 0) {
        if (owedFirst()) return flushOwed();
        return { acted: false, reason: "列表里没有未读", ms: Date.now() - t0 };
      }
      name = pickChat(scan.rows, wl);
      if (!name) {
        // 有未读、但一个都不在白名单里 —— 别在这一句上每拍干等：欠着的照样要回去补。
        // （2026-11-18 真机：其它群有未读时，合并窗口攒下的那 9 条一直没被补发。）
        if (owedFirst()) return flushOwed();
        return { acted: false, reason: "未读都不在白名单", ms: Date.now() - t0 };
      }
      const wanted = name;
      // pickChat 返回的是白名单里的规范名；列表里那行可能被 OCR 读歪（「以摸鱼…」），按模糊找
      const row = scan.rows.find((r) => r.name === wanted) ?? scan.rows.find((r) => sameChatName(r.name, wanted));
      if (!row) return { acted: false, reason: `列表里找不到「${wanted}」`, ms: Date.now() - t0 };
      rowY = row.y;
    }

    // 4) 进去并核对标题：交给 navigate.enterChat。
    //    以前这里自己内联了点行循环，点不进去就每拍重烧一遍。旧插件的教训是：
    //    列表在「截图」和「点击」之间会重排，盲点行必踩，所以它早就改成了搜索优先；
    //    enterChat 现在带「点行失败就转搜索」的兜底，并把 via / attempts 回报出来。
    const nav = await enterChat(this.#navDeps(), name, { tapX: this.#cfg.rowTapX });
    if (!nav.ok) {
      await this.#backToList();
      // 进不去就挂冷却。旧插件的 perChatCooldownSec 就是干这个的：否则这个会话会被
      // 每一拍重试一次（每次十几张截图），永远出不来，还会一直刷「进错会话」。
      d.world.patch(name, { cooldownUntil: Date.now() + this.#cfg.perChatCooldownMs });
      d.eventLog?.append(
        "note",
        { stage: "enter-chat-failed", chat: name, reason: nav.reason ?? null, attempts: nav.attempts },
        { src: "monitor" },
      );
      return { acted: false, chat: name, reason: nav.reason ?? "进不去会话", ms: Date.now() - t0 };
    }
    const title: string | null = nav.title ?? null;

    // 等画面稳定只看静区（标题栏 / 输入栏）：聊天区有动图表情，整帧永远不稳（device-probes 实测）。
    const headerArea = rectOf(d.graph, "chat", "title_strip", screen.w, screen.h);
    // 页面图里没有 input_bar 也不该把整轮 tick 搞崩（老配置 / 测试桩都会缺元素）。
    let inputBar: Rect | null = null;
    try {
      inputBar = rectOf(d.graph, "chat", "input_bar", screen.w, screen.h);
    } catch {
      inputBar = null;
    }

    // (a) 顶部如果挂着「有人@我」，先点它（旧插件 findMentionTag）。它返回的是提示条中心，
    //     点"上沿"会点到标题栏（旧实现有这个坑）。
    try {
      const pre = await d.device.adb.screencap();
      const tag = await findMentionTag(pre.png, d.ocr, rectOf(d.graph, "chat", "mention_tag", screen.w, screen.h));
      if (tag) {
        d.eventLog?.append("note", { stage: "mention-tag", chat: name, x: tag.x, y: tag.y }, { src: "monitor" });
        await d.actuator.tapPoint(tag.x, tag.y, 70);
      }
    } catch (err) {
      d.eventLog?.append("note", { stage: "mention-tag", chat: name, error: (err as Error).message }, { src: "monitor" });
    }

    // (b) 带未读进来时微信停在"第一条未读"，不滑到底就看不到最新的话
    //     （旧插件 scrollToBottom；否则读到的是最旧那一屏，会据此回错话）。
    await scrollToBottom(d.device.adb, 3, { screen });
    // (c) 等滚停，并把这一帧直接拿去读消息（省一张截图）。
    const settled = await waitScrollSettle(d.device.adb, {
      regions: inputBar ? [headerArea, inputBar] : [headerArea],
      frames: 2,
      timeoutMs: 3000,
    });
    const chatShot: Frame = {
      png: settled.lastPng,
      width: screen.w,
      height: screen.h,
      ms: 0,
      bmp: settled.lastFrame,
    };

    // 5) 定群/私聊：标题只是第一条线索，正文里出现 ≥2 个不同发送者才算硬证据
    //    （world.patch 里保证 group 不会被一次误判降级成 dm —— 旧插件踩过这个坑：
    //    群被当成私聊 → 没人 @ 也在群里回话）。
    const kind = detectChatKind(title || name);
    d.world.patch(name, { kind });

    const chatBmp: Bitmap = chatShot.bmp ?? decode(chatShot.png);
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
    // 之前因为冷却 / 静默 / 合并窗口被判「先等等」的消息攒在 world 里（旧插件的 pendingText）。
    // 不接这一段的话：合并窗口第一拍必然判「再等等」，第二拍 fresh 已经是空，这条消息就永远
    // 不会再触发了 —— 等于永久丢消息（旧插件当年就是这么丢的，后来专门加了 flushPending）。
    const unsent = d.world.peekUnsent(name);
    const decision = decide({ now, chat: d.world.chat(name), fresh, unsent, config: this.#cfg.policy });
    d.eventLog?.append(
      "intent.decided",
      { chat: name, reply: decision.reply, reason: decision.reason, fresh: fresh.length, unsent: unsent.length },
      { src: "policy" },
    );

    if (!decision.reply) {
      // 只把「暂时不处理」的攒起来（合并窗口 / 冷却 / 静默）；永久不该回的别进队列，
      // 否则它们会被每一拍重新判一次，白白烧 OCR 和次数。
      if (/合并窗口|冷却|静默|补发/.test(decision.reason)) {
        const queued = d.world.queueUnsent(name, fresh);
        if (queued > 0) {
          d.eventLog?.append("note", { stage: "unsent-queued", chat: name, added: queued, reason: decision.reason }, { src: "policy" });
        }
      }
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

    const lastOther = [...fresh, ...unsent].reverse().find((m) => m.from === "other");
    await this.#maybeCollect(name, fresh.length);
    // 第 4 个参数把自己发的文本也记下来：气泡分边在长引用/合并转发上会判错，
    // 记下"我说过什么"才能在下次读回来时不把自己当成对方。
    d.world.markReplied(name, lastOther?.id, Date.now(), text);
    d.world.takeUnsent(name);
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
  /** 连续几次回不到列表：用来判「微信僵死」 */
  #ensureListFails = 0;

  async #ensureList(): Promise<boolean> {
    for (let i = 0; i <= this.#cfg.maxBackSteps; i++) {
      const frame = await this.#d.device.adb.screencap();
      const focus = await this.#d.device.adb.focus();
      const guess = detectPage(decodeFrame(frame), focus);
      if (guess.page === "list") {
        this.#ensureListFails = 0;
        return true;
      }
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

    // 连按几次返回都回不到列表：多半是微信僵死了（华为上实测过 dumpsys 说微信在前台、
    // 截图却是桌面，这种只能重启 App）。旧插件是连 3 次才动手，这里一样 —— 别每拍都重启。
    this.#ensureListFails++;
    if (this.#ensureListFails >= 3) {
      this.#ensureListFails = 0;
      const adb = this.#d.device.adb;
      if (adb.restartWeChat) {
        const r = await adb
          .restartWeChat({ forceStopWaitMs: 1500, launchWaitMs: 6000 })
          .catch((err) => ({ ok: false, log: (err as Error).message, pkg: "com.tencent.mm" }));
        this.#d.eventLog?.append("note", { stage: "restart-wechat", ok: r.ok, log: r.log }, { src: "monitor" });
      }
    }
    return false;
  }

  /** 给 navigate.enterChat 的依赖：actuator 包成 injector.tap，导航日志落事件流 */
  #navDeps() {
    const d = this.#d;
    return {
      adb: d.device.adb,
      injector: {
        tap: async (x: number, y: number, downMs: number) => {
          await d.actuator.tapPoint(x, y, downMs);
        },
      },
      ocr: d.ocr,
      graph: d.graph,
      ime: this.#d.ime,
      withIme: this.#d.withIme,
      log: (m: string) => d.eventLog?.append("note", { stage: "nav", msg: m }, { src: "nav" }),
    };
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