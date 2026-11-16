/**
 * OCR 端口：调 Windows 自带的 OCR 引擎（tools/ocr/ocr.ps1）。
 *
 * 为什么用 Windows OCR：这台机器上没有 Python、也不想为 OCR 引云 API；
 * Windows.Media.Ocr 自带中英文识别，离线、免费、一次 ~0.5–1s。
 *
 * 接口按「区域 OCR」设计：微信里我们几乎总是只关心某一块（气泡、正文、标题栏），
 * 整屏 OCR 既慢又容易被无关文字污染。
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type { Rect } from "../image/image.ts";

const run = promisify(execFile);

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrResult {
  lines: OcrLine[];
  ms: number;
  /** 拼起来的整段文本（按行，已去掉中文之间的空格） */
  text: string;
}

export interface OcrOptions {
  /** PowerShell 脚本路径 */
  script: string;
  /** 截图落盘的临时目录 */
  workDir: string;
  /** 放大倍数：小字（聊天气泡）用 3，整屏正文 2 就够 */
  scale?: number;
}

export class Ocr {
  readonly #script: string;
  readonly #workDir: string;
  readonly #scale: number;

  constructor(opts: OcrOptions) {
    this.#script = opts.script;
    this.#workDir = opts.workDir;
    this.#scale = opts.scale ?? 2;
    mkdirSync(this.#workDir, { recursive: true });
  }

  /** 对 PNG 字节做 OCR；region 用原图像素坐标。 */
  async recognize(png: Buffer, region?: Rect): Promise<OcrResult> {
    const file = join(this.#workDir, `ocr-${randomUUID()}.png`);
    writeFileSync(file, png);
    const t0 = Date.now();
    try {
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.#script,
        "-Png",
        file,
        "-Scale",
        String(this.#scale),
      ];
      if (region) {
        args.push(
          "-X",
          String(Math.round(region.x)),
          "-Y",
          String(Math.round(region.y)),
          "-W",
          String(Math.round(region.w)),
          "-H",
          String(Math.round(region.h)),
        );
      }
      const { stdout } = await run("powershell", args, {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout.trim()) as { lines?: OcrLine[] };
      const lines = (parsed.lines ?? []).map((l) => ({
        text: String(l.text ?? ""),
        x: Number(l.x ?? 0),
        y: Number(l.y ?? 0),
        w: Number(l.w ?? 0),
        h: Number(l.h ?? 0),
      }));
      return { lines, text: lines.map((l) => despaceCjk(l.text)).join("\n"), ms: Date.now() - t0 };
    } finally {
      try {
        unlinkSync(file);
      } catch {
        // 临时文件删不掉不影响结果
      }
    }
  }
}

/**
 * Windows OCR 会把中文逐字用空格隔开（「你 ， 想 家 了」）。
 * 比对/入库前去掉 CJK 之间的空格，但保留西文单词之间的空格。
 */
export function despaceCjk(text: string): string {
  return text
    .replace(/([\u3000-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u9fff\uff00-\uffef])/g, "$1")
    .replace(/\s+([，。！？、：；（）《》])/g, "$1")
    .trim();
}