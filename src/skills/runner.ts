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
import { crop, decode, type Rect } from "../image/image.ts";
import { detectPage, rectOf, type PageGraph } from "../perception/page.ts";
import { waitStable } from "../perception/stable.ts";
import { findDarkPanel, isMenuPanel } from "../perception/panel.ts";
import { findStickerCells, type PanelGrid } from "../perception/cells.ts";
import { findImageBubbles } from "../perception/bubbles.ts";
import { stickerFeatures } from "../image/image.ts";
import { findLinkCards } from "../perception/cards.ts";
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
        // 消息区里不一定有卡片：可能在上面的聊天记录里，最多往上翻 4 屏找
        const screen = this.#deps.graph.device.screen;
        const area = rectOf(this.#deps.graph, "chat", "message_area", screen.w, screen.h);
        let cards = findLinkCards(decode((await this.#deps.device.adb.screencap()).png), area);
        for (let i = 0; i < 4 && cards.length === 0; i++) {
          await this.#deps.actuator.swipe(
            { x: area.x + area.w / 2, y: area.y + area.h * 0.3 },
            { x: area.x + area.w / 2, y: area.y + area.h * 0.8 },
            260,
          );
          await new Promise((r) => setTimeout(r, 600));
          cards = findLinkCards(decode((await this.#deps.device.adb.screencap()).png), area);
        }
        if (cards.length === 0) throw new SkillRunError("往上翻了 4 屏也没找到链接卡片");
        const raw = args["index"];
        const want = typeof raw === "number" ? raw : cards.length;
        const index = Math.min(cards.length, Math.max(1, Math.round(want)));
        const card = cards[index - 1]!;
        const cx = card.rect.x + card.rect.w * 0.4;
        const cy = card.rect.y + card.rect.h * 0.35;
        await this.#deps.actuator.tapPoint(cx, cy, 60);
        return { cards: cards.length, index, rect: card.rect };
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
        const shot = await this.#deps.device.adb.screencap();
        const bmp = decode(shot.png);
        const scan = (this.#deps.graph.pages["sticker_panel"]?.grid as { scan?: unknown } | undefined)?.scan as
          | import("../perception/cells.ts").PanelGrid
          | undefined;
        if (!scan) throw new SkillRunError("页面图里没有 sticker_panel.grid.scan");
        const cells = findStickerCells(bmp, scan);
        if (cells.length === 0) throw new SkillRunError("面板里没认出贴纸");

        // 把屏幕上每一格和库里的条目对上，挑情绪匹配、最好玩的那张
        const matches = cells
          .map((cell) => {
            const piece = crop(bmp, cell.rect);
            const feat = stickerFeatures(piece);
            const entry = this.#deps.stickers!.findByFeatures(feat.hist, feat.dhash);
            return entry ? { cell, entry } : null;
          })
          .filter((x): x is { cell: (typeof cells)[number]; entry: import("../stickers/library.ts").StickerEntry } => x !== null);

        const pool = mood ? matches.filter((m) => m.entry.mood === mood || m.entry.tags.includes(mood)) : matches;
        const chosen = (pool.length > 0 ? pool : matches).sort((a, b) => b.entry.funny - a.entry.funny)[0];
        if (!chosen) throw new SkillRunError(`面板里没有库里的贴纸（认出了 ${cells.length} 格，库里 ${this.#deps.stickers.size} 张）`);

        const cx = chosen.cell.rect.x + chosen.cell.rect.w / 2;
        const cy = chosen.cell.rect.y + chosen.cell.rect.h / 2;
        await this.#deps.actuator.tapPoint(cx, cy, 60);
        this.#deps.stickers.markSent(chosen.entry);
        this.#deps.stickers.save();
        return { mood: chosen.entry.mood, slot: chosen.cell.index, funny: chosen.entry.funny, tags: chosen.entry.tags };
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
          const known = this.#deps.stickers.findByFeatures(feat.hist, feat.dhash);
          if (known?.collectedAt) return { collected: false, reason: `已经收藏过（${known.mood}）` };

          const label = known
            ? { mood: known.mood, tags: known.tags, funny: known.funny }
            : await this.#deps.labeler.label(piece);
          const entry = this.#deps.stickers.upsert({
            dhash: feat.dhash,
            hist: feat.hist,
            mood: label.mood,
            tags: label.tags ?? [],
            funny: label.funny,
            source: "received",
          });
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
          if (!panel || !isMenuPanel(menuBmp, panel.rect)) {
            // 没出菜单：不要按 back（在会话页按 back 会退回列表），直接继续试上一张
            continue;
          }
          const addPoint = panel.cell(0, 0, 5, 2);
          await this.#deps.actuator.tapPoint(addPoint.x, addPoint.y, 60);
          entry.collectedAt = Date.now();
          this.#deps.stickers.save();
          return { collected: true, mood: entry.mood, funny: entry.funny, slot: 0 };
        }
        return { collected: false, reason: "最近的图片都不是值得收藏的表情" };
      }

      case "act.close_panel": {
        const shot = await this.#deps.device.adb.screencap();
        const bmp = decode(shot.png);
        // 只在「会话页且输入栏被顶上去」时才 back；在列表页按 back 会退出微信
        const page = detectPage(bmp, await this.#deps.device.adb.focus());
        // 列表页绝不 back（会退微信）；面板开着时页面会是 unknown，这时 back 是安全的
        if (page.page === "list") return { closed: false, page: page.page };
        if (looksLikeInputBar(bmp)) return { closed: false };
        await this.#deps.device.adb.shell("input keyevent KEYCODE_BACK", 15000);
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

      case "act.back": {
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