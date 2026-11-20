/**
 * 技能执行器：把声明式技能跑成动作序列。
 *
 * 原则：
 *  - 不认识的断言/操作**直接报错**，不静默通过（静默通过比失败更危险）；
 *  - 每一步都受预算约束（步数 + 墙钟）；
 *  - 只在有把握的地方做「验证」：读输入框、判页面；没有 OCR 就不假装能验 OCR；
 *  - 失败要能说清「卡在第几步、为什么」。
 */

import type { EventLog } from "../eventlog.ts";
import { Actuator } from "../act/actuator.ts";
import type { DevicePorts } from "../device/types.ts";
import { crop, decode, regionDiff, type Bitmap, type Rect } from "../image/image.ts";
import { detectPage, rectOf, type PageGraph } from "../perception/page.ts";
import { waitStable } from "../perception/stable.ts";
import { findDarkPanel, isMenuPanel } from "../perception/panel.ts";
import { findStickerCells, type PanelGrid } from "../perception/cells.ts";
import { findImageBubbles } from "../perception/bubbles.ts";
import { cosine, hamming, stickerFeatures } from "../image/image.ts";
import { pickSticker } from "../stickers/pick.ts";
import { findCardTitle, findLinkCards } from "../perception/cards.ts";
import { bubbleSide } from "../monitor/read.ts";
import { looksLikeInputBar } from "../perception/page.ts";
import { bindSteps } from "./registry.ts";
import type { Assertion, Skill, Step } from "./types.ts";

export interface RunnerDeps {
  device: DevicePorts;
  actuator: Actuator;
  graph: PageGraph;
  eventLog?: EventLog;
  /** 有 OCR 才能跑 obs.ocr 类步骤 */
  ocr?: import("../perception/ocr.ts").Ocr;
  /** 表情库（按情绪挑图用） */
  stickers?: import("../stickers/library.ts").StickerLibrary;
  /** 视觉打标器（自动收藏用） */
  labeler?: import("../stickers/labeler.ts").StickerLabeler;
}

export interface RunResult {
  skillId: string;
  ok: boolean;
  steps: number;
  ms: number;
  /** pre / steps / post / budget */
  failedAt?: "pre" | "steps" | "post" | "budget";
  reason?: string;
  outputs: Record<string, unknown>;
}

export class SkillRunError extends Error {
  override name = "SkillRunError";
  constructor(message: string) {
    super(message);
  }
}

export class SkillRunner {
  readonly #deps: RunnerDeps;
  /** obs.screenshot 带 tag 的帧，供 check 对比 */
  readonly #shots = new Map<string, import("../image/image.ts").Bitmap>();
  /**
   * 在收藏面板里怎么都找不到的目标 → 记录时间。
   * 不记的话每轮都拿它当目标、白扫 6 屏，最后只能退回「最后一屏剩下的那张」，
   * 一晚上反复发同一张（2026-11-19 22 点爬山群就是这个现象）。
   */
  readonly #panelMiss = new Map<string, number>();

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
  }

  async run(skill: Skill, params: Record<string, unknown> = {}): Promise<RunResult> {
    const started = Date.now();
    const outputs: Record<string, unknown> = {};
    const steps = bindSteps(skill, params);

    this.#deps.eventLog?.append(
      "plan.planned",
      { skill: skill.id, version: skill.version, params, steps: steps.length, dryRun: this.#deps.actuator.dryRun },
      { src: "skills.runner" },
    );

    const finish = (ok: boolean, failedAt?: RunResult["failedAt"], reason?: string, stepIndex = 0): RunResult => {
      const result: RunResult = {
        skillId: skill.id,
        ok,
        steps: stepIndex,
        ms: Date.now() - started,
        outputs,
      };
      if (failedAt) result.failedAt = failedAt;
      if (reason) result.reason = reason;
      this.#deps.eventLog?.append(
        ok ? "action.verified" : "note",
        { skill: skill.id, ok, failedAt: failedAt ?? null, reason: reason ?? null, steps: stepIndex, ms: result.ms },
        { src: "skills.runner" },
      );
      return result;
    };

    // ---- pre ----
    for (const assertion of skill.pre) {
      const check = await this.#assert(assertion);
      if (!check.ok) return finish(false, "pre", `前置条件不满足：${check.message}`);
    }

    // ---- steps ----
    let i = 0;
    for (const step of steps) {
      i++;
      if (i > skill.budget.maxSteps) return finish(false, "budget", `步数超过预算 ${skill.budget.maxSteps}`, i - 1);
      if (Date.now() - started > skill.budget.maxMs) {
        return finish(false, "budget", `耗时超过预算 ${skill.budget.maxMs}ms`, i - 1);
      }
      try {
        const detail = await this.#step(step, outputs);
        if (detail) outputs[`step${i}`] = detail;
      } catch (err) {
        const message = (err as Error).message;
        if (step.optional) {
          this.#deps.eventLog?.append("note", { skill: skill.id, step: i, skipped: message }, { src: "skills.runner" });
          continue;
        }
        if (step.onFail === "skip") continue;
        return finish(false, "steps", `第 ${i} 步（${step.op}）失败：${message}`, i - 1);
      }
    }

    // ---- post ----
    for (const assertion of skill.post) {
      const check = await this.#assert(assertion);
      if (!check.ok) return finish(false, "post", `后置条件不满足：${check.message}`, i);
    }

    return finish(true, undefined, undefined, i);
  }

  // ---------------- 断言 ----------------

  async #assert(assertion: Assertion): Promise<{ ok: boolean; message: string }> {
    const label = typeof assertion.value === "string" ? assertion.value : JSON.stringify(assertion.value);
    switch (assertion.kind) {
      case "page": {
        const guess = await this.#page();
        return { ok: guess.page === assertion.value, message: `期望页面 ${label}，实际 ${guess.page}（${guess.reason}）` };
      }
      case "element": {
        // 元素存在性在页面图里判：这页有没有这个元素
        const [page, element] = String(assertion.value).split(".");
        if (!page || !element) return { ok: false, message: `元素断言格式应为 page.element，收到 ${label}` };
        try {
          rectOf(this.#deps.graph, page, element, 1, 1);
          return { ok: true, message: "ok" };
        } catch (err) {
          return { ok: false, message: (err as Error).message };
        }
      }
      case "no_ime": {
        const shown = await this.#imeShown();
        return { ok: shown === false, message: `期望键盘收起，实际 ${shown ? "弹出" : "收起"}` };
      }
      default:
        throw new SkillRunError(`这条断言还不会判：${assertion.kind}（不静默通过）`);
    }
  }

  // ---------------- 步骤 ----------------

  async #step(step: Step, outputs: Record<string, unknown>): Promise<unknown> {
    const args = (step.args ?? {}) as Record<string, unknown>;
    switch (step.op) {
      case "obs.screenshot": {
        const shot = await this.#deps.device.adb.screencap();
        this.#shots.set(String(args["tag"] ?? "shot"), decode(shot.png));
        const guess = await this.#page();
        this.#deps.eventLog?.append(
          "frame.captured",
          { tag: String(args["tag"] ?? "shot"), page: guess.page, bytes: shot.png.length, width: shot.width, height: shot.height },
          { src: "skills.runner" },
        );
        return { page: guess.page, bytes: shot.png.length, ms: shot.ms };
      }

      case "act.tap": {
        const rect = this.#rectOfTarget(step);
        return this.#deps.actuator.tapRect(rect);
      }

      case "act.long_press": {
        const rect = this.#rectOfTarget(step);
        return this.#deps.actuator.holdRect(rect);
      }

      case "act.type": {
        const text = String(args["text"] ?? "");
        if (!text) throw new SkillRunError("act.type 少了 text");
        return this.#deps.actuator.typeText(text);
      }

      case "act.clear_input": {
        // 输入框里可能有上一次没发出去的残句（真机 19:29 看到两条回复粘在草稿里，
        // 中间还夹着 %%% 的乱码）。发新的一句之前先清干净，免得越攒越长。
        const cur = await this.#deps.actuator.readInput().catch(() => ({ before: "", after: "" }));
        const current = `${cur.before}${cur.after}`;
        if (!current.trim()) return { cleared: false };
        await this.#deps.device.ime.clear();
        await new Promise((r) => setTimeout(r, 250));
        const left = `${(await this.#deps.actuator.readInput().catch(() => ({ before: "", after: "" }))).before}`;
        this.#deps.eventLog?.append(
          "note",
          { op: "clear_input", had: current.slice(0, 40), left: left.slice(0, 40) },
          { src: "skills.runner" },
        );
        return { cleared: true, had: current.length };
      }

      case "act.send_current_text": {
        // 点「发送」并**确认真的发出去了**：以前只点一次固定坐标就算成功，
        // 真机上按钮被键盘/浮层挡住时输入框里的字会留下来，引擎却记成已发送 ——
        // 于是越攒越多（2026-11-18 19:29 的草稿：「…泥鳅啊%%%又爆一个？…」）。
        //
        // 两次机会，都不按返回键：会话页里按 BACK 很容易直接退出会话（真机踩过）。
        //   a) OCR 找到「发送」按钮（且必须在屏幕右侧、文字正好是「发送」）；
        //   b) 页面图里的 send_button 坐标（打字时用的探针输入法很矮，按钮就在右下）。
        const text = String(args["text"] ?? "");
        const screen = this.#deps.graph.device.screen;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const want = text.replace(/\s+/g, "");
        const readAll = async (): Promise<string> => {
          const cur = await this.#deps.actuator.readInput();
          return `${cur.before}${cur.after}`.replace(/\s+/g, "");
        };
        const ocrSend = async (): Promise<{ x: number; y: number } | null> => {
          const shot = await this.#deps.device.adb.screencap();
          const region = { x: 0, y: Math.round(screen.h * 0.3), w: screen.w, h: Math.round(screen.h * 0.7) };
          const ocr = await this.#deps.ocr!.recognize(shot.png, region);
          // 只做 /发送/ 匹配会命中输入框正文（模型的话也常以「发送」开头）——
          // 必须文字正好是「发送」、在右半边、宽度不大。
          const btn = ocr.lines.find(
            (l) => l.text.replace(/\s+/g, "") === "发送" && l.x > screen.w * 0.5 && l.w <= screen.w * 0.3,
          );
          return btn ? { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 } : null;
        };
        const coords: Array<{ x: number; y: number }> = [];
        const ocrPoint = await ocrSend();
        if (ocrPoint) coords.push(ocrPoint);
        const rect = rectOf(this.#deps.graph, "chat", "send_button", screen.w, screen.h);
        coords.push({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

        for (const point of coords) {
          await this.#deps.actuator.tapPoint(point.x, point.y, 60);
          await sleep(800);
          const now = await readAll();
          if (!want || !now.includes(want)) return { sent: true, at: point };
          this.#deps.eventLog?.append(
            "note",
            { op: "send", still: true, at: point, left: now.slice(0, 40) },
            { src: "skills.runner" },
          );
        }
        throw new SkillRunError("点了「发送」但输入框里还有文字 —— 这条没发出去");
      }

      case "act.open_sticker_panel": {
        // 打开微信自带的表情面板。真机坑（2026-11-18）：
        // 发完文字键盘还开着时，输入栏被顶到屏幕中间，页面图里 emoji_panel_button 的坐标
        // 点下去落在键盘上（有时还切出系统表情键盘），面板根本不开 —— 后面的
        // act.tap_sticker_mood 只会报「面板没打开」。
        // 所以这里：先收键盘（并确认没把会话页一起退掉）→ 点一次 → 验一次，最多 3 次。
        const screen = this.#deps.graph.device.screen;
        const rect = rectOf(this.#deps.graph, "chat", "emoji_panel_button", screen.w, screen.h);
        const cx = Math.round(rect.x + rect.w / 2);
        const cy = Math.round(rect.y + rect.h / 2);
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const inputShown = async (): Promise<boolean> => {
          try {
            return /mInputShown=true/.test(await this.#deps.device.adb.shell("dumpsys input_method", 20000));
          } catch {
            return false;
          }
        };
        const panelOpen = async (): Promise<boolean> => {
          const bmp = decode((await this.#deps.device.adb.screencap()).png);
          return !looksLikeInputBar(bmp);
        };
        if (await panelOpen()) return { open: true, via: "already" };
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await inputShown()) {
            await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
            await sleep(450);
            const nowPage = await this.#page();
            if (nowPage.page !== "chat") {
              throw new SkillRunError(`收键盘之后不在会话页（${nowPage.page}），没法打开表情面板`);
            }
          }
          await this.#deps.actuator.tapPoint(cx, cy, 60);
          await sleep(650);
          if (await panelOpen()) return { open: true, attempts: attempt + 1, at: { x: cx, y: cy } };
        }
        throw new SkillRunError("点不到表情按钮（键盘收不掉或坐标不对）");
      }

      case "act.tap_sticker_slot": {
        const shot = await this.#deps.device.adb.screencap();
        const bmp = decode(shot.png);
        const scan = (this.#deps.graph.pages["sticker_panel"]?.grid as { scan?: unknown } | undefined)?.scan as
          | import("../perception/cells.ts").PanelGrid
          | undefined;
        if (!scan) throw new SkillRunError("页面图里没有 sticker_panel.grid.scan");
        const cells = findStickerCells(bmp, scan);
        if (cells.length === 0) throw new SkillRunError("面板里没认出贴纸（可能不在收藏页）");
        const want = Number(args["slot"] ?? 1);
        const index = Math.min(cells.length, Math.max(1, Number.isFinite(want) ? Math.round(want) : 1));
        const cell = cells[index - 1]!;
        const cx = cell.rect.x + cell.rect.w / 2;
        const cy = cell.rect.y + cell.rect.h / 2;
        await this.#deps.actuator.tapPoint(cx, cy, 60);
        return { slot: index, total: cells.length, fill: cell.fill, at: { x: Math.round(cx), y: Math.round(cy) } };
      }

      case "act.tap_link_card": {
        // 找卡片：当前屏 → 先回到底部（链接多半是最近发的）→ 再逐步往上翻。
        // 每一屏都先 OCR「标题 + 来源」，认不出来再退回白卡检测；两个都认不出来才滑。
        // 滑到边缘（画面不再变）就停，避免固定翻 5 屏、也避免翻过头丢掉刚看到的内容。
        const nowPage = await this.#page();
        if (nowPage.page !== "chat") throw new SkillRunError(`不在会话页（${nowPage.page}），不敢滚动找卡片`);
        if (!this.#deps.ocr) throw new SkillRunError("没有配置 OCR，无法定位链接卡片");
        const screen = this.#deps.graph.device.screen;
        const area = rectOf(this.#deps.graph, "chat", "message_area", screen.w, screen.h);
        const midX = area.x + area.w / 2;
        const toBottom = () =>
          this.#deps.actuator.swipe({ x: midX, y: area.y + area.h * 0.82 }, { x: midX, y: area.y + area.h * 0.24 }, 260);
        const toTop = () =>
          this.#deps.actuator.swipe({ x: midX, y: area.y + area.h * 0.24 }, { x: midX, y: area.y + area.h * 0.82 }, 260);

        type Probe = { hit: boolean; via?: "ocr" | "pixel"; title?: string; lines: number; cards: number };
        const probe = async (phase: string, n: number): Promise<Probe> => {
          const shot = await this.#deps.device.adb.screencap();
          const bmp = decode(shot.png);
          const ocr = await this.#deps.ocr!.recognize(shot.png, area);
          const rawTitle = findCardTitle(ocr.lines);
          // 绿色气泡里的「大字 + 下面小字」不是卡片（自己的消息常这样）
          const title = rawTitle && bubbleSide(bmp, { text: rawTitle.text, x: rawTitle.x, y: rawTitle.y, w: rawTitle.w, h: rawTitle.h }) === "me" ? null : rawTitle;
          const cards = findLinkCards(bmp, area);
          this.#deps.eventLog?.append(
            "note",
            { op: "tap_link_card", phase, screen: n, lines: ocr.lines.length, title: title?.text ?? null, pixelCards: cards.length },
            { src: "skills.runner" },
          );
          if (title) {
            const cx = title.x + Math.min(title.w, 220) / 2;
            const cy = title.y + title.h / 2;
            await this.#deps.actuator.tapPoint(cx, cy, 60);
            return { hit: true, via: "ocr", title: title.text, lines: ocr.lines.length, cards: cards.length };
          }
          if (cards.length > 0) {
            const card = cards[cards.length - 1]!;
            const cx = card.rect.x + card.rect.w * 0.25;
            const cy = card.rect.y + card.rect.h * 0.3;
            await this.#deps.actuator.tapPoint(cx, cy, 60);
            return { hit: true, via: "pixel", lines: ocr.lines.length, cards: cards.length };
          }
          return { hit: false, lines: ocr.lines.length, cards: cards.length };
        };

        // 滑一屏；返回 false 表示已经到边（画面没动）
        const move = async (dir: "bottom" | "top", prev: Bitmap | null): Promise<{ moved: boolean; now: Bitmap }> => {
          const now = decode((await this.#deps.device.adb.screencap()).png);
          if (prev && regionDiff(prev, now, area, 12).ratio < 0.002) return { moved: false, now };
          if (dir === "bottom") await toBottom();
          else await toTop();
          await new Promise((r) => setTimeout(r, 650));
          return { moved: true, now };
        };

        let r = await probe("now", 0);
        if (r.hit) return { via: r.via, title: r.title ?? null };

        let prev: Bitmap | null = null;
        for (let k = 1; k <= 3; k++) {
          const m = await move("bottom", prev);
          prev = m.now;
          if (!m.moved) break;
          r = await probe("bottom", k);
          if (r.hit) return { via: r.via, title: r.title ?? null };
        }
        // 换方向必须清掉对比基准：否则第一屏「和刚才一样」会被当成到边，永远不会向上翻
        prev = null;
        for (let k = 1; k <= 6; k++) {
          const m = await move("top", prev);
          prev = m.now;
          if (!m.moved) break;
          r = await probe("top", k);
          if (r.hit) return { via: r.via, title: r.title ?? null };
        }
        throw new SkillRunError("把这段聊天从头翻到尾也没找到链接卡片（OCR 与像素都没认出来）");
      }

      case "act.scroll_to_top": {
        // 语义：把这块区域滚回顶部，滚到「再滚也不动」为止（不是固定几次）
        const region = this.#optionalRect(step, args["region"] as string | undefined, "chat.message_area");
        const max = clampInt(args["times"], 6, 1, 12);
        const midX = region.x + region.w / 2;
        let prev: Bitmap | null = null;
        let swipes = 0;
        for (let k = 0; k < max; k++) {
          const now = decode((await this.#deps.device.adb.screencap()).png);
          if (prev && regionDiff(prev, now, region, 12).ratio < 0.002) break;
          prev = now;
          await this.#deps.actuator.swipe(
            { x: midX, y: region.y + region.h * 0.22 },
            { x: midX, y: region.y + region.h * 0.82 },
            240,
          );
          swipes++;
          await new Promise((r) => setTimeout(r, 450));
        }
        this.#deps.eventLog?.append("note", { op: "scroll_to_top", region, swipes }, { src: "skills.runner" });
        return { toTop: swipes };
      }

      case "wait.text_stable": {
        if (!this.#deps.ocr) throw new SkillRunError("没有配置 OCR");
        const region = this.#regionFromArgs(args);
        const checks = Math.max(1, Number(args["checks"] ?? 2));
        const intervalMs = Math.max(100, Number(args["intervalMs"] ?? 600));
        const timeoutMs = Math.max(1000, Number(args["timeoutMs"] ?? 10000));
        const minChars = Math.max(0, Number(args["minChars"] ?? 10));
        const t0 = Date.now();
        let lastLen = -1;
        let same = 0;
        let text = "";
        while (Date.now() - t0 < timeoutMs) {
          const shot = await this.#deps.device.adb.screencap();
          const r = await this.#deps.ocr.recognize(shot.png, region);
          text = r.text;
          if (text.length >= minChars && text.length === lastLen) {
            same++;
            if (same >= checks) return { text, stable: true, ms: Date.now() - t0 };
          } else {
            same = 0;
          }
          lastLen = text.length;
          await new Promise((res) => setTimeout(res, intervalMs));
        }
        throw new SkillRunError(`等文字稳定超时（${timeoutMs}ms），当前 ${text.length} 字`);
      }

      case "act.tap_sticker_mood": {
        if (!this.#deps.stickers) throw new SkillRunError("没有配置表情库（deps.stickers 为空）");
        const mood = String(args["mood"] ?? "").trim();
        const scan = (this.#deps.graph.pages["sticker_panel"]?.grid as { scan?: unknown } | undefined)?.scan as
          | import("../perception/cells.ts").PanelGrid
          | undefined;
        if (!scan) throw new SkillRunError("页面图里没有 sticker_panel.grid.scan");

        const screen = this.#deps.graph.device.screen;
        const gridArea = rectOf(this.#deps.graph, "sticker_panel", "grid_area", screen.w, screen.h);
        const midX = gridArea.x + gridArea.w / 2;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // 面板上认图：不能照搬聊天气泡那套判据。实测（2026-11-19，收藏面板 7 帧 53 格）：
        //   直方图 ≥0.93 的 35 格，但同一张在面板里的 dHash 能漂到 25~40 位 ——
        //   “0.96 / 14 位”严格档一格都认不出来，“0.88 / 30 位”也只认 17 格。
        // 而不同贴纸的直方图只有 0.60~0.76，所以面板这条路以直方图为主，dHash 放宽到 40 位兜底。
        const matchEntry = (piece: Bitmap) => {
          const feat = stickerFeatures(piece);
          return (
            this.#deps.stickers!.findByFeatures(feat.hist, feat.dhash) ??
            this.#deps.stickers!.findByFeatures(feat.hist, feat.dhash, 0.93, 40)
          );
        };
        type StickerCell = ReturnType<typeof findStickerCells>[number];
        type Entry = import("../stickers/library.ts").StickerEntry;
        type Cand = { cell: StickerCell; entry?: Entry };
        /** 一格贴纸是不是就是库里那一张：只跟指定目标比，认错的风险由目标 id 兜住。 */
        const isThatSticker = (piece: Bitmap, target: Entry): boolean => {
          const feat = stickerFeatures(piece);
          const h = cosine(feat.hist, target.hist);
          if (h >= 0.96) return true;
          return h >= 0.93 && hamming(feat.dhash, target.dhash) <= 44;
        };
        const scanNow = async (): Promise<{ cells: Cand[]; bmp: Bitmap }> => {
          const bmp = decode((await this.#deps.device.adb.screencap()).png);
          // 面板没打开时输入栏还在底部（面板打开会把它顶上去）——这时滑屏只会滑聊天记录
          if (looksLikeInputBar(bmp)) throw new SkillRunError("表情面板没打开（键盘还开着/按钮没点中）");
          const used = new Set<string>();
          const out: Cand[] = [];
          for (const cell of findStickerCells(bmp, scan)) {
            const entry = matchEntry(crop(bmp, cell.rect));
            if (!entry || used.has(entry.id)) continue;
            used.add(entry.id);
            out.push({ cell, entry });
          }
          return { cells: out, bmp };
        };
        const stepPx = Math.round(scan.pitchY * screen.h);
        const swipePanel = async (dir: "top" | "down"): Promise<void> => {
          const y0 = Math.round(gridArea.y + gridArea.h * (dir === "down" ? 0.72 : 0.3));
          const y1 = dir === "down" ? y0 - stepPx : y0 + stepPx;
          await this.#deps.actuator.swipe({ x: midX, y: y0 }, { x: midX, y: y1 }, 260);
          await sleep(400);
        };

        // 以前挑图只看当前屏：面板一屏才 7~8 格（grid.scan.maxRows = 2），而收藏里存了
        // 一两百张，翻页又只在「一个候选都没有」时才走 —— 于是永远在发第一屏那几张。
        // 2026-11-19 用户的原话：「你已经存了很多了，只是你不会往下滑表情窗口」。
        //
        // 现在反过来：**先按情绪从整个库里挑目标**（最久没发过的那张），再一屏一屏往下滑
        // 把它找出来；找不到才退回「当前屏里最久没发过的那张」。
        const AVOID_MS = 20 * 60 * 1000;
        const MISS_TTL_MS = 30 * 60 * 1000;
        const MAX_SCREENS = 6;
        type Located = Cand & { entry: Entry; screen: number };
        const pool: Located[] = [];
        let screens = 0;
        const addAll = (list: Cand[], screen: number): void => {
          for (const c of list) {
            if (!c.entry) continue;
            if (!pool.some((p) => p.entry.id === c.entry!.id)) pool.push({ cell: c.cell, entry: c.entry, screen });
          }
        };

        // 面板会记住上次滑到哪儿，先无脑滑回顶部（到顶了再滑就是不动，没副作用）
        for (let i = 0; i < 4; i++) await swipePanel("top");

        const lib = this.#deps.stickers;
        // 上一轮在面板里怎么都找不到的目标，这一轮直接换一个当目标。
        // 不这么做的话：每轮都瞄同一个「库里存在但面板里认不出」的贴纸 → 扫满 6 屏仍找不到
        // → 只能退回最后一屏剩下的那张 → 一晚上反复发同一张（2026-11-19 爬山群）。
        for (const [id, t] of this.#panelMiss) {
          if (Date.now() - t > MISS_TTL_MS) this.#panelMiss.delete(id);
        }
        const wanted = lib.pick(mood, { recentWindow: AVOID_MS, now: Date.now(), exclude: new Set(this.#panelMiss.keys()) });
        let chosen: (Cand & { entry: Entry }) | null = null;
        let found = false;
        let lastScreen: Cand[] = [];
        let screenIdx = 0;

        /** 这一屏里有没有目标那张：先看认出来的格子，再把认不出的格子单独跟目标比。 */
        const huntTarget = (
          shot: { cells: Cand[]; bmp: Bitmap },
          target: Entry,
        ): (Cand & { entry: Entry }) | undefined => {
          const known = shot.cells.find((c) => c.entry?.id === target.id);
          if (known?.entry) return { cell: known.cell, entry: known.entry };
          const knownAt = new Set(shot.cells.map((c) => c.cell.index));
          for (const cell of findStickerCells(shot.bmp, scan)) {
            if (knownAt.has(cell.index)) continue;
            if (isThatSticker(crop(shot.bmp, cell.rect), target)) return { cell, entry: target };
          }
          return undefined;
        };

        for (let s = 0; s < MAX_SCREENS; s++) {
          if (s > 0) await swipePanel("down");
          let shot = await scanNow();
          screens++;
          screenIdx = s;
          addAll(shot.cells, s);
          lastScreen = shot.cells;
          if (s === 0 && shot.cells.length === 0) {
            // 面板可能停在别的 tab（表情 / 搜索）——切到收藏再扫这一屏。
            // 以前是盲点 tab_favorites 的绝对坐标，面板高度一变就点到格子里
            // 直接把一张表情发出去（2026-11-18 真机）。
            const tab = rectOf(this.#deps.graph, "sticker_panel", "tab_favorites", screen.w, screen.h);
            await this.#deps.actuator.tapPoint(Math.round(tab.x + tab.w / 2), Math.round(tab.y + tab.h / 2), 60);
            await sleep(500);
            shot = await scanNow();
            screens++;
            addAll(shot.cells, s);
            lastScreen = shot.cells;
          }
          if (wanted) {
            const hit = huntTarget(shot, wanted);
            if (hit) {
              chosen = hit;
              found = true;
              break;
            }
          }
          // 没有指定目标（库里压根没这个情绪）：第一屏有得挑就收手
          if (!wanted && pool.length > 0) break;
        }

        // 目标没找到：不是「只从最后一屏里挑」，而是从**这一轮扫到的整池**里挑
        // （整池通常有 20~30 条，最后一屏只有两三条，只挑最后一屏等于天天发同那张）。
        // 挑中的如果在前几屏，就滑回那一屏再扫一次确认坐标 —— 滑走的格子坐标不能直接点。
        if (!chosen) {
          const recent = lib.recentlySent(AVOID_MS);
          const distinct = pool.filter((c) => !recent.some((r) => lib.isSamePicture(r, c.entry)));
          const usable = distinct.length > 0 ? distinct : pool;
          const picked = pickSticker(usable, mood, { now: Date.now(), avoidRecentMs: AVOID_MS });
          const cand = picked.chosen as Located | undefined;
          if (cand) {
            if (cand.screen === screenIdx) {
              chosen = { cell: cand.cell, entry: cand.entry };
            } else {
              for (let i = 0; i < 4; i++) await swipePanel("top");
              for (let i = 0; i < cand.screen; i++) await swipePanel("down");
              const shot = await scanNow();
              screens++;
              const hit = huntTarget(shot, cand.entry);
              if (hit) {
                chosen = hit;
                screenIdx = cand.screen;
              }
            }
          }
          if (!chosen) {
            // 连滑回去都没认出来：至少把当前屏能点的给它，别整条技能失败
            const here = lastScreen.filter((c): c is Cand & { entry: Entry } => Boolean(c.entry));
            const p2 = pickSticker(here, mood, { now: Date.now(), avoidRecentMs: AVOID_MS });
            chosen = (p2.chosen as (Cand & { entry: Entry }) | undefined) ?? null;
            found = false;
          }
        }
        // 记下「这个目标在面板里找不到」，下一轮别再瞄它
        if (wanted && !found) this.#panelMiss.set(wanted.id, Date.now());
        if (!chosen) {
          throw new SkillRunError(`面板里没有库里的贴纸（库里 ${this.#deps.stickers.size} 张；收藏可能还没收进来）`);
        }

        // 挑谁、滑了几屏、认出来几张 —— 排查「怎么老是同一张」第一眼看这条
        this.#deps.eventLog?.append(
          "note",
          {
            stage: "sticker-pick",
            mood: mood ?? null,
            id: chosen.entry.id,
            wanted: wanted?.id ?? null,
            found,
            slot: chosen.cell.index,
            pool: pool.length,
            screens,
            repeated: !found,
          },
          { src: "skills.runner" },
        );

        const cx = chosen.cell.rect.x + chosen.cell.rect.w / 2;
        const cy = chosen.cell.rect.y + chosen.cell.rect.h / 2;
        await this.#deps.actuator.tapPoint(cx, cy, 60);
        this.#deps.stickers.markSent(chosen.entry);
        chosen.entry.collectedAt = chosen.entry.collectedAt ?? Date.now();
        this.#deps.stickers.save();

        // 发完必须确认面板真的关了。真机踩过（2026-11-19 15:00）：点完贴纸面板没收，
        // 而 detectPage 把它判成「列表页」，`act.close_panel` 看到 list 就直接返回不按返回 ——
        // 面板就这么一直开着，之后每次 enterChat 都「搜索框里也没点进会话」，引擎卡了十几分钟。
        // 这里不信页面判定，只看两条硬信号：输入栏有没有回到屏幕底部、格子里还有没有东西。
        await sleep(500);
        try {
          const shot = decode((await this.#deps.device.adb.screencap()).png);
          const stillOpen = !looksLikeInputBar(shot) && findStickerCells(shot, scan).length > 0;
          let backs = 0;
          if (stillOpen) {
            backs = 1;
            await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
            await sleep(400);
          }
          this.#deps.eventLog?.append(
            "note",
            { stage: "sticker-close", closed: !stillOpen, backs },
            { src: "skills.runner" },
          );
        } catch {
          // 截图失败就算了，别把「已经发出去了」这一事实搞成失败
        }

        return {
          mood: chosen.entry.mood,
          slot: chosen.cell.index,
          funny: chosen.entry.funny,
          tags: chosen.entry.tags,
        };
      }

      case "act.collect_sticker": {
        if (!this.#deps.stickers || !this.#deps.labeler) throw new SkillRunError("没有配置表情库/打标器");
        const rawThreshold = Number(args["funnyThreshold"]);
        const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 0.7;
        const shot = await this.#deps.device.adb.screencap();
        const bmp = decode(shot.png);
        const screen = this.#deps.graph.device.screen;
        const area = rectOf(this.#deps.graph, "chat", "message_area", screen.w, screen.h);
        const bubbles = findImageBubbles(bmp, area).filter((b) => b.side === "left");
        if (bubbles.length === 0) return { collected: false, reason: "没有对方发的图片/表情" };

        // 从最新的往上试：图片会长按进画廊，表情才会出菜单；最多试 3 个
        const attempts = bubbles.slice(-4).reverse();
        for (const bubble of attempts) {
          const pageNow = await this.#page();
          if (pageNow.page !== "chat") {
            return { collected: false, reason: `脱离了会话页（${pageNow.page}），停止收藏` };
          }
          const piece = crop(bmp, bubble.rect);
          const feat = stickerFeatures(piece);
          // 认「是不是已经有这张」分两档：
          //   严格档（0.96/14 位）用来复用库里的条目（同一张换个帧，不该再建一条）；
          //   放宽档（0.95/22 位）只用来判断「微信里是不是已经收藏过」—— 认成收过就不点「添加」，
          //   于是不会把已经收藏的那张刷回收藏列表最前面（2026-11-19 用户指出）。
          //   放宽档**不**拿来建/改条目：实测它会把「cosplay 合影」和「调侃梗图」认成同一张。
          const strict = this.#deps.stickers.findByFeatures(feat.hist, feat.dhash);
          const loose = strict ?? this.#deps.stickers.findByFeatures(feat.hist, feat.dhash, 0.95, 22);
          if (loose?.collectedAt) continue;

          const label = loose
            ? { mood: loose.mood, tags: loose.tags, funny: loose.funny }
            : await this.#deps.labeler.label(piece);
          // 严格档认出来的就在原条目上刷新特征（换个 id 会凭空多一条重复）
          const entry = this.#deps.stickers.upsert(
            {
              dhash: feat.dhash,
              hist: feat.hist,
              mood: label.mood,
              tags: label.tags ?? [],
              funny: label.funny,
              source: "received",
            },
            strict ? { id: strict.id } : {},
          );
          this.#deps.stickers.save();

          if (entry.funny < threshold) continue; // 不够好玩，试上一张

          await this.#deps.actuator.holdRect(bubble.rect);
          await new Promise((r) => setTimeout(r, 700));
          // 轮询焦点：画廊会稍晚一点拿到焦点；只有停在聊天页才可能是表情菜单
          let inGallery = false;
          for (let i = 0; i < 4; i++) {
            const f = await this.#deps.device.adb.focus();
            if (/gallery/i.test(f.component)) {
              inGallery = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          if (inGallery) {
            // 是图片不是表情：退回聊天，试上一张
            await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
            await new Promise((r) => setTimeout(r, 600));
            this.#deps.eventLog?.append("note", { op: "collect", skipped: "image-not-sticker" }, { src: "skills.runner" });
            continue;
          }
          const menuShot = await this.#deps.device.adb.screencap();
          const menuBmp = decode(menuShot.png);
          const panel = findDarkPanel(menuBmp);
          if (!panel) {
            // 没出菜单：不要按 back（在会话页按 back 会退回列表），直接继续试上一张
            continue;
          }
          // 菜单项用 OCR 认：只有收到的贴纸才有「添加」，自己的贴纸没有。
          // 比按网格猜坐标稳得多（实测菜单面板的 y/高度每张图都不同）。
          if (!this.#deps.ocr) continue;
          const menuArea = { x: panel.rect.x, y: panel.rect.y - 12, w: panel.rect.w, h: Math.min(420, panel.rect.h * 2.4) };
          const menuOcr = await this.#deps.ocr.recognize(menuShot.png, menuArea);
          const addLine = menuOcr.lines.find((l) => /添\s*加/.test(l.text));
          if (!addLine) {
            const texts = menuOcr.lines.map((l) => l.text).join(" / ").slice(0, 80);
            this.#deps.eventLog?.append("note", { op: "collect", menu: texts, skipped: "no-add-item" }, { src: "skills.runner" });
            // ⚠ 绝对不要用坐标点空白收菜单：菜单可能正好铺在上面，点到「删除」就会弹确认框（真机踩过）。
            // 返回键只关浮层、不选中任何项，安全。
            await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }

          // 长按后菜单可能还没稳定/又刷新了：点之前再确认一次「添加」还在，坐标以这一帧为准
          const checkShot = await this.#deps.device.adb.screencap();
          const checkBmp = decode(checkShot.png);
          const panel2 = findDarkPanel(checkBmp);
          if (!panel2) continue;
          const again = await this.#deps.ocr.recognize(checkShot.png, {
            x: panel2.rect.x,
            y: panel2.rect.y - 12,
            w: panel2.rect.w,
            h: Math.min(420, panel2.rect.h * 2.4),
          });
          const addLine2 = again.lines.find((l) => /添\s*加/.test(l.text));
          if (!addLine2) {
            await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          await this.#deps.actuator.tapPoint(addLine2.x + addLine2.w / 2, addLine2.y + addLine2.h / 2, 60);

          // 安全网：万一弹了「确认删除」，只按「取消」，绝不能按删除
          const afterShot = await this.#deps.device.adb.screencap();
          const dialog = await this.#deps.ocr.recognize(afterShot.png, { x: 80, y: 700, w: 920, h: 720 });
          const isDeleteDialog = dialog.lines.some((l) => /确认删除/.test(l.text));
          if (isDeleteDialog) {
            const cancel = dialog.lines.find((l) => /取\s*消/.test(l.text));
            if (cancel) await this.#deps.actuator.tapPoint(cancel.x + cancel.w / 2, cancel.y + cancel.h / 2, 60);
            else await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
            this.#deps.eventLog?.append("note", { op: "collect", incident: "delete-dialog-cancelled" }, { src: "skills.runner" });
            continue;
          }
          await new Promise((r) => setTimeout(r, 400));
          entry.collectedAt = Date.now();
          this.#deps.stickers.save();
          return { collected: true, mood: entry.mood, funny: entry.funny, slot: 0 };
        }
        return { collected: false, reason: "最近的图片都不是值得收藏的表情" };
      }

      case "act.close_panel": {
        const shot = await this.#deps.device.adb.screencap();
        const bmp = decode(shot.png);
        const page = detectPage(bmp, await this.#deps.device.adb.focus());
        if (page.page === "list") {
          this.#deps.eventLog?.append(
            "note",
            { op: "close_panel", page: page.page, note: "已经在列表页，不按返回" },
            { src: "skills.runner" },
          );
          return { closed: false, page: page.page };
        }
        // 用「面板格子还在不在」判断面板开没开：输入栏的白盒判据在动画中间会误判，
        // 一旦误判按了 back 就直接退出会话（真机踩过）。
        const scan = (this.#deps.graph.pages["sticker_panel"]?.grid as { scan?: unknown } | undefined)?.scan as
          | import("../perception/cells.ts").PanelGrid
          | undefined;
        // 两个信号都要：面板开着时输入栏被顶上去（不在底部）、且格子里有东西。
        // 只看格子会误判 —— 会话页的消息区/贴纸也会被当成格子，按了返回就退出会话。
        const inputBar = looksLikeInputBar(bmp);
        const cellCount = scan ? findStickerCells(bmp, scan).length : -1;
        const panelOpen = !inputBar && (scan ? cellCount > 0 : true);
        this.#deps.eventLog?.append(
          "note",
          { op: "close_panel", page: page.page, inputBar, cells: cellCount, panelOpen },
          { src: "skills.runner" },
        );
        if (!panelOpen) return { closed: false, page: page.page };
        await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
        await new Promise((r) => setTimeout(r, 300));
        return { closed: true };
      }

      case "act.paste": {
        const text = String(args["text"] ?? "");
        if (!text) throw new SkillRunError("act.paste 少了 text");
        // 不走「长按输入框→粘贴」的菜单（位置不稳），直接用输入法提交；
        // 同时把内容放进剪贴板，便于人工核对与后续复制。
        await this.#deps.actuator.setClipboard(text);
        await this.#deps.actuator.typeText(text);
        return { pasted: text.length };
      }

      case "act.goto_list": {
        // 面板开着先收面板，再退出会话；最多 4 次返回。前台不是微信就不按（会在桌面乱点）
        const f0 = await this.#deps.device.adb.focus();
        if (f0.pkg !== "com.tencent.mm") return { page: "other", backs: 0 };
        for (let i = 0; i < 4; i++) {
          const frame = await this.#deps.device.adb.screencap();
          const page = detectPage(decode(frame.png), await this.#deps.device.adb.focus());
          if (page.page === "list") return { page: "list", backs: i };
          await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
          await new Promise((r) => setTimeout(r, 400));
        }
        const frame = await this.#deps.device.adb.screencap();
        const page = detectPage(decode(frame.png), await this.#deps.device.adb.focus());
        if (page.page !== "list") throw new SkillRunError(`回不到列表（当前 ${page.page}）`);
        return { page: "list", backs: 4 };
      }

      case "act.back": {
        const f = await this.#deps.device.adb.focus();
        if (f.pkg !== "com.tencent.mm") throw new SkillRunError("前台不是微信，不按返回（会在桌面上乱点）");
        await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
        return { back: true };
      }

      case "act.scroll": {
        const region = this.#optionalRect(step, args["region"] as string | undefined, "chat.message_area");
        const times = Number(args["times"] ?? 1);
        const n = Number.isFinite(times) ? Math.max(0, Math.min(12, Math.round(times))) : 1;
        for (let k = 0; k < n; k++) {
          await this.#deps.actuator.swipe(
            { x: region.x + region.w / 2, y: region.y + region.h * 0.85 },
            { x: region.x + region.w / 2, y: region.y + region.h * 0.2 },
          );
        }
        return { scrolled: n };
      }

      case "wait.stable": {
        const frames = Number(args["frames"] ?? 2);
        const timeoutMs = Number(args["timeoutMs"] ?? 2000);
        const region = this.#staticRegion();
        const result = await waitStable(this.#deps.device.adb, { frames, timeoutMs, region });
        this.#deps.eventLog?.append(
          "note",
          { wait: "stable", ok: result.stable, ratio: round4(result.ratio), ms: result.ms, region: region ?? null },
          { src: "skills.runner" },
        );
        if (!result.stable) throw new SkillRunError(`等稳定帧超时（${timeoutMs}ms，变化 ${round4(result.ratio)}）`);
        return { stable: true, ms: result.ms, ratio: round4(result.ratio) };
      }

      case "wait.element": {
        const what = String(args["what"] ?? "");
        const timeoutMs = Number(args["timeoutMs"] ?? 3000);
        const page = what.split(".")[0] as string;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const guess = await this.#page();
          if (guess.page === page) return { appeared: page, ms: Date.now() - (deadline - timeoutMs) };
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new SkillRunError(`等 ${what} 超时（${timeoutMs}ms），当前页面不是 ${page}`);
      }

      case "check": {
        const kind = String(args["kind"] ?? "");
        // dry-run 只出计划：需要读设备状态的检查跳过并记一笔，不能让它把计划判失败
        if (this.#deps.actuator.dryRun && (kind === "input_contains" || kind === "clipboard_contains")) {
          this.#deps.eventLog?.append("note", { check: kind, skipped: "dry-run" }, { src: "skills.runner" });
          return { skipped: "dry-run", check: kind };
        }
        if (kind === "input_contains") {
          const expect = String(args["value"] ?? "");
          const current = await this.#deps.actuator.readInput();
          const hay = `${current.before}${current.after}`;
          if (!hay.includes(expect)) {
            throw new SkillRunError(`输入框里没有「${expect}」，实际是「${truncate(hay)}」`);
          }
          this.#deps.eventLog?.append("action.verified", { check: kind, expect, ok: true }, { src: "skills.runner" });
          return { inputContains: true };
        }
        if (kind === "message_changed") {
          const tag = String(args["tag"] ?? "before");
          const before = this.#shots.get(tag);
          if (!before) throw new SkillRunError(`没有找到标签为 ${tag} 的截图`);
          const threshold = Number(args["threshold"] ?? 0.01);
          const shot = await this.#deps.device.adb.screencap();
          const after = decode(shot.png);
          const screen = this.#deps.graph.device.screen;
          const area = rectOf(this.#deps.graph, "chat", "message_area", screen.w, screen.h);
          const diff = regionDiff(before, after, area, 12);
          if (diff.ratio < threshold) throw new SkillRunError(`消息区没有变化（${diff.ratio}），可能没发出去`);
          return { changed: diff.ratio, bbox: diff.bbox };
        }

        if (kind === "clipboard_contains") {
          const expect = String(args["value"] ?? "");
          const text = await this.#deps.actuator.readClipboard();
          if (!text.includes(expect)) throw new SkillRunError(`剪贴板里没有「${expect}」`);
          return { clipboardContains: true };
        }
        throw new SkillRunError(`这条检查还不会做：${kind}（不静默通过）`);
      }

      case "record": {
        this.#deps.eventLog?.append("note", { record: args }, { src: "skills.runner" });
        outputs[String(args["kind"] ?? "record")] = args;
        return { recorded: true };
      }

      case "obs.text_bubble": {
        // 长按气泡 → 找深色菜单 → 点第一格（复制）→ 读剪贴板
        const rect = this.#rectOfTarget(step);
        await this.#deps.actuator.holdRect(rect);
        await new Promise((r) => setTimeout(r, 600));
        const shot = await this.#deps.device.adb.screencap();
        const bmp = decode(shot.png);
        const panel = findDarkPanel(bmp);
        if (!panel) throw new SkillRunError("长按后没找到浮层菜单（可能没选中气泡）");
        const copy = panel.cell(0, 0, 5, 2);
        await this.#deps.actuator.tapPoint(copy.x, copy.y, 60);
        await new Promise((r) => setTimeout(r, 300));
        const text = await this.#deps.actuator.readClipboard();
        this.#deps.eventLog?.append("note", { op: "text_bubble", chars: text.length }, { src: "skills.runner" });
        return { text };
      }

      case "obs.clipboard": {
        const text = await this.#deps.actuator.readClipboard();
        return { clipboard: text };
      }

      case "obs.ocr": {
        if (!this.#deps.ocr) throw new SkillRunError("没有配置 OCR（deps.ocr 为空）");
        const shot = await this.#deps.device.adb.screencap();
        const region = this.#regionFromArgs(args);
        const result = await this.#deps.ocr.recognize(shot.png, region);
        this.#deps.eventLog?.append(
          "note",
          { ocr: true, tag: String(args["tag"] ?? "ocr"), lines: result.lines.length, ms: result.ms, region: region ?? null },
          { src: "skills.runner" },
        );
        return { text: result.text, lines: result.lines, ms: result.ms };
      }

      case "branch":
      case "obs.a11y":
      case "act.paste":
        throw new SkillRunError(`操作 ${step.op} 还没实现（不静默跳过）`);

      default:
        throw new SkillRunError(`未知操作 ${String(step.op)}`);
    }
  }

  // ---------------- 小工具 ----------------

  async #page() {
    const frame = await this.#deps.device.adb.screencap();
    const bmp = decode(frame.png);
    const focus = await this.#deps.device.adb.focus();
    return detectPage(bmp, focus);
  }

  async #imeShown(): Promise<boolean> {
    const dump = await this.#deps.device.adb.shell("dumpsys input_method", 20000);
    return /mInputShown=true/.test(dump);
  }

  #rectOfTarget(step: Step): Rect {
    const raw = (step.args ?? {}) as Record<string, unknown>;
    const given = raw["rect"] as Rect | undefined;
    if (given && typeof given.x === "number") return given;
    const target = step.target;
    if (!target) throw new SkillRunError(`${step.op} 需要 target 或 args.rect`);
    const screen = this.#deps.graph.device.screen;
    return rectOf(this.#deps.graph, target.page, target.element, screen.w, screen.h);
  }

  #regionFromArgs(args: Record<string, unknown>): { x: number; y: number; w: number; h: number } | undefined {
    const raw = args["region"];
    if (!raw) return undefined;
    if (typeof raw === "object") return raw as { x: number; y: number; w: number; h: number };
    const [page, element] = String(raw).split(".");
    if (!page || !element) throw new SkillRunError("region 应为 page.element，收到 " + String(raw));
    const screen = this.#deps.graph.device.screen;
    return rectOf(this.#deps.graph, page, element, screen.w, screen.h);
  }

  #optionalRect(step: Step, regionName: string | undefined, fallback: string): Rect {
    const screen = this.#deps.graph.device.screen;
    if (regionName) {
      const [page, element] = regionName.split(".");
      if (page && element) return rectOf(this.#deps.graph, page, element, screen.w, screen.h);
    }
    if (step.target) return rectOf(this.#deps.graph, step.target.page, step.target.element, screen.w, screen.h);
    const [page, element] = fallback.split(".");
    return rectOf(this.#deps.graph, page!, element!, screen.w, screen.h);
  }

  /** 当前页面的静区（用于等稳定帧）；没有定义就返回 undefined（整帧，谨慎使用）。 */
  #staticRegion(): Rect | undefined {
    const screen = this.#deps.graph.device.screen;
    // 聊天页的静区取标题栏 + 输入栏之外的上下两条带以外的位置没意义，
    // 这里用「标题栏」——它不该动，动了说明页面在切。
    const page = this.#deps.graph.pages["chat"];
    const header = page?.elements?.["header"];
    if (!header) return undefined;
    return {
      x: Math.round(header.x * screen.w),
      y: Math.round(header.y * screen.h),
      w: Math.round(header.w * screen.w),
      h: Math.round(header.h * screen.h),
    };
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function truncate(s: string): string {
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

/** 参数是脏的（undefined/NaN/字符串）也不能让循环失控。 */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}