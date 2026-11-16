/**
 * 输入法客户端：通过广播遥控 ProbeIme。
 *
 * 结果不走 logcat（缓冲有限、时序不稳），而是让接收器 `setResultData(result)`，
 * `am broadcast` 会直接打印 `Broadcast completed: result=0, data="..."`。
 *
 * 注意 `-f 0x20`：新装的应用处于 stopped 状态，普通广播会被跳过；
 * 带上 FLAG_INCLUDE_STOPPED_PACKAGES 才能第一次就叫得醒。
 */

import type { AdbPort, ImePort } from "./types.ts";

export class ImeError extends Error {
  override name = "ImeError";
  constructor(message: string) {
    super(message);
  }
}

export interface ImeOptions {
  /** 应用包名 */
  pkg?: string;
  /** 接收器组件（相对包名） */
  receiver?: string;
  /** 广播时附带的 flag，默认 0x20 = INCLUDE_STOPPED_PACKAGES */
  flags?: string;
}

export class ImeClient implements ImePort {
  readonly #adb: AdbPort;
  readonly #pkg: string;
  readonly #receiver: string;
  readonly #flags: string;

  constructor(adb: AdbPort, opts: ImeOptions = {}) {
    this.#adb = adb;
    this.#pkg = opts.pkg ?? "mimic.probe";
    this.#receiver = opts.receiver ?? ".CommandReceiver";
    this.#flags = opts.flags ?? "0x20";
  }

  async #broadcast(action: string, extras: Record<string, string> = {}): Promise<string> {
    const parts = [
      "am",
      "broadcast",
      "-n",
      `${this.#pkg}/${this.#receiver}`,
      "-a",
      action,
      "-f",
      this.#flags,
    ];
    for (const [key, value] of Object.entries(extras)) {
      parts.push("--es", key, shellQuote(value));
    }
    const out = await this.#adb.shell(parts.join(" "), 20000);
    const data = parseBroadcastResult(out);
    if (data.startsWith("ERR")) throw new ImeError(`${action}: ${data}`);
    return data;
  }

  async ping(): Promise<string> {
    return this.#broadcast("mimic.PING");
  }

  async readClipboard(): Promise<string> {
    const data = await this.#broadcast("mimic.READ_CLIPBOARD");
    if (data === "EMPTY") return "";
    if (!data.startsWith("CLIP=")) throw new ImeError(`读剪贴板返回了意外内容：${truncate(data)}`);
    return data.slice("CLIP=".length);
  }

  async readInput(): Promise<{ before: string; after: string }> {
    const data = await this.#broadcast("mimic.READ_INPUT");
    return parseReadInput(data);
  }

  async type(text: string): Promise<void> {
    await this.#broadcast("mimic.TYPE", { text });
  }

  async setClipboard(text: string): Promise<void> {
    await this.#broadcast("mimic.SET_CLIPBOARD", { text });
  }

  async clear(): Promise<void> {
    await this.#broadcast("mimic.CLEAR");
  }
}

/** 从 `Broadcast completed: result=0, data="ok ime=true"` 里取 data 并反转义。 */
export function parseBroadcastResult(output: string): string {
  const m = /data=("(?:[^"\\]|\\.)*")/.exec(output);
  if (!m) {
    const line = output.trim().split("\n").pop() ?? "";
    throw new ImeError(`广播没有返回数据：${truncate(line)}`);
  }
  try {
    return JSON.parse(m[1]!) as string;
  } catch {
    // am 打印的不一定是严格 JSON 转义，退化为手工去引号
    return m[1]!.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

export function parseReadInput(data: string): { before: string; after: string } {
  const m = /^BEFORE=([\s\S]*?)\|\|AFTER=([\s\S]*)$/.exec(data);
  if (!m) throw new ImeError(`读输入框返回了意外内容：${truncate(data)}`);
  return { before: m[1]!, after: m[2]! };
}

/** adb shell 里单引号包裹；内部的单引号用 '\'' 断开。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function truncate(s: string): string {
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}