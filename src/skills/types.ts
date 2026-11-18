/**
 * 技能（Skill）——「她能做的一件事」。
 *
 * 为什么是声明式 JSON 而不是代码：
 *  1. 技能要能被回放器按事件重放，JSON 是天然可序列化的计划；
 *  2. 技能要能在没有手机的情况下测（前置/后置断言是纯函数）；
 *  3. 模型只能从闭集里选技能 + 传参数，**不能**自己拼 shell、给坐标、临时发明步骤。
 *
 * 硬纪律：技能里**只出现元素名，不出现像素坐标**。落点由页面图 + Humanizer 决定，
 * 换机 / 换分辨率 / 微信改版时只改页面图，技能不动。
 */

/** 允许的操作原语。新增要升版本——回放器按这个集合解释历史事件。 */
export const OPS = [
  // 动作（唯一能改设备状态的入口）
  "act.tap",
  "act.long_press",
  "act.type",
  "act.paste",
  "act.scroll",
  "act.scroll_to_top",
  "act.back",
  "act.goto_list",
  "act.close_panel",
  "act.tap_link_card",
  "act.tap_sticker_slot",
  "act.clear_input",
  "act.send_current_text",
  "act.open_sticker_panel",
  "act.tap_sticker_mood",
  "act.collect_sticker",
  // 观察（会产出事件/工件）
  "obs.screenshot",
  "obs.ocr",
  "obs.a11y",
  "obs.clipboard",
  "obs.text_bubble",
  // 等待（等真实状态，不睡固定时间）
  "wait.element",
  "wait.text_stable",
  "wait.stable",
  // 判定与流程
  "check",
  "branch",
  "record",
] as const;

export type Op = (typeof OPS)[number];

/** 元素引用：页面图里的名字 + 可选序号（序号由参数或前一步结果填充）。 */
export interface ElementRef {
  page: string;
  element: string;
  /** "$slot" 这样的占位符由 params 或上一步观察填充 */
  index?: string | number;
}

/** 断言：前置、post、check、比较都用同一套。kind 是开放集合，未知的按「不满足」处理。 */
export interface Assertion {
  kind: string;
  value?: unknown;
  /** 失败时的中文说明，直接进事件与人话报错 */
  message?: string;
}

export interface Step {
  op: Op;
  target?: ElementRef;
  args?: Record<string, unknown>;
  /** 内联断言，失败按 onFail 处理 */
  expect?: Assertion[];
  optional?: boolean;
  onFail?: "abort" | "retry" | "skip" | "escalate";
}

export interface ParamSpec {
  type: "string" | "integer" | "boolean" | "enum";
  required?: boolean;
  min?: number;
  max?: number;
  values?: string[];
  desc?: string;
}

export interface Skill {
  /** `namespace.name`，例如 wechat.send_sticker */
  id: string;
  version: number;
  title: string;
  /** 这个技能在哪个页面开始 */
  page: string;
  /** 对应意图层能说的话，例如 reply_with_sticker */
  intent: string;
  params: Record<string, ParamSpec>;
  pre: Assertion[];
  steps: Step[];
  post: Assertion[];
  budget: { maxSteps: number; maxMs: number };
  /** read = 只读、safe = 可重试、unsafe = 不可撤销（发送/删除） */
  idempotency: "read" | "safe" | "unsafe";
  /** dryRun 是否支持（unsafe 技能必须支持，否则不许上线） */
  dryRun: "supported" | "blocked";
}

/** 禁止出现在技能里的键——坐标属于页面图，不属于技能。 */
export const FORBIDDEN_KEYS = ["x", "y", "px", "py", "x1", "y1", "x2", "y2", "left", "top", "width", "height"];

export interface ValidationIssue {
  path: string;
  message: string;
}

const ID_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * 校验一个技能。返回全部问题而不是第一个——改的时候一次改完。
 * 这里刻意不抛异常：加载器要把问题汇总成一条人话给设置页。
 */
export function validateSkill(raw: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bad = (path: string, message: string) => issues.push({ path, message });

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [{ path: "", message: "技能必须是 JSON 对象" }];
  }
  const s = raw as Record<string, unknown>;

  // --- 身份 ---
  if (typeof s["id"] !== "string" || !ID_RE.test(s["id"])) {
    bad("id", "必须是 namespace.name（小写、下划线），例如 wechat.send_sticker");
  }
  if (!Number.isInteger(s["version"]) || (s["version"] as number) < 1) bad("version", "必须是从 1 开始的整数");
  if (typeof s["title"] !== "string" || s["title"].trim() === "") bad("title", "不能为空");
  if (typeof s["page"] !== "string" || s["page"].trim() === "") bad("page", "不能为空");
  if (typeof s["intent"] !== "string" || s["intent"].trim() === "") bad("intent", "不能为空");

  // --- 参数 ---
  const params = s["params"];
  if (params !== undefined) {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      bad("params", "必须是对象");
    } else {
      for (const [name, spec] of Object.entries(params as Record<string, unknown>)) {
        if (typeof spec !== "object" || spec === null) {
          bad(`params.${name}`, "必须是对象");
          continue;
        }
        const p = spec as Record<string, unknown>;
        if (!["string", "integer", "boolean", "enum"].includes(String(p["type"]))) {
          bad(`params.${name}.type`, "必须是 string/integer/boolean/enum");
        }
        if (p["type"] === "enum" && !Array.isArray(p["values"])) {
          bad(`params.${name}.values`, "enum 必须给 values 数组");
        }
      }
    }
  }

  // --- 断言 ---
  const checkAssertions = (list: unknown, path: string, required: boolean) => {
    if (list === undefined) {
      if (required) bad(path, "不能为空数组");
      return;
    }
    if (!Array.isArray(list)) {
      bad(path, "必须是数组");
      return;
    }
    if (required && list.length === 0) bad(path, "至少一条");
    list.forEach((a, i) => {
      if (typeof a !== "object" || a === null) bad(`${path}[${i}]`, "必须是对象");
      else if (typeof (a as Record<string, unknown>)["kind"] !== "string") bad(`${path}[${i}].kind`, "缺少 kind");
    });
  };
  checkAssertions(s["pre"], "pre", true);
  checkAssertions(s["post"], "post", true);

  // --- 步骤 ---
  const steps = s["steps"];
  if (!Array.isArray(steps) || steps.length === 0) {
    bad("steps", "必须是非空数组");
  } else {
    steps.forEach((step, i) => {
      if (typeof step !== "object" || step === null) {
        bad(`steps[${i}]`, "必须是对象");
        return;
      }
      const st = step as Record<string, unknown>;
      if (!OPS.includes(st["op"] as Op)) {
        bad(`steps[${i}].op`, `未知操作：${String(st["op"])}`);
      }
      if (st["target"] !== undefined) {
        const t = st["target"];
        if (typeof t !== "object" || t === null) bad(`steps[${i}].target`, "必须是对象");
        else {
          const tr = t as Record<string, unknown>;
          if (typeof tr["page"] !== "string" || typeof tr["element"] !== "string") {
            bad(`steps[${i}].target`, "需要 page + element");
          }
        }
      }
      if (st["onFail"] !== undefined && !["abort", "retry", "skip", "escalate"].includes(String(st["onFail"]))) {
        bad(`steps[${i}].onFail`, "必须是 abort/retry/skip/escalate");
      }
      checkAssertions(st["expect"], `steps[${i}].expect`, false);
    });
  }

  // --- 预算与性质 ---
  const budget = s["budget"];
  if (typeof budget !== "object" || budget === null) {
    bad("budget", "必须给 {maxSteps, maxMs}");
  } else {
    const b = budget as Record<string, unknown>;
    if (!Number.isInteger(b["maxSteps"]) || (b["maxSteps"] as number) < 1) bad("budget.maxSteps", "正整数");
    if (!Number.isInteger(b["maxMs"]) || (b["maxMs"] as number) < 100) bad("budget.maxMs", "≥100 的整数");
    if (Array.isArray(steps) && Number.isInteger(b["maxSteps"]) && (b["maxSteps"] as number) < steps.length) {
      bad("budget.maxSteps", `小于步骤数 ${steps.length}，永远跑不完`);
    }
  }
  if (!["read", "safe", "unsafe"].includes(String(s["idempotency"]))) {
    bad("idempotency", "必须是 read/safe/unsafe");
  }
  if (!["supported", "blocked"].includes(String(s["dryRun"]))) {
    bad("dryRun", "必须是 supported/blocked");
  }
  if (s["idempotency"] === "unsafe" && s["dryRun"] !== "supported") {
    bad("dryRun", "不可撤销的技能必须支持 dryRun 才能上线");
  }

  // --- 坐标纪律（对整个对象递归检查）---
  for (const hit of findForbiddenKeys(raw)) {
    bad(hit, "技能里不许出现像素坐标（属于页面图）；请改成 target.element");
  }

  return issues;
}

/** 递归找禁用键。返回人类可读路径列表。 */
export function findForbiddenKeys(value: unknown, path = ""): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findForbiddenKeys(v, `${path}[${i}]`)));
    return hits;
  }
  if (typeof value !== "object" || value === null) return hits;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = path === "" ? k : `${path}.${k}`;
    if (FORBIDDEN_KEYS.includes(k) && typeof v === "number") hits.push(next);
    hits.push(...findForbiddenKeys(v, next));
  }
  return hits;
}