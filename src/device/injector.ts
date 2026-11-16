/**
 * 注入器客户端：一条命令一个 TCP 连接，读一行回复。
 *
 * 为什么不长连：注入器是单线程 accept 循环，长连遇到异常（半包、超时）不好恢复；
 * 一条命令一次连接的开销在 loopback 上不到 1ms，换来的是没有状态残留。
 *
 * 可测试性：send 可以注入，测试不需要真 socket。
 */

import { connect } from "node:net";

import type { InjectorPort } from "./types.ts";

export class InjectorError extends Error {
  override name = "InjectorError";
  readonly command: string;
  constructor(command: string, message: string) {
    super(`注入器 ${command} 失败：${message}`);
    this.command = command;
  }
}

export interface InjectorOptions {
  host?: string;
  port?: number;
  /** 测试用：替掉真实 socket */
  send?: (line: string) => Promise<string>;
  timeoutMs?: number;
}

function tcpSend(host: string, port: number, timeoutMs: number) {
  return (line: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect({ host, port }, () => socket.write(line + "\n"));
      let buf = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`${timeoutMs}ms 没回复`));
      }, timeoutMs);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          socket.end();
          resolve(buf.slice(0, nl).trim());
        }
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
}

export class InjectorClient implements InjectorPort {
  readonly #send: (line: string) => Promise<string>;

  constructor(opts: InjectorOptions = {}) {
    const timeoutMs = opts.timeoutMs ?? 15000;
    this.#send = opts.send ?? tcpSend(opts.host ?? "127.0.0.1", opts.port ?? 7801, timeoutMs);
  }

  async #run(line: string): Promise<string> {
    let reply: string;
    try {
      reply = await this.#send(line);
    } catch (err) {
      throw new InjectorError(line, (err as Error).message);
    }
    if (!reply.startsWith("ok")) {
      throw new InjectorError(line, reply || "(空回复)");
    }
    return reply;
  }

  async ping(): Promise<void> {
    await this.#run("ping");
  }

  async info(): Promise<string> {
    return this.#run("info");
  }

  async press(pressure: number, size: number): Promise<void> {
    if (!(pressure >= 0 && pressure <= 1) || !(size >= 0 && size <= 1)) {
      throw new InjectorError("press", "压力/面积必须在 0..1");
    }
    await this.#run(`press ${round(pressure)} ${round(size)}`);
  }

  async tap(x: number, y: number, downMs: number): Promise<void> {
    await this.#run(`tap ${px(x)} ${px(y)} ${Math.max(1, Math.round(downMs))}`);
  }

  async hold(x: number, y: number, ms: number): Promise<void> {
    await this.#run(`hold ${px(x)} ${px(y)} ${Math.max(30, Math.round(ms))}`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void> {
    await this.#run(`swipe ${px(x1)} ${px(y1)} ${px(x2)} ${px(y2)} ${Math.max(20, Math.round(ms))}`);
  }

  async path(points: ReadonlyArray<{ x: number; y: number; t: number }>): Promise<void> {
    if (points.length < 2) throw new InjectorError("path", "至少两个点");
    const body = points.map((p) => `${px(p.x)},${px(p.y)},${Math.max(0, Math.round(p.t))}`).join(" ");
    await this.#run(`path ${body}`);
  }
}

function px(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function round(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}