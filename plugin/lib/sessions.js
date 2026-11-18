/**
 * 列出本机 DSH 会话，供设置页选择「唤醒会话」。
 *
 * 数据来源（只读）：
 *   1. `~/.dsh/storages/session_projcache/sessions/*.json`（有标题、工作目录、最后活动时间）
 *   2. 读不到时退回 `~/.dsh/sessions/<工作区>/session-*` 目录（只有 id）
 *
 * 不改任何文件；DSH_HOME 可以覆盖家目录。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

const cacheDir = () => path.join(dshHome(), "storages", "session_projcache", "sessions");
const sessionsDir = () => path.join(dshHome(), "sessions");

const isSessionFile = (name) => /^session-[0-9a-f-]+\.json$/.test(name);

function fromProjectionCache() {
  let files;
  try {
    files = fs.readdirSync(cacheDir()).filter(isSessionFile);
  } catch {
    return null;
  }

  const out = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cacheDir(), file), "utf8"));
      const rows = raw?.record?.rows || {};
      const value = (key) => rows[key]?.val;
      const meta = value("sessionListMetadata") || {};
      if (meta.blank) continue; // 空白会话不列
      const identity = raw?.record?.identity || {};
      out.push({
        id: file.slice(0, -".json".length),
        title: typeof value("title") === "string" ? value("title").trim() : "",
        cwd:
          typeof value("workingDirectory") === "string"
            ? value("workingDirectory")
            : identity.cwd || "",
        createdAt: Number(identity.createdAt) || 0,
        lastAt: Number(meta.lastPromptAt) || Number(identity.createdAt) || 0,
      });
    } catch {
      /* 单个文件坏了不影响其它会话 */
    }
  }
  return out;
}

function fromSessionDirs() {
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(sessionsDir(), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  const out = [];
  for (const workspace of workspaces) {
    let dirs = [];
    try {
      dirs = fs
        .readdirSync(path.join(sessionsDir(), workspace.name), { withFileTypes: true })
        .filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!/^session-/.test(dir.name)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(sessionsDir(), workspace.name, dir.name)).mtimeMs;
      } catch {
        /* ignore */
      }
      out.push({ id: dir.name, title: "", cwd: "", createdAt: 0, lastAt: mtime });
    }
  }
  return out;
}

/** 按最近活动倒序返回会话：{ id, title, cwd, createdAt, lastAt } */
export function listSessions({ limit = 200 } = {}) {
  const cached = fromProjectionCache();
  const all = cached && cached.length ? cached : fromSessionDirs();

  // 同一会话可能出现在多个工作区目录里：按 id 去重，保留 lastAt 更大的
  const byId = new Map();
  for (const s of all) {
    const prev = byId.get(s.id);
    if (!prev || s.lastAt > prev.lastAt) byId.set(s.id, s);
  }

  const n = Math.min(1000, Math.max(1, Math.round(Number(limit) || 200)));
  return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, n);
}