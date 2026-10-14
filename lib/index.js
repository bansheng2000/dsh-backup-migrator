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
import { rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import z from "@deepseek-ai/schemastery";

import {
  NS, ROUTE, createBackup, dataRootOf, defaultOptions, deleteBackup, exportBackup,
  inspectBackup, itemsOf, listBackups, readManifest, restoreBackup, scan, storeDirOf, ITEM_CATALOG,
} from "./backup.js";

const VERSION = "0.3.0";
const inject = [];

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
async function receiveUpload(req, storeDir, logger) {
  const tmp = join(storeDir, ".upload-" + Date.now() + ".part");
  try {
    await pipeline(req, createWriteStream(tmp));
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
    return {
      options,
      storeDir: storeDirOf(options),
      dataRoot: dataRootOf(),
      catalog: ITEM_CATALOG,
      selection: scan(ids, dataRootOf()),
      backups: listBackups(options),
      running: running !== null,
      progress,
      failure,
      version: VERSION,
    };
  }

  function startBackup(options, label) {
    if (running !== null) return null;
    failure = null;
    running = createBackup(options, {
      version: VERSION,
      onPhase(phase, info) {
        progress = { phase, at: Date.now(), ...info };
      },
    })
      .then((result) => logger.info(NS + ": " + label + "完成 " + result.name))
      .catch((error) => {
        failure = { at: Date.now(), label, message: messageOf(error) };
        logger.warn(NS + ": " + label + "失败 " + failure.message);
      })
      .finally(() => {
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
      ];

      const listeners = routes.map((route) => sctx.webServer.register(route, NS + ": " + route.path));
      return () => {
        for (const dispose of listeners) dispose();
      };
    }, NS + ": api");

    // 自动备份：一个 setInterval 就够。备份是 IO 重活，间隔至少 10 分钟，
    // 否则用户一不留神就把硬盘写满——下限在这里兜，不靠用户自觉。
    sctx.effect(() => {
      const minutes = Number(currentOptions(sctx.settings).autoIntervalMin ?? 0);
      if (!Number.isFinite(minutes) || minutes <= 0) return;
      const timer = setInterval(() => startBackup(currentOptions(sctx.settings), "定时备份"),
        Math.max(10, minutes) * 60_000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, NS + ": auto timer");
  });
}

export { NS, ROUTE, VERSION, Config, apply, inject };
export default { apply, inject, name: NS, Config };
