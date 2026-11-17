import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillRegistry, SkillError, bindSteps } from "../src/skills/registry.ts";
import { findForbiddenKeys, validateSkill } from "../src/skills/types.ts";

const SKILL_DIR = new URL("../skills/wechat/", import.meta.url).pathname;

function workspaceSkills() {
  return SkillRegistry.loadDir(decodeURIComponent(SKILL_DIR.replace(/^\/([A-Za-z]:)/, "$1")));
}

test("仓库里的三个微信技能全部通过校验", () => {
  const reg = workspaceSkills();
  assert.deepEqual(reg.issues, []);
  assert.deepEqual([...reg.skills.keys()].sort(), [
    "wechat.read_article",
    "wechat.read_link",
    "wechat.read_screen",
    "wechat.read_summary",
    "wechat.save_sticker",
    "wechat.send_sticker",
    "wechat.send_sticker_mood",
    "wechat.send_text",
  ]);
  assert.ok(reg.byIntent("reply_with_sticker").length >= 1, "按情绪发表情与按槽位发表情都挂在 reply_with_sticker 上");
});

test("技能里出现像素坐标就被拒（坐标属于页面图）", () => {
  const reg = workspaceSkills();
  const skill = structuredClone(reg.get("wechat.send_sticker"));
  skill.steps[1] = { op: "act.tap", target: { page: "chat", element: "x" }, args: { x: 540, y: 1200 } };

  const issues = validateSkill(skill);
  const hits = issues.filter((i) => i.message.includes("像素坐标"));
  assert.ok(hits.length >= 2, `期望至少 2 条坐标告警，实际 ${JSON.stringify(issues)}`);
  assert.ok(hits.some((h) => h.path.endsWith(".x")));
});

test("未知操作、预算不够、坏 id 被逐条报出来", () => {
  const base = {
    id: "Bad-Id",
    version: 1,
    title: "x",
    page: "chat",
    intent: "x",
    params: {},
    pre: [{ kind: "page" }],
    steps: [{ op: "act.tap" }, { op: "act.fly" }, { op: "act.back" }],
    post: [{ kind: "element" }],
    budget: { maxSteps: 2, maxMs: 1000 },
    idempotency: "unsafe",
    dryRun: "blocked",
  };
  const issues = validateSkill(base);
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes("id"));
  assert.ok(paths.includes("steps[1].op"));
  assert.ok(paths.includes("budget.maxSteps"));
  assert.ok(paths.includes("dryRun"));
});

test("参数校验给人话，不是错误码", () => {
  const reg = workspaceSkills();
  assert.throws(() => reg.resolve("wechat.send_sticker", {}), (err) => {
    assert.ok(err instanceof SkillError);
    assert.match(err.message, /缺少参数 slot/);
    return true;
  });
  assert.throws(() => reg.resolve("wechat.send_sticker", { slot: 99 }), /不能大于 8/);
  assert.throws(() => reg.resolve("wechat.send_sticker", { slot: 1.5 }), /必须是整数/);
  assert.throws(() => reg.resolve("wechat.nope", {}), /没有技能 wechat\.nope/);
});

test("$参数占位会被填进步骤，且不改动技能本体", () => {
  const reg = workspaceSkills();
  const { skill, params } = reg.resolve("wechat.send_sticker", { slot: 3 });
  const idx = skill.steps.findIndex((s) => s.args && s.args.slot === "$slot");
  assert.ok(idx >= 0, "技能里应有 $slot 占位");
  const steps = bindSteps(skill, params);
  assert.equal(steps[idx].args.slot, 3);
  assert.equal(skill.steps[idx].args.slot, "$slot", "原技能必须保持只读");
});

test("重复 id 的第二个文件被跳过，而不是静默覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  const reg = workspaceSkills();
  const skill = reg.get("wechat.send_sticker");
  writeFileSync(join(dir, "a.json"), JSON.stringify(skill), "utf8");
  writeFileSync(join(dir, "b.json"), JSON.stringify(skill), "utf8");
  const loaded = SkillRegistry.loadDir(dir);
  assert.equal(loaded.skills.size, 1);
  assert.equal(loaded.issues.length, 1);
  assert.match(loaded.issues[0], /id 重复/);
});

test("坏 JSON 不影响其它技能加载", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  const good = workspaceSkills().get("wechat.read_link");
  writeFileSync(join(dir, "good.json"), JSON.stringify(good), "utf8");
  writeFileSync(join(dir, "bad.json"), "{ not json", "utf8");
  const loaded = SkillRegistry.loadDir(dir);
  assert.equal(loaded.skills.size, 1);
  assert.match(loaded.issues[0], /不是合法 JSON/);
});

test("findForbiddenKeys 只在值是数字时报警（元素名里带 x 不算）", () => {
  assert.deepEqual(findForbiddenKeys({ target: { element: "bubble.x" } }), []);
  assert.deepEqual(findForbiddenKeys({ a: [{ y: 3 }] }), ["a[0].y"]);
});