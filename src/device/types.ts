/**
 * 设备侧的端口（port）定义。
 *
 * 三层各有一个接口：adb（截图/命令/状态）、注入器（触摸）、输入法（文本与剪贴板）。
 * 这样 actuator / perception / skills 都能在**没有手机**的情况下测。
 */

import type { Bitmap } from "../image/image.ts";

export interface Frame {
  png: Buffer;
  width: number;
  height: number;
  /** 从发起截图到拿到字节的耗时 */
  ms: number;
  /**
   * 这张 PNG 解码后的位图（Adb.screencap 顺手填上）。
   *
   * 为什么放在 Frame 里：screencap 为了拿宽高本来就要 decode 一次，
   * 调用方（perception / monitor）拿到 Frame 又 decode 第二遍 —— 同一帧解两遍，
   * 1080×2160 大约是每次多 20~30ms 的纯拷贝。有它就别再 decode(frame.png) 了。
   *
   * 可选：实现 AdbPort 的假设备（测试里那些）不填也没关系，调用方要写
   * `frame.bmp ?? decode(frame.png)`。
   */
  bmp?: Bitmap;
}

export interface Focus {
  /** 原始 mCurrentFocus 行 */
  raw: string;
  pkg: string;
  activity: string;
  /** pkg/activity 这种完整组件名 */
  component: string;
}

export interface AdbPort {
  exec(args: string[], timeoutMs?: number): Promise<Buffer>;
  shell(cmd: string, timeoutMs?: number): Promise<string>;
  screencap(): Promise<Frame>;
  focus(): Promise<Focus>;
  forward(localPort: number, remotePort: number): Promise<void>;
  push(localPath: string, remotePath: string): Promise<void>;

  // ---- 下面这些是可选的「设备自检」能力。假设备（测试里的）不实现也没关系 ----
  // 只在 Adb 这一层有；用可选成员而不是必选，是为了不把每个 fake 都改一遍。

  /** 手机现在是不是醒着（亮屏且没锁）。读 `dumpsys power` 的 mWakefulness。 */
  screenAwake?(): Promise<boolean>;
  /** 微信僵死时重启它（force-stop + monkey 拉起）。重锤，调用方先确认真的卡死了。 */
  restartWeChat?(opts?: {
    forceStopWaitMs?: number;
    launchWaitMs?: number;
    checkFocus?: boolean;
  }): Promise<{ ok: boolean; log: string; pkg: string }>;
  /** 作废截图复用窗口（点/滑/切 App 之后必须调用；waitStable 这类轮询也该每次调用）。 */
  invalidateFrame?(): void;
}

export interface InjectorPort {
  /** 轻点：带 MOVE 与压力曲线的按下 */
  tap(x: number, y: number, downMs: number): Promise<void>;
  /** 按住不动：不发 MOVE（微信气泡的长按需要这个） */
  hold(x: number, y: number, ms: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>;
  /** 逐点轨迹，t 为相对毫秒 */
  path(points: ReadonlyArray<{ x: number; y: number; t: number }>): Promise<void>;
  press(pressure: number, size: number): Promise<void>;
  info(): Promise<string>;
  ping(): Promise<void>;
}

export interface ImePort {
  ping(): Promise<string>;
  /** 剪贴板原文（默认输入法才有权限） */
  readClipboard(): Promise<string>;
  /** 当前输入框里光标前后的文本 */
  readInput(): Promise<{ before: string; after: string }>;
  type(text: string): Promise<void>;
  setClipboard(text: string): Promise<void>;
  clear(): Promise<void>;
}

/** 三个端口的组合，actuator 只依赖这个。 */
export interface DevicePorts {
  adb: AdbPort;
  injector: InjectorPort;
  ime: ImePort;
}