/**
 * 稳定帧：按**区域**判，而不是整帧。
 *
 * 实测（docs/device-probes.md §5）：微信聊天页只要有动图表情，整帧永远不会静止
 * （500ms 内 2.3–3.1% 像素在变）。所以只能判「我关心的那块区域静了没有」，
 * 消息区默认算脏区，不参与判定。
 */

import { decode, regionDiff, type Bitmap, type Rect } from "../image/image.ts";
import type { AdbPort } from "../device/types.ts";

export interface StableOptions {
  /** 只在这个区域里比较；不传就是整帧（不建议） */
  region?: Rect;
  /** 连续多少次「没变」算稳定 */
  frames?: number;
  /** 两次采样间隔 */
  intervalMs?: number;
  /** 超时 */
  timeoutMs?: number;
  /** 变化像素占比阈值（小于它算「没变」） */
  threshold?: number;
  /** 单通道容差，压掉编码噪声 */
  perChannel?: number;
}

/**
 * 等稳定的结果 —— **这里面的帧就是调用方接下来要用的那一帧**。
 *
 * 旧插件把「等稳定」拍的那一帧扔掉、调用方再拍一张，一次进出会话的照片从 3~4 张
 * 涨到 12~16 张。这个返回值就是用来止血的：
 *  - 要 OCR → 用 `lastPng`（OCR 端口收的是 PNG 字节，不用再截一张）；
 *  - 要做像素判断（页面判定 / 气泡颜色 / dhash）→ 用 `lastFrame`（已解码的位图）。
 * 两者指的是同一帧（同一个时刻的画面），措辞上不要混用。
 */
export interface StableResult {
  stable: boolean;
  /** 判定为稳定时用了几次采样 */
  samples: number;
  /** 最后一次的变化比例（稳定时是最小值） */
  ratio: number;
  /** 有变化的最后位置（不稳定时有用） */
  bbox: Rect | null;
  ms: number;
  /** 稳定帧本身（已解码），调用方可以直接在上面做像素判断，避免再截一次 */
  lastFrame: Bitmap;
  /** 稳定帧的 PNG 字节，调用方可以直接喂给 `Ocr.recognize`，避免再截一次 */
  lastPng: Buffer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 设备侧可能开了截图复用窗口（AdbOptions.captureReuseMs）。稳定判定必须每次真拍。 */
type CacheBuster = { invalidateFrame?: () => void };

/**
 * 截一帧**这一次**的画面。
 *
 * 为什么每次都要先作废复用窗口：`waitStable` / `waitScrollSettle` 的整个判据是
 * 「连续几次截图长得一样」。如果 Adb 开着 300ms 复用窗口（T3 省连拍用的），
 * 200ms 间隔的两次采样会拿到同一帧 —— 一上来就判「稳定」，等于没判。
 */
async function freshFrame(adb: Pick<AdbPort, "screencap">) {
  (adb as CacheBuster).invalidateFrame?.();
  return adb.screencap();
}

/**
 * 等区域稳定。返回最后一次采样的画面（`lastFrame` / `lastPng`），
 * 调用方直接在它上面做后续判断，**不要再 screencap 一次**。
 */
export async function waitStable(adb: AdbPort, opts: StableOptions = {}): Promise<StableResult> {
  const frames = Math.max(1, opts.frames ?? 2);
  const intervalMs = opts.intervalMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const threshold = opts.threshold ?? 0.002;
  const perChannel = opts.perChannel ?? 8;

  const t0 = Date.now();
  let prev: Bitmap | null = null;
  let stableCount = 0;
  let samples = 0;
  let lastRatio = 1;
  let lastBbox: Rect | null = null;
  let lastFrame: Bitmap | null = null;
  let lastPng: Buffer | null = null;

  // 一次截图 600ms 量级，所以「超时」只在拿到足够证据之后才判失败；
  // 否则 frames=2 在 1500ms 里根本采不到三次。
  while (true) {
    const frame = await freshFrame(adb);
    // Frame.bmp 是 Adb.screencap 顺手解出来的；假设备（测试里的）不填就自己解
    const bmp = frame.bmp ?? decode(frame.png);
    samples++;
    lastFrame = bmp;
    lastPng = frame.png;

    if (prev) {
      const diff = regionDiff(prev, bmp, opts.region, perChannel);
      lastRatio = diff.ratio;
      lastBbox = diff.bbox;
      if (diff.ratio < threshold) {
        stableCount++;
        if (stableCount >= frames) {
          return { stable: true, samples, ratio: diff.ratio, bbox: diff.bbox, ms: Date.now() - t0, lastFrame: bmp, lastPng: frame.png };
        }
      } else {
        stableCount = 0;
      }
    }
    prev = bmp;
    if (Date.now() - t0 >= timeoutMs) break;
    await sleep(intervalMs);
  }

  if (!lastFrame || !lastPng) {
    const frame = await freshFrame(adb);
    lastFrame = frame.bmp ?? decode(frame.png);
    lastPng = frame.png;
  }
  return { stable: false, samples, ratio: lastRatio, bbox: lastBbox, ms: Date.now() - t0, lastFrame, lastPng };
}

export interface ScrollSettleOptions {
  /**
   * 用来判「停没停」的**静区**（标题栏 / 输入栏这种本不该随滚动变化的区域）。
   * 强烈建议给：不给就只能拿整帧判，而聊天页的动图一直在播（device-probes §5 实测），
   * 整帧永远不稳，等于一直等到超时（比"什么都没比就宣布停稳"安全，但很慢）。
   */
  regions?: Rect[];
  /** 连续几次一致算停（默认 2：采到第二帧即可，别把 3 屏滚动拖成十几秒） */
  frames?: number;
  /** 采样间隔（旧插件 scrollSampleMs 是 250~300） */
  intervalMs?: number;
  /** 超时（超了返回 settled:false，调用方自己决定要不要硬往下走） */
  timeoutMs?: number;
  /** 变化像素占比阈值 */
  threshold?: number;
  /** 单通道容差 */
  perChannel?: number;
}

export interface ScrollSettleResult {
  settled: boolean;
  samples: number;
  /** 静区里最大的变化比例（稳定时是最小值） */
  ratio: number;
  ms: number;
  /** 最后一帧，调用方可以直接复用，别为了读消息再截一张 */
  lastFrame: Bitmap;
  lastPng: Buffer;
}

/**
 * 等滑动停下来。
 *
 * 旧插件 poller.js:971-997 用的是**整帧哈希**，那在旧机器上勉强能用；这台机器上
 * 聊天页的动图一直在播，整帧哈希每帧都不同 —— 照抄会一直等到超时。
 * 所以改成「只看静区」：标题栏和输入栏两处都没有变化才算停（和 waitStable 同一套判据）。
 */
export async function waitScrollSettle(
  adb: Pick<AdbPort, "screencap">,
  opts: ScrollSettleOptions,
): Promise<ScrollSettleResult> {
  const regions = opts.regions ?? [];
  // 没给静区就退回整帧（旧插件同口径）：聊天页有动图时会一直等到超时 —— 难受，
  // 但比「什么都没比就宣布停稳」安全（后者会让调用方读到滚了一半的消息）。
  const compare: Array<Rect | undefined> = regions.length > 0 ? regions : [undefined];
  const frames = Math.max(1, opts.frames ?? 2);
  const intervalMs = opts.intervalMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const threshold = opts.threshold ?? 0.002;
  const perChannel = opts.perChannel ?? 8;

  const t0 = Date.now();
  let prev: Bitmap | null = null;
  let same = 0;
  let samples = 0;
  let lastRatio = 1;
  let lastFrame: Bitmap | null = null;
  let lastPng: Buffer | null = null;

  while (true) {
    const frame = await freshFrame(adb);
    const bmp = frame.bmp ?? decode(frame.png);
    samples++;
    lastFrame = bmp;
    lastPng = frame.png;

    if (prev) {
      // 任一静区在变 = 还在滚（取最大值，宁可多等一帧也不要读到半截消息）
      let worst = 0;
      for (const region of compare) {
        const diff = regionDiff(prev, bmp, region, perChannel);
        if (diff.ratio > worst) worst = diff.ratio;
      }
      lastRatio = worst;
      if (worst < threshold) {
        same++;
        if (same >= frames - 1) {
          return { settled: true, samples, ratio: worst, ms: Date.now() - t0, lastFrame: bmp, lastPng: frame.png };
        }
      } else {
        same = 0;
      }
    }
    prev = bmp;
    if (Date.now() - t0 >= timeoutMs) break;
    await sleep(intervalMs);
  }

  if (!lastFrame || !lastPng) {
    const frame = await freshFrame(adb);
    lastFrame = frame.bmp ?? decode(frame.png);
    lastPng = frame.png;
  }
  return { settled: false, samples, ratio: lastRatio, ms: Date.now() - t0, lastFrame, lastPng };
}