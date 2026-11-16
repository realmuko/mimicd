/**
 * adb 的最小封装（探针用）。
 *
 * 只做三件事：跑命令、截图、读设备上的文件。刻意不引入任何依赖，
 * 也不缓存状态——探针要的是「现在这一刻机器什么样」。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

const run = promisify(execFile);

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  ms: number;
  code: number;
}

export class AdbError extends Error {
  override name = "AdbError";
  readonly args: string[];
  readonly exitCode: number;
  readonly stderr: string;
  constructor(args: string[], exitCode: number, stderr: string) {
    super(`adb ${args.join(" ")} 失败（exit ${exitCode}）：${stderr.trim().slice(0, 400)}`);
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class Adb {
  readonly adbPath: string;
  readonly serial: string;

  constructor(adbPath: string, serial = "") {
    this.adbPath = adbPath;
    this.serial = serial;
  }

  get label(): string {
    return this.serial || "(唯一设备)";
  }

  private withSerial(args: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...args] : args;
  }

  async exec(args: string[], timeoutMs = 30000): Promise<ExecResult> {
    const full = this.withSerial(args);
    const t0 = performance.now();
    try {
      const { stdout, stderr } = await run(this.adbPath, full, {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer",
        windowsHide: true,
      });
      return {
        stdout: stdout as Buffer,
        stderr: String(stderr ?? ""),
        ms: Math.round(performance.now() - t0),
        code: 0,
      };
    } catch (err) {
      const e = err as { code?: number; stderr?: Buffer | string; killed?: boolean; signal?: string };
      const stderr = String(e.stderr ?? "");
      if (e.killed) {
        throw new AdbError(full, -1, `超时 ${timeoutMs}ms：${stderr}`);
      }
      throw new AdbError(full, typeof e.code === "number" ? e.code : -1, stderr);
    }
  }

  async shell(cmd: string, timeoutMs = 30000): Promise<string> {
    const r = await this.exec(["shell", cmd], timeoutMs);
    return r.stdout.toString("utf8");
  }

  /** 截图（PNG 字节）。用 exec-out 避免临时文件与换行破坏。 */
  async screencap(timeoutMs = 30000): Promise<{ buf: Buffer; ms: number }> {
    const r = await this.exec(["exec-out", "screencap", "-p"], timeoutMs);
    if (r.stdout.length < 8 || r.stdout[1] !== 0x50) {
      throw new AdbError(["exec-out", "screencap", "-p"], r.code, `返回的不是 PNG（${r.stdout.length} 字节）`);
    }
    return { buf: r.stdout, ms: r.ms };
  }

  /** uiautomator dump 后直接 cat 回来（不 pull，少一次落盘）。 */
  async dumpUi(): Promise<{ xml: string; ms: number; dumpMs: number }> {
    const dump = await this.shell("uiautomator dump /sdcard/window_dump.xml", 20000);
    if (!/dumped to/i.test(dump)) {
      throw new AdbError(["shell", "uiautomator dump"], -1, `dump 未成功：${dump.trim().slice(0, 200)}`);
    }
    const r = await this.exec(["exec-out", "cat /sdcard/window_dump.xml"], 20000);
    return { xml: r.stdout.toString("utf8"), ms: r.ms, dumpMs: 0 };
  }

  async devices(): Promise<Array<{ serial: string; state: string }>> {
    const r = await this.exec(["devices"]);
    return r.stdout
      .toString("utf8")
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state] = l.split(/\s+/);
        return { serial: serial ?? "", state: state ?? "" };
      });
  }
}