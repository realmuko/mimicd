/**
 * 探针结果解析（纯函数，全部可离线测）。
 *
 * 这些东西的价值在于：设备上跑一次，把「微信到底能不能 a11y / 能不能读剪贴板 /
 * 帧稳不稳 / 通知里有没有正文」变成几个数，而不是靠印象。
 */

export interface A11ySummary {
  /** 解析到的 node 总数 */
  nodes: number;
  /** text 非空的节点数 */
  withText: number;
  /** content-desc 非空的节点数 */
  withDesc: number;
  /** 可点击节点数 */
  clickable: number;
  /** 出现过的 package（微信里通常只有 com.tencent.mm） */
  packages: string[];
  /** 前 N 条非空文本，按文档顺序 */
  texts: string[];
  /** class 直方图，判断是不是「只有一层 FrameLayout」 */
  classes: Record<string, number>;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#10;": "\n",
};

export function unxml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#10);/g, (m) => ENTITIES[m] ?? m);
}

/** 解析 uiautomator dump 的 XML。不解码整棵树，只数节点、取文本。 */
export function parseA11yXml(xml: string, maxTexts = 40): A11ySummary {
  const summary: A11ySummary = {
    nodes: 0,
    withText: 0,
    withDesc: 0,
    clickable: 0,
    packages: [],
    texts: [],
    classes: {},
  };
  const pkgs = new Set<string>();
  const nodeRe = /<node\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    summary.nodes++;
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:-]+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1] ?? "")) !== null) attrs[a[1]!] = unxml(a[2]!);

    const cls = attrs["class"] ?? "(none)";
    summary.classes[cls] = (summary.classes[cls] ?? 0) + 1;
    if (attrs["package"]) pkgs.add(attrs["package"]);
    if (attrs["clickable"] === "true") summary.clickable++;

    const text = (attrs["text"] ?? "").trim();
    const desc = (attrs["content-desc"] ?? "").trim();
    if (text) {
      summary.withText++;
      if (summary.texts.length < maxTexts) summary.texts.push(text);
    }
    if (desc) {
      summary.withDesc++;
      if (summary.texts.length < maxTexts) summary.texts.push(`[desc] ${desc}`);
    }
  }
  summary.packages = [...pkgs].sort();
  return summary;
}

export interface NoticeItem {
  title: string;
  text: string;
}

/**
 * 从 `dumpsys notification --noredact` 里取微信通知的标题与正文。
 * 只做保守解析：拿不到就当没有，绝不猜。
 */
export function parseNotifications(dump: string, pkg = "com.tencent.mm"): NoticeItem[] {
  const out: NoticeItem[] = [];
  const blocks = dump.split(/NotificationRecord\(/).slice(1);
  for (const block of blocks) {
    const pkgMatch = /pkg=(\S+)/.exec(block);
    if (!pkgMatch || pkgMatch[1] !== pkg) continue;
    const title = /android\.title=String \((.*?)\)\s*$/m.exec(block)?.[1] ?? "";
    const text =
      /android\.text=String \((.*?)\)\s*$/m.exec(block)?.[1] ??
      /android\.bigText=String \((.*?)\)\s*$/m.exec(block)?.[1] ??
      "";
    if (title || text) out.push({ title: title.trim(), text: text.trim() });
  }
  return out;
}

export interface FrameStats {
  /** PROFILEDATA 里解析到的帧数（末段） */
  frames: number;
  columns: number;
  /** 有数据的段数（多段时取最后一段） */
  segments: number;
}

/**
 * `dumpsys gfxinfo <pkg> framestats` → 帧数。
 * 用来做「等稳定帧」的判据：帧号在涨 = 还在动，不用截图。
 */
export function parseFramestats(dump: string): FrameStats {
  const parts = dump.split("---PROFILEDATA---");
  const segments = Math.max(0, Math.floor((parts.length - 1) / 2));
  const body = parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d/.test(l) && l.includes(","));
  // 列数以表头为准：数据行末尾常带逗号，按数据行数会多出一列。
  const header = body.split("\n").find((l) => /^Flags,/.test(l.trim()));
  const columns = header ? header.split(",").filter((c) => c.trim() !== "").length : 0;
  return { frames: lines.length, columns, segments };
}

/** 键盘/屏幕等状态的一句话摘要，写进报告用。 */
export function summarizeState(props: Record<string, string>): string {
  const bits: string[] = [];
  if (props["wakefulness"]) bits.push(`屏幕:${props["wakefulness"]}`);
  if (props["focus"]) bits.push(`前台:${props["focus"]}`);
  if (props["ime"]) bits.push(`输入法:${props["ime"].split("/")[0]}`);
  return bits.join(" · ");
}