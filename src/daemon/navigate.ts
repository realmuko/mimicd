/**
 * 「进会话」这一步，只有一件事：**进错了就别发**。
 *
 * 为什么单独成模块：这是唯一一处「点错一行 = 把话说到别人群里」的地方。
 * 旧插件和上一版引擎都栽在这里 —— 扫列表拿到行 y，截图到点击之间列表会重排，
 * 点下去就进到隔壁会话；只看「页面是不是 chat」发现不了（别的群也是 chat）。
 *
 * 规矩：
 *   1. 点完必须核对标题；
 *   2. 列表只赌**一次**：对不上就立刻转搜索（旧插件 poller 的真机结论是「搜索优先」，
 *      因为列表在「截图→点击」的间隔里会重排，盲点第二、第三次的成功率约等于 0，
 *      只是每多赌一次就多烧一屏一 OCR）；
 *   3. 搜索框里打名字、点搜出来的那一条（再核对标题）；
 *   4. 只有「列表 + 搜索」都确认不了才失败 —— 那种情况仍然不发，但要把原因说清楚。
 */

import type { AdbPort, Focus, InjectorPort, ImePort } from "../device/types.ts";
import { decode, type Bitmap, type Rect } from "../image/image.ts";
import { detectPage, hasElement, rectOf, type PageGraph } from "../perception/page.ts";
import type { Ocr } from "../perception/ocr.ts";
import { cleanName, isNameLine } from "../monitor/scan.ts";
import { normalizeTitle, titleFromOcr, titleMatches } from "../monitor/chat.ts";

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
  /**
   * 一共试了几次 = 列表点行次数 + 搜索次数（**如实相加**，不是「最多几次」）。
   * 有搜索能力时列表只点一次（见 enterChat），所以正常是 1（列表）或 2（列表+搜索）。
   */
  attempts: number;
  /** 最后一次看到的标题（排查用） */
  title?: string;
  /** 最后是怎么进去的：list = 点行成功，search = 搜索框成功 */
  via?: "list" | "search";
}

const WECHAT_PKG = "com.tencent.mm";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 只读 PNG 的 IHDR 拿宽高，不解整张图。
 *
 * `findMentionTag(png, ocr)` 要按比例裁顶部区域，需要宽高；为了这个去 decode 一次
 * 就等于把 T3 想省掉的那次解码又加回来了（1080×2160 一次 20~30ms）。
 */
function pngSize(png: Buffer): { w: number; h: number } | null {
  if (png.length < 24) return null;
  // PNG 签名 + "IHDR"，宽高在字节 16..24（大端）
  if (png.readUInt32BE(0) !== 0x89504e47 || png.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** 有位图就用位图（Adb.screencap 已经解好），没有才自己解。 */
function bmpOf(frame: { png: Buffer; bmp?: Bitmap }): Bitmap {
  return frame.bmp ?? decode(frame.png);
}

/**
 * 截一帧**这一次**的画面，供「点完等页面切过去 / 读标题」这类轮询用。
 *
 * Adb 可能开着截图复用窗口（AdbOptions.captureReuseMs，T3 用来砍连拍）。
 * 这里每隔 300ms 就要看一次「页面变了没有」，复用窗口会把上一次的画面再交回来，
 * 于是「点完没反应」会一直看到旧帧 —— 所以每次轮询前先把它作废。
 */
async function freshShot(adb: Pick<AdbPort, "screencap">) {
  (adb as { invalidateFrame?: () => void }).invalidateFrame?.();
  return adb.screencap();
}

/**
 * 确认前台是微信。不是就先拉起来；拉不起来就**什么都不点**（否则会在手机桌面上乱点到别的 App）。
 * 这是「桌面右上角电子邮件被点开」的根因：手机被之前的返回键退出到桌面后，
 * 还按列表坐标去点搜索/会话行。
 */
async function ensureWeChat(deps: NavDeps): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const f = await deps.adb.focus();
    if (f.pkg === WECHAT_PKG) return true;
    deps.log?.(`[nav] 前台不是微信（${f.pkg || "未知"}），尝试拉起`);
    await deps.adb.shell("am start -n com.tencent.mm/.ui.LauncherUI", 15000).catch(() => "");
    await sleep(1200);
  }
  const f = await deps.adb.focus();
  return f.pkg === WECHAT_PKG;
}

async function currentPage(deps: NavDeps): Promise<string> {
  const frame = await freshShot(deps.adb);
  const focus: Focus = await deps.adb.focus();
  return detectPage(bmpOf(frame), focus).page;
}

async function backToList(deps: NavDeps): Promise<void> {
  const f = await deps.adb.focus();
  if (f.pkg !== WECHAT_PKG) return; // 已经在桌面/别的 App，按返回只会更乱
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
    const shot = await freshShot(deps.adb);
    title = titleFromOcr((await deps.ocr.recognize(shot.png, titleArea)).lines);
    if (!title) await sleep(250);
  }
  return title;
}

/**
 * 搜索框兜底：列表里点不准时，去搜索框把名字打进去，点搜出来的那一条。
 * 只负责「搜 → 点进一个 chat 页」，标题核对仍由 enterChat 做。
 *
 * 旧插件 core.openChat 的两个真机教训（都已照抄）：
 *  1. **进搜索页先清空输入框**：微信搜索框会保留上一次的查询，不清就拼成
 *     「摸鱼闲聊群文件传输助手」这种垃圾串，第一条结果变成「搜一搜」，
 *     点进去是 webview 页；轮询下一轮又判「不在目标聊天」→ 每 60 秒重来一次，
 *     屏幕上就是反复「切出去→搜索→点进去」。（旧插件连按 25 次退格，
 *     而且压进同一条 shell：25 次 adb 往返 ≈ 12 秒，一条 ≈ 0.3 秒。）
 *  2. **结果里优先精确匹配**：搜索是模糊的，「阿鲤」会先搜出「钓鱼群」，精确那一行往往在后面。
 */
export async function searchChat(deps: NavDeps, name: string): Promise<boolean> {
  if (!deps.ime || !deps.withIme) return false;
  if (!(await ensureWeChat(deps))) return false;
  const screen = deps.graph.device.screen;

  // 回到列表（只在微信里按返回）
  for (let i = 0; i < 4; i++) {
    const f = await deps.adb.focus();
    if (f.pkg !== WECHAT_PKG) return false;
    if ((await currentPage(deps)) === "list") break;
    await deps.adb.shell("input keyevent KEYCODE_BACK", 15000);
    await sleep(400);
  }
  if ((await currentPage(deps)) !== "list") return false;
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

  // 点一下搜索框再清空：旧插件每次都会先点搜索框（有些 ROM 上搜索页不会自动聚焦，
  // 不点就敲键，退格和输入全落到空处，结果框里还是上一次的查询）。
  const field = hasElement(deps.graph, "search", "search_field")
    ? rectOf(deps.graph, "search", "search_field", screen.w, screen.h)
    : { x: Math.round(screen.w * 0.2), y: Math.round(screen.h * 0.055), w: Math.round(screen.w * 0.62), h: Math.round(screen.h * 0.04) };
  await deps.injector.tap(field.x + field.w / 2, field.y + field.h / 2, 70);
  await sleep(350);

  // 清空输入框：一条 shell 里连按 25 次退格（keyevent 67 = DEL）
  try {
    await deps.adb.shell("for i in $(seq 1 25); do input keyevent 67; done", 20000);
  } catch (err) {
    deps.log?.(`[searchChat] 清空搜索框失败（继续试）：${(err as Error).message}`);
  }
  await sleep(200);

  // 打字（切到自动化输入法 → 广播 → 还回去）
  try {
    await deps.withIme(async () => deps.ime!.type(name));
  } catch (err) {
    deps.log?.(`[searchChat] 搜索框输入失败：${(err as Error).message}`);
  }
  await sleep(1600);

  // 在结果里找名字那一行：精确（归一化后相等）→ 干净的相等 → 包含 → 原始包含
  const shot = await freshShot(deps.adb);
  const area = hasElement(deps.graph, "search", "results_area")
    ? rectOf(deps.graph, "search", "results_area", screen.w, screen.h)
    : { x: 0, y: Math.round(screen.h * 0.1), w: screen.w, h: Math.round(screen.h * 0.78) };
  const want = name.replace(/\s+/g, "");
  const wantTitle = normalizeTitle(name);
  const lines = (await deps.ocr.recognize(shot.png, area)).lines;
  const hit =
    lines.find((l) => isNameLine(l) && normalizeTitle(l.text) === wantTitle) ??
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

/** 进会话并核对标题。点错一次就转搜索；搜索也不行才放弃。 */
export async function enterChat(
  deps: NavDeps,
  name: string,
  opts: { attempts?: number; tapX?: number; search?: boolean } = {},
): Promise<EnterChatResult> {
  if (!(await ensureWeChat(deps))) {
    return { ok: false, reason: "前台不是微信（拉不起来），没有点任何东西", attempts: 0 };
  }
  const want = name.replace(/\s+/g, "");
  const maxAttempts = opts.attempts ?? 3;
  const useSearch = opts.search !== false && Boolean(deps.ime && deps.withIme);
  // 点行只赌一次：
  //  - 旧插件证明列表在「截图→点击」的间隔里会重排，盲点第二、三次基本是白送；
  //  - 新引擎点行前 OCR 已经到手、窗口只有百毫秒级，所以还可以先试一次点行（比搜索快一屏）；
  //  - 但只要这一下没进对，就别再赌第二次 —— 直接转搜索（位置无关，旧插件的正解）。
  // 没有搜索能力（没配输入法）时才退回「点行重试 maxAttempts 次」。
  const listBudget = useSearch ? 1 : maxAttempts;
  const screen = deps.graph.device.screen;
  const tapX = opts.tapX ?? Math.round(screen.w * 0.3);
  const listArea = rectOf(deps.graph, "list", "list_area", screen.w, screen.h);
  const titleArea = rectOf(deps.graph, "chat", "title_strip", screen.w, screen.h);

  let lastReason = "进不去会话";
  let lastTitle: string | undefined;
  /** 列表点了几次（如实回报给调用方，别把搜索次数混进来） */
  let listTries = 0;
  /** 搜索走了几次 */
  let searchTries = 0;

  // 1) 列表里点，最多 listBudget 次
  for (let attempt = 1; attempt <= listBudget; attempt++) {
    listTries = attempt;
    // 先回到列表（当前在聊天页/文章页/浮层都退回去；桌面/别的 App 不按返回）
    for (let i = 0; i < 4; i++) {
      const f = await deps.adb.focus();
      if (f.pkg !== WECHAT_PKG) {
        if (!(await ensureWeChat(deps))) {
          return { ok: false, reason: "中途离开了微信（拉不回来），没有点任何东西", attempts: listTries };
        }
      }
      if ((await currentPage(deps)) === "list") break;
      await deps.adb.shell("input keyevent KEYCODE_BACK", 15000);
      await sleep(400);
    }
    if ((await currentPage(deps)) !== "list") {
      return { ok: false, reason: `不在微信列表（${await currentPage(deps)}），没有点任何东西`, attempts: listTries };
    }

    // 扫列表找这一行（名字模糊匹配）
    const shot = await freshShot(deps.adb);
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

    // 点进去，等 chat 页。
    // tap 的 y 口径与 monitor/scan 的 ListRow.y 一致：都是「这一行的垂直中心」，
    // 不能用 OCR 行的上沿或红点中心（红点在头像右上角，比行中心高 ~40px，一重排就点到上一行）。
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
      continue; // 只有 listBudget=1 才会走到这（有搜索时立刻转搜索；没有搜索才继续重试）
    }

    // 核对标题
    await sleep(350);
    const title = await readTitle(deps, titleArea);
    lastTitle = title || lastTitle;

    if (!title) {
      // 认不出标题：不猜，退回来（下一轮或搜索）
      lastReason = "进了会话但认不出标题";
      await backToList(deps);
      continue;
    }
    if (titleMatches(name, title)) {
      return { ok: true, attempts: listTries, title, via: "list" };
    }

    lastReason = `进错会话：想进「${name}」，实际「${title}」`;
    deps.log?.(`[enterChat] ${lastReason}（列表第 ${attempt}/${listBudget} 次，转搜索）`);
    await backToList(deps);
    await sleep(300);
  }

  // 2) 列表点不准 → 搜索框兜底（点错了就重来，别一错就放弃）
  if (useSearch) {
    for (let s = 0; s < 2; s++) {
      searchTries++;
      deps.log?.(`[enterChat] 列表没点准，改用搜索框找「${name}」（第 ${searchTries} 次）`);
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
        return { ok: true, attempts: listTries + searchTries, title, via: "search" };
      }
      lastReason = title
        ? `搜索后进错会话：想进「${name}」，实际「${title}」`
        : "搜索后仍认不出标题";
      await backToList(deps);
    }
  }

  return {
    ok: false,
    reason: `${lastReason}（列表点了 ${listTries} 次${useSearch ? ` + 搜索 ${searchTries} 次` : ""}）`,
    attempts: listTries + searchTries,
    title: lastTitle,
  };
}
// ---------------------------------------------------------------------------
// 进会话之后的两件事：滑到底（带未读进来时微信停在第一条未读）、定位「有人@我」提示条。
// 调用点由 Lead 接进 autochat（这里只提供函数 + 注释，不碰 autochat.ts）。
// ---------------------------------------------------------------------------

export interface ScrollToBottomOptions {
  /** 屏幕尺寸（滑动的起止点按比例算；默认 1080×2160） */
  screen?: { w: number; h: number };
  /** 两屏之间的间隔。旧插件 poller.js:916-923 是 320ms：太快会被系统并成一次长滑 */
  gapMs?: number;
  /** 最后一屏之后等多久（旧插件 200ms） */
  settleMs?: number;
}

/**
 * 往**上**滑，把会话滑到最底部（最新消息）。
 *
 * 旧插件 poller.js:916-923 的真机经验：带未读进会话时，微信停在「第一条未读」，
 * 也就是说**最新消息在下面**；不先滑到底就读消息，读到的永远是几条老消息，
 * 判断「有没有新内容」全错。它固定滚 3 屏（一屏 ≈ 0.45 屏高，3 屏够跨过绝大多数未读）。
 *
 * ⚠ 不要用 `input keyevent KEYCODE_MOVE_END` 之类的捷径：微信聊天页不吃它。
 * 只负责滑，**不负责等停** —— 停没停交给 waitScrollSettle（新引擎里在 perception/stable.ts，
 * 按标题栏/输入栏这种静区判；这台机器的动图一直在播，整帧哈希永远等不到停）。
 */
export async function scrollToBottom(
  adb: Pick<AdbPort, "shell">,
  maxScreens = 3,
  opts: ScrollToBottomOptions = {},
): Promise<{ screens: number }> {
  const screen = opts.screen ?? { w: 1080, h: 2160 };
  const gapMs = Math.max(0, opts.gapMs ?? 320);
  const settleMs = Math.max(0, opts.settleMs ?? 200);
  const screens = Math.max(0, Math.floor(maxScreens));
  const x = Math.round(screen.w / 2);
  // 从 78% 高度划到 33%：手指往上 → 内容往上滚 → 露出更下面的消息
  const fromY = Math.round(screen.h * 0.78);
  const toY = Math.round(screen.h * 0.33);
  for (let i = 0; i < screens; i++) {
    await adb.shell(`input swipe ${x} ${fromY} ${x} ${toY} 200`, 15000);
    if (i < screens - 1) await sleep(gapMs);
  }
  if (screens > 0) await sleep(settleMs);
  return { screens };
}

/** 「有人@我」提示条的位置（屏幕坐标中心点） */
export interface MentionTag {
  x: number;
  y: number;
  /** OCR 到的那一行原文（排查用） */
  text: string;
}

/** 「有人@我」/「提到我」——微信顶部那条灰色提示条 */
const MENTION_TAG = /有人\s*[@＠]\s*我|提到我/;

/**
 * 在屏幕**顶部窄条**里找「有人@我」提示条，返回它的中心点。
 *
 * 旧插件 poller.js:959-969 的做法：只 OCR 顶部一条（1080×2160 上 y=110..370）再找
 * `有人@我|提到我`，返回 (x + w/2, y)。为什么不整屏 OCR：整屏既慢（~2s），
 * 又会被正文里「@我的」这类内容干扰。
 *
 * 区域优先用调用方传进来的（页面图 `chat.mention_tag`，见 profiles/wechat/pages.json），
 * 不传就按屏幕顶部 5%~18% 兜底。
 *
 * @param png 当前帧的 PNG（为了拿宽高只看 IHDR，不解码整张图）
 * @param area 像素坐标的搜索区域；不传按比例兜底
 */
export async function findMentionTag(
  png: Buffer,
  ocr: Pick<Ocr, "recognize">,
  area?: Rect,
): Promise<MentionTag | null> {
  const dims = pngSize(png) ?? (() => {
    const bmp = bmpOf({ png });
    return { w: bmp.width, h: bmp.height };
  })();
  const region: Rect = area ?? {
    x: 0,
    y: Math.round(dims.h * 0.05),
    w: dims.w,
    h: Math.round(dims.h * 0.13),
  };
  const lines = (await ocr.recognize(png, region)).lines;
  const hit = lines.find((l) => MENTION_TAG.test(l.text));
  if (!hit) return null;
  // 返回**中心点**：旧插件返回的是 hit.y（上沿），点进去会点到提示条上方的标题栏；
  // 提示条本身只有 ~40px 高，落点必须居中。
  return {
    x: Math.round(hit.x + hit.w / 2),
    y: Math.round(hit.y + hit.h / 2),
    text: hit.text,
  };
}
