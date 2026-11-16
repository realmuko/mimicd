/**
 * 事件信封 —— 整个系统唯一的事实来源。
 *
 * 纪律（见 DECISIONS.md D8 与 docs/research 的 E12 / 反模式 10）：
 *  1. 只增不删：新增字段必须可选；改语义 = 新增 kind；不兼容 = 升版本。
 *  2. 事件里**不放 base64**：图片落 artifacts/，事件只带 path + sha256 + 尺寸。
 *  3. 时间双份：`t` 墙钟（跨进程/跨机对齐、给人看），`mono` 单调（算间隔、给统计用）。
 */

/** 当前信封版本。回读时 `v > SCHEMA_VERSION` 直接报错，不猜。 */
export const SCHEMA_VERSION = 1;

/** 大对象引用。path 相对数据根目录，永远用 `/` 分隔。 */
export interface ArtifactRef {
  path: string;
  sha256: string;
  bytes: number;
  kind: "png" | "jpg" | "jsonl" | "txt" | "other";
  w?: number;
  h?: number;
}

/**
 * kind 是开放集合：这里只列出已知的，未知 kind 在回放时必须被忽略而不是报错
 * （否则「只增不删」就只是口号）。新增时先加到这里，再加写入方。
 */
export type EventKind =
  // 生命周期
  | "run.started"
  | "run.stopped"
  // 感知
  | "frame.captured"
  | "page.classified"
  | "message.seen"
  | "mention.seen"
  | "unread.changed"
  | "thread.opened"
  | "thread.touched"
  | "thread.closed"
  // 决策与执行
  | "intent.decided"
  | "plan.planned"
  | "action.executed"
  | "action.verified"
  | "send.succeeded"
  | "send.failed"
  // 其他
  | "note";

export interface EventEnvelope<D = Record<string, unknown>> {
  /** schema 版本 */
  v: number;
  /** 本 run 内单调递增，从 1 开始；断档即丢事件 */
  seq: number;
  /** `${run}:${seq}`，跨 run 唯一 */
  id: string;
  /** 墙钟，ms */
  t: number;
  /** 进程内单调时钟，ms（performance.now 取整） */
  mono: number;
  /** 一次进程启动一个 run */
  run: string;
  kind: EventKind | (string & {});
  /** 产出该事件的模块，例如 "perception.ocr" */
  src: string;
  data: D;
  refs?: ArtifactRef[];
}

/** run id：可排序、无歧义、便于在文件名里直接读。 */
export function makeRunId(at: number = Date.now()): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rnd = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `r-${stamp}-${rnd}`;
}

/** 2026-11-17，按本地时区（给人看的目录用）。 */
export function dayStamp(at: number = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}