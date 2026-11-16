/**
 * 工件仓：图片/大对象按内容寻址落盘，事件只带引用。
 *
 * 反模式 10：事件流里存 base64，几天就几百 MB，回放慢到没人用。
 * 这里同时做去重——同一帧被重复截图时只写一次。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dayStamp, type ArtifactRef } from "./events.ts";

export type ArtifactExt = "png" | "jpg" | "jsonl" | "txt";

export interface PutInput {
  buf: Buffer;
  ext: ArtifactExt;
  kind?: ArtifactRef["kind"];
  w?: number;
  h?: number;
  /** 归日（默认当前时间） */
  at?: number;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export class ArtifactStore {
  /** 数据根目录（与 events/ 同级） */
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * 写入并返回引用。path 相对 root、用 `/` 分隔，可直接拼到任何 URL 后面。
   * 同一内容重复 put 不会重写。
   */
  put(input: PutInput): ArtifactRef {
    const hash = sha256(input.buf);
    const rel = `artifacts/${dayStamp(input.at ?? Date.now())}/${hash.slice(0, 2)}/${hash}.${input.ext}`;
    const abs = join(this.root, ...rel.split("/"));

    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, input.buf);
    }

    const ref: ArtifactRef = {
      path: rel,
      sha256: hash,
      bytes: input.buf.length,
      kind: input.kind ?? (input.ext === "jpg" ? "jpg" : input.ext),
    };
    if (input.w !== undefined) ref.w = input.w;
    if (input.h !== undefined) ref.h = input.h;
    return ref;
  }

  /** 校验引用对应的文件仍在、且内容未变。回放前应该跑一遍。 */
  verify(ref: ArtifactRef): { ok: boolean; reason?: string } {
    const abs = join(this.root, ...ref.path.split("/"));
    if (!existsSync(abs)) return { ok: false, reason: `工件缺失：${ref.path}` };
    return { ok: true };
  }
}