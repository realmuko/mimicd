window.__ModuleLoader__.load({
  id: "dsh-mimicd-wechat",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const inject = ["slots"];

    // 宿主侧的小 API（见 lib/api.js）：只监听 127.0.0.1:65482
    const API = "http://127.0.0.1:65482";
    const ENGINE_DASH = "http://127.0.0.1:65480/dash";

    const readJson = async (res) => {
      const raw = await res.text();
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`HTTP ${res.status}: ${raw.slice(0, 160)}`);
      }
    };

    const clone = (v) => JSON.parse(JSON.stringify(v ?? {}));

    function rel(ts) {
      const t = Number(ts || 0);
      if (!t) return "—";
      const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (sec < 60) return `${sec} 秒前`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min} 分钟前`;
      const hour = Math.floor(min / 60);
      if (hour < 24) return `${hour} 小时前`;
      return `${Math.floor(hour / 24)} 天前`;
    }

    function clock(ts) {
      const t = Number(ts || 0);
      if (!t) return "—";
      return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
    }

    function secs(ms) {
      const n = Number(ms || 0);
      if (!n) return "0s";
      const s = Math.round(n / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
      return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
    }

    function shortId(id) {
      const s = String(id || "");
      return s.length > 8 ? `${s.slice(0, 8)}…` : s;
    }

    function baseName(p) {
      const s = String(p || "").replace(/[\\/]+$/, "");
      const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
      return i >= 0 ? s.slice(i + 1) : s;
    }

    const S = {
      page: { padding: "18px 20px 40px", maxWidth: 880, font: "inherit", color: "inherit", fontSize: 13, lineHeight: 1.6 },
      head: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, margin: "0 0 4px" },
      h1: { fontSize: 15, fontWeight: 600, margin: 0 },
      sub: { opacity: 0.6, margin: "0 0 14px", fontSize: 12, lineHeight: 1.6 },
      group: { border: "1px solid rgba(127,127,127,.22)", borderRadius: 10, padding: "12px 14px", margin: "0 0 12px" },
      groupTitle: {
        fontSize: 12, fontWeight: 600, opacity: 0.75, margin: "0 0 10px", letterSpacing: 0.2,
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap",
      },
      cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 8, margin: "0 0 12px" },
      card: { background: "rgba(127,127,127,.07)", borderRadius: 8, padding: "8px 10px", minWidth: 0 },
      cardK: { fontSize: 11, opacity: 0.55, marginBottom: 3 },
      cardV: { fontSize: 12.5, fontWeight: 600, wordBreak: "break-all", lineHeight: 1.45 },
      row: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px", flexWrap: "wrap" },
      label: { width: 124, flex: "none", opacity: 0.7, fontSize: 12 },
      input: {
        flex: 1, minWidth: 120, height: 28, padding: "0 8px", fontSize: 12, font: "inherit",
        color: "inherit", background: "rgba(127,127,127,.10)",
        border: "1px solid rgba(127,127,127,.25)", borderRadius: 7, outline: "none",
      },
      num: {
        width: 92, height: 28, padding: "0 8px", fontSize: 12, font: "inherit", color: "inherit",
        background: "rgba(127,127,127,.10)", border: "1px solid rgba(127,127,127,.25)", borderRadius: 7, outline: "none",
      },
      select: {
        flex: 1, minWidth: 180, height: 30, padding: "0 6px", fontSize: 12, font: "inherit", color: "inherit",
        background: "rgba(127,127,127,.10)", border: "1px solid rgba(127,127,127,.25)", borderRadius: 7, outline: "none",
      },
      btn: {
        height: 28, padding: "0 12px", fontSize: 12, font: "inherit", color: "inherit",
        background: "rgba(127,127,127,.12)", border: "1px solid rgba(127,127,127,.28)", borderRadius: 8, cursor: "pointer",
      },
      btnPrimary: {
        height: 28, padding: "0 14px", fontSize: 12, font: "inherit", color: "#fff",
        background: "#2563eb", border: "1px solid #2563eb", borderRadius: 8, cursor: "pointer",
      },
      btnDanger: {
        height: 28, padding: "0 12px", fontSize: 12, font: "inherit", color: "#b91c1c",
        background: "rgba(220,38,38,.08)", border: "1px solid rgba(220,38,38,.35)", borderRadius: 8, cursor: "pointer",
      },
      note: { fontSize: 11, opacity: 0.55, marginTop: 6, lineHeight: 1.6 },
      table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
      th: { textAlign: "left", padding: "5px 6px", fontWeight: 600, opacity: 0.6, borderBottom: "1px solid rgba(127,127,127,.2)" },
      td: { padding: "5px 6px", borderBottom: "1px solid rgba(127,127,127,.12)", verticalAlign: "top" },
      pre: {
        fontSize: 11.5, whiteSpace: "pre-wrap", background: "rgba(127,127,127,.08)", borderRadius: 8,
        padding: "8px 10px", margin: "6px 0 0", lineHeight: 1.6, wordBreak: "break-all",
      },
      events: { maxHeight: 260, overflow: "auto", border: "1px solid rgba(127,127,127,.18)", borderRadius: 8, padding: "4px 8px", fontSize: 11.5 },
      evRow: { display: "flex", gap: 8, padding: "2px 0", borderBottom: "1px solid rgba(127,127,127,.08)", lineHeight: 1.55 },
      evT: { opacity: 0.5, flex: "none", fontVariantNumeric: "tabular-nums" },
      evK: { opacity: 0.7, flex: "none", minWidth: 52 },
      item: { display: "flex", gap: 10, alignItems: "flex-start", padding: "7px 0", borderBottom: "1px solid rgba(127,127,127,.1)" },
      code: { fontFamily: "ui-monospace,Consolas,monospace" },
      link: { color: "#2563eb", textDecoration: "none", fontSize: 11.5 },
      msg: (ok) => ({ marginTop: 8, fontSize: 12, color: ok ? "#16a34a" : "#dc2626", whiteSpace: "pre-wrap" }),
    };

    function Dot(ok) {
      return h("span", {
        style: {
          display: "inline-block", width: 8, height: 8, borderRadius: 4, marginRight: 6,
          background: ok ? "#16a34a" : "#9ca3af", verticalAlign: "middle",
        },
      });
    }

    function Card({ label, value, tone }) {
      return h("div", { style: S.card },
        h("div", { style: S.cardK }, label),
        h("div", { style: { ...S.cardV, ...(tone ? { color: tone } : {}) } }, value));
    }

    function Row({ label, children }) {
      return h("div", { style: S.row }, h("span", { style: S.label }, label), children);
    }

    function Panel({ title, right, children }) {
      return h("div", { style: S.group },
        h("div", { style: S.groupTitle }, h("span", {}, title), right || null),
        children);
    }

    function MimicdSection() {
      const [ov, setOv] = React.useState(null);
      const [err, setErr] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [notice, setNotice] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [sessions, setSessions] = React.useState([]);
      const [showNoise, setShowNoise] = React.useState(false);
      const initialized = React.useRef(false);

      const load = React.useCallback(async () => {
        try {
          const json = await readJson(await fetch(`${API}/overview`));
          if (!json.ok) throw new Error(json.error || "读取失败");
          setOv(json);
          setErr("");
          if (!initialized.current) {
            initialized.current = true;
            setDraft(clone(json.config));
          }
        } catch (e) {
          setErr(String(e?.message || e));
        }
      }, []);

      React.useEffect(() => {
        load();
        const timer = setInterval(load, 3000);
        return () => clearInterval(timer);
      }, [load]);

      React.useEffect(() => {
        fetch(`${API}/sessions?limit=80`)
          .then(readJson)
          .then((json) => setSessions(Array.isArray(json.sessions) ? json.sessions : []))
          .catch(() => setSessions([]));
      }, []);

      const post = async (path, body, key, doneText) => {
        setBusy(key);
        setNotice(null);
        try {
          const json = await readJson(await fetch(`${API}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
          }));
          if (!json.ok) throw new Error(json.error || "操作失败");
          setNotice({ ok: true, text: json.message || doneText || "完成" });
          await load();
          return json;
        } catch (e) {
          setNotice({ ok: false, text: String(e?.message || e) });
          return null;
        } finally {
          setBusy("");
        }
      };

      const patchDraft = (fn) => {
        setDraft((current) => {
          const next = clone(current);
          fn(next);
          return next;
        });
      };

      const saveConfig = async () => {
        if (!draft) return;
        setBusy("save");
        setNotice(null);
        try {
          const json = await readJson(await fetch(`${API}/config`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bridge: draft.bridge, tools: draft.tools }),
          }));
          if (!json.ok) throw new Error(json.error || "保存失败");
          setDraft(clone(json.config));
          setNotice({ ok: true, text: "已保存；桥接已按新配置重启。" });
          await load();
        } catch (e) {
          setNotice({ ok: false, text: `保存失败：${e?.message || e}` });
        } finally {
          setBusy("");
        }
      };

      const engine = ov?.engine || {};
      const health = engine.health || {};
      const bridge = ov?.bridge || {};
      const engineCfg = ov?.engineConfig || {};
      const policy = engineCfg.policy || {};
      const autochat = engineCfg.autochat || {};
      const proactive = engineCfg.proactive || {};
      const pending = ov?.pending || { count: 0, items: [] };
      const chats = ov?.chats || [];
      const events = ov?.events || [];
      const stickers = ov?.stickers || { total: 0, moods: {} };
      const cfg = draft || ov?.config || { bridge: {}, tools: {} };
      // 会话对齐的候选：引擎见过的会话 + 白名单里的（白名单里可能有还没进过的群）
      const chatSessionNames = [...new Set([...(chats || []).map((c) => c.name), ...(policy.whitelist || [])])]
        .filter(Boolean);
      // 每个会话一行：左边名字，右边挑一个 DSH 会话（空 = 用默认唤醒会话）
      const chatSessionRows = chatSessionNames.map((name) => h("div", {
        key: name,
        style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
      },
        h("span", {
          style: { width: 168, flex: "none", fontSize: 12, wordBreak: "break-all", opacity: 0.8 },
          title: name,
        }, name),
        h("select", {
          style: { ...S.select, flex: 1, minWidth: 0, maxWidth: "100%" },
          value: (cfg.bridge?.chatSessions || {})[name] || "",
          onChange: (e) => patchDraft((c) => {
            const map = { ...(c.bridge?.chatSessions || {}) };
            if (e.target.value) map[name] = e.target.value;
            else delete map[name];
            c.bridge = { ...(c.bridge || {}), chatSessions: map };
          }),
        },
          h("option", { value: "" }, "（用上面的默认唤醒会话）"),
          sessions.map((s) => h("option", { key: s.id, value: s.id },
            `${s.title || shortId(s.id)} · ${baseName(s.cwd) || "?"} · ${rel(s.lastAt)}`)))));

      const online = Boolean(engine.online);
      const running = Boolean(bridge.running);
      const canControl = online && !busy;
      const cooldownLeft = (ts) => {
        const left = Math.ceil((Number(ts || 0) - Date.now()) / 1000);
        return left > 0 ? `${left}s` : "—";
      };

      const statusLine = online
        ? `${health.paused ? "已暂停" : "运行中"}${health.dryRun ? " · dry-run" : " · 真发"} · 已跑 ${health.uptime || "—"}`
        : "连不上引擎";

      const headerButtons = h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        h("button", {
          style: S.btn,
          disabled: !canControl,
          onClick: () => post("/control", { action: health.paused ? "resume" : "pause" }, "pause"),
        }, health.paused ? "恢复" : "暂停"),
        h("button", {
          style: S.btn,
          disabled: !canControl,
          onClick: () => post("/control", { action: health.dryRun ? "wet" : "dry_run" }, "dry"),
        }, health.dryRun ? "恢复真发" : "切到干跑"),
        h("button", {
          style: S.btnPrimary,
          disabled: !canControl || busy === "tick",
          onClick: () => post("/tick", {}, "tick"),
        }, busy === "tick" ? "跑一轮…" : "强制跑一轮"),
        h("button", { style: S.btn, disabled: Boolean(busy), onClick: () => load() }, "刷新"));

      const monitor = h("div", {},
        h("div", { style: S.cards },
          h(Card, {
            label: "引擎",
            value: online ? `${health.paused ? "已暂停" : "运行中"}${health.dryRun ? " · dry-run" : ""}` : "离线",
            tone: online ? (health.paused ? "#b45309" : "#16a34a") : "#dc2626",
          }),
          h(Card, { label: "设备", value: health.device ? `${health.device.online ? "在线" : "离线"} · ${health.device.page || "?"} · ${String(health.device.focus || "").split("/").pop() || "?"}` : "—" }),
          h(Card, {
            label: "最后一轮",
            value: health.lastTick
              ? `${clock(health.lastTick.at)} · ${health.lastTick.acted ? "有动作" : "不动"} · ${health.lastTick.reason || ""}${health.lastTick.chat ? ` · ${health.lastTick.chat}` : ""}`
              : "还没跑过",
          }),
          h(Card, { label: "待办 / 表情", value: `${pending.count} 条 · ${stickers.total} 张` })));

      const chatsTable = h("table", { style: S.table },
        h("thead", {}, h("tr", {},
          h("th", { style: S.th }, "会话"),
          h("th", { style: S.th }, "类型"),
          h("th", { style: S.th }, "未读"),
          h("th", { style: S.th }, "最后一条"),
          h("th", { style: S.th }, "活跃"),
          h("th", { style: S.th }, "冷却"))),
        h("tbody", {}, chats.length === 0
          ? h("tr", {}, h("td", { style: S.td, colSpan: 6 }, "还没有会话记录（引擎跑几轮就有了）"))
          : chats.slice(0, 20).map((chat) => h("tr", { key: chat.name },
            h("td", { style: { ...S.td, fontWeight: 600 } }, chat.name),
            h("td", { style: S.td }, chat.kind === "group" ? "群" : "私聊"),
            h("td", { style: S.td }, chat.unread || "—"),
            h("td", { style: { ...S.td, maxWidth: 280, opacity: 0.85 } }, (chat.lastFrom === "me" ? "我：" : "") + (chat.lastText || "—")),
            h("td", { style: S.td }, rel(chat.lastSeenAt)),
            h("td", { style: S.td }, cooldownLeft(chat.cooldownUntil))))));

      const pendingPanel = h("div", { style: { marginTop: 12 } },
        h("div", { style: S.groupTitle }, h("span", {}, "待办队列"), h("span", { style: { opacity: 0.5, fontWeight: 400 } }, `${pending.count} 条`)),
        pending.items.length === 0
          ? h("div", { style: { fontSize: 12, opacity: 0.55 } }, "没有待办。引擎判断「该回了」时，这里会出现一条；桥接会同时叫醒会话。")
          : pending.items.map((item) => h("div", { key: item.id, style: S.item },
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: 12 } },
                h("b", {}, item.chat),
                h("span", { style: { opacity: 0.6 } }, `（${item.kind === "group" ? "群" : item.kind === "dm" ? "私聊" : "未知"}）`),
                ` · ${item.ageSec}s 前 · 还剩 ${item.expiresInSec}s`,
                item.needsJudgment ? " · 没 @，等判断" : "",
                h("span", { style: { opacity: 0.5, fontSize: 11 } }, ` · #${shortId(item.id)}`)),
              h("div", { style: { fontSize: 11.5, opacity: 0.7, marginTop: 2, wordBreak: "break-word" } },
                item.messages.map((m) => `${m.from === "me" ? "我" : m.sender || "对方"}：${m.text}`).join("　｜　"))),
            h("button", {
              style: S.btnDanger,
              disabled: Boolean(busy),
              onClick: () => post("/pending/skip", { id: item.id, reason: "设置页手动忽略" }, `skip:${item.id}`),
            }, busy === `skip:${item.id}` ? "跳过中…" : "跳过"))));

      const visibleEvents = events
        .filter((e) => showNoise || !e.noise)
        .slice()
        .reverse()
        .slice(0, 40);

      const eventsPanel = h("div", { style: { marginTop: 12 } },
        h("div", { style: S.groupTitle },
          h("span", {}, "事件流"),
          h("span", { style: { display: "flex", gap: 10, alignItems: "center", fontWeight: 400, opacity: 0.75 } },
            h("label", { style: { fontSize: 11, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" } },
              h("input", { type: "checkbox", checked: showNoise, onChange: (e) => setShowNoise(e.target.checked) }),
              "显示心跳事件"),
            h("a", { href: ENGINE_DASH, target: "_blank", rel: "noreferrer", style: S.link }, "引擎状态页"))),
        h("div", { style: S.events },
          visibleEvents.length === 0
            ? h("div", { style: { opacity: 0.55, padding: 4 } }, showNoise ? "还没有事件" : "没有重要事件（勾选「显示心跳事件」看全部）")
            : visibleEvents.map((event, i) => h("div", {
              key: `${event.t}-${event.kind}-${i}`,
              style: { ...S.evRow, opacity: event.noise ? 0.45 : 1 },
            },
            h("span", { style: S.evT }, clock(event.t)),
            h("span", { style: S.evK }, event.label || event.kind),
            h("span", { style: { flex: 1, minWidth: 0, wordBreak: "break-word" } }, event.summary || "")))));

      const engineConfigPanel = h("div", {},
        h(Row, { label: "配置文件" }, h("span", { style: { ...S.code, fontSize: 11.5, wordBreak: "break-all" } }, engineCfg.path || "—")),
        h(Row, { label: "白名单" }, h("span", {}, (policy.whitelist || []).join("、") || "（空 = 不限制）")),
        h(Row, { label: "群聊策略" }, h("span", {},
          policy.groupStrategy === "judge"
            ? "judge —— 没 @ 也交给主模型判断要不要接"
            : "mention —— 只回 @ 我的")),
        h(Row, { label: "静默时段" }, h("span", {},
          Array.isArray(policy.quietHours) && policy.quietHours.length === 2
            ? `${policy.quietHours[0]}–${policy.quietHours[1]} 点`
            : "关")),
        h(Row, { label: "同会话最小间隔" }, h("span", {}, secs(policy.minGapMs))),
        h(Row, { label: "每小时上限" }, h("span", {}, `${policy.maxPerHour} 条`)),
        h(Row, { label: "单条字数上限" }, h("span", {}, `${policy.maxReplyChars} 字`)),
        h(Row, { label: "同会话冷却" }, h("span", {}, secs(autochat.perChatCooldownMs))),
        h(Row, { label: "主动搭话" }, h("span", {},
          `${proactive.maxPerHour}/小时 · ${proactive.maxPerDay}/天 · ${proactive.allowGroups ? "允许进群" : "不进群"}`)),
        h(Row, { label: "表情" }, h("span", {},
          `文字回复带表情概率 ${Math.round((Number((ov?.engineConfig?.reply || {}).stickerChance) || 0) * 100)}% · 同会话冷却 ${(ov?.engineConfig?.reply || {}).stickerCooldownMin || 0} 分钟`)),
        h(Row, { label: "合并窗口" }, h("span", { style: { opacity: 0.85 } },
          `${secs(policy.mergeWindowMs)}（对方一句话拆几条发时先攒着）· 最多拖 ${secs(policy.maxMergeWaitMs)} 强制放行`)),
        h("div", { style: S.note },
          engineCfg.error
            ? engineCfg.error
            : engineCfg.note || "引擎配置由引擎自己读取；HTTP 层没有写配置的接口，所以这里只展示。要改就编辑上面的 JSON 文件并重启引擎（改完不用重装插件）。"));

      const bridgeRuntime = [
        running
          ? `轮询中 · 每 ${Math.round((bridge.intervalMs || 8000) / 1000)}s · 上次轮询 ${rel(bridge.lastPollAt)}`
          : `未运行（${bridge.reason || "未知"}）`,
        bridge.lastWakeAt ? `上次叫醒 ${rel(bridge.lastWakeAt)}` : "还没叫醒过会话",
        bridge.watchdogResets ? `看门狗复位 ${bridge.watchdogResets} 次` : "",
        bridge.lastError ? `最后错误：${bridge.lastError}` : "",
        bridge.scheduleAvailable ? "" : "schedule 服务不可用",
      ].filter(Boolean).join(" · ");

      const pluginConfigPanel = h("div", {},
        h(Row, { label: "启用桥接" },
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: Boolean(cfg.bridge?.enabled),
              onChange: (e) => patchDraft((c) => { c.bridge = { ...(c.bridge || {}), enabled: e.target.checked }; }),
            }),
            "把引擎的待办叫醒成一个 DSH 会话")),
        h(Row, { label: "引擎地址" },
          h("input", {
            style: S.input, type: "text", spellCheck: false,
            value: cfg.bridge?.engineUrl || "",
            onChange: (e) => patchDraft((c) => { c.bridge = { ...(c.bridge || {}), engineUrl: e.target.value }; }),
          })),
        h(Row, { label: "轮询间隔（ms）" },
          h("input", {
            style: S.num, type: "number", min: 2000, max: 120000, step: 500,
            value: cfg.bridge?.intervalMs ?? 8000,
            onChange: (e) => patchDraft((c) => { c.bridge = { ...(c.bridge || {}), intervalMs: Number(e.target.value) }; }),
          })),
        h(Row, { label: "唤醒会话" },
          h("select", {
            style: S.select,
            value: cfg.bridge?.sessionId || "",
            onChange: (e) => patchDraft((c) => { c.bridge = { ...(c.bridge || {}), sessionId: e.target.value }; }),
          },
            h("option", { value: "" }, "（不唤醒）"),
            cfg.bridge?.sessionId && !sessions.some((s) => s.id === cfg.bridge.sessionId)
              ? h("option", { key: "__current", value: cfg.bridge.sessionId }, `${shortId(cfg.bridge.sessionId)}（不在当前列表）`)
              : null,
            sessions.map((s) => h("option", { key: s.id, value: s.id },
              `${s.title || shortId(s.id)} · ${baseName(s.cwd) || "?"} · ${rel(s.lastAt)}`)))),
        h(Row, { label: "会话对齐" },
          h("div", { style: { flex: 1, minWidth: 0, display: "grid", gap: 6 } },
            chatSessionRows.length === 0
              ? h("span", { style: { opacity: 0.55, fontSize: 12 } }, "还没有会话记录（引擎跑几轮就有了）")
              : chatSessionRows)),
        h("div", { style: S.note },
          "给某个群单独指定一个 DSH 会话：这个群的消息只叫醒那个会话，两个群就不会混进同一条对话里。名字按前缀匹配（手机上群名会被截断，写开头几个字就够）。留空 = 用默认会话。"),
        h(Row, { label: "启用工具" },
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: cfg.tools?.enabled !== false,
              onChange: (e) => patchDraft((c) => { c.tools = { ...(c.tools || {}), enabled: e.target.checked }; }),
            }),
            "允许主模型调用 wechat_* 工具（关掉后工具会直接报错，桥接也会停）")),
        h("div", { style: { ...S.row, marginTop: 10 } },
          h("button", { style: S.btnPrimary, disabled: Boolean(busy), onClick: saveConfig }, busy === "save" ? "保存中…" : "保存"),
          h("button", {
            style: S.btn,
            disabled: Boolean(busy) || !ov,
            onClick: () => { initialized.current = true; setDraft(clone(ov?.config || {})); setNotice(null); },
          }, "重置"),
          h("span", { style: { fontSize: 11, opacity: 0.5 } }, ov?.configPath || "")),
        h("div", { style: S.note }, bridgeRuntime),
        h("div", { style: S.note },
          "保存后桥接会按新配置重启；不用重启 DSH。唤醒会话的 prompt 会带上引擎给的待办 id、群聊发送者昵称和回话工具说明。"));

      const restartPanel = h("div", {},
        h("div", { style: { fontSize: 12, opacity: 0.8 } },
          "插件不替你重启引擎（避免把正在发消息的那一轮打断）。要重启，用你平时的方式："),
        h("pre", { style: S.pre }, [
          "D:\\mimicd\\scripts\\run-daemon.cmd",
          "",
          "或手动：",
          'cd /d D:\\mimicd',
          'node tools/daemon.ts --adb "<adb路径>" --serial <序列号> --launch-wechat',
        ].join("\n")),
        h("div", { style: S.note },
          "暂停/继续、干跑/真发、强制跑一轮都在上面的按钮里；重启后 /health 的 uptime 会归零，可用来确认。"));

      return h("div", { style: S.page },
        h("div", { style: S.head },
          h("div", {},
            h("div", { style: S.h1 }, "mimicd 微信"),
            h("div", { style: { fontSize: 12, opacity: 0.65, marginTop: 2 } },
              Dot(online), `引擎${online ? "在线" : "离线"} · ${statusLine}`,
              " · ",
              `桥接${running ? "运行中" : "未运行"}`)),
          headerButtons),
        h("div", { style: S.sub },
          "设备、读屏、判断和发送都由 mimicd 引擎负责；这个页面只管看状态、转控制动作、配置「叫醒哪个会话」。每 3 秒刷新。",
          engine.degraded && engine.degraded.length ? `（部分接口降级：${engine.degraded.join("；")}）` : ""),
        err ? h("div", { style: S.msg(false) }, `设置页 API 读取失败：${err}（确认插件已启用；端口 65482 是否被占用）`) : null,
        notice ? h("div", { style: S.msg(notice.ok) }, notice.text) : null,

        h(Panel, { title: "监控", right: h("span", { style: { fontWeight: 400, opacity: 0.55 } }, `更新于 ${clock(ov?.now)}`) },
          monitor,
          h("div", { style: { marginTop: 10 } },
            h("div", { style: S.groupTitle },
              h("span", {}, "最近会话"),
              h("span", { style: { opacity: 0.5, fontWeight: 400 } }, `${chats.length} 个`)),
            chatsTable),
          pendingPanel,
          eventsPanel),

        h(Panel, { title: "插件配置（可保存）" },
          !ov
            ? h("div", { style: { fontSize: 12, opacity: 0.6 } }, "读取中…")
            : pluginConfigPanel),

        h(Panel, { title: "引擎配置（只读）" },
          !ov
            ? h("div", { style: { fontSize: 12, opacity: 0.6 } }, "读取中…")
            : engineConfigPanel),

        h(Panel, { title: "重启引擎" }, restartPanel),

        h("div", { style: { ...S.note, marginTop: 4 } },
          `插件 dsh-mimicd-wechat · 设置页 API http://127.0.0.1:65482 · 不提供 wechat_shot / wechat_send 等直接操作手机的工具（设备由引擎独占）。`));
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => {
        try {
          return ctx.slots.register({
            name: "settings.section",
            id: "mimicd-wechat",
            order: 132,
            label: () => "mimicd 微信",
          }, MimicdSection);
        } catch {
          return () => {};
        }
      });
    }

    const module = { exports: {} };
    module.exports = { apply, inject };
    return module.exports;
  },
});