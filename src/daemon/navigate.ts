/**
 * 「进会话」这一步，只有一件事：**进错了就别发**。
 *
 * 为什么单独成模块：这是唯一一处「点错一行 = 把话说到别人群里」的地方。
 * 旧插件和上一版引擎都栽在这里 —— 扫列表拿到行 y，截图到点击之间列表会重排，
 * 点下去就进到隔壁会话；只看「页面是不是 chat」发现不了（别的群也是 chat）。
 *
 * 规矩：
 *   1. 点完必须核对标题；
 *   2. 对不上就退回来重扫重点（最多 attempts 次）——不放弃；
 *   3. 列表一直点不准，就**走搜索框**把名字打进去、点搜出来的那一条（再核对标题）；
 *   4. 只有「列表 + 搜索」都确认不了才失败 —— 那种情况仍然不发，但要把原因说清楚。
 */

import type { AdbPort, Focus, InjectorPort, ImePort } from "../device/types.ts";
import { decode } from "../image/image.ts";
import { detectPage, rectOf, type PageGraph } from "../perception/page.ts";
import type { Ocr } from "../perception/ocr.ts";
import { cleanName, isNameLine } from "../monitor/scan.ts";
import { titleFromOcr, titleMatches } from "../monitor/chat.ts";

export interface NavDeps {
  adb: Pick<AdbPort, "screencap" | "focus" | "shell">;
  injector: Pick<InjectorPort, "tap">;
  ocr: Ocr;
  graph: PageGraph;
  /** 搜索框那条路要打字（走 ADBKeyboard 广播） */
  ime?: Pick<ImePort, "type">;
  /** 打字前后切/还输入法（daemon 里的 withAutomationIme） */
  withIme?: <T>(fn: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
}

export interface EnterChatResult {
  ok: boolean;
  /** 失败原因（人话，能直接回给模型） */
  reason?: string;
  /** 试了几次（列表重试 + 搜索兜底） */
  attempts: number;
  /** 最后一次看到的标题（排查用） */
  title?: string;
  /** 最后是怎么进去的 */
  via?: "list" | "search";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function currentPage(deps: NavDeps): Promise<string> {
  const frame = await deps.adb.screencap();
  const focus: Focus = await deps.adb.focus();
  return detectPage(decode(frame.png), focus).page;
}

async function backToList(deps: NavDeps): Promise<void> {
  if ((await currentPage(deps)) === "chat") {
    await deps.adb.shell("input keyevent KEYCODE_BACK", 15000);
    await sleep(350);
  }
}

/** 读当前会话页的标题（读两次，第一次可能被加载态干扰）。 */
async function readTitle(
  deps: NavDeps,
  titleArea: { x: number; y: number; w: number; h: number },
): Promise<string> {
  let title = "";
  for (let k = 0; k < 2 && !title; k++) {
    const shot = await deps.adb.screencap();
    title = titleFromOcr((await deps.ocr.recognize(shot.png, titleArea)).lines);
    if (!title) await sleep(250);
  }
  return title;
}

/**
 * 搜索框兜底：列表里点不准时，去搜索框把名字打进去，点搜出来的那一条。
 * 只负责「搜 → 点进一个 chat 页」，标题核对仍由 enterChat 做。
 */
export async function searchChat(deps: NavDeps, name: string): Promise<boolean> {
  if (!deps.ime || !deps.withIme) return false;
  const screen = deps.graph.device.screen;

  // 回到列表
  for (let i = 0; i < 4; i++) {
    if ((await currentPage(deps)) === "list") break;
    await deps.adb.shell("input keyevent KEYCODE_BACK", 15000);
    await sleep(400);
  }
  const icon = rectOf(deps.graph, "list", "search_icon", screen.w, screen.h);
  await deps.injector.tap(icon.x + icon.w / 2, icon.y + icon.h / 2, 70);

  // 等搜索页（活动名 FTSMainUI）
  let onSearch = false;
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    if ((await currentPage(deps)) === "search") {
      onSearch = true;
      break;
    }
  }
  if (!onSearch) {
    deps.log?.("[searchChat] 点了搜索图标但没进搜索页");
    return false;
  }

  // 打字（切到自动化输入法 → 广播 → 还回去）
  try {
    await deps.withIme(async () => deps.ime!.type(name));
  } catch (err) {
    deps.log?.(`[searchChat] 搜索框输入失败：${(err as Error).message}`);
  }
  await sleep(1600);

  // 在结果里找名字那一行（先精确、再包含）
  const shot = await deps.adb.screencap();
  const area = { x: 0, y: Math.round(screen.h * 0.1), w: screen.w, h: Math.round(screen.h * 0.78) };
  const want = name.replace(/\s+/g, "");
  const lines = (await deps.ocr.recognize(shot.png, area)).lines;
  const hit =
    lines.find((l) => isNameLine(l) && cleanName(l.text).replace(/\s+/g, "") === want) ??
    lines.find((l) => isNameLine(l) && cleanName(l.text).includes(want)) ??
    lines.find((l) => l.text.replace(/\s+/g, "").includes(want));
  if (!hit) {
    deps.log?.(`[searchChat] 搜出来没有「${name}」`);
    return false;
  }

  await deps.injector.tap(Math.round(screen.w * 0.3), Math.round(hit.y + hit.h / 2), 70);
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if ((await currentPage(deps)) === "chat") return true;
  }
  return false;
}

/** 进会话并核对标题。点错就退回来重试；重试还错就走搜索框；都不行才放弃。 */
export async function enterChat(
  deps: NavDeps,
  name: string,
  opts: { attempts?: number; tapX?: number; search?: boolean } = {},
): Promise<EnterChatResult> {
  const want = name.replace(/\s+/g, "");
  const maxAttempts = opts.attempts ?? 3;
  const useSearch = opts.search !== false && Boolean(deps.ime && deps.withIme);
  const screen = deps.graph.device.screen;
  const tapX = opts.tapX ?? Math.round(screen.w * 0.3);
  const listArea = rectOf(deps.graph, "list", "list_area", screen.w, screen.h);
  const titleArea = rectOf(deps.graph, "chat", "title_strip", screen.w, screen.h);

  let lastReason = "进不去会话";
  let lastTitle: string | undefined;
  let used = 0;

  // 1) 列表里点，最多 attempts 次
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    used = attempt;
    // 先回到列表（当前在聊天页/文章页/浮层都退回去）
    for (let i = 0; i < 4; i++) {
      if ((await currentPage(deps)) === "list") break;
      await deps.adb.shell("input keyevent KEYCODE_BACK", 15000);
      await sleep(400);
    }

    // 扫列表找这一行（名字模糊匹配）
    const shot = await deps.adb.screencap();
    const listOcr = await deps.ocr.recognize(shot.png, listArea);
    const line = listOcr.lines.find((l) => isNameLine(l) && cleanName(l.text).includes(want));
    if (!line) {
      const seen = listOcr.lines
        .filter(isNameLine)
        .map((l) => cleanName(l.text))
        .slice(0, 8)
        .join(" / ");
      lastReason = `列表里没找到「${name}」（OCR 到：${seen || "无"}）`;
      break; // 名字都没看见，重试也白搭 → 交给搜索框
    }

    // 点进去，等 chat 页
    await deps.injector.tap(tapX, Math.round(line.y + line.h / 2), 70);
    let entered = false;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      if ((await currentPage(deps)) === "chat") {
        entered = true;
        break;
      }
    }
    if (!entered) {
      lastReason = "点了会话行但没进到聊天页";
      continue;
    }

    // 核对标题
    await sleep(350);
    const title = await readTitle(deps, titleArea);
    lastTitle = title || lastTitle;

    if (!title) {
      // 认不出标题：不猜，退回来再点一次（下一轮或搜索）
      lastReason = "进了会话但认不出标题";
      await backToList(deps);
      continue;
    }
    if (titleMatches(name, title)) {
      return { ok: true, attempts: attempt, title, via: "list" };
    }

    lastReason = `进错会话：想进「${name}」，实际「${title}」`;
    deps.log?.(`[enterChat] ${lastReason}（第 ${attempt}/${maxAttempts} 次）`);
    await backToList(deps);
    await sleep(300);
  }

  // 2) 列表点不准 → 搜索框兜底（点错了就重来，别一错就放弃）
  if (useSearch) {
    for (let s = 0; s < 2; s++) {
      deps.log?.(`[enterChat] 列表点不准，改用搜索框找「${name}」（第 ${s + 1} 次）`);
      const clicked = await searchChat(deps, name);
      if (!clicked) {
        lastReason = "搜索框里也没点进会话";
        await backToList(deps);
        continue;
      }
      await sleep(350);
      const title = await readTitle(deps, titleArea);
      lastTitle = title || lastTitle;
      if (title && titleMatches(name, title)) {
        return { ok: true, attempts: used + s + 1, title, via: "search" };
      }
      lastReason = title
        ? `搜索后进错会话：想进「${name}」，实际「${title}」`
        : "搜索后仍认不出标题";
      await backToList(deps);
    }
  }

  return {
    ok: false,
    reason: `${lastReason}（列表重试 ${maxAttempts} 次${useSearch ? " + 搜索兜底" : ""}）`,
    attempts: used || maxAttempts,
    title: lastTitle,
  };
}