/**
 * dsh-backup-migrator — 主入口（宿主侧）
 *
 * 职责边界（能压到最小就压）：
 *   - 读配置：settings.describe() 里按 ns 找自己那行，拿不到就退回 loader 给的 config。
 *   - 挂 HTTP 路由：面板所有读写都走 /_backup-migrator/api/*。
 *   - 定时器：autoIntervalMin > 0 时按间隔自动打包；0 = 只手动。
 * 真正的打包 / 校验 / 还原逻辑全在 lib/backup.js（不依赖 cordis，可单测）。
 *
 * 约定提醒（踩过的坑）：
 *   - 路由路径必须以 / 开头，否则 WebServer.match() 的 exact 表永远匹配不上。
 *   - handler 收的是 node 原生 (req, res)，自己 writeHead/end。
 *
 * 换机怎么进来：面板用原生 <input type="file"> 选文件 → POST 原始字节到 /import，
 * 落到 storeDir 里成为一条普通历史条目 → 校验 → 还原。不问用户要绝对路径：
 * 浏览器给不出文件路径，而手填路径在换机场景里是多余的输入。
 */

import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
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

const VERSION = "0.3.1";
const inject = [];
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

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((done, fail) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        fail(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        done({});
        return;
      }
      try {
        done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", fail);
  });
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
async function receiveUpload(req, storeDir, logger, maxBytes = MAX_UPLOAD) {
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
    await pipeline(req, counter, createWriteStream(tmp));
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
  const name = "dsh-backup-" + stamp() + (format === "tgz" ? ".tar.gz" : ".zip");
  const file = join(storeDir, name);
  await rename(tmp, file);
  logger.info(NS + ": 收到上传备份 " + name);
  return name;
}

function apply(ctx, config) {
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

  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => {
      // 面板自带全部交互，宿主再生成一份 schema 表单只会重复。
      sctx.settings.configure({ auto: false }, ctx.fiber);

      /** 每个 handler 都从这里起手：解析配置 + 统一错误出口。 */
      const handle = (req, res, fn) => {
        let options;
        try {
          options = currentOptions(sctx.settings);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: { message: messageOf(error) } });
          return;
        }
        Promise.resolve()
          .then(() => fn(options))
          .then((value) => writeJson(res, 200, { ok: true, value }))
          .catch((error) => {
            logger.warn(NS + ": " + messageOf(error));
            writeJson(res, 400, { ok: false, error: { message: messageOf(error) } });
          });
      };

      /** POST-only：这几个动作都改状态，GET 进来没有意义。 */
      const post = (fn) => async (req, res) => {
        const body = await readJson(req).catch((error) => {
          writeJson(res, 400, { ok: false, error: { message: messageOf(error) } });
          return;
        });
        if (body === undefined) return;
        handle(req, res, (options) => fn(options, body));
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

      const routes = [
        {
          kind: "exact",
          path: ROUTE + "/status",
          handler(req, res) {
            handle(req, res, (options) => snapshot(options));
          },
        },
        {
          kind: "exact",
          path: ROUTE + "/backup",
          handler(req, res) {
            handle(req, res, (options) => {
              if (running !== null) throw new Error("已有备份在进行中");
              startBackup(options, "手动备份");
              return { started: true };
            });
          },
        },
        {
          kind: "exact",
          path: ROUTE + "/options",
          handler: post(async (options, body) => {
            const patch = body.patch !== null && typeof body.patch === "object" ? body.patch : {};
            const next = { ...options, ...patch };
            const { revision } = namespaceOf(sctx.settings.describe(), NS);
            await sctx.settings.update(NS, { options: next }, revision);
            return snapshot(next);
          }),
        },
        {
          kind: "exact",
          path: ROUTE + "/import",
          handler(req, res) {
            let options;
            try {
              options = currentOptions(sctx.settings);
            } catch (error) {
              writeJson(res, 500, { ok: false, error: { message: messageOf(error) } });
              req.resume();
              return;
            }
            // 带自定义头的才是本插件面板发的。没有它的 POST 在浏览器眼里是「简单请求」，
            // 任意网页都能诱导用户浏览器往这里灌一个文件。
            if (req.headers["x-backup-migrator"] !== "1") {
              req.resume();
              writeJson(res, 403, { ok: false, error: { message: "缺少 x-backup-migrator 头" } });
              return;
            }
            void receiveUpload(req, storeDirOf(options), logger)
              .then(async (name) => ({ name, report: inspectBackup(join(storeDirOf(options), name)) }))
              .then((value) => writeJson(res, 200, { ok: true, value }))
              .catch((error) => {
                logger.warn(NS + ": 上传备份失败 " + messageOf(error));
                writeJson(res, 400, { ok: false, error: { message: messageOf(error) } });
              });
          },
        },
        {
          kind: "exact",
          path: ROUTE + "/inspect",
          handler: post((options, body) => inspectBackup(picked(options, body.name).file)),
        },
        {
          kind: "exact",
          path: ROUTE + "/restore",
          handler: post((options, body) => restoreBackup(
            picked(options, body.name).file,
            body.mode === "direct" ? "direct" : "staged",
            options,
          )),
        },
        {
          kind: "exact",
          path: ROUTE + "/delete",
          handler: post((options, body) => deleteBackup(options, picked(options, body.name).safe)),
        },
        {
          kind: "exact",
          path: ROUTE + "/export",
          handler: post((options, body) => exportBackup(options, picked(options, body.name).safe, body.dest)),
        },
        {
          // 面板每次打开都把渲染进程里的 DSH 版本报回来：宿主进程自己探不到（asar 是单文件）。
          kind: "exact",
          path: ROUTE + "/hello",
          handler: post((options, body) => ({ dsh: rememberDshVersion(body.version) })),
        },
        {
          kind: "exact",
          path: ROUTE + "/notify-targets",
          handler(req, res) {
            handle(req, res, () => notifyTargets());
          },
        },
        {
          kind: "exact",
          path: ROUTE + "/cloud/list",
          handler(req, res) {
            handle(req, res, async (options) => {
              const rows = await cloudList(options);
              return { rows: rows.filter((row) => CLOUD_BACKUP_NAME.test(row.name)) };
            });
          },
        },
        {
          kind: "exact",
          path: ROUTE + "/cloud/upload",
          handler: post(async (options, body) => {
            const { safe, file } = picked(options, body.name);
            return cloudUpload(options, file, safe);
          }),
        },
        {
          kind: "exact",
          path: ROUTE + "/cloud/download",
          handler: post(async (options, body) => {
            const remote = basename(String(body.name ?? ""));
            if (!CLOUD_BACKUP_NAME.test(remote)) throw new Error("云端这个文件名不像本插件的备份");
            const got = await cloudDownload(options, remote, storeDirOf(options));
            return { ...got, report: inspectBackup(got.file) };
          }),
        },
        {
          // 卸载本插件。用户点了确认才会打到这里；卸载后要重启 DSH 才生效。
          kind: "exact",
          path: ROUTE + "/uninstall",
          handler: post(() => {
            const profiles = findProfiles(dataRootOf());
            if (profiles.length === 0) throw new Error("没找到装过本插件的 profile（可能已经卸过了）");
            const results = profiles.map((profile) => uninstallProfile(profile, String(Date.now())));
            logger.info(NS + ": 已卸载 " + results.map((row) => row.profile).join(", "));
            return { results, hint: "重启 DSH 之后插件才真正消失（package.json 已改，包目录已删）。" };
          }),
        },
      ];

      const listeners = routes.map((route) => sctx.webServer.register(route, NS + ": " + route.path));
      return () => {
        for (const dispose of listeners) dispose();
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
