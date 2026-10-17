// dsh-backup-migrator — 客户端：设置页「备份与换机」面板。
//
// 由 window.__ModuleLoader__ 以 UMD 工厂加载，React 从宿主模块表拿。
//
// 两个已知的坑（长期记忆）：
//  1. CSS 必须以自建真实 DOM 祖先类（.bm-wrap）做前缀。用注入 <style> 的
//     data-plugin-css 属性做前缀会让每条规则静默失效——元素退回浏览器默认样式。
//  2. settings.section 组件的 props 里没有配置读写接口，面板自己 POST 宿主路由。
//
// 数据全走 /_backup-migrator/api/*：
//   GET  /status      → 快照（配置 + 可选项 + 历史列表 + 当前进度）
//   POST /options     → 写配置 {patch}
//   POST /backup      → 立即备份（异步，轮询 /status 看进度）
//   POST /import      → 上传一份外部备份（原始字节流）
//   POST /inspect     → 校验
//   POST /restore     → 还原 {mode: staged|direct}
//   POST /delete /export → 删除 / 复制到指定路径
//   POST /hello         → 把渲染进程探到的 DSH 版本报给宿主（宿主自己探不到：app.asar 是单文件）
//   GET  /notify-targets → dsh-im 已登记的投递目标（失败通知用）
//   POST /cloud/list|upload|download → WebDAV 云端备份
//   POST /uninstall     → 从 profile 里卸掉本插件

window.__ModuleLoader__.load({
  id: "dsh-backup-migrator",
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const inject = ["slots"];
    const SLOT = "settings.section";
    const ENTRY_ID = "backup-migrator";
    const BASE = "/_backup-migrator/api";

    // 作用域根：.bm-wrap 是本组件自己渲染的 span，所有规则都挂在它下面。
    const STYLE = [
      ".bm-wrap { display: block; box-sizing: border-box; color: var(--dsw-alias-label-primary); }",
      ".bm-wrap * { box-sizing: border-box; }",
      ".bm-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }",
      ".bm-row .bm-grow { flex: 1 1 180px; min-width: 0; }",
      ".bm-lab { font-size: 12px; color: var(--dsw-alias-label-secondary); }",
      ".bm-val { font-size: 13px; }",
      ".bm-btn { all: unset; box-sizing: border-box; cursor: pointer; padding: 5px 12px;",
      "  font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary);",
      "  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm);",
      "  background: var(--dsw-specific-input-major); }",
      ".bm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary); }",
      ".bm-btn:disabled { opacity: .45; cursor: not-allowed; }",
      ".bm-btn.bm-primary { border-color: var(--dsw-alias-state-business-primary); }",
      ".bm-btn.bm-danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-danger); color: var(--dsw-alias-state-business-danger); }",
      ".bm-in { width: 100%; font: inherit; font-size: 13px; padding: 5px 8px;",
      "  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);",
      "  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }",
      ".bm-in:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }",
      ".bm-sel { font: inherit; font-size: 13px; padding: 4px 6px; color: var(--dsw-alias-label-primary);",
      "  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);",
      "  border-radius: var(--dsw-radius-sm); }",
      ".bm-note { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 4px 0; }",
      ".bm-err { font-size: 12px; color: var(--dsw-alias-state-business-danger); margin: 4px 0; }",
      ".bm-ok { font-size: 12px; color: var(--dsw-alias-state-business-success); margin: 4px 0; }",
      ".bm-sec { margin: 18px 0 6px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1);",
      "  font-size: 13px; font-weight: 600; }",
      ".bm-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 12px; margin: 8px 0; }",
      ".bm-item { display: flex; gap: 6px; align-items: center; font-size: 13px; }",
      ".bm-item.bm-off { opacity: .5; }",
      ".bm-list { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }",
      ".bm-file { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 8px;",
      "  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }",
      ".bm-file.bm-picked { border-color: var(--dsw-alias-state-business-primary); }",
      ".bm-file .bm-meta { flex: 1 1 200px; min-width: 0; }",
      ".bm-file .bm-meta .bm-val { overflow-wrap: anywhere; }",
      ".bm-prog { height: 4px; border-radius: 2px; background: var(--dsw-alias-bg-layer-1);",
      "  overflow: hidden; margin: 6px 0; max-width: 320px; }",
      ".bm-prog > i { display: block; height: 100%; width: 35%; background: var(--dsw-alias-state-business-primary); }",
      ".bm-num { width: 72px; }",
    ].join("");

    function url(suffix) {
      return new URL(BASE + suffix, document.baseURI).href;
    }

    async function api(suffix, body) {
      const res = await fetch(url(suffix), body === undefined
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (data?.ok !== true) throw new Error(String(data?.error?.message ?? "请求失败（" + res.status + "）"));
      return data.value;
    }

    function fmtBytes(n) {
      const bytes = Number(n ?? 0);
      if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let at = 0;
      let left = bytes;
      while (left >= 1024 && at < units.length - 1) {
        left /= 1024;
        at += 1;
      }
      return (at === 0 ? String(left) : left.toFixed(1)) + " " + units[at];
    }

    function fmtTime(iso) {
      const at = Date.parse(String(iso ?? ""));
      if (!Number.isFinite(at)) return "—";
      const d = new Date(at);
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
        + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    const PHASE_TEXT = { scan: "统计内容…", pack: "正在打包…", prune: "清理旧备份…", done: "完成" };

    /**
     * 渲染进程里能看到的 DSH 版本。__DSH_BOOT__ 的字段名没有公开文档，所以取一串候选值，
     * 全都拿不到就返回空串——留空比写一个猜的版本号好（换机时会照着版本号判断兼容性）。
     */
    function probeVersion() {
      try {
        const boot = globalThis.__DSH_BOOT__;
        const candidates = [
          boot?.version, boot?.appVersion, boot?.productVersion, boot?.versionInfo?.version,
          boot?.env?.version, globalThis.__DSH_VERSION__,
        ];
        for (const value of candidates) {
          const text = String(value ?? "").trim();
          if (text !== "") return text;
        }
      } catch {
        /* 读不到就当没有 */
      }
      return "";
    }

    /** 导出时的建议文件名主干，和宿主侧的备份名规则一致（dsh-backup-<时间>）。 */
    function stampName() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
        + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }

    const FALLBACK = ["sessions", "attachments", "memories", "storages", "integrations", "profiles"];

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-plugin-css", "bm");
        style.textContent = STYLE;
        document.head.appendChild(style);
        return () => style.remove();
      }, "bm: css");

      // 选文件夹：桌面端 preload 直接有原生对话框（__DSH_DIRECTORY_PICKER__），
      // Web GUI 没有 preload，就问宿主的 uiWorkspace（它转 remote 走主进程）。
      // 两条路都拿不到就返回 null，面板退回手填——别让一个按钮决定功能可用性。
      const pickDir = async () => {
        const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
        if (desktop !== undefined && typeof desktop.pick === "function") return desktop.pick();
        let service;
        try {
          service = ctx.get("uiWorkspace");
        } catch {
          service = undefined;
        }
        return service === undefined ? null : service.pickDirectory();
      };

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ENTRY_ID,
        order: 60,
        label: () => "备份与换机",
        locale: "zh-CN",
      }, (props) => h(BackupPanel, { ...props, pickDir })));
    }

    function BackupPanel(props) {
      const [state, setState] = useState(null);
      const [error, setError] = useState("");
      const [note, setNote] = useState("");
      const [busy, setBusy] = useState("");
      const [picked, setPicked] = useState("");
      const [report, setReport] = useState(null);
      const [mode, setMode] = useState("staged");
      const [dest, setDest] = useState("");
      const [cloudRows, setCloudRows] = useState([]);
      const [targets, setTargets] = useState({ available: false, targets: [] });
      const pickDir = props.pickDir;
      const poll = useRef(0);

      const reload = useCallback(async () => {
        const snap = await api("/status");
        setState((old) => {
          // 备份刚跑完：服务端已清 running，本地得把按钮解锁，否则界面卡在「备份中」。
          if (old?.running === true && snap.running !== true) {
            setBusy("");
            setNote("备份完成");
          }
          return snap;
        });
        return snap;
      }, []);

      useEffect(() => {
        reload().catch((e) => setError(String(e?.message ?? e)));
        // 这两条都是锦上添花，失败不该在面板顶上摆一条红字。
        api("/hello", { version: probeVersion() }).catch(() => undefined);
        api("/notify-targets").then(setTargets).catch(() => undefined);
        return () => clearInterval(poll.current);
      }, [reload]);

      // 备份是异步任务：发起后轮询 /status 直到 running 变 false。
      useEffect(() => {
        clearInterval(poll.current);
        if (state?.running !== true) return undefined;
        poll.current = setInterval(() => {
          reload().catch((e) => setError(String(e?.message ?? e)));
        }, 900);
        return () => clearInterval(poll.current);
      }, [reload, state?.running]);

      const guard = useCallback(async (label, fn) => {
        setBusy(label);
        setError("");
        setNote("");
        try {
          return await fn();
        } catch (e) {
          setError(String(e?.message ?? e));
          return undefined;
        } finally {
          setBusy("");
        }
      }, []);

      const save = useCallback(async (patch) => {
        await api("/options", { patch });
        await reload();
      }, [reload]);

      const fail = (e) => setError(String(e?.message ?? e));

      // 选中的文件夹交给调用方落地：备份目录写配置，导出目标拼成完整文件名。
      const chooseDir = useCallback((label, use) => guard(label, async () => {
        const picked = await pickDir();
        if (picked === null || picked === undefined || String(picked) === "") {
          setNote("没拿到文件夹路径（当前环境可能没有系统对话框），可以手动填写");
          return;
        }
        await use(String(picked));
      }), [guard, pickDir]);

      const onPick = useCallback(async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = "";
        if (file === undefined) return;
        await guard("上传中", async () => {
          // 自定义头不是给服务端做鉴权的花活：浏览器只对「简单请求」免预检，
          // 带上它，别的网页就没法顺手把文件 POST 进来。
          const res = await fetch(url("/import"), {
            method: "POST", body: file, headers: { "x-backup-migrator": "1" },
          });
          const data = await res.json().catch(() => null);
          if (data?.ok !== true) throw new Error(String(data?.error?.message ?? "上传失败"));
          setPicked(String(data.value.name));
          setReport(data.value.report ?? null);
          setNote("已载入，请确认校验结果再还原");
          await reload();
        });
      }, [guard, reload]);

      const doBackup = useCallback(() => guard("备份中", async () => {
        await api("/backup", {});
        await reload();
      }), [guard, reload]);

      const doInspect = useCallback(() => guard("校验中", async () => {
        const r = await api("/inspect", { name: picked });
        setReport(r);
        setNote(r.problems.length === 0 ? "校验通过" : "校验发现问题，见下");
      }), [guard, picked]);

      const doRestore = useCallback(() => guard("还原中", async () => {
        const result = await api("/restore", { name: picked, mode });
        setNote(mode === "direct"
          ? "已写回 " + result.target + "，请重启 DSH"
          : "已解到暂存区 " + result.dir + "（含 restore.ps1）");
        await reload();
      }), [guard, mode, picked, reload]);

      const doDelete = useCallback((name) => guard("删除中", async () => {
        if (picked === name) {
          setPicked("");
          setReport(null);
        }
        await api("/delete", { name });
        await reload();
      }), [guard, picked, reload]);

      const doExport = useCallback((name) => guard("导出中", async () => {
        const result = await api("/export", { name, dest: dest.trim() });
        setNote("已复制到 " + result.to + "（" + fmtBytes(result.bytes) + "）");
      }), [dest, guard]);

      const doCloudList = useCallback(() => guard("云端列目录中", async () => {
        const result = await api("/cloud/list");
        const rows = result.rows ?? [];
        setCloudRows(rows);
        setNote("云端找到 " + rows.length + " 份备份");
      }), [guard]);

      const doCloudUpload = useCallback((name) => guard("上传云端中", async () => {
        const result = await api("/cloud/upload", { name });
        setNote("已上传 " + result.name + "（" + fmtBytes(result.bytes) + "）");
      }), [guard]);

      const doCloudDownload = useCallback((name) => guard("云端下载中", async () => {
        const result = await api("/cloud/download", { name });
        setPicked(result.name);
        setReport(result.report ?? null);
        setNote("已下载到备份目录：" + result.name + "，确认校验结果后再还原");
        await reload();
      }), [guard, reload]);

      const doUninstall = useCallback(() => guard("卸载中", async () => {
        const ask = globalThis.confirm;
        if (typeof ask !== "function") throw new Error("当前环境没有确认框，请在桌面端卸载");
        if (ask("确定卸载「备份与换机」插件？\n会从 profile 的 package.json 与 node_modules 里移除本插件，"
          + "重启 DSH 后生效。\n备份文件、备份配置与云端设置都保留。") !== true) return;
        const result = await api("/uninstall", {});
        setNote("已卸载 profile：" + result.results.map((row) => row.profile).join("、") + "。" + result.hint);
      }), [guard]);

      if (state === null) {
        return h("span", { className: "bm-wrap" },
          h("p", { className: "bm-note" }, error === "" ? "正在读取备份配置…" : error));
      }

      const options = state.options ?? {};
      const items = state.catalog ?? [];
      const on = new Set(Array.isArray(options.items) && options.items.length > 0 ? options.items : FALLBACK);
      const progress = state.progress ?? null;
      const failure = state.failure ?? null;
      const backups = state.backups ?? [];
      const lock = busy !== "";

      const toggle = (id) => {
        const next = new Set(on);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        save({ items: [...next] }).catch(fail);
      };

      const field = (key, value, props) => h("input", {
        className: "bm-in bm-num",
        type: "number",
        min: key === "keepCount" ? "1" : "0",
        value: String(value ?? ""),
        disabled: lock,
        onChange: (e) => setState({ ...state, options: { ...options, [key]: e.target.value } }),
        onBlur: (e) => save({ [key]: Number(e.target.value) }).catch(fail),
        ...props,
      });

      // 文本类配置项：本地先改（否则每敲一个字就丢焦点），失焦才落盘。
      const text = (key, placeholder, props) => h("input", {
        className: "bm-in",
        value: String(options[key] ?? ""),
        placeholder,
        disabled: lock,
        onChange: (e) => setState({ ...state, options: { ...options, [key]: e.target.value } }),
        onBlur: (e) => save({ [key]: e.target.value }).catch(fail),
        ...props,
      });

      const kids = [
        h("h3", { className: "bm-sec", key: "s1" }, "备份内容"),
        h("div", { className: "bm-items", key: "i" }, items.map((item) => h("label", {
          className: "bm-item" + (on.has(item.id) ? "" : " bm-off"),
          key: item.id,
        },
          h("input", { type: "checkbox", checked: on.has(item.id), disabled: lock, onChange: () => toggle(item.id) }),
          h("span", null, item.label),
          item.sensitive === true ? h("span", { className: "bm-lab" }, "（默认关）") : null))),
        h("p", { className: "bm-note", key: "i2" },
          "本机将打包 " + (state.selection?.files ?? 0) + " 个文件 / 原始 "
          + fmtBytes(state.selection?.bytes) + "（压缩后更小）"
          // 说清楚为什么比看上去小：node_modules 不进包，但体积得摆在明面上。
          + ((state.selection?.skipped ?? 0) > 0
            ? "（另有 " + fmtBytes(state.selection.skipped) + " 在 node_modules 里，不打包）"
            : "")
          + ((state.selection?.missing?.length ?? 0) > 0 ? "；缺少：" + state.selection.missing.join("、") : "")),

        h("h3", { className: "bm-sec", key: "s2" }, "存放与自动备份"),
        h("div", { className: "bm-row", key: "dir" }, h("div", { className: "bm-grow" },
          h("div", { className: "bm-lab" }, "备份目录（留空 = " + state.storeDir + "）"),
          h("input", {
            className: "bm-in",
            value: String(options.storeDir ?? ""),
            placeholder: state.storeDir,
            disabled: lock,
            onChange: (e) => setState({ ...state, options: { ...options, storeDir: e.target.value } }),
            onBlur: (e) => save({ storeDir: e.target.value }).catch(fail),
          })),
          // 选了直接写配置，不让人再去复制粘贴——换盘换机最烦的就是这一步。
          h("button", {
            type: "button",
            className: "bm-btn",
            disabled: lock,
            onClick: () => chooseDir("选目录中", async (dir) => {
              await save({ storeDir: dir });
              setNote("备份目录已改为 " + dir);
            }),
          }, busy === "选目录中" ? "选择…" : "选择文件夹…")),
        h("div", { className: "bm-row", key: "fmt" },
          h("label", { className: "bm-lab" }, "格式"),
          h("select", {
            className: "bm-sel",
            value: options.format ?? "zip",
            disabled: lock,
            onChange: (e) => save({ format: e.target.value }).catch(fail),
          },
            h("option", { key: "z", value: "zip" }, ".zip（默认）"),
            h("option", { key: "t", value: "tgz" }, ".tar.gz")),
          h("label", { className: "bm-lab" }, "自动间隔（分钟，0 = 关）"),
          field("autoIntervalMin", options.autoIntervalMin)),
        h("div", { className: "bm-row", key: "keep" },
          h("label", { className: "bm-lab" }, "保留份数"),
          field("keepCount", options.keepCount),
          h("label", { className: "bm-lab" }, "保留天数（0 = 不限）"),
          field("keepDays", options.keepDays, { step: "1" }),
          h("label", { className: "bm-lab" }, "占用上限 GB（0 = 不限）"),
          field("keepBytesGb", options.keepBytesGb, { step: "0.5" })),
        h("p", { className: "bm-note", key: "a" },
          "清理顺序：先删超过保留天数的，再按占用上限从最旧删起，最后收敛到保留份数；"
          + "刚打出来的这份本次不会被清掉。自动间隔低于 10 分钟按 10 分钟算。"
          + "凭据 .credentials.yaml 默认不打包，需要就在上面勾上。"),

        h("h3", { className: "bm-sec", key: "s3" }, "立即备份"),
        h("div", { className: "bm-row", key: "b" },
          h("button", { type: "button", className: "bm-btn bm-primary", disabled: lock, onClick: doBackup },
            busy === "备份中" ? "备份中…" : "备份到 " + state.storeDir),
          state.running === true ? h("div", { className: "bm-prog" }, h("i")) : null),
        progress !== null
          ? h("p", { className: "bm-note", key: "p" },
            (PHASE_TEXT[progress.phase] ?? String(progress.phase))
            + (typeof progress.bytes === "number" ? "（" + fmtBytes(progress.bytes) + "）" : ""))
          : null,
        // 备份是异步的：POST 早就返回 200 了，失败原因只能在这儿补显。
        failure !== null
          ? h("p", { className: "bm-err", key: "pf" },
            (failure.label ?? "备份") + "失败：" + String(failure.message ?? "未知原因")
            // 通知没发出去必须说出来：不然用户以为「开了通知」而其实一条都没发。
            + (failure.notified === true ? "（已发失败通知）"
              : failure.notifyError ? "（通知没发出去：" + failure.notifyError + "）" : ""))
          : null,

        h("h3", { className: "bm-sec", key: "s4" }, "历史备份"),
        backups.length === 0
          ? h("p", { className: "bm-note", key: "e" }, "还没有备份。")
          : h("div", { className: "bm-list", key: "l" }, backups.map((b) => h("div", {
            className: "bm-file" + (picked === b.name ? " bm-picked" : ""),
            key: b.name,
          },
            h("input", {
              type: "radio",
              name: "bm-pick",
              checked: picked === b.name,
              onChange: () => { setPicked(b.name); setReport(null); },
            }),
            h("div", { className: "bm-meta" },
              h("div", { className: "bm-val" }, b.name),
              h("div", { className: "bm-lab" },
                fmtTime(b.createdAt) + " · " + fmtBytes(b.bytes) + " · " + (b.items ?? []).length + " 项"
                + (b.sha256 === null ? "（大文件未记哈希）" : ""))),
            h("button", { type: "button", className: "bm-btn", disabled: lock, onClick: () => doExport(b.name) }, "导出…"),
            h("button", { type: "button", className: "bm-btn bm-danger", disabled: lock, onClick: () => doDelete(b.name) }, "删除")))),

        h("h3", { className: "bm-sec", key: "s5" }, "换机：导入备份"),
        h("div", { className: "bm-row", key: "u" },
          h("label", { className: "bm-btn" }, busy === "上传中" ? "上传中…" : "选择备份文件…",
            h("input", { type: "file", accept: ".zip,.gz", style: { display: "none" }, onChange: onPick })),
          h("span", { className: "bm-lab" }, "从 U 盘 / 旧电脑拷过来的 .zip 或 .tar.gz")),
        report !== null ? h("div", { key: "r" },
          h("p", { className: "bm-note" },
            String(report.manifest?.sourceRoot ?? "未知来源") + " · "
            + fmtTime(report.manifest?.createdAt) + " · " + report.entries + " 条目 · "
            + fmtBytes(report.bytes)
            + (report.manifest?.dsh ? " · DSH " + report.manifest.dsh : "")),
          report.problems.length === 0
            ? h("p", { className: "bm-ok" }, "校验通过，可以还原。")
            : h("div", null, report.problems.map((p, i) => h("p", { className: "bm-err", key: "e" + i }, String(p))))) : null,
        picked !== "" ? h("div", { className: "bm-row", key: "m" },
          h("label", { className: "bm-lab" }, "还原方式"),
          h("select", { className: "bm-sel", value: mode, disabled: lock, onChange: (e) => setMode(e.target.value) },
            h("option", { key: "s", value: "staged" }, "暂存区（解出来 + restore.ps1，自己确认再落盘）"),
            h("option", { key: "d", value: "direct" }, "直接写回数据目录（覆盖同名文件）")),
          h("button", { type: "button", className: "bm-btn bm-primary", disabled: lock, onClick: doRestore }, "还原"),
          h("button", { type: "button", className: "bm-btn", disabled: lock, onClick: doInspect }, "重新校验")) : null,
        picked !== "" && mode === "staged"
          ? h("p", { className: "bm-note", key: "sn" },
            "暂存区在备份目录里，是一个 .restore-* 文件夹。确认无误后执行里面的 restore.ps1 才真正写回（建议先关掉 DSH）。")
          : null,

        h("h3", { className: "bm-sec", key: "s6" }, "导出到指定位置"),
        h("div", { className: "bm-row", key: "x" },
          h("div", { className: "bm-grow" }, h("input", {
            className: "bm-in",
            value: dest,
            placeholder: "例如 E:/备份/dsh-2026.zip",
            onChange: (e) => setDest(e.target.value),
          })),
          // 导出要的是完整文件名，所以只让用户选文件夹，文件名留给他自己改。
          h("button", {
            type: "button",
            className: "bm-btn",
            disabled: lock,
            onClick: () => chooseDir("选目录中", (dir) => {
              const current = dest.trim();
              const stem = current === "" ? stampName() + ".zip" : current.split(/[\\/]/).pop();
              setDest(dir + "/" + stem);
              setNote("已填好导出路径，点右侧按钮复制过去");
            }),
          }, busy === "选目录中" ? "选择…" : "选择文件夹…"),
          picked !== ""
            ? h("button", { type: "button", className: "bm-btn", disabled: lock, onClick: () => doExport(picked) }, "把选中那份复制过去")
            : null),
        h("p", { className: "bm-note", key: "xn" },
          "「选择文件夹…」走系统原生对话框，选完直接生效；也可以直接把备份目录里的文件手工拷走。"),

        h("h3", { className: "bm-sec", key: "s7" }, "备份失败时通知我"),
        targets.available !== true
          ? h("p", { className: "bm-note", key: "na" },
            "没检测到 dsh-im 通道（装上并连好机器人后这里才能选收件目标）。失败时仍会在本页红字提示并写进宿主日志。")
          : h("div", { className: "bm-row", key: "nb" },
            h("label", { className: "bm-item" },
              h("input", {
                type: "checkbox",
                checked: options.notifyOnFailure === true,
                disabled: lock,
                onChange: (ev) => save({ notifyOnFailure: ev.target.checked }).catch(fail),
              }),
              h("span", null, "备份失败时发一条消息")),
            h("select", {
              className: "bm-sel",
              value: String(options.notifyTarget ?? ""),
              disabled: lock || options.notifyOnFailure !== true,
              onChange: (ev) => save({ notifyTarget: ev.target.value }).catch(fail),
            },
              h("option", { key: "-", value: "" }, "（选择收件目标）"),
              ...targets.targets.map((row) => h("option", { key: row.value, value: row.value }, row.label)))),

        h("h3", { className: "bm-sec", key: "s8" }, "云端备份（WebDAV）"),
        h("p", { className: "bm-note", key: "cn" },
          "坚果云 / Nextcloud / 群晖 / Alist 等任意 WebDAV 都行。口令是明文存在本机配置文件里的，"
          + "建议用它给的应用专用密码，别用主账号密码。"),
        h("div", { className: "bm-row", key: "curl" },
          h("div", { className: "bm-grow" },
            h("div", { className: "bm-lab" }, "WebDAV 地址"),
            text("cloudUrl", "https://dav.jianguoyun.com/dav/"))),
        h("div", { className: "bm-row", key: "cacc" },
          h("div", { className: "bm-grow" },
            h("div", { className: "bm-lab" }, "远端目录（可选）"),
            text("cloudDir", "dsh-backups")),
          h("div", { className: "bm-grow" },
            h("div", { className: "bm-lab" }, "账号"),
            text("cloudUser", "you@example.com")),
          h("div", { className: "bm-grow" },
            h("div", { className: "bm-lab" }, "口令 / 应用密码"),
            text("cloudPass", "••••••", { type: "password" }))),
        h("div", { className: "bm-row", key: "cact" },
          h("button", { type: "button", className: "bm-btn", disabled: lock, onClick: doCloudList },
            busy === "云端列目录中" ? "读取中…" : "查看云端备份"),
          picked !== ""
            ? h("button", { type: "button", className: "bm-btn bm-primary", disabled: lock,
              onClick: () => doCloudUpload(picked) },
              busy === "上传云端中" ? "上传中…" : "把选中的这份传上去")
            : h("span", { className: "bm-lab" }, "先在「历史备份」里选中一份，才能把它传到云端")),
        cloudRows.length === 0
          ? null
          : h("div", { className: "bm-list", key: "cl" }, cloudRows.map((row) => h("div", {
            className: "bm-file",
            key: row.name,
          },
            h("div", { className: "bm-meta" },
              h("div", { className: "bm-val" }, row.name),
              h("div", { className: "bm-lab" }, fmtBytes(row.bytes) + " · " + String(row.modified ?? ""))),
            h("button", { type: "button", className: "bm-btn", disabled: lock,
              onClick: () => doCloudDownload(row.name) }, "下载到备份目录")))),

        h("h3", { className: "bm-sec", key: "s9" }, "卸载本插件"),
        h("p", { className: "bm-note", key: "un" },
          "从当前的 DSH profile 里摘掉本插件（package.json 会先备份一份，重启 DSH 后生效）。"
          + "备份文件、备份配置和云端设置都留在原处，不会删。"),
        h("button", { type: "button", className: "bm-btn bm-danger", disabled: lock, onClick: doUninstall },
          busy === "卸载中" ? "卸载中…" : "卸载插件…"),

        error === "" ? null : h("p", { className: "bm-err", key: "err" }, error),
        note === "" ? null : h("p", { className: "bm-ok", key: "note" }, note),
      ];

      return h("span", { className: "bm-wrap", title: props?.locale ?? undefined }, ...kids);
    }

    exports.apply = apply;
    exports.inject = inject;
    return exports;
  },
});
