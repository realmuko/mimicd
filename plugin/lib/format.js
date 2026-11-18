/**
 * 纯格式化：把引擎的原始结构压成工具返回值 / 设置页要的小对象。
 * 这里不碰网络和文件，方便单测。
 */

const EVENT_LABELS = {
  "intent.decided": "决定",
  "intent.pending": "挂起待办",
  "intent.skipped": "跳过",
  "send.succeeded": "发出",
  "send.failed": "发送失败",
  "message.seen": "看到消息",
  "action.executed": "动作",
  "action.verified": "动作完成",
  "frame.captured": "截图",
  "plan.planned": "计划",
  note: "备注",
};

export function eventLabel(kind) {
  return EVENT_LABELS[kind] || String(kind || "");
}

/** 会刷屏的「心跳」事件：设置页默认折叠，工具返回里也尽量别带。 */
export function isNoiseEvent(kind) {
  return kind === "message.seen" || kind === "frame.captured" || kind === "action.executed" || kind === "plan.planned";
}

export function formatUptime(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function formatClock(ts) {
  const n = Number(ts);
  if (!n) return "—";
  return new Date(n).toLocaleTimeString("zh-CN", { hour12: false });
}

export function relativeTime(ts, now = Date.now()) {
  const n = Number(ts);
  if (!n) return "未知时间";
  const sec = Math.max(0, Math.round((now - n) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/** 一条事件的摘要（沿用引擎状态页的判断，但只给文本，渲染交给调用方）。 */
export function summarizeEvent(event) {
  const d = event?.data || {};
  const kind = String(event?.kind || "");
  let summary = "";
  switch (kind) {
    case "intent.decided":
      summary = `${d.chat || ""} · 回复=${d.reply} · ${d.reason || ""}`;
      break;
    case "intent.pending":
      summary = `${d.chat || ""} · 已交给主模型${d.injected ? "（测试注入）" : ""}`;
      break;
    case "intent.skipped":
      summary = `${d.chat || ""} · ${d.reason || ""}`;
      break;
    case "send.succeeded":
      summary = [
        d.chat || "",
        d.text ? `文字：${d.text}` : "",
        d.stickerMood ? `表情：${d.stickerMood}` : "",
      ].filter(Boolean).join(" · ");
      break;
    case "send.failed":
      summary = `${d.chat || ""} · ${d.reason || d.error || ""}`;
      break;
    case "message.seen":
      summary = `${d.chat || ""} · ${d.from === "me" ? "我" : d.sender ? String(d.sender) : "对方"}：${d.text || ""}`;
      break;
    case "action.executed":
      summary = `${d.kind || ""}${d.detail?.x != null ? ` (${d.detail.x},${d.detail.y})` : ""}`;
      break;
    case "action.verified":
      summary = d.skill
        ? `技能 ${d.skill} ${d.ok ? "成功" : "失败"} ${d.reason || ""}`
        : `${d.check || ""} ${d.ok ? "ok" : "fail"}`;
      break;
    case "frame.captured":
      summary = `${d.tag || ""} ${d.page || ""} 未读行=${d.unreadRows ?? ""}`;
      break;
    case "plan.planned":
      summary = `技能 ${d.skill || ""} ${JSON.stringify(d.params || {})}`;
      break;
    default:
      summary = typeof d === "object" ? JSON.stringify(d).slice(0, 300) : String(d);
  }
  return {
    t: Number(event?.t) || 0,
    kind,
    label: eventLabel(kind),
    src: String(event?.src || ""),
    noise: isNoiseEvent(kind),
    summary,
  };
}

/** 最近会话：按 lastSeenAt 倒序，去掉 world 里又大又不用的 seen 历史。 */
export function summarizeChats(world, { limit = 50 } = {}) {
  const chats = Object.values(world?.chats ?? {}).map((c) => ({
    name: String(c?.name ?? ""),
    kind: c?.kind === "group" ? "group" : c?.kind === "dm" ? "dm" : "unknown",
    unread: Number(c?.unread) || 0,
    lastText: String(c?.lastText ?? "").slice(0, 160),
    lastFrom: c?.lastFrom === "me" ? "me" : "other",
    lastSeenAt: Number(c?.lastSeenAt) || 0,
    cooldownUntil: Number(c?.cooldownUntil) || 0,
    replies: Array.isArray(c?.replies) ? c.replies.length : 0,
  }));
  chats.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const n = Math.min(200, Math.max(1, Math.round(Number(limit) || 50)));
  return chats.slice(0, n);
}

/** 待办列表：给工具/设置页用，算好「几秒前」「还剩几秒」。 */
export function summarizePending(items, now = Date.now()) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id ?? ""),
    chat: String(item?.chat ?? ""),
    kind: item?.kind === "group" ? "group" : item?.kind === "dm" ? "dm" : "unknown",
    createdAt: Number(item?.createdAt) || 0,
    ageSec: Math.max(0, Math.round((now - (Number(item?.createdAt) || now)) / 1000)),
    expiresInSec: Math.max(0, Math.round(((Number(item?.expiresAt) || now) - now) / 1000)),
    needsJudgment: Boolean(item?.needsJudgment),
    status: String(item?.status ?? "open"),
    messages: (Array.isArray(item?.messages) ? item.messages : []).slice(-8).map((m) => ({
      from: m?.from === "me" ? "me" : "other",
      sender: m?.sender ? String(m.sender) : "",
      text: String(m?.text ?? ""),
    })),
  }));
}