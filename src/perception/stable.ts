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

export interface StableResult {
  stable: boolean;
  /** 判定为稳定时用了几次采样 */
  samples: number;
  /** 最后一次的变化比例（稳定时是最小值） */
  ratio: number;
  /** 有变化的最后位置（不稳定时有用） */
  bbox: Rect | null;
  ms: number;
  /** 稳定帧本身，调用方可以直接复用，避免再截一次 */
  lastFrame: Bitmap;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 等区域稳定。返回最后一次采样的画面，方便调用方直接在它上面做后续判断。
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

  // 一次截图 600ms 量级，所以「超时」只在拿到足够证据之后才判失败；
  // 否则 frames=2 在 1500ms 里根本采不到三次。
  while (true) {
    const frame = await adb.screencap();
    const bmp = decode(frame.png);
    samples++;
    lastFrame = bmp;

    if (prev) {
      const diff = regionDiff(prev, bmp, opts.region, perChannel);
      lastRatio = diff.ratio;
      lastBbox = diff.bbox;
      if (diff.ratio < threshold) {
        stableCount++;
        if (stableCount >= frames) {
          return { stable: true, samples, ratio: diff.ratio, bbox: diff.bbox, ms: Date.now() - t0, lastFrame: bmp };
        }
      } else {
        stableCount = 0;
      }
    }
    prev = bmp;
    if (Date.now() - t0 >= timeoutMs) break;
    await sleep(intervalMs);
  }

  if (!lastFrame) {
    const frame = await adb.screencap();
    lastFrame = decode(frame.png);
  }
  return { stable: false, samples, ratio: lastRatio, bbox: lastBbox, ms: Date.now() - t0, lastFrame };
}

