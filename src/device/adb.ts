/**
 * adb 端口实现。
 *
 * 用 spawn 而不是 execFile，原因就一条：
 * execFile 在超时 / 超 buffer 时会**直接杀掉客户端**，正在传输的 `exec-out screencap -p`
 * 被截断，adb server 那边的 transport 很容易卡成 offline —— 之后所有命令都是 "no devices"，
 * 只有 `adb kill-server` 才能救回来。这里超时后先用 `taskkill /T /F` 把进程树收干净，
 * 并抛一个带 `recoverable` 标记的错误，让引擎知道「该重启 adb server 了」。
 *
 * 另外：所有子进程都登记在册。引擎被 Ctrl+C / 正常退出时一并清掉，
 * 不留孤儿客户端占着设备（孤儿正是「一重启引擎，设备就没了」的元凶之一）。
 *
 * 只用 spawn（不经 shell），避免 Windows 下 MSYS 把 `/data/local/tmp/x` 转成 `C:/...`。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

import { decode } from "../image/image.ts";
import type { AdbPort, Focus, Frame } from "./types.ts";

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const COMMAND_TIMEOUT = 30000;
/** 强杀之后最多再等多久收尾，避免 taskkill 没生效时把调用方吊死 */
const KILL_GRACE_MS = 5000;

export interface AdbErrorDetail {
  /** 超时被杀（命令没跑完就断了，adb server 可能需要重置） */
  timedOut?: boolean;
  /** 输出超过上限被杀（同上） */
  overflow?: boolean;
}

export class AdbError extends Error {
  override name = "AdbError";
  readonly args: string[];
  readonly exitCode: number;
  readonly detail: AdbErrorDetail;

  constructor(args: string[], exitCode: number, message: string, detail: AdbErrorDetail = {}) {
    super(`adb ${args.join(" ")} 失败（exit ${exitCode}）：${message}`);
    this.args = args;
    this.exitCode = exitCode;
    this.detail = detail;
  }

  /**
   * 这条错误是不是「adb 链路被我们自己弄断了」。
   * 是的话，调用方应该重置 adb server，而不是傻等。
   */
  get recoverable(): boolean {
    return this.detail.timedOut === true || this.detail.overflow === true;
  }
}

/** 手机为什么不在：区分「根本没有设备」和「设备在但离线/没授权」 */
export type DeviceErrorKind = "none" | "no-device" | "offline" | "unauthorized";

/**
 * 从 adb 的报错文本里认设备状态。纯函数，方便单测。
 *
 * 小心 `device offline` 和 `no devices/emulators found` 是两种故障：
 * 前者 server 还知道这台设备，`reconnect` 有机会救；后者连设备都没了。
 */
export function classifyDeviceError(message: string): DeviceErrorKind {
  const m = String(message ?? "");
  if (/unauthorized/i.test(m)) return "unauthorized";
  if (/device offline|offline\b/i.test(m)) return "offline";
  if (/no devices|device .*not found|not found device/i.test(m)) return "no-device";
  return "none";
}

export interface AdbOptions {
  adbPath: string;
  serial?: string;
  /** 单条命令最多收多少字节，超了强杀（默认 64MB） */
  maxBufferBytes?: number;
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
  killed: boolean;
  reason: "timeout" | "overflow" | null;
}

export class Adb implements AdbPort {
  readonly adbPath: string;
  readonly serial: string;
  readonly maxBufferBytes: number;

  /** 正在跑的 adb 子进程（退出时一并清掉，不留孤儿） */
  readonly #live = new Set<ChildProcess>();
  /** 这条命令被我们半路掐断过 → 下次该重置 server */
  #needsRecovery = false;

  constructor(opts: AdbOptions) {
    this.adbPath = opts.adbPath;
    this.serial = opts.serial ?? "";
    this.maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  }

  /** 现在还有几条 adb 命令在跑（测试与退出清理用） */
  get liveCount(): number {
    return this.#live.size;
  }

  /** 上次是不是被我们半路掐断过 */
  get needsRecovery(): boolean {
    return this.#needsRecovery;
  }

  clearRecoveryFlag(): void {
    this.#needsRecovery = false;
  }

  private withSerial(args: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...args] : args;
  }

  /** 强杀一条命令（Windows 上连子孙一起收），失败不抛 */
  #terminate(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      try {
        const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        k.on("error", () => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        });
      } catch {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }

  /**
   * 跑一条 adb 命令。
   *
   * @param args 已经拼好 serial 的完整参数
   * @param timeoutMs 超时后强杀（并标记 needsRecovery）
   * @param maxBytes 输出上限，超了强杀（同上）
   */
  #run(args: string[], timeoutMs: number, maxBytes: number): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.adbPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        reject(new AdbError(args, -1, `起不来：${(err as Error).message}`));
        return;
      }

      const out: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outLen = 0;
      let errLen = 0;
      let settled = false;
      let killed = false;
      let reason: RunResult["reason"] = null;

      const cleanup = () => {
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        this.#live.delete(child);
      };
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(errChunks).subarray(0, 8192).toString("utf8"),
          code,
          killed,
          reason,
        });
      };
      const hardKill = (why: RunResult["reason"]) => {
        if (settled) return;
        killed = true;
        reason = why;
        this.#terminate(child);
        // taskkill 万一没生效，也别把调用方吊死
        grace = setTimeout(() => finish(-1), KILL_GRACE_MS);
        grace.unref?.();
      };

      let grace: NodeJS.Timeout | null = null;
      const timer = setTimeout(() => hardKill("timeout"), Math.max(1, timeoutMs));
      timer.unref?.();

      this.#live.add(child);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        outLen += chunk.length;
        if (outLen > maxBytes) {
          hardKill("overflow");
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (errLen >= 8192) return;
        errChunks.push(chunk);
        errLen += chunk.length;
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new AdbError(args, -1, `起不来：${err.message}`));
      });
      child.on("close", (code) => finish(code === null ? -1 : code));
    });
  }

  /** 跑一条**不带 -s** 的原生命令（kill-server / start-server / devices） */
  private async raw(args: string[], timeoutMs: number, maxBytes = 1024 * 1024): Promise<RunResult> {
    return await this.#run(args, timeoutMs, maxBytes);
  }

  async exec(args: string[], timeoutMs = COMMAND_TIMEOUT): Promise<Buffer> {
    const full = this.withSerial(args);
    const r = await this.#run(full, timeoutMs, this.maxBufferBytes);
    if (r.killed) {
      this.#needsRecovery = true;
      const why = r.reason === "timeout" ? `超时 ${timeoutMs}ms` : `输出超过 ${this.maxBufferBytes} 字节`;
      throw new AdbError(full, -1, `${why}（已强杀，adb server 可能要重置）`, {
        timedOut: r.reason === "timeout",
        overflow: r.reason === "overflow",
      });
    }
    if (r.code !== 0) throw new AdbError(full, r.code, r.stderr);
    return r.stdout;
  }

  async shell(cmd: string, timeoutMs = COMMAND_TIMEOUT): Promise<string> {
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

  /** 把还活着的 adb 客户端全部收掉（引擎退出时用，防孤儿占设备） */
  async killAllChildren(): Promise<number> {
    const kids = [...this.#live];
    for (const kid of kids) this.#terminate(kid);
    if (kids.length === 0) return 0;
    // 给 taskkill 一点时间落地，最多等 1.5s，不阻塞退出太久
    const deadline = Date.now() + 1500;
    while (this.#live.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return kids.length;
  }

  /**
   * 重置 adb server：kill-server → start-server → devices 检查。
   *
   * 这是「设备掉线后唯一真正有用的一步」——`adb reconnect offline` 只能救保住了 transport 的
   * offline 设备，救不了 server 本身卡死、或孤儿客户端占着设备的情况。
   */
  async recover(opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; log: string }> {
    const timeoutMs = opts.timeoutMs ?? 20000;
    const notes: string[] = [];

    const orphans = await this.killAllChildren();
    if (orphans > 0) notes.push(`清掉 ${orphans} 条残留 adb 客户端`);

    const kill = await this.raw(["kill-server"], 15000).catch((err: Error) => {
      notes.push(`kill-server 失败（${err.message.slice(0, 80)}）`);
      return null;
    });
    if (kill && kill.code !== 0) notes.push(`kill-server exit ${kill.code}`);

    try {
      const start = await this.raw(["start-server"], timeoutMs);
      notes.push(`start-server exit ${start.code}`);
    } catch (err) {
      this.#needsRecovery = false;
      return { ok: false, log: [...notes, `start-server 起不来：${(err as Error).message.slice(0, 120)}`].join("；") };
    }

    const listed = await this.raw(["devices"], 15000).catch(() => null);
    const text = listed ? listed.stdout.toString("utf8") : "";
    const ok = this.serial ? new RegExp(`^${escapeRegExp(this.serial)}\\s+device\\b`, "m").test(text) : /^\S+\s+device\b/m.test(text);
    notes.push(ok ? "设备在" : "设备不在");
    if (ok) this.#needsRecovery = false;
    return { ok, log: notes.join("；") };
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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