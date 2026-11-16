/**
 * adb 端口实现。
 *
 * 只用 execFile（不经 shell），避免 Windows 下 MSYS 把 `/data/local/tmp/x` 转成 `C:/...`。
 * 每个方法都带超时；截图是 600ms 量级的操作，其余按 30s 兜底。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

import { decode } from "../image/image.ts";
import type { AdbPort, Focus, Frame } from "./types.ts";

const run = promisify(execFile);

export class AdbError extends Error {
  override name = "AdbError";
  readonly args: string[];
  readonly exitCode: number;
  constructor(args: string[], exitCode: number, message: string) {
    super(`adb ${args.join(" ")} 失败（exit ${exitCode}）：${message}`);
    this.args = args;
    this.exitCode = exitCode;
  }
}

export interface AdbOptions {
  adbPath: string;
  serial?: string;
}

export class Adb implements AdbPort {
  readonly adbPath: string;
  readonly serial: string;

  constructor(opts: AdbOptions) {
    this.adbPath = opts.adbPath;
    this.serial = opts.serial ?? "";
  }

  private withSerial(args: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...args] : args;
  }

  async exec(args: string[], timeoutMs = 30000): Promise<Buffer> {
    const full = this.withSerial(args);
    try {
      const { stdout } = await run(this.adbPath, full, {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer",
        windowsHide: true,
      });
      return stdout as Buffer;
    } catch (err) {
      const e = err as { code?: number; stderr?: Buffer | string; killed?: boolean };
      const stderr = String(e.stderr ?? "").trim().slice(0, 300);
      if (e.killed) throw new AdbError(full, -1, `超时 ${timeoutMs}ms ${stderr}`);
      throw new AdbError(full, typeof e.code === "number" ? e.code : -1, stderr);
    }
  }

  async shell(cmd: string, timeoutMs = 30000): Promise<string> {
    return (await this.exec(["shell", cmd], timeoutMs)).toString("utf8");
  }

  async screencap(): Promise<Frame> {
    const t0 = performance.now();
    const png = await this.exec(["exec-out", "screencap", "-p"], 30000);
    const ms = Math.round(performance.now() - t0);
    if (png.length < 8 || png[1] !== 0x50) {
      throw new AdbError(["exec-out", "screencap", "-p"], 0, `返回的不是 PNG（${png.length} 字节）`);
    }
    const bmp = decode(png);
    return { png, width: bmp.width, height: bmp.height, ms };
  }

  async focus(): Promise<Focus> {
    const dump = await this.shell("dumpsys window", 20000);
    const line = dump.split("\n").find((l) => l.includes("mCurrentFocus=")) ?? "";
    return parseFocus(line);
  }

  async forward(localPort: number, remotePort: number): Promise<void> {
    // 先删掉旧映射，避免 "already in use"
    await this.exec(["forward", "--remove", `tcp:${localPort}`], 10000).catch(() => Buffer.alloc(0));
    await this.exec(["forward", `tcp:${localPort}`, `tcp:${remotePort}`], 10000);
  }

  async push(localPath: string, remotePath: string): Promise<void> {
    await this.exec(["push", localPath, remotePath], 120000);
  }
}

/**
 * 从 `mCurrentFocus=Window{23377b9 u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}` 里取包名与活动。
 * 纯函数，方便单测（这条正则被不同 ROM 的格式折腾过，值得单独测）。
 */
export function parseFocus(line: string): Focus {
  const raw = line.trim();
  const m = /Window\{\S+\s+(?:u\d+\s+)?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/.exec(raw);
  if (!m) {
    return { raw, pkg: "", activity: "", component: "" };
  }
  const pkg = m[1]!;
  const activity = m[2]!;
  return { raw, pkg, activity, component: `${pkg}/${activity}` };
}