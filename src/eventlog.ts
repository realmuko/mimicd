/**
 * JSONL 事件日志：追加写 + 严格回读。
 *
 * 写入用同步 append：单行几百字节，代价约 0.1 ms，换来的是「顺序绝不会乱」
 * （异步队列在崩溃时会丢尾部，而事件流的价值全在尾部）。
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  SCHEMA_VERSION,
  makeRunId,
  type ArtifactRef,
  type EventEnvelope,
  type EventKind,
} from "./events.ts";

export interface EventLogOptions {
  /** 事件文件绝对路径，例如 data/events/2026-11-17/run-r-....jsonl */
  file: string;
  /** 不传则生成 */
  run?: string;
  /** 默认 "core" */
  src?: string;
  /** 测试注入用 */
  now?: () => number;
  mono?: () => number;
}

export interface AppendOptions {
  src?: string;
  refs?: ArtifactRef[];
  /** 覆盖墙钟（例如事件来自离线回放） */
  at?: number;
}

export class EventLog {
  readonly file: string;
  readonly run: string;
  readonly #now: () => number;
  readonly #mono: () => number;
  #seq = 0;
  #closed = false;

  constructor(opts: EventLogOptions) {
    this.file = opts.file;
    mkdirSync(dirname(this.file), { recursive: true });
    this.run = opts.run ?? makeRunId();
    this.#now = opts.now ?? Date.now;
    this.#mono = opts.mono ?? (() => performance.now());
  }

  get seq(): number {
    return this.#seq;
  }

  append<D extends Record<string, unknown> = Record<string, unknown>>(
    kind: EventKind | (string & {}),
    data: D,
    opts: AppendOptions = {},
  ): EventEnvelope<D> {
    if (this.#closed) throw new Error("EventLog 已关闭，不能再写事件");
    const seq = ++this.#seq;
    const env: EventEnvelope<D> = {
      v: SCHEMA_VERSION,
      seq,
      id: `${this.run}:${seq}`,
      t: opts.at ?? this.#now(),
      mono: Math.round(this.#mono()),
      run: this.run,
      kind,
      src: opts.src ?? "core",
      data,
    };
    if (opts.refs && opts.refs.length > 0) env.refs = opts.refs;

    // 顺序固定：字段顺序不影响语义，但影响 diff 的可读性，保持稳定。
    appendFileSync(this.file, JSON.stringify(env) + "\n", "utf8");
    return env;
  }

  /** 幂等；重复调用只写一次 run.stopped。 */
  close(extra: Record<string, unknown> = {}): void {
    if (this.#closed) return;
    this.append("run.stopped", { seq: this.#seq, ...extra }, { src: "core" });
    this.#closed = true;
  }
}

export class EventLogFormatError extends Error {
  override name = "EventLogFormatError";
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message}（第 ${line} 行）`);
    this.line = line;
  }
}

/** 单行解析 + 校验。未知字段保留，未知 kind 允许（回放侧自行忽略）。 */
export function parseEventLine(line: string, lineNo = 0): EventEnvelope {
  if (line.trim() === "") throw new EventLogFormatError("空行", lineNo);
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new EventLogFormatError("不是合法 JSON", lineNo);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EventLogFormatError("事件必须是对象", lineNo);
  }
  const obj = raw as Record<string, unknown>;

  const num = (k: string): number => {
    const val = obj[k];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new EventLogFormatError(`字段 ${k} 缺失或不是有限数`, lineNo);
    }
    return val;
  };
  const str = (k: string): string => {
    const val = obj[k];
    if (typeof val !== "string" || val === "") {
      throw new EventLogFormatError(`字段 ${k} 缺失或为空`, lineNo);
    }
    return val;
  };

  const v = num("v");
  if (v > SCHEMA_VERSION) {
    throw new EventLogFormatError(
      `事件 schema 版本 ${v} 高于本二进制认识的 ${SCHEMA_VERSION}，拒绝猜测式回读`,
      lineNo,
    );
  }
  if (!Number.isInteger(v) || v < 1) {
    throw new EventLogFormatError(`事件 schema 版本非法：${v}`, lineNo);
  }

  const data = obj["data"];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new EventLogFormatError("字段 data 必须是对象", lineNo);
  }

  const env: EventEnvelope = {
    v,
    seq: num("seq"),
    id: str("id"),
    t: num("t"),
    mono: num("mono"),
    run: str("run"),
    kind: str("kind"),
    src: str("src"),
    data: data as Record<string, unknown>,
  };

  const refs = obj["refs"];
  if (refs !== undefined) {
    if (!Array.isArray(refs)) throw new EventLogFormatError("字段 refs 必须是数组", lineNo);
    env.refs = refs.map((r, i) => {
      if (typeof r !== "object" || r === null) {
        throw new EventLogFormatError(`refs[${i}] 不是对象`, lineNo);
      }
      const ref = r as Record<string, unknown>;
      if (typeof ref["path"] !== "string" || typeof ref["sha256"] !== "string") {
        throw new EventLogFormatError(`refs[${i}] 缺 path/sha256`, lineNo);
      }
      const out: ArtifactRef = {
        path: ref["path"],
        sha256: ref["sha256"],
        bytes: typeof ref["bytes"] === "number" ? ref["bytes"] : 0,
        kind: (typeof ref["kind"] === "string" ? ref["kind"] : "other") as ArtifactRef["kind"],
      };
      if (typeof ref["w"] === "number") out.w = ref["w"];
      if (typeof ref["h"] === "number") out.h = ref["h"];
      return out;
    });
  }

  return env;
}

export interface ReadOptions {
  /** 只取这些 kind；`undefined` = 全部 */
  kinds?: ReadonlySet<string> | string[];
  /** 从 seq > afterSeq 开始（回放断点续跑用） */
  afterSeq?: number;
}

/** 同步读全部事件。一个 run 的量级是几万行，够用；再大就分片。 */
export function readEvents(file: string, opts: ReadOptions = {}): EventEnvelope[] {
  const text = readFileSync(file, "utf8");
  const kindSet = opts.kinds
    ? opts.kinds instanceof Set
      ? opts.kinds
      : new Set(opts.kinds)
    : undefined;

  const out: EventEnvelope[] = [];
  let lastSeq = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" && i === lines.length - 1) break; // 尾部换行
    const env = parseEventLine(line, i + 1);
    if (env.seq <= lastSeq) {
      throw new EventLogFormatError(`seq 未递增：${env.seq} <= ${lastSeq}`, i + 1);
    }
    lastSeq = env.seq;
    if (opts.afterSeq !== undefined && env.seq <= opts.afterSeq) continue;
    if (kindSet && !kindSet.has(env.kind)) continue;
    out.push(env);
  }
  return out;
}