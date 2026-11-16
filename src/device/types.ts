/**
 * 设备侧的端口（port）定义。
 *
 * 三层各有一个接口：adb（截图/命令/状态）、注入器（触摸）、输入法（文本与剪贴板）。
 * 这样 actuator / perception / skills 都能在**没有手机**的情况下测。
 */

export interface Frame {
  png: Buffer;
  width: number;
  height: number;
  /** 从发起截图到拿到字节的耗时 */
  ms: number;
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