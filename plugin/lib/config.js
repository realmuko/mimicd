/**
 * 插件配置：`<plugin>/wechat-mimicd.config.json`。
 *
 * 只认两个段：
 *   bridge: { enabled, engineUrl, sessionId, intervalMs }
 *   tools:  { enabled }
 *
 * 写文件走「临时文件 + rename」，避免设置页保存到一半留下半截 JSON。
 * 环境变量 `WECHAT_MIMICD_CONFIG` 可以把配置文件指到别处（测试/多实例用）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 插件根目录（lib/ 的上一级）。 */
export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 插件自己的运行数据（日志等）；mimicd 仓库的 .gitignore 已忽略 data/。 */
export const DATA_DIR = path.join(PLUGIN_ROOT, "data");

export const DEFAULT_CONFIG = {
  bridge: {
    enabled: true,
    engineUrl: "http://127.0.0.1:65480",
    sessionId: "",
    intervalMs: 8000,
  },
  tools: {
    enabled: true,
  },
};

export function configPath() {
  return process.env.WECHAT_MIMICD_CONFIG || path.join(PLUGIN_ROOT, "wechat-mimicd.config.json");
}

export function exampleConfigPath() {
  return path.join(PLUGIN_ROOT, "wechat-mimicd.config.example.json");
}

/** 引擎的配置：默认在插件目录的上一级（mimicd 仓库）的 data/config.json。 */
export function engineConfigPath() {
  return process.env.MIMICD_CONFIG || path.resolve(PLUGIN_ROOT, "..", "data", "config.json");
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 首次运行没有配置时，从示例复制一份；示例也丢了就写默认值。 */
function ensureConfig(file) {
  if (fs.existsSync(file)) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(exampleConfigPath())) fs.copyFileSync(exampleConfigPath(), file);
    else fs.writeFileSync(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  } catch {
    /* 写不了就算了：读配置时用默认值，插件照常启动 */
  }
}

/**
 * 合并一份配置补丁。只接受已知字段 + 类型/范围校验，
 * 设置页传来的脏数据不会把配置写坏。
 */
export function mergeConfig(base, patch = {}) {
  const out = {
    bridge: { ...DEFAULT_CONFIG.bridge, ...(base?.bridge ?? {}) },
    tools: { ...DEFAULT_CONFIG.tools, ...(base?.tools ?? {}) },
  };

  const b = patch?.bridge;
  if (b && typeof b === "object") {
    if (typeof b.enabled === "boolean") out.bridge.enabled = b.enabled;
    if (typeof b.engineUrl === "string" && b.engineUrl.trim()) {
      const url = b.engineUrl.trim().replace(/\/+$/, "");
      if (/^https?:\/\/[^\s]+$/i.test(url)) out.bridge.engineUrl = url;
    }
    // sessionId 允许清空（空的 = 不叫醒任何会话）
    if (typeof b.sessionId === "string") out.bridge.sessionId = b.sessionId.trim();
    if (b.intervalMs !== undefined) {
      out.bridge.intervalMs = clampInt(b.intervalMs, 2000, 120000, out.bridge.intervalMs);
    }
  }

  const t = patch?.tools;
  if (t && typeof t === "object" && typeof t.enabled === "boolean") {
    out.tools.enabled = t.enabled;
  }

  return out;
}

/**
 * 读配置。坏文件不抛错：返回默认值 + error，让设置页把问题显示出来，
 * 而不是让整个插件加载失败。
 */
export function configInfo(file = configPath()) {
  ensureConfig(file);
  const info = { path: file, mtime: 0, cfg: mergeConfig(DEFAULT_CONFIG, {}), error: null };
  try {
    const raw = fs.readFileSync(file, "utf8");
    info.mtime = fs.statSync(file).mtimeMs;
    info.cfg = mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (err) {
    info.error = `读配置失败（${file}）：${err?.message || err}`;
  }
  return info;
}

export function loadConfig(file = configPath()) {
  return configInfo(file).cfg;
}

/** 保存一份补丁；返回保存后的完整配置信息。 */
export function saveConfig(patch, file = configPath()) {
  const current = configInfo(file);
  if (current.error && !patch) throw new Error(current.error);
  const next = mergeConfig(current.cfg, patch ?? {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return { path: file, mtime: fs.statSync(file).mtimeMs, cfg: next, error: null };
}

/**
 * 读引擎的配置（只读展示用）。
 * 引擎的 HTTP 层没有写配置的接口，所以设置页只能展示 + 提示文件路径。
 */
export function engineConfigInfo(file = engineConfigPath()) {
  const out = { path: file, exists: false, mtime: 0, data: null, error: null };
  try {
    const raw = fs.readFileSync(file, "utf8");
    out.exists = true;
    out.mtime = fs.statSync(file).mtimeMs;
    out.data = JSON.parse(raw);
  } catch (err) {
    if (err?.code !== "ENOENT") out.error = `读引擎配置失败（${file}）：${err?.message || err}`;
  }
  return out;
}