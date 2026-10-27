/**
 * dsh-boss-whale —— 客户端半边：DSH「设置」→ **求职**
 *
 * 数据流：本节 ⇄ `/dsh-boss/api/*`（同源 fetch）⇄ ~/.dsh/boss-whale.config.json
 * 保存时提交**整份配置**（load 回来只改几个键），未显示的字段不会被抹掉。
 */
window.__ModuleLoader__.load({
  id: "dsh-boss-whale",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = "/dsh-boss/api";
    const CSS_TAG = "dsh-boss-whale/section.css";
    const CSS = [
      ".bw{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      ".bw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".bw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
      ".bw-group{margin-top:16px;font-size:13px;font-weight:600;line-height:20px}",
      ".bw-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".bw-row:last-child{border-bottom:none}",
      ".bw-row>div:first-child{flex:1;min-width:200px}",
      ".bw-label{font-size:13px;line-height:19px}",
      ".bw-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}",
      ".bw-input,.bw-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:180px;outline:none}",
      ".bw-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".bw-input.bw-wide{min-width:280px}",
      ".bw-input.bw-num{min-width:90px;width:90px}",
      ".bw-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".bw-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".bw-btn:disabled{opacity:.5;cursor:default}",
      ".bw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".bw-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:280px;overflow:auto;margin-top:10px}",
      ".bw-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}",
      ".bw-ok{color:var(--dsw-alias-state-success-primary,#3aa675);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}",
      ".bw-badge{display:inline-block;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary);margin-left:6px}",
      ".bw-cookie{display:flex;flex-direction:column;gap:8px;min-width:260px;width:100%}",
      ".bw-area{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;padding:8px;min-height:64px;resize:vertical;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
      ".bw-job{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 11px;margin-top:8px;font-size:12.5px;line-height:19px}",
      ".bw-job b{font-weight:600}",
      ".bw-job .bw-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px}",
      ".bw-win{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".bw-qr{display:flex;flex-direction:column;gap:8px;min-width:260px;width:100%}",
      ".bw-qrbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      ".bw-qrstate{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".bw-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);display:inline-block;flex:0 0 auto}",
      ".bw-dot.bw-live{background:var(--dsw-alias-brand-primary);animation:bwPulse 1.2s ease-in-out infinite}",
      ".bw-dot.bw-good{background:var(--dsw-alias-state-success-primary,#3aa675)}",
      ".bw-dot.bw-bad{background:var(--dsw-alias-state-error-primary)}",
      "@keyframes bwPulse{0%,100%{opacity:.35}50%{opacity:1}}",
      ".bw-chips{display:flex;gap:4px;flex-wrap:wrap}",
      ".bw-chip{font-size:10.5px;line-height:15px;padding:0 6px;border-radius:4px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-tertiary)}",
      ".bw-chip.bw-on{background:rgba(58,166,117,.16);color:var(--dsw-alias-state-success-primary,#3aa675)}",
      ".bw-sep{height:.5px;background:var(--dsw-alias-border-l2);margin:14px 0 2px}",
    ].join("");

    // ── 字段清单（唯一真相：加字段只改这里）──────────────────────────
    const FIELDS = [
      { group: "搜索条件", path: ["search", "keywords"], label: "关键词", hint: "多个用逗号分隔，例如 前端开发, Node.js", kind: "list" },
      { group: "搜索条件", path: ["search", "city"], label: "城市", hint: "城市名，例如 北京 / 上海 / 杭州 / 全国", kind: "text" },
      { group: "搜索条件", path: ["search", "cityCode"], label: "城市编码", hint: "可选。认不出城市时填这里（BOSS 搜索页 URL 里的 city= 值）", kind: "text" },
      { group: "搜索条件", path: ["search", "salaryMin"], label: "最低薪资（K）", hint: "0 = 不限；低于此值的岗位会被压到很后面", kind: "number" },
      { group: "搜索条件", path: ["search", "experience"], label: "经验要求", hint: "留空不限，例如 3-5年", kind: "text" },
      { group: "搜索条件", path: ["search", "degree"], label: "学历要求", hint: "留空不限，例如 本科", kind: "text" },
      { group: "搜索条件", path: ["search", "exclude"], label: "排除词", hint: "命中即降权，例如 外包, 驻场, 销售", kind: "list" },

      { group: "抓取礼貌", path: ["search", "pages"], label: "每次抓几页", hint: "1–4 页；页数越多越容易触发风控", kind: "number" },
      { group: "抓取礼貌", path: ["fetch", "minGapSec"], label: "请求最小间隔（秒）", hint: "默认 6，别低于 3", kind: "number" },
      { group: "抓取礼貌", path: ["fetch", "jitterSec"], label: "随机抖动（秒）", hint: "在间隔上再叠一段随机等待，避免固定节奏", kind: "number" },

      { group: "生物钟", path: ["plan", "runsPerDay"], label: "每天跑几轮", hint: "1–12；求职建议 2–3 轮", kind: "number" },
      { group: "生物钟", path: ["plan", "minGapMin"], label: "两轮最小间隔（分钟）", hint: "默认 180", kind: "number" },
      { group: "生物钟", path: ["plan", "skipChance"], label: "跳过概率", hint: "0.1 = 一成概率跳过（跳过也算一轮）", kind: "number" },

      { group: "虚拟人", path: ["fetch", "mode"], label: "浏览方式", hint: "「虚拟人」= 开真浏览器自己看页面（稳，慢）；「接口直连」只用来排查问题，BOSS 会判环境异常", kind: "select", options: [
        { value: "human", label: "虚拟人（真浏览器，推荐）" },
        { value: "api", label: "接口直连（快，但会被拦）" },
      ] },
      { group: "虚拟人", path: ["human", "slow"], label: "慢慢来", hint: "每一步停 1.5–4 秒。关掉只用于调试，别关着跑日常", kind: "switch" },
      { group: "虚拟人", path: ["human", "scrollSteps"], label: "每屏滚动几段", hint: "2–12，默认 5。越多越像人，也越慢", kind: "number" },
      { group: "虚拟人", path: ["human", "dwellSec"], label: "每屏停留（秒）", hint: "默认 8", kind: "number" },
      { group: "虚拟人", path: ["human", "peekPerRun"], label: "每轮点开几个岗位", hint: "0 = 只看列表；1 = 随机点开一个看看再返回", kind: "number" },
      { group: "虚拟人", path: ["human", "handoff"], label: "撞到验证时等人来解", hint: "有人在场（终端里手动跑）才会等；调度器跑的时候直接停手，不会干等", kind: "switch" },
      { group: "虚拟人", path: ["human", "offscreen"], label: "窗口挪到屏幕外", hint: "看不见但仍是「有头」浏览器。切到别的窗口工作时可以打开", kind: "switch" },

      { group: "日报", path: ["digest", "topN"], label: "日报列几条", hint: "默认 8", kind: "number" },
      { group: "日报", path: ["digest", "pushToSession"], label: "推送到会话", hint: "关掉 = 只抓取存盘，不在会话里播报", kind: "switch" },

      { group: "自动沟通", path: ["greet", "enabled"], label: "自动打招呼", hint: "关着只出草稿；开着才会真发。每天上限 2 条，服务端硬限制，改配置也突破不了", kind: "switch" },
      {
        group: "自动沟通",
        path: ["greet", "maxPerDay"],
        label: "每天最多打几条",
        hint: "0 = 只出草稿，一条都不发",
        kind: "select",
        options: [
          { value: 0, label: "0 条（不发送）" },
          { value: 1, label: "1 条" },
          { value: 2, label: "2 条" },
        ],
      },
      { group: "自动沟通", path: ["greet", "minScore"], label: "最低匹配分", hint: "默认 10（岗位名命中关键词就算 10 分）；低于这个分不打", kind: "number" },
      { group: "自动沟通", path: ["greet", "autoContinue"], label: "自动接话", hint: "对方回话就接一句；但碰到简历/面试/薪资/要联系方式，一律交回你本人", kind: "switch" },
      { group: "自动沟通", path: ["greet", "maxTurns"], label: "每个会话最多接几句", hint: "默认 2；接满就把话题交回你，不硬聊", kind: "number" },
      { group: "自动沟通", path: ["greet", "maxRepliesPerDay"], label: "每天自动接话上限", hint: "默认 6", kind: "number" },
      { group: "自动沟通", path: ["greet", "quietOnly"], label: "只在时间窗口内发", hint: "别在凌晨三点跟 HR 聊", kind: "switch" },
      { group: "自动沟通", path: ["greet", "signature"], label: "落款", hint: "可选，自动补在招呼语末尾；想指定位置就在模板里写 {signature}", kind: "text" },
      { group: "自动沟通", path: ["greet", "templates"], label: "招呼语模板", hint: "一行一条，最多 6 条。占位符：{name} {brand} {kw} {skills} {city} {signature}", kind: "lines" },

      { group: "接口路径", path: ["greet", "greetPath"], label: "打招呼接口", hint: "留空 = 用内置候选。报「路径不存在(404)」时，把浏览器 DevTools 里的真实路径填这里", kind: "text", wide: true },
      { group: "接口路径", path: ["greet", "listPath"], label: "会话列表接口", hint: "留空 = 自动探测（只会探这个读接口，不会拿打招呼接口去试）", kind: "text", wide: true },
      { group: "接口路径", path: ["greet", "sendPath"], label: "发消息接口", hint: "留空 = 沿用上次成功的路径", kind: "text", wide: true },

      { group: "工具链", path: ["toolsPath"], label: "工具目录", hint: "留空 = 用插件自带的 tools/boss.mjs", kind: "text", wide: true },
    ];

    const getPath = (obj, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const setPath = (obj, p, value) => {
      let cur = obj;
      for (let i = 0; i < p.length - 1; i += 1) {
        const k = p[i];
        if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
        cur = cur[k];
      }
      cur[p[p.length - 1]] = value;
      return obj;
    };

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === "undefined") return;
        if (document.querySelector(`style[data-dsh="${CSS_TAG}"]`)) return;
        const tag = document.createElement("style");
        tag.dataset.dsh = CSS_TAG;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }, []);
    }

    async function api(path, opts) {
      const res = await fetch(API + path, {
        headers: { "content-type": "application/json" },
        ...opts,
      });
      let body = null;
      try { body = await res.json(); } catch {}
      if (!res.ok && body == null) throw new Error(`HTTP ${res.status}`);
      return body ?? {};
    }

    function Field({ field, draft, onChange }) {
      const value = getPath(draft, field.path);
      const id = `bw-${field.path.join("-")}`;
      const common = { className: `bw-input${field.wide ? " bw-wide" : ""}`, id };

      let control;
      if (field.kind === "number") {
        control = h("input", {
          ...common,
          className: "bw-input bw-num",
          type: "number",
          value: value ?? 0,
          onChange: (e) => onChange(field.path, e.target.value === "" ? 0 : Number(e.target.value)),
        });
      } else if (field.kind === "switch") {
        control = h("input", {
          id,
          type: "checkbox",
          checked: value !== false,
          onChange: (e) => onChange(field.path, e.target.checked),
        });
      } else if (field.kind === "select") {
        control = h("select", {
          ...common,
          value: value ?? "",
          onChange: (e) => onChange(field.path, e.target.value),
        }, (field.options ?? []).map((o) => h("option", { key: o.value, value: o.value }, o.label)));
      } else if (field.kind === "list") {
        control = h("input", {
          ...common,
          type: "text",
          value: Array.isArray(value) ? value.join(", ") : String(value ?? ""),
          onChange: (e) => onChange(field.path, e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)),
        });
      } else if (field.kind === "select") {
        control = h("select", {
          ...common,
          value: String(value ?? (field.options?.[0]?.value ?? "")),
          onChange: (e) => onChange(field.path, Number(e.target.value)),
        }, (field.options ?? []).map((o) => h("option", { key: String(o.value), value: String(o.value) }, o.label)));
      } else if (field.kind === "lines") {
        control = h("textarea", {
          className: "bw-area",
          style: { minWidth: "260px" },
          value: Array.isArray(value) ? value.join("\n") : String(value ?? ""),
          onChange: (e) => onChange(field.path, e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)),
        });
      } else {
        control = h("input", {
          ...common,
          type: "text",
          value: String(value ?? ""),
          onChange: (e) => onChange(field.path, e.target.value),
        });
      }

      return h("div", { className: "bw-row" },
        h("div", null,
          h("div", { className: "bw-label" }, field.label),
          field.hint ? h("div", { className: "bw-hint" }, field.hint) : null),
        control);
    }

    function WindowEditor({ draft, onChange }) {
      const windows = getPath(draft, ["plan", "windows"]) ?? [];
      const update = (idx, key, val) => {
        const next = windows.map((w, i) => (i === idx ? { ...w, [key]: val } : w));
        onChange(["plan", "windows"], next);
      };
      return h("div", { className: "bw-row" },
        h("div", null,
          h("div", { className: "bw-label" }, "时间窗口"),
          h("div", { className: "bw-hint" }, "只在窗口内跑；跨零点可以写 22:00–02:00")),
        h("div", { className: "bw-win" },
          windows.map((w, idx) => h("div", { key: idx, className: "bw-win" },
            h("input", {
              className: "bw-input", type: "time", value: w.start ?? "09:30",
              onChange: (e) => update(idx, "start", e.target.value),
            }),
            h("span", { className: "bw-hint" }, "→"),
            h("input", {
              className: "bw-input", type: "time", value: w.end ?? "11:00",
              onChange: (e) => update(idx, "end", e.target.value),
            }),
            windows.length > 1
              ? h("button", {
                className: "bw-btn bw-btn2",
                onClick: () => onChange(["plan", "windows"], windows.filter((_, i) => i !== idx)),
              }, "删除")
              : null)),
          h("button", {
            className: "bw-btn bw-btn2",
            onClick: () => onChange(["plan", "windows"], [...windows, { start: "14:00", end: "15:00" }]),
          }, "加一个窗口")));
    }

    function BossWhaleSection() {
      useStyleOnce();
      const [draft, setDraft] = useState(null);
      const [meta, setMeta] = useState({ credentials: null, city: null, scheduler: null, configPath: "" });
      const [status, setStatus] = useState(null);
      const [jobs, setJobs] = useState([]);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");
      const [err, setErr] = useState("");
      const [cookie, setCookie] = useState("");
      const [qr, setQr] = useState(null);
      const qrTimer = useRef(null);
      const [dirty, setDirty] = useState(false);
      const [tryKw, setTryKw] = useState("");
      const [engage, setEngage] = useState(null);

      const load = useCallback(async () => {
        setBusy("load"); setErr(""); setMsg("");
        try {
          const data = await api("/settings");
          setDraft(data.config ?? {});
          setMeta({
            credentials: data.credentials ?? null,
            city: data.city ?? null,
            scheduler: data.scheduler ?? null,
            configPath: data.configPath ?? "",
          });
          setDirty(false);
        } catch (e) { setErr("读取设置失败：" + e.message); }
        finally { setBusy(""); }
      }, []);

      const loadStatus = useCallback(async () => {
        try {
          const [st, js, en] = await Promise.all([api("/status"), api("/jobs"), api("/greet/status")]);
          setStatus(st);
          setJobs(Array.isArray(js.jobs) ? js.jobs : []);
          setEngage(en);
        } catch {}
      }, []);

      useEffect(() => { load(); }, [load]);
      useEffect(() => { loadStatus(); }, [loadStatus]);

      // 关掉设置页（或组件重挂）时必须停掉轮询，否则会对着一个已经不存在的登录流程一直发请求
      useEffect(() => () => {
        if (qrTimer.current) { clearInterval(qrTimer.current); qrTimer.current = null; }
      }, []);

      const onChange = (path, value) => {
        setDraft((cur) => {
          const next = JSON.parse(JSON.stringify(cur ?? {}));
          setPath(next, path, value);
          return next;
        });
        setDirty(true);
        setMsg(""); setErr("");
      };

      const save = async () => {
        setBusy("save"); setErr(""); setMsg("");
        try {
          const res = await api("/settings", { method: "POST", body: JSON.stringify({ config: draft }) });
          if (!res.ok) { setErr(res.error || "保存失败"); return; }
          setDraft(res.config ?? draft);
          setMeta((m) => ({ ...m, city: res.city ?? m.city }));
          setDirty(false);
          setMsg("已保存"
            + (res.warn ? `（注意：${res.warn}）` : "")
            + (res.ignored?.length ? `\n⚠️ 这些键不认，已忽略：${res.ignored.join("、")}` : "")
            + " —— 生物钟下一 tick 就按新配置走");
          loadStatus();
        } catch (e) { setErr("保存失败：" + e.message); }
        finally { setBusy(""); }
      };

      // ── 扫码登录 ───────────────────────────────────────────────────────
      /**
       * 后端开的是 BOSS **官方登录窗口**（二维码在弹窗里，不在这个设置页上），
       * 所以前端这里没有图片可画，职责只有三件：开窗、轮询、把状态说清楚。
       *
       * cookie 的值永远不经过这里 —— 后端只回「关键字段名」和指纹，
       * 一个把 cookie 明文丢进浏览器的登录实现，等于把它又写了一遍日志。
       */
      const stopQrPoll = () => {
        if (qrTimer.current) { clearInterval(qrTimer.current); qrTimer.current = null; }
      };

      const QR_TERMINAL = ["success", "unverified", "cancelled", "error", "expired", "idle"];

      // 只刷新登录态徽章，**不调 load()** —— load 会重置 draft，
      // 扫码成功时如果用户正在改配置，未保存的改动会被无声抹掉。
      const refreshCred = async () => {
        try {
          const st = await api("/status");
          if (st?.credentials) setMeta((m) => ({ ...m, credentials: st.credentials }));
        } catch {}
      };

      const applyQr = (p) => {
        setQr(p);
        if (!QR_TERMINAL.includes(p.status)) return;
        stopQrPoll();
        if (p.status === "success") { setMsg(p.detail || "登录态已保存"); refreshCred(); loadStatus(); }
        else if (p.status === "unverified") { setErr(p.detail || "登录态没验通"); refreshCred(); loadStatus(); }
        else if (p.status === "error") setErr("扫码登录失败：" + (p.error || "未知原因"));
      };

      const startQr = async (mode) => {
        setBusy("qr"); setErr(""); setMsg("");
        stopQrPoll();
        try {
          const res = await api("/auth/qr/start", { method: "POST", body: JSON.stringify({ mode: mode || "auto" }) });
          if (!res.ok) { setQr(null); setErr(res.error || "打不开登录窗口"); return; }
          setQr(res);
          const id = res.id;
          qrTimer.current = setInterval(async () => {
            try {
              const p = await api("/auth/qr/poll", { method: "POST", body: JSON.stringify({ id }) });
              if (!p.ok) {
                stopQrPoll(); setQr(null);
                setErr(p.error || "登录流程已失效，请重新点「扫码登录」");
                return;
              }
              applyQr(p);
            } catch {
              // 单次轮询失败不算结束：DSH 重启、页面切走都可能断一下，下一轮再试
            }
          }, 1200);
        } catch (e) { setErr("打不开登录窗口：" + e.message); }
        finally { setBusy(""); }
      };

      const cancelQr = async () => {
        const id = qr?.id;
        stopQrPoll();
        setQr((q) => (q ? { ...q, status: "cancelled", detail: "已取消" } : q));
        try { await api("/auth/qr/cancel", { method: "POST", body: JSON.stringify({ id }) }); } catch {}
      };

      const saveCookie = async () => {
        if (!cookie.trim()) { setErr("先把 cookie 粘进来"); return; }
        setBusy("cookie"); setErr(""); setMsg("");
        try {
          const res = await api("/cookie", { method: "POST", body: JSON.stringify({ cookie }) });
          if (!res.ok) { setErr(res.error || "保存失败"); return; }
          setCookie("");
          setMeta((m) => ({ ...m, credentials: res.credentials }));
          setMsg(res.detail + (res.warn ? ` —— ⚠️ ${res.warn}` : ""));
          loadStatus();
        } catch (e) { setErr("保存失败：" + e.message); }
        finally { setBusy(""); }
      };

      /**
       * 从剪贴板一键填入。
       *
       * 手抄 cookie 是这个插件里最反人类的一步（stoken 是几 KB 的串），
       * 而 DevTools 里"复制整行"其实是一键操作 —— 中间只差一个粘贴。
       * 浏览器可能因权限/非安全上下文拒绝读剪贴板，所以失败时给的是明确动作指引，不是一句"失败"。
       */
      const pasteCookie = async () => {
        setErr("");
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
            setErr("这个界面读不到剪贴板，请手动 Ctrl+V 粘贴到下面的框里");
            return;
          }
          const text = await navigator.clipboard.readText();
          if (!text || !text.trim()) { setErr("剪贴板是空的：先在 DevTools 里右键复制那行 cookie"); return; }
          setCookie(text.trim());
          setMsg("已从剪贴板填入，确认无误后点「保存 cookie」");
        } catch {
          setErr("浏览器没给剪贴板权限（或页面不在安全上下文）：请手动 Ctrl+V");
        }
      };

      const deps = async () => {
        setBusy("deps"); setErr(""); setMsg("");
        try {
          const res = await api("/deps");
          const lines = (res.items ?? []).map((i) => `${i.ok ? "✓" : "✗"} ${i.name} —— ${i.detail}`);
          if (res.error) lines.unshift("✗ " + res.error);
          const sched = res.scheduler;
          if (sched?.state) lines.push(`· 生物钟：今日 ${sched.state.runs} 轮${sched.plan?.atText ? ` · 下次 ${sched.plan.atText}` : ""}`);
          setMsg(lines.join("\n") || "体检没有返回内容");
          loadStatus();
        } catch (e) { setErr("体检失败：" + e.message); }
        finally { setBusy(""); }
      };

      const runNow = async () => {
        const keyword = tryKw.trim();
        setBusy("run"); setErr(""); setMsg("");
        try {
          const res = await api("/run", {
            method: "POST",
            body: JSON.stringify(keyword ? { keyword } : {}),
          });
          if (!res.ok) { setErr(res.error || "抓取失败"); return; }
          const head = res.dry ? `（试跑「${keyword}」· 只看不记，不影响去重）\n` : "";
          setMsg(head + (res.text || "抓取完成，但没有内容"));
          loadStatus();
        } catch (e) { setErr("抓取失败：" + e.message); }
        finally { setBusy(""); }
      };

      // ── 自动沟通的四个按钮 ─────────────────────────────────────────────
      const greetRun = async (confirm) => {
        if (confirm) {
          const ok = typeof window !== "undefined" && typeof window.confirm === "function"
            ? window.confirm("这会真的给一位 HR 发一条招呼（消耗今天 1 次额度）。确定？")
            : false;
          if (!ok) return;
        }
        setBusy(confirm ? "greet-send" : "greet-dry"); setErr(""); setMsg("");
        try {
          const res = await api("/greet/run", { method: "POST", body: JSON.stringify({ confirm }) });
          const lines = [];
          if (res.ok) lines.push(`✓ 已发出 · ${res.job?.name ?? ""} · ${res.job?.brand ?? ""}`, res.text ?? "");
          else if (res.dry) lines.push(`（试算，未发送）目标 · ${res.job?.name ?? ""} · ${res.job?.brand ?? ""}`, res.text ?? "");
          else lines.push(`✗ ${res.reason ?? res.error ?? "没发出去"}`);
          const q = res.quota ?? {};
          if (q.max !== undefined) lines.push(`今日额度：${q.used}/${q.max}`);
          if (res.code === "unknown-path") lines.push('接口路径不对 → 填下面的「打招呼接口」');
          setMsg(lines.filter(Boolean).join("\n"));
          loadStatus();
        } catch (e) { setErr("打招呼失败：" + e.message); }
        finally { setBusy(""); }
      };

      const showReplies = async () => {
        setBusy("replies"); setErr(""); setMsg("");
        try {
          const res = await api("/replies");
          if (!res.ok) { setErr(res.error || "读不到会话"); return; }
          const lines = [`会话 ${res.count ?? 0} 个`];
          for (const a of res.actions ?? []) {
            const tag = { reply: "↩ 会回", handoff: "⚠ 交回你", close: "✓ 结束", wait: "… 等", hold: "· 停", "send-failed": "✗ 失败" }[a.decision] ?? a.decision;
            lines.push(`${tag} · ${a.boss ?? ""}：${String(a.text ?? "").slice(0, 40)}`);
            lines.push(`   ${a.reason ?? ""}`);
            if (a.wouldReply) lines.push(`   拟回：${a.wouldReply}`);
          }
          if ((res.actions ?? []).length === 0) lines.push("（没有新动静）");
          setMsg(lines.join("\n"));
        } catch (e) { setErr("读取失败：" + e.message); }
        finally { setBusy(""); }
      };

      const runProbe = async () => {
        setBusy("probe"); setErr(""); setMsg("");
        try {
          const res = await api("/probe");
          const lines = [res.ok ? "✓ 读接口通了" : "✗ 读接口都没通"];
          for (const r of res.results ?? []) lines.push(`${r.ok ? "✓" : "✗"} ${r.path} → ${r.message}`);
          setMsg(lines.join("\n"));
          loadStatus();
        } catch (e) { setErr("探测失败：" + e.message); }
        finally { setBusy(""); }
      };

      /**
       * 开窗过验证：交给一个独立进程，这里只负责"叫醒"它。
       * 不在这里等 —— 过验证是人的节奏，等下去只会把界面卡死。
       */
      const openBrowse = async () => {
        setBusy("browse"); setErr(""); setMsg("");
        try {
          const res = await api("/browse", { method: "POST" });
          if (!res.ok) { setErr(res.error || "打不开浏览器"); return; }
          setMsg("窗口已打开，停在 BOSS 搜索页。\n"
            + "在窗口里把验证过一下 / 登录一下，然后直接关掉窗口就行 —— 之后自动浏览就不会再撞它。");
        } catch (e) { setErr("打不开浏览器：" + e.message); }
        finally { setBusy(""); }
      };

      const clearRiskNow = async () => {
        setBusy("risk"); setErr(""); setMsg("");
        try {
          await api("/greet/clear-risk", { method: "POST" });
          setMsg("已清除风控冷却 —— 但如果是今天刚被拦的，建议还是等一会儿再发");
          loadStatus();
        } catch (e) { setErr("操作失败：" + e.message); }
        finally { setBusy(""); }
      };

      if (!draft) {
        return h("div", { className: "bw" },
          h("h2", { className: "bw-title" }, "求职"),
          h("p", { className: "bw-intro" }, busy === "load" ? "读取中…" : "未读取到配置"),
          err ? h("div", { className: "bw-err" }, err) : null);
      }

      const cred = meta.credentials ?? {};
      // 冷却期要在最显眼的地方说清，否则用户只会看到"今天没跑"然后反复点按钮
      const cd = status?.scheduler?.cooldown ?? null;
      const cdActive = cd?.active === true;
      const cdUntil = cd?.until ? (() => {
        const d = new Date(cd.until);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      })() : "";
      const groups = [];
      for (const f of FIELDS) {
        if (!groups.includes(f.group)) groups.push(f.group);
      }

      // ── 扫码登录的状态行 ───────────────────────────────────────────────
      // 二维码在弹窗里，这里能给的只有"进行到哪一步"和"关键字段拿到没有"。
      // 三个 chip 就是诊断线索：一直不亮的那个字段，直接指向问题出在登录流程的哪一段。
      const QR_TEXT = {
        waiting: "等待扫码",
        success: "已登录",
        unverified: "已保存，但没验通",
        cancelled: "已取消",
        error: "失败",
        expired: "等待超时",
      };
      const qrLive = !!(qr && qr.id && !QR_TERMINAL.includes(qr.status));
      const qrMode = qr?.mode === "browser"
        ? h("span", { className: "bw-chip bw-on" }, qr.browser ? `系统浏览器 · ${qr.browser}` : "系统浏览器")
        : null;
      const qrLine = qr
        ? h("div", { className: "bw-qrstate" },
          h("span", {
            className: "bw-dot" + (qrLive ? " bw-live"
              : qr.status === "success" ? " bw-good"
                : (qr.status === "error" || qr.status === "unverified") ? " bw-bad" : ""),
          }),
          h("span", null, QR_TEXT[qr.status] ?? qr.status),
          qrMode,
          qr.detail ? h("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, "· " + qr.detail) : null,
          h("div", { className: "bw-chips" },
            ["__zp_stoken__", "bst", "wt2"].map((k) =>
              h("span", {
                key: k,
                className: "bw-chip" + ((qr.names ?? []).includes(k) ? " bw-on" : ""),
                title: (qr.names ?? []).includes(k) ? "已拿到" : "还没拿到",
              }, k))))
        : null;

      return h("div", { className: "bw" },
        h("h2", { className: "bw-title" }, "求职",
          h("span", { className: "bw-badge" }, cred.present ? `已登录 ${cred.fp ?? ""}` : "未登录")),
        h("p", { className: "bw-intro" }, "它会在设定窗口里开一个真浏览器：打开 BOSS 搜索页、慢慢往下滚、偶尔点开一个岗位看看，把看到的岗位记下来整理成日报投进 boss-whale 会话。撞到人机验证会立刻停手（在终端里手动跑会把窗口留给你去解）。自动沟通可选：开启后每天最多跟 2 位 HR 打招呼（可设 0 = 只看不发），简历、面试、薪资、联系方式一律交回你本人。"),

        h("div", { className: "bw-group" }, "登录态"),
        h("div", { className: "bw-row" },
          h("div", null,
            h("div", { className: "bw-label" }, "扫码登录"),
            h("div", { className: "bw-hint", style: { whiteSpace: "pre-line" } },
              "点一下打开 BOSS 官方登录页，用手机 BOSS 直聘 App 扫码（也能用手机号登录）。\n"
              + "DSH 里弹不出窗口时会自动改用本机 Edge/Chrome（独立配置，第一次要在那边扫一次）。\n"
              + "登录成功后自动取登录态 —— 不用手抄 cookie。")),
          h("div", { className: "bw-qr" },
            h("div", { className: "bw-qrbar" },
              h("button", { className: "bw-btn", disabled: !!busy, onClick: () => startQr("auto") },
                busy === "qr" ? "打开中…" : (qrLive ? "重新打开登录" : "扫码登录")),
              (qrLive && qr?.mode === "browser")
                ? null
                : h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: () => startQr("browser") }, "改用浏览器"),
              qrLive
                ? h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: cancelQr }, "取消")
                : null),
            qrLine)),

        h("div", { className: "bw-sep" }),

        h("div", { className: "bw-row" },
          h("div", null,
            h("div", { className: "bw-label" }, "或者手动粘贴 cookie"),
            h("div", { className: "bw-hint", style: { whiteSpace: "pre-line" } },
              "推荐：在 zhipin.com 按 F12 → Network → 点任意一个 zhipin 请求 → Headers → Request Headers → cookie → 右键 Copy value。\n"
              + "这条路能把 HttpOnly 的 __zp_stoken__ 一起带出来；Application → Cookies 里整行复制也可以。\n"
              + "别用 document.cookie —— 它读不到 Stoken，粘进来一定失败。")),
          h("div", { className: "bw-cookie" },
            h("textarea", {
              className: "bw-area",
              placeholder: "__zp_stoken__=...; bst=...; wt2=...; lastCity=...",
              value: cookie,
              onChange: (e) => setCookie(e.target.value),
            }),
            h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
              h("button", { className: "bw-btn", disabled: !!busy, onClick: saveCookie },
                busy === "cookie" ? "保存中…" : "保存 cookie"),
              h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: pasteCookie }, "从剪贴板填入"),
              h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: load }, "重新读取")))),

        h("div", { className: "bw-group" }, "搜索条件"),
        FIELDS.filter((f) => f.group === "搜索条件").map((f) =>
          h(Field, { key: f.path.join("."), field: f, draft, onChange })),
        meta.city && !meta.city.code
          ? h("div", { className: "bw-err" }, `城市未识别：${meta.city.name} —— 请填上面的「城市编码」`)
          : null,

        h("div", { className: "bw-group" }, "抓取礼貌"),
        FIELDS.filter((f) => f.group === "抓取礼貌").map((f) =>
          h(Field, { key: f.path.join("."), field: f, draft, onChange })),

        h("div", { className: "bw-group" }, "虚拟人",
          cdActive ? h("span", { className: "bw-badge" }, `冷却中 · 还要 ${cd.remainingMin} 分钟`) : null),
        cdActive
          ? h("div", { className: "bw-hint", style: { marginBottom: 6, whiteSpace: "pre-line" } },
            `⏸ 已经停手，${cdUntil} 之后才会再动。\n`
            + `原因：${cd.message || cd.kind || "上次被风控拦下"}\n`
            + "这段时间里不要反复试 —— 从「环境异常」升级成「IP 异常」以后，你自己用浏览器打开 BOSS 也会被要求验证。")
          : null,
        FIELDS.filter((f) => f.group === "虚拟人").map((f) =>
          h(Field, { key: f.path.join("."), field: f, draft, onChange })),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" } },
          h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: openBrowse },
            busy === "browse" ? "打开中…" : "开窗过验证 / 登录"),
          cdActive
            ? h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: clearRiskNow }, "我已等够，解除冷却")
            : null,
          h("span", { className: "bw-hint" }, "弹出浏览器停在搜索页；过完验证直接关掉窗口即可")),

        h("div", { className: "bw-group" }, "生物钟"),
        h(WindowEditor, { draft, onChange }),
        FIELDS.filter((f) => f.group === "生物钟").map((f) =>
          h(Field, { key: f.path.join("."), field: f, draft, onChange })),

        h("div", { className: "bw-group" }, "日报"),
        FIELDS.filter((f) => f.group === "日报").map((f) =>
          h(Field, { key: f.path.join("."), field: f, draft, onChange })),

        h("div", { className: "bw-group" }, "自动沟通",
          engage?.quota
            ? h("span", { className: "bw-badge" },
              `今日 ${engage.quota.used}/${engage.quota.max}`
              + (engage.quota.risk ? " · 风控冷却中" : ""))
            : null),
        FIELDS.filter((f) => f.group === "自动沟通").map((f) =>
          h(Field, { key: f.path.join("."), field: f, draft, onChange })),
        engage?.convs?.length
          ? h("div", { className: "bw-job" },
            h("b", null, "最近会话"),
            engage.convs.slice(0, 5).map((c) => h("div", { key: c.key, className: "bw-sub" },
              `${c.status === "handoff" ? "⚠ 等你接手" : c.status === "closed" ? "✓ 已结束" : "· 进行中"}`,
              ` · ${c.job?.name ?? ""} ${c.job?.brand ?? ""} · 已自动接 ${c.turn} 句`,
              c.lastBossText ? ` · 对方：${String(c.lastBossText).slice(0, 30)}` : "")))
          : null,
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 } },
          h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: () => greetRun(false) },
            busy === "greet-dry" ? "试算中…" : "试算（不发送）"),
          h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: () => greetRun(true) },
            busy === "greet-send" ? "发送中…" : "真发一条"),
          h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: showReplies },
            busy === "replies" ? "读取中…" : "看回复"),
          h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: runProbe },
            busy === "probe" ? "探测中…" : "探接口"),
          engage?.quota?.risk
            ? h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: clearRiskNow }, "清除风控冷却")
            : null),

        h("div", { className: "bw-group" }, "接口路径（高级）"),
        h("div", { className: "bw-hint", style: { marginBottom: 4 } },
          "BOSS 的内部接口路径没有公开文档。留空时按内置候选走；如果「真发一条」报路径不存在，"
          + "在浏览器 F12 → Network 里点一次真实的打招呼，把那条请求的路径粘到下面。"),
        FIELDS.filter((f) => f.group === "接口路径").map((f) =>
          h(Field, { key: f.path.join("."), field: f, draft, onChange })),

        h("div", { className: "bw-group" }, "工具链"),
        FIELDS.filter((f) => f.group === "工具链").map((f) =>
          h(Field, { key: f.path.join("."), field: f, draft, onChange })),

        h("div", { className: "bw-group" }, "试跑"),
        h("div", { className: "bw-row" },
          h("div", null,
            h("div", { className: "bw-label" }, "临时关键词"),
            h("div", { className: "bw-hint" }, "只跑这一次：不写进配置，也不记入去重（不会把岗位从日报里挤掉）")),
          h("input", {
            className: "bw-input",
            value: tryKw,
            placeholder: "留空 = 正常跑一轮",
            onChange: (e) => setTryKw(e.target.value),
          })),

        h("div", { className: "bw-actions" },
          h("button", { className: "bw-btn", disabled: !!busy || !dirty, onClick: save },
            busy === "save" ? "保存中…" : (dirty ? "保存" : "已保存")),
          h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: deps },
            busy === "deps" ? "体检中…" : "体检"),
          h("button", { className: "bw-btn bw-btn2", disabled: !!busy, onClick: runNow },
            busy === "run" ? "抓取中…" : "立即跑一轮")),

        status
          ? h("div", { className: "bw-hint", style: { marginTop: 8 } },
            `方式 ${(draft?.fetch?.mode ?? "human") === "human" ? "虚拟人" : "接口直连"} · 今日 ${status.scheduler?.state?.runs ?? 0} 轮 · 已存岗位 ${status.stored ?? 0} 条 · 去重表 id ${status.seen ?? 0} / 指纹 ${status.fingerprints ?? 0}`
            + (cdActive ? ` · ⏸ 冷却到 ${cdUntil}` : "")
            + (status.engage?.quota
              ? ` · 招呼 ${status.engage.quota.used}/${status.engage.quota.max} · 接话 ${status.engage.quota.replied}/${status.engage.quota.replyMax}`
              : "")
            + (status.engage?.quota?.risk ? ` · ⚠ 风控冷却到 ${status.engage.quota.risk.until}` : "")
            + (status.scheduler?.lastError ? ` · 上次错误：${status.scheduler.lastError}` : ""))
          : null,

        // 2026-10-27：让她有个固定去处 —— 会话不存在时，界面上没有任何入口，
        //   主人只能在别的会话里凭空聊，产出也散在各处。
        status?.scheduler?.session
          ? h("div", { className: "bw-hint", style: { marginTop: 4 } }, (() => {
            const s = status.scheduler.session
            if (!s.ready) {
              return `专属会话「${s.id}」还没建出来${s.error ? " · " + s.error : " · 重启 DSH 后会自动建"}`
            }
            return s.intro === "done"
              ? `专属会话「${s.id}」已就绪 · 工作区 → 未分组 —— 每轮的岗位清单和招呼语草稿都落在那里面`
              : `专属会话「${s.id}」已建出（首播：${s.intro === "pending" ? "待发" : s.intro}）`
          })())
          : null,

        err ? h("div", { className: "bw-err" }, err) : null,
        msg ? h("div", { className: "bw-out" }, msg) : null,

        jobs.length
          ? h("div", null,
            h("div", { className: "bw-group" }, "最近抓到"),
            jobs.map((j, i) => h("div", { key: j.id ?? i, className: "bw-job" },
              h("b", null, j.name), " · ", j.brand,
              j.salaryDesc ? h("span", null, " · ", j.salaryDesc) : null,
              h("div", { className: "bw-sub" },
                [j.city, j.experience, j.degree].filter(Boolean).join(" | ")))))
          : null,

        h("div", { className: "bw-hint", style: { marginTop: 14 } },
          "配置：" + (meta.configPath || "（未知）")));
    }

    const inject = ["slots"];
    const NS = "boss-whale";
    const NAMES = { nav: "求职" };

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: NS, order: 6, label: () => NAMES.nav },
              BossWhaleSection,
            ),
            "boss-whale: settings section",
          ),
        "boss-whale: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.BossWhaleSection = BossWhaleSection;
    exports.FIELDS = FIELDS;
    return module.exports;
  },
});
