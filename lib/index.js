/**
 * dsh-backup-migrator — 主入口（宿主侧）
 *
 * 职责边界（能压到最小就压）：
 *   - 读配置：settings.describe() 里按 ns 找自己那行，拿不到就退回 loader 给的 config。
 *   - 挂接口：面板每个 endpoint 挂一条宿主「连接层」的**精确 fetch 路由** /api/dsh-backup-migrator/<endpoint>
 *     （带真正的浏览器鉴权 + Host/Origin 信任），见 API_PREFIX。
 *   - 定时器：autoIntervalMin > 0 时按间隔自动打包；0 = 只手动。
 * 真正的打包 / 校验 / 还原逻辑全在 lib/backup.js（不依赖 cordis，可单测）。
 *
 * 为什么不用 ctx.webServer.register（2026-10-18 换掉）：
 *   - webServer 上的插件路由**不在宿主的鉴权墙后面**：任何本机进程、乃至经 cloudflared
 *     隧道进来的公网请求（remoteAddress 恒为回环）都能无凭据读写「删备份 / 还原 / 卸插件」。
 *   - 连接层（@deepseek-ai/dsh-client-connection）自带鉴权：admit() 验浏览器凭据 + Host/Origin
 *     信任，精确 fetch 路由还要求 principal.kind === "owner"。
 *
 * 为什么连 connection.rpc.handle 也不能用（2026-10-18 真机实测 + 源码定位；0.3.2 的 405 就是它）：
 *   - rpc.handle 内部 register(owner, …) 要用**读取者 ctx** 的 owner.webServer 去挂前缀路由
 *     （dsh-client-connection/lib/index.js:724-730 的 get rpc() → :855-872 的 owner.effect）。
 *     而这个 owner 被 createShadow 绑成**连接层插件自己**的 ctx（其 inject 只有 credentials），
 *     守卫（@deepseek-ai/cordis/lib/index.js:676-698）沿那条 fiber 往上找 webServer 必然落空 →
 *     抛 `cannot get property "webServer" without inject`。我们的 inject 名单救不了它：
 *     实测调用方 inject 空/满两种写法都抛，因为守卫看的是连接层那条 fiber。
 *   - 本代 DSH 的 webServer 由 dsh-host-webserver 这个**兄弟**插件 provide，没人往连接层的
 *     祖先链上挂过它 —— 所以 0.2.1-rc.2 里任何插件都拿不到 rpc.handle。
 *   - fetch.register 走的是另一条路（:840-853 只往自己的 Map 里塞，不碰 owner.webServer），
 *     由连接层自己用 `ctx.inject(["webServer"], webCtx => …)` 挂的 /api 前缀（:1035-1065）分发，
 *     所以**永远可用**。0.3.3 起面板全部端点都走它。
 *
 * 接口形态（都在 ctx.connection 上）：
 *   - fetch.register({ path: API_PREFIX + "/" + endpoint, methods: ["POST"], requestBody: "buffered" })：
 *     每个 endpoint 一条**精确路径**路由（连接层只做 pathname 精确匹配，不支持前缀）。
 *     请求体是面板自己的 JSON，响应体是 {ok:true,value} / {ok:false,error:{code,message,details}}。
 *   - fetch.register({ path: IMPORT_PATH, requestBody: "streaming" })：上传几百 MB 的备份。
 *     JSON 路由装不下文件，所以上传单开一条流式路由。
 *   - rpc.handle(CHANNEL, handler)：**留着但必抛**（见上），只当将来 DSH 修好后的备用通道；
 *     客户端在没有精确路由时也会回退到 connection.rpc.call（老宿主兼容）。
 *
 * 换机怎么进来：面板用原生 <input type="file"> 选文件 → POST 原始字节到 IMPORT_PATH，
 * 落到 storeDir 里成为一条普通历史条目 → 校验 → 还原。不问用户要绝对路径：
 * 浏览器给不出文件路径，而手填路径在换机场景里是多余的输入。
 */

import { appendFileSync, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import z from "@deepseek-ai/schemastery";

import {
  NS, ROUTE, createBackup, dataRootOf, defaultOptions, deleteBackup, dshVersionOf, exportBackup,
  inspectBackup, invalidateScan, itemsOf, listBackups, readManifest, rememberDshVersion, restoreBackup,
  scanLazy, storeDirOf, ITEM_CATALOG,
} from "./backup.js";
import { CLOUD_BACKUP_NAME, cloudDownload, cloudList, cloudUpload } from "./cloud.js";
import { findProfiles, uninstallProfile } from "./uninstall.js";

const VERSION = "0.3.3";
/** 启动诊断日志（<数据根>/.backup-migrator-plugin/boot.log）：宿主半插件挂没挂、挂到哪一步失败，只有它能说清。 */
function trace(line) {
  const text = "[" + new Date().toISOString() + "] " + line;
  try { console.log("[backup-migrator] " + text); } catch { /* 控制台没了也要闭嘴 */ }
  try {
    const dir = join(dataRootOf(), ".backup-migrator-plugin");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "boot.log");
    try { if (statSync(file).size > 256 * 1024) renameSync(file, join(dir, "boot.log.1")); } catch { /* 首次或改名失败都无所谓 */ }
    appendFileSync(file, text + "\n");
  } catch { /* 日志绝不能影响加载 */ }
}
trace("模块已加载 v" + VERSION);
const inject = [];
/** 连接层 channel：面板 connection.rpc.call(CHANNEL, endpoint, …) 必须与这里一致。 */
const CHANNEL = "/dsh-backup-migrator";
/**
 * 面板写接口的 URL 前缀。连接层把 /api 前缀挂在宿主 webServer 上（它自己 inject 到了 webServer），
 * 我们给每个 endpoint 注册一条精确路由 /api/dsh-backup-migrator/<endpoint>。
 * 客户端 lib/client.js 的 API_PREFIX 必须与这里同源（自检会对账）。
 */
const API_PREFIX = "/api/dsh-backup-migrator";
/** 上传单开一条流式 fetch 路由（JSON 路由的请求体装不下备份）。 */
const IMPORT_PATH = API_PREFIX + "/import";
/** 单次上传上限：本地工具，8GB 够一份换机包，也挡得住把盘写满。 */
const MAX_UPLOAD = 8 * 1024 * 1024 * 1024;

/**
 * 配置 schema。整块可编辑面只能是**一个** volatile 节点——嵌套 volatile() 是 schemastery
 * 硬错误。交互全部由设置页面板提供，schema 只负责校验与默认值（并关掉宿主自动表单）。
 */
const Options = z.object({
  /** 备份存放目录；空 = <数据根>\backups。支持跨盘符 / 外置硬盘。 */
  storeDir: z.string().default(""),
  /** zip（默认）或 tar.gz。两者都走系统 tar，不引第三方依赖。 */
  format: z.union(["zip", "tgz"]).default("zip"),
  /** 要备份哪些单元，见 backup.js 的 ITEMS。 */
  items: z.array(z.string()).default([]),
  /** 自动备份间隔（分钟），0 = 关闭。 */
  autoIntervalMin: z.number().default(0),
  /** 保留份数，超出自动清理最旧的。 */
  keepCount: z.number().default(10),
  /** 保留天数，0 = 不限；超期的最先被清掉。 */
  keepDays: z.number().default(0),
  /** 备份目录总占用上限（GB，可小数），0 = 不限；超了从最旧的删起。 */
  keepBytesGb: z.number().default(0),
  /** 失败通知：装了 dsh-im 才有通道；target 形如 botId::targetId（面板从已登记的投递目标里选）。 */
  notifyOnFailure: z.boolean().default(false),
  notifyTarget: z.string().default(""),
  /** 云端备份（WebDAV）。口令是明文存进配置文件里的，面板上写明了。 */
  cloudUrl: z.string().default(""),
  cloudDir: z.string().default(""),
  cloudUser: z.string().default(""),
  cloudPass: z.string().default(""),
});

const Config = z.object({ options: Options.volatile() });

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** describe() 的返回形态在 0.2.0 上是数组，也可能包一层 { namespaces }，都收。 */
function namespaceOf(described, namespace) {
  const rows = Array.isArray(described) ? described : described?.namespaces ?? [];
  const row = rows.find((item) => item?.ns === namespace);
  const value = row?.value !== null && typeof row?.value === "object" ? row.value : {};
  return { revision: row?.revision ?? 0, value };
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate())
    + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/**
 * 收上传的备份：流式落盘，不进内存。
 * 备份动辄几百 MB，readFileSync 一把梭就是 OOM；写成 .part 再改名，中断也不会留半个
 * 看起来合法的备份文件。
 */
async function receiveUpload(body, storeDir, logger, maxBytes = MAX_UPLOAD) {
  if (body === null || body === undefined) throw new Error("上传请求没有请求体");
  const tmp = join(storeDir, ".upload-" + Date.now() + ".part");
  // 边收边数：Content-Length 可以是假的，也可以根本不存在（chunked），只有流上的字节数作数。
  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > maxBytes) {
        done(new Error("备份文件超过上限 " + Math.round(maxBytes / 1048576) + "MB"));
        return;
      }
      done(null, chunk);
    },
  });
  try {
    // body 是连接层 streaming 模式直通过来的请求体（ReadableStream）。
    // 必须读干净：连接层看到 requestUnread 就 req.destroy()，响应会被截断。
    await pipeline(Readable.fromWeb(body), counter, createWriteStream(tmp));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  // 扩展名跟着内容走：manifest 说它是 tar.gz 就别改名成 .zip，否则 inspect 阶段
  // 的格式一致性检查会拿扩展名去对，直接把好备份判成坏的。
  let format = "zip";
  try {
    format = String(readManifest(tmp)?.format ?? "zip");
  } catch (error) {
    await rm(tmp, { force: true });
    throw new Error("这不是一份可读的备份：" + messageOf(error));
  }
  // 同一秒内上传两次、或跟本机刚生成的备份撞在同一秒时，不能把已有备份覆盖掉：
  // 本仓既有语义就是「撞名加序号」（lib/backup.js 的 createBackup / exportBackup / .pre-restore 三处同款）。
  const ext = format === "tgz" ? ".tar.gz" : ".zip";
  const stem = "dsh-backup-" + stamp();
  let name = stem + ext;
  for (let n = 2; existsSync(join(storeDir, name)); n += 1) name = stem + "-" + n + ext;
  const file = join(storeDir, name);
  await rename(tmp, file);
  logger.info(NS + ": 收到上传备份 " + name);
  return name;
}

function apply(ctx, config) {
  // ctx.get() 不看 inject（读不到也不抛），所以这里只当线索用：Service 形态的服务不一定能这样取到。
  const probe = (name) => { try { return typeof ctx.get(name); } catch { return "?"; } };
  trace("apply 进入：settings=" + probe("settings") + " webServer=" + probe("webServer") + " connection=" + probe("connection"));
  let entered = false;
  // 服务一直不到位时 inject 回调会永远不进——那条线索不能只留在「没日志」里。
  const pendingTimer = setTimeout(() => {
    if (!entered) {
      trace("警告：inject 回调 20 秒仍未进入 → 有服务始终不可用（settings/webServer/connection 之一）");
    }
  }, 20_000);
  pendingTimer.unref?.();
  // cordis 只传 (ctx, config)，第三参数 logger 永远是 undefined。之前用它打日志，
  // 备份失败时在 .catch() 里抛 TypeError，未处理的 rejection 直接把宿主带崩——
  // 用户看到的是「DSH 闪退 + 路由变 404」，而不是真正的失败原因。
  const logger = ctx.logger ?? console;

  /** 一次只跑一个备份：定时器和手动按钮共用这一个槽。 */
  let running = null;
  let progress = null;
  // 备份是异步的，失败没地方回给面板（POST /backup 早就 200 了）。留住最后一次原因，
  // 否则用户只会看到「点了没反应」，得去翻日志。
  let failure = null;

  function currentOptions(settings) {
    const base = defaultOptions();
    try {
      const { value } = namespaceOf(settings.describe(), NS);
      if (value?.options !== null && typeof value?.options === "object") return { ...base, ...value.options };
    } catch { /* settings 服务异常时退回 loader 配置 */ }
    return { ...base, ...(config.options ?? {}) };
  }

  function snapshot(options) {
    const ids = itemsOf(options);
    const selection = scanLazy(ids, dataRootOf());
    return {
      options,
      storeDir: storeDirOf(options),
      dataRoot: dataRootOf(),
      catalog: ITEM_CATALOG,
      // 这里绝不能同步全量扫盘：/status 被面板 900ms 轮询一次，/options 每点一下都要回一遍，
      // 而 profiles 下 6 万个文件 stat 一遍 1.7 秒 —— 那就是「点一下等两秒」的来源。
      // scanLazy 只读缓存、要算的丢后台，所以响应永远是毫秒级。
      selection: selection.value,
      // 数字还在后台补算：面板据此再轮一次，并显示「统计中」，别让人以为这就是终值。
      selectionPending: selection.pending,
      backups: listBackups(options),
      running: running !== null,
      progress,
      failure,
      version: VERSION,
    };
  }

  /**
   * 失败通知。宿主没有通知服务（app.asar 里 grep 不到任何 notif/toast 的 provide），
   * 唯一现成通道是 dsh-im（用户装了才有）。通道或目标缺失时**不静默**：把原因一并回给面板，
   * 否则用户会以为「开了通知」而实际什么都没发出去。
   */
  async function notifyFailure(options, text) {
    const im = ctx.get("dshIm");
    const target = String(options?.notifyTarget ?? "");
    if (im?.send === undefined) return { sent: false, reason: "宿主里没有 dsh-im 通道" };
    if (target === "") return { sent: false, reason: "还没选通知目标" };
    const cut = target.indexOf("::");
    const botId = target.slice(0, cut);
    const targetId = target.slice(cut + 2);
    try {
      // 结果必须看 result.sent：sendChecked 不抛错也不代表送达（抄 dsh-task-notify 的判据）。
      const result = await im.send(botId, targetId, text, { format: "text" });
      return result?.sent === true ? { sent: true, reason: "" } : { sent: false, reason: "通道未确认送达" };
    } catch (error) {
      return { sent: false, reason: messageOf(error) };
    }
  }

  function startBackup(options, label) {
    if (running !== null) return null;
    failure = null;
    running = createBackup(options, {
      version: VERSION,
      dsh: dshVersionOf(),
      onPhase(phase, info) {
        progress = { phase, at: Date.now(), ...info };
      },
    })
      .then((result) => logger.info(NS + ": " + label + "完成 " + result.name))
      .catch((error) => {
        failure = { at: Date.now(), label, message: messageOf(error), notified: null, notifyError: "" };
        logger.warn(NS + ": " + label + "失败 " + failure.message);
        if (options?.notifyOnFailure !== true) return;
        return notifyFailure(options, "DSH 备份失败\n动作：" + label + "\n时间："
          + new Date().toLocaleString("zh-CN") + "\n原因：" + failure.message)
          .then((result) => {
            failure.notified = result.sent;
            failure.notifyError = result.reason;
            if (!result.sent) logger.warn(NS + ": 失败通知没发出去 " + result.reason);
          });
      })
      .finally(() => {
        // 面板的「本机将打包多少」带缓存，打完必须失效一次，否则数字停在备份之前。
        invalidateScan();
        running = null;
        progress = null;
      });
    return running;
  }

  ctx.inject(["settings", "webServer", "connection"], (sctx) => {
    entered = true;
    clearTimeout(pendingTimer);
    trace("inject 回调进入：settings=" + typeof sctx.settings + " webServer=" + typeof sctx.webServer + " connection=" + typeof sctx.connection);
    sctx.effect(() => {
      // 面板自带全部交互，宿主再生成一份 schema 表单只会重复。
      try {
        sctx.settings.configure({ auto: false }, ctx.fiber);
      } catch (error) {
        trace("settings.configure 失败：" + messageOf(error));
      }

      const ok = (value) => ({ ok: true, value });
      /**
       * 失败对象必须带 string code / string message / **record** details：连接层客户端的
       * parseConnectionResponse 校验不过就直接抛 connection: invalid server-response failure，
       * 用户看到的是「请求失败」而不是真正的错因。
       */
      const bad = (error, code = "backup-migrator/error") => ({
        ok: false,
        error: { code, message: messageOf(error), details: {} },
      });

      /** 每个 endpoint 都从这里起手：解析配置 + 统一错误出口。 */
      const run = async (fn) => {
        try {
          return ok(await fn(currentOptions(sctx.settings)));
        } catch (error) {
          logger.warn(NS + ": " + messageOf(error));
          return bad(error);
        }
      };

      /** 备份名必须是本插件自己产出的名字（防 ../ 逃逸）。 */
      const picked = (options, name) => {
        const safe = basename(String(name ?? ""));
        if (safe === "") throw new Error("请先在下面选一份备份");
        const file = join(storeDirOf(options), safe);
        return { safe, file };
      };

      /**
       * 已登记的 dsh-im 投递目标，给面板做下拉。
       * dsh-im 暴露的字段名没有公开文档，所以每个字段都取几个候选名并逐 bot try/catch——
       * 某个 bot 的形态变了，不该让整个下拉变空。
       */
      const notifyTargets = async () => {
        const im = ctx.get("dshIm");
        if (im?.listBots === undefined || im?.listTargets === undefined) {
          return { available: false, targets: [] };
        }
        const targets = [];
        for (const bot of await im.listBots()) {
          const botId = String(bot?.botId ?? bot?.id ?? "");
          if (botId === "") continue;
          let list = [];
          try {
            list = await im.listTargets(botId);
          } catch {
            continue;
          }
          for (const item of list ?? []) {
            const targetId = String(item?.targetId ?? item?.id ?? "");
            if (targetId === "") continue;
            targets.push({
              value: botId + "::" + targetId,
              label: (bot?.name ?? bot?.displayName ?? botId) + " / "
                + (item?.title ?? item?.name ?? item?.label ?? targetId),
            });
          }
        }
        return { available: true, targets };
      };

      /**
       * endpoint → 处理器；payload 就是面板 connection.rpc.call 的第三个参数（对象）。
       * endpoint 里允许带 /（"cloud/list"）：连接层按 / 切段，每段匹配 [A-Za-z0-9_$.-]+。
       */
      const endpoints = {
        status: (options) => snapshot(options),
        backup: (options) => {
          if (running !== null) throw new Error("已有备份在进行中");
          startBackup(options, "手动备份");
          return { started: true };
        },
        options: async (options, body) => {
          const patch = body.patch !== null && typeof body.patch === "object" ? body.patch : {};
          const next = { ...options, ...patch };
          const { revision } = namespaceOf(sctx.settings.describe(), NS);
          await sctx.settings.update(NS, { options: next }, revision);
          return snapshot(next);
        },
        inspect: (options, body) => inspectBackup(picked(options, body.name).file),
        restore: (options, body) => restoreBackup(
          picked(options, body.name).file,
          body.mode === "direct" ? "direct" : "staged",
          options,
        ),
        delete: (options, body) => deleteBackup(options, picked(options, body.name).safe),
        export: (options, body) => exportBackup(options, picked(options, body.name).safe, body.dest),
        // 面板每次打开都把渲染进程里的 DSH 版本报回来：宿主进程自己探不到（asar 是单文件）。
        hello: (options, body) => ({ dsh: rememberDshVersion(body.version) }),
        "notify-targets": () => notifyTargets(),
        "cloud/list": async (options) => {
          const rows = await cloudList(options);
          return { rows: rows.filter((row) => CLOUD_BACKUP_NAME.test(row.name)) };
        },
        "cloud/upload": async (options, body) => {
          const { safe, file } = picked(options, body.name);
          return cloudUpload(options, file, safe);
        },
        "cloud/download": async (options, body) => {
          const remote = basename(String(body.name ?? ""));
          if (!CLOUD_BACKUP_NAME.test(remote)) throw new Error("云端这个文件名不像本插件的备份");
          const got = await cloudDownload(options, remote, storeDirOf(options));
          return { ...got, report: inspectBackup(got.file) };
        },
        // 卸载本插件。用户点了确认才会打到这里；卸载后要重启 DSH 才生效。
        uninstall: () => {
          const profiles = findProfiles(dataRootOf());
          if (profiles.length === 0) throw new Error("没找到装过本插件的 profile（可能已经卸过了）");
          const results = profiles.map((profile) => uninstallProfile(profile, String(Date.now())));
          logger.info(NS + ": 已卸载 " + results.map((row) => row.profile).join(", "));
          return { results, hint: "重启 DSH 之后插件才真正消失（package.json 已改，包目录已删）。" };
        },
      };

      /**
       * 面板的写接口：每个 endpoint 一条**精确 fetch 路由**
       *   /api/dsh-backup-migrator/<endpoint>   （"cloud/list" → /api/dsh-backup-migrator/cloud/list）
       * 鉴权由连接层把关（先过浏览器凭据 + Host/Origin 信任，再要求 principal 是 owner）。
       * 连接层只对 pathname 做**精确**匹配，所以一条 endpoint 一条路由，省不成前缀。
       */
      const onJson = [];
      for (const [name, fn] of Object.entries(endpoints)) {
        try {
          onJson.push(sctx.connection.fetch.register({
            path: API_PREFIX + "/" + name,
            methods: ["POST"],
            // 必须显式写 buffered：requestBody 缺省时 createSharedFetchHandler 返回 undefined，
            // bridge 判成非 buffered 就走流式通道，request.json() 在那种形态下不可靠。
            requestBody: "buffered",
            async fetch(request) {
              if (request.headers.get("x-backup-migrator") !== "1") {
                return Response.json(bad("缺少 x-backup-migrator 头", "backup-migrator/forbidden"), { status: 403 });
              }
              let body = {};
              try { body = await request.json(); } catch { /* 空体当 {}：status/hello/notify-targets 不带参数 */ }
              if (body === null || typeof body !== "object") body = {};
              return Response.json(await run((options) => fn(options, body)));
            },
          }));
        } catch (error) {
          trace("fetch 路由注册失败 " + name + "：" + messageOf(error));
        }
      }
      trace("面板 fetch 路由注册 " + onJson.length + "/" + Object.keys(endpoints).length + " 条：" + API_PREFIX + "/<endpoint>");

      const onRpc = (() => {
        try {
          const disposer = sctx.connection.rpc.handle(CHANNEL, (endpoint, payload) => {
            const fn = endpoints[endpoint];
            if (fn === undefined) return bad("没有这个接口：" + endpoint, "backup-migrator/not-found");
            return run((options) => fn(options, payload ?? {}));
          });
          trace("rpc.handle 注册成功：" + CHANNEL);
          return disposer;
        } catch (error) {
          trace("rpc.handle 注册失败：" + messageOf(error));
          return null;
        }
      })();

      /**
       * 上传备份：单开一条流式 fetch 路由。连接层对 fetch 路由额外要求 principal 是 owner
       * （浏览器凭据已验），非回环 Host 连门都进不来；streaming 模式必须把请求体读干净，
       * 否则连接层会 req.destroy() 把响应截断。
       */
      const onUpload = (() => {
        try {
          const disposer = sctx.connection.fetch.register({
        path: IMPORT_PATH,
        methods: ["POST"],
        requestBody: "streaming",
        async fetch(request) {
          try {
            // 自定义头只是给自己留个痕：真正的鉴权是连接层的浏览器凭据 + Host/Origin 信任。
            if (request.headers.get("x-backup-migrator") !== "1") {
              try { await request.body?.cancel(); } catch { /* 已经在关了 */ }
              return Response.json(bad("缺少 x-backup-migrator 头", "backup-migrator/forbidden"), { status: 403 });
            }
            const options = currentOptions(sctx.settings);
            const name = await receiveUpload(request.body, storeDirOf(options), logger);
            return Response.json(ok({ name, report: inspectBackup(join(storeDirOf(options), name)) }));
          } catch (error) {
            logger.warn(NS + ": 上传备份失败 " + messageOf(error));
            return Response.json(bad(error), { status: 400 });
          }
        },
          });
          trace("fetch.register 注册成功：" + IMPORT_PATH);
          return disposer;
        } catch (error) {
          trace("fetch.register 注册失败：" + messageOf(error));
          return null;
        }
      })();

      trace("注册阶段结束（面板路由=" + onJson.length + " rpc=" + (onRpc === null ? "无" : "有")
        + " upload=" + (onUpload === null ? "无" : "有") + "）");
      return () => {
        for (const dispose of onJson) { try { dispose?.(); } catch { /* 已经放下 */ } }
        try { onRpc?.(); } catch { /* 已经放下 */ }
        try { onUpload?.(); } catch { /* 已经放下 */ }
      };
    }, NS + ": api");

    // 自动备份：每 30 秒问一次「距上次自动备份够不够久」，而不是把间隔焊进 setInterval——
    // 焊死的话面板上改了间隔必须重启 DSH 才生效。备份是 IO 重活，间隔下限 10 分钟兜住，
    // 否则用户一不留神就把硬盘写满。
    sctx.effect(() => {
      let last = Date.now();
      const timer = setInterval(() => {
        const minutes = Number(currentOptions(sctx.settings).autoIntervalMin ?? 0);
        if (!Number.isFinite(minutes) || minutes <= 0) return;
        if (Date.now() - last < Math.max(10, minutes) * 60_000) return;
        last = Date.now();
        startBackup(currentOptions(sctx.settings), "定时备份");
      }, 30_000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, NS + ": auto timer");
  });
}

export { NS, ROUTE, VERSION, Config, apply, inject };
export default { apply, inject, name: NS, Config };
