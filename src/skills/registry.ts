/**
 * 技能库：加载、校验、解析参数。
 *
 * 加载失败**不是**启动失败：坏技能被跳过并列进 `issues`，设置页把那几行原样显示。
 * 一个坏技能不该让她整个不能动。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateSkill, type Skill, type ValidationIssue } from "./types.ts";

export interface LoadReport {
  skills: Map<string, Skill>;
  /** `${file}: ${path} ${message}` 形式，直接能给用户看 */
  issues: string[];
  files: string[];
}

export class SkillRegistry {
  readonly skills = new Map<string, Skill>();
  readonly issues: string[] = [];
  readonly files: string[] = [];

  static loadDir(dir: string): SkillRegistry {
    const reg = new SkillRegistry();
    if (!existsSync(dir)) {
      reg.issues.push(`技能目录不存在：${dir}`);
      return reg;
    }
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      reg.files.push(name);
      reg.addFile(file, name);
    }
    return reg;
  }

  addFile(file: string, label = file): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      this.issues.push(`${label}: 不是合法 JSON（${(err as Error).message}）`);
      return;
    }
    const problems: ValidationIssue[] = validateSkill(raw);
    if (problems.length > 0) {
      for (const p of problems) this.issues.push(`${label}: ${p.path || "(根)"} ${p.message}`);
      return;
    }
    const skill = raw as Skill;
    if (this.skills.has(skill.id)) {
      this.issues.push(`${label}: 技能 id 重复（${skill.id}），后一个被忽略`);
      return;
    }
    this.skills.set(skill.id, skill);
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  /** 意图 → 候选技能（意图层只能从这里面选）。 */
  byIntent(intent: string): Skill[] {
    return [...this.skills.values()].filter((s) => s.intent === intent);
  }

  /**
   * 参数解析：检查必填/类型/范围，把 `$name` 占位符替换成实际值。
   * 失败返回人话错误（给模型看的那种），而不是异常码。
   */
  resolve(id: string, params: Record<string, unknown> = {}): { skill: Skill; params: Record<string, unknown> } {
    const skill = this.get(id);
    if (!skill) {
      const known = [...this.skills.keys()].join("、") || "（空）";
      throw new SkillError(`没有技能 ${id}。可用：${known}`);
    }
    const resolved: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(skill.params)) {
      const given = params[name];
      if (given === undefined) {
        if (spec.required !== false) {
          throw new SkillError(`技能 ${id} 缺少参数 ${name}${spec.desc ? `（${spec.desc}）` : ""}`);
        }
        continue;
      }
      if (spec.type === "integer") {
        if (!Number.isInteger(given)) throw new SkillError(`参数 ${name} 必须是整数，收到 ${JSON.stringify(given)}`);
        const n = given as number;
        if (spec.min !== undefined && n < spec.min) throw new SkillError(`参数 ${name} 不能小于 ${spec.min}`);
        if (spec.max !== undefined && n > spec.max) throw new SkillError(`参数 ${name} 不能大于 ${spec.max}`);
      } else if (spec.type === "boolean") {
        if (typeof given !== "boolean") throw new SkillError(`参数 ${name} 必须是 true/false`);
      } else if (spec.type === "enum") {
        if (!spec.values?.includes(String(given))) {
          throw new SkillError(`参数 ${name} 只能是：${spec.values?.join(" / ")}`);
        }
      } else if (typeof given !== "string") {
        throw new SkillError(`参数 ${name} 必须是字符串`);
      }
      resolved[name] = given;
    }
    // 参数里出现技能没声明的字段：不报错，但也不进 resolved（避免拼错参数被静默忽略）
    return { skill, params: resolved };
  }
}

export class SkillError extends Error {
  override name = "SkillError";
}

/** 把步骤里的 `$name` 占位填上。返回新对象，不改技能本体（技能是共享只读的）。 */
export function bindSteps(skill: Skill, params: Record<string, unknown>): Skill["steps"] {
  const sub = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$")) {
      const key = v.slice(1);
      return params[key] ?? v;
    }
    if (Array.isArray(v)) return v.map(sub);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = sub(val);
      return out;
    }
    return v;
  };
  return sub(skill.steps) as Skill["steps"];
}