/**
 * 「进会话」这一步，只有一件事：**进错了就别发**。
 *
 * 为什么单独成模块：这是唯一一处「点错一行 = 把话说到别人群里」的地方。
 * 旧插件和上一版引擎都栽在这里 —— 扫列表拿到行 y，截图到点击之间列表会重排，
 * 点下去就进到隔壁会话；只看「页面是不是 chat」发现不了（别的群也是 chat）。
 * 所以这里的规矩是：
 *   1. 点完必须核对标题；
 *   2. 标题认不出来 = 失败（宁可这一次不发，也不能发错地方）；
 *   3. 对不上就退回列表重扫重点，最多 attempts 次，仍不对就放弃并说明原因。
 */

import type { AdbPort, Focus, InjectorPort } from "../device/types.ts";
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
  log?: (message: string) => void;
}

export interface EnterChatResult {
  ok: boolean;
  /** 失败原因（人话，能直接回给模型） */
  reason?: string;
  /** 试了几次 */
  attempts: number;
  /** 最后一次看到的标题（排查用） */
  title?: string;
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

/** 进会话并核对标题。错了就退回来重试，认不出标题也算失败。 */
export async function enterChat(
  deps: NavDeps,
  name: string,
  opts: { attempts?: number; tapX?: number } = {},
): Promise<EnterChatResult> {
  const want = name.replace(/\s+/g, "");
  const maxAttempts = opts.attempts ?? 3;
  const screen = deps.graph.device.screen;
  const tapX = opts.tapX ?? Math.round(screen.w * 0.3);
  const listArea = rectOf(deps.graph, "list", "list_area", screen.w, screen.h);
  const titleArea = rectOf(deps.graph, "chat", "title_strip", screen.w, screen.h);

  let lastReason = "进不去会话";
  let lastTitle: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1) 先回到列表（当前在聊天页/文章页/浮层都退回去）
    for (let i = 0; i < 4; i++) {
      if ((await currentPage(deps)) === "list") break;
      await deps.adb.shell("input keyevent KEYCODE_BACK", 15000);
      await sleep(400);
    }

    // 2) 扫列表找这一行（名字模糊匹配）
    const shot = await deps.adb.screencap();
    const listOcr = await deps.ocr.recognize(shot.png, listArea);
    const line = listOcr.lines.find((l) => isNameLine(l) && cleanName(l.text).includes(want));
    if (!line) {
      const seen = listOcr.lines
        .filter(isNameLine)
        .map((l) => cleanName(l.text))
        .slice(0, 8)
        .join(" / ");
      return { ok: false, reason: `列表里没找到「${name}」（OCR 到：${seen || "无"}）`, attempts: attempt };
    }

    // 3) 点进去，等 chat 页
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

    // 4) 核对标题。等过渡动画落定；读两次，第一次可能被加载态干扰
    await sleep(350);
    let title = "";
    for (let k = 0; k < 2 && !title; k++) {
      const chatShot = await deps.adb.screencap();
      title = titleFromOcr((await deps.ocr.recognize(chatShot.png, titleArea)).lines);
      if (!title) await sleep(250);
    }
    lastTitle = title || lastTitle;

    if (!title) {
      // 读不出标题就不敢发 —— 这是「不点错」的底线
      lastReason = "进了会话但认不出标题（不敢发，怕发错地方）";
      await backToList(deps);
      continue;
    }
    if (titleMatches(name, title)) {
      return { ok: true, attempts: attempt, title };
    }

    lastReason = `进错会话：想进「${name}」，实际「${title}」`;
    deps.log?.(`[enterChat] ${lastReason}（第 ${attempt}/${maxAttempts} 次）`);
    await backToList(deps);
    await sleep(300);
  }

  return { ok: false, reason: `${lastReason}（已重试 ${maxAttempts} 次）`, attempts: maxAttempts, title: lastTitle };
}