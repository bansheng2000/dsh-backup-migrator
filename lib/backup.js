/**
 * dsh-backup-migrator / lib/backup.js
 *
 * 打包与还原的纯逻辑：不依赖 cordis，test/selftest.mjs 可以直接 import 跑。
 *
 * 三条实测出来的硬约束决定了这里的形状：
 *  1. 本机 tar = bsdtar 3.8.8，支持 tar --format zip -cf，zip/tar.gz 都不需要第三方依赖。
 *  2. bsdtar 不能追加进 zip（tar --format zip -rf → exit 1 "Unrecognized archive format"），
 *     所以 manifest 必须和数据在同一次 -cf 里写出（多个 -C 是允许的，实测 exit 0）。
 *  3. --exclude 走 glob 且实测有效：profiles 共 1248MB，其中 node_modules 占 1248.16MB，
 *     排除后真机归档 24.42MB / 352 条，泄漏计数为 0。
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statfsSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const NS = "backup-migrator";
export const ROUTE = "/_" + NS + "/api";
export const PLUGIN = "dsh-backup-migrator";
/** manifest 结构版本；导入端只认不高于当前值的，改结构就 +1 并在导入处写迁移分支。 */
export const SCHEMA = 1;
export const INDEX_NAME = "index.json";
export const MANIFEST_NAME = "dsh-backup-manifest.json";
export const RESTORE_PREFIX = ".restore-";
/** 超过这个体积不算 sha256：GB 级归档哈希要几十秒，不值。 */
const HASH_LIMIT = 256 * 1024 * 1024;
/** 永远跳过的目录名：重装更快，也不至于把 1.2GB 的 node_modules 打进包。 */
const SKIP_DIRS = new Set(["node_modules"]);
const BACKUP_NAME = /^dsh-backup-.+(\.zip|\.tar\.gz)$/;

export const ITEMS = Object.freeze([
  { id: "sessions", label: "聊天记录", path: "./sessions" },
  { id: "attachments", label: "附件", path: "./attachments" },
  { id: "memories", label: "长期记忆", path: "./memories" },
  { id: "storages", label: "存储与状态", path: "./storages" },
  { id: "integrations", label: "集成配置", path: "./integrations" },
  { id: "profiles", label: "插件与 profile 配置", path: "./profiles", exclude: [
    "./profiles/*/node_modules",
    "./profiles/*/node_modules/*",
    "./profiles/*/cordis.patch.yml.bak-*",
    "./profiles/*/*.dshbak-*",
  ] },
  { id: "guardian", label: "启动自愈记录", path: "./guardian" },
  { id: "im", label: "IM 渠道配置", path: "./im" },
  // 0.2.1 起官方插件市场会往数据根写 dsh-market（市场登录态在里面），换机不带上就得重新登录。
  // 默认不开：不是所有版本都有这个目录，且里面是账号态。
  { id: "market", label: "插件市场数据（含登录态）", path: "./dsh-market", sensitive: true },
  // 插件自带的数据（2026-10-18 补）：默认**全关**——不是每个版本 / 每台机器都有这些目录，
  // 里面还可能有登录态与 API Key。要换机时勾上即可，勾选状态存在 options.items 里。
  { id: "channel-pack", label: "渠道包数据（含 API Key）", path: "./channel-pack", sensitive: true, optIn: true },
  { id: "openai-gateway", label: "OpenAI 网关配置", path: "./openai-gateway", optIn: true },
  { id: "remote-web-ui-registry", label: "远程访问登记表", path: "./remote-web-ui-registry", optIn: true },
  { id: "remote-web-ui-devices", label: "远程访问设备表（敏感）", path: "./remote-web-ui-devices.json", file: true, sensitive: true, optIn: true },
  { id: "worktrees", label: "插件工作树记录", path: "./worktrees", optIn: true },
  { id: "credentials", label: "凭据 .credentials.yaml（敏感）", path: "./.credentials.yaml", file: true, sensitive: true },

]);

const ITEM_IDS = ITEMS.map((item) => item.id);
const DEFAULT_ITEMS = ["sessions", "attachments", "memories", "storages", "integrations", "profiles"];
export const FORMAT_EXT = Object.freeze({ zip: ".zip", tgz: ".tar.gz" });
export const ITEM_CATALOG = ITEMS.map((item) => ({
  id: item.id, label: item.label, path: item.path,
  sensitive: item.sensitive === true,
  // 默认关闭的可选项：面板据此标「（默认关）」，否则用户以为勾选状态就是默认值。
  optIn: item.optIn === true,
}));

/** 数据根：环境变量优先，其次标准位置。换机后路径由用户改，这里不写死盘符。 */
export function dataRootOf(env = process.env) {
  const raw = String(env.DSH_DATA_DIR ?? "").trim();
  return raw === "" ? join(homedir(), ".dsh") : resolve(raw);
}

export function storeDirOf(options, env = process.env) {
  const raw = String(options?.storeDir ?? "").trim();
  return raw === "" ? join(dataRootOf(env), "backups") : resolve(raw);
}

export function formatOf(options) {
  return options?.format === "tgz" ? "tgz" : "zip";
}

export function formatOfFile(file) {
  return String(file).endsWith(".tar.gz") ? "tgz" : "zip";
}

export function defaultOptions() {
  return {
    storeDir: "",
    format: "zip",
    items: DEFAULT_ITEMS.slice(),
    autoIntervalMin: 0,
    keepCount: 10,
    /** 保留天数，0 = 不限。 */
    keepDays: 0,
    /** 备份目录总占用上限（GB，可小数），0 = 不限。 */
    keepBytesGb: 0,
  };
}

/**
 * 勾选项过滤；全空时退回默认集——备份一个空包没有意义。
 * credentials 就是 items 里的一个 id（面板上标了「（敏感）」），默认集里没有它，
 * 所以不勾就不打——不需要第二个 includeCredentials 开关，两处开关必然互相打架。
 */
export function itemsOf(options) {
  const picked = Array.isArray(options?.items)
    ? options.items.filter((id) => ITEM_IDS.includes(id))
    : [];
  return picked.length > 0 ? picked : DEFAULT_ITEMS.slice();
}

export function itemById(id) {
  return ITEMS.find((item) => item.id === id) ?? null;
}

/**
 * 把 ITEMS.exclude 里的 glob 变成正则。实测 bsdtar 的 '*' 会跨路径分隔符：profiles 下任意深度的
 * node_modules 都被一条 --exclude 排掉。所以这里也用 '.*' 对齐，面板统计才和打出来的包一致。
 */
function excludeMatcher(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return () => false;
  // 单个 '*' 写成 '.*'（跨 / 与 bsdtar 一致）；两个星号自然变成 '.*.*'，效果相同，不必特判。
  const rules = patterns.map((pattern) => new RegExp("^"
    + String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
  return (relative) => rules.some((rule) => rule.test(relative));
}

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 目录体积缓存：这个数只服务面板上「有多少 MB 不打包」那一行，跟真实备份内容无关。
 * profiles\node_modules 有 6 万个文件 / 2GB，stat 一遍实测 1.6 秒，而它几秒内不会变——
 * 挂在 30 秒的扫描 TTL 上不够用（连点两下设置页就要重扫两次），单独放大到 5 分钟。
 * 失效交给 TTL，invalidateScan() 故意不清它：清掉等于每打完一次包就为一行说明文字重扫 1.6 秒。
 */
const dirSizeCache = new Map();
const DIR_SIZE_TTL = 5 * 60_000;

/** 量一个目录有多大（含被排除的），只给面板显示用，不进包。 */
function measure(dir) {
  const hit = dirSizeCache.get(dir);
  if (hit !== undefined && Date.now() - hit.at < DIR_SIZE_TTL) return { bytes: hit.bytes };
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes: total };
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += measure(full).bytes;
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    } catch {
      /* 量的时候被删或被锁，跳过即可 */
    }
  }
  return { bytes: total };
}

function walk(dir, out, relative, excluded) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative + "/" + entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        // node_modules 单独记账：它在 .dsh 里占 1.2GB，不打进去，但面板得让人看见
        // 「为什么勾了 profiles 却只有几百 KB」，否则这个数字看起来就是错的。
        out.skipped += measure(full).bytes;
        continue;
      }
      walk(full, out, rel, excluded);
      continue;
    }
    if (!entry.isFile() || excluded(rel)) continue;
    try {
      out.bytes += statSync(full).size;
      out.files += 1;
    } catch {
      /* 备份期间被删或被锁，跳过即可 */
    }
  }
  return out;
}

/**
 * /status 被面板每 900ms 轮询一次，/options 更是每点一下就要回一遍；而 profiles 下有 6 万个文件，
 * 全量 stat 一遍实测 1.7 秒（其中 profiles 一项 1.6 秒，其余五项加起来 0.1 秒）。
 * 这 1.7 秒落在请求路径上，表现就是「点一下复选框要等两秒」。三层处理：
 *   1) 按**单个单元**缓存：勾一个框只是换了一份组合，没动过的目录不该重扫；
 *   2) 按整组缓存拼好的总和：没算完时先把上一次的数字端出去，不清零、不跳变；
 *   3) 要算的部分丢到后台（warm），请求路径上永远只读缓存。
 * 打完包 invalidateScan() 全清，保证备份后数字归零重算。
 */
const SCAN_TTL = 30_000;
const itemCache = new Map();
const scanCache = new Map();
const warming = new Set();

export function invalidateScan() {
  itemCache.clear();
  scanCache.clear();
}

const itemKeyOf = (root, id) => String(root) + "|" + id;
const scanKeyOf = (root, items) => String(root) + "|" + items.join(",");

function isFresh(root, id) {
  const hit = itemCache.get(itemKeyOf(root, id));
  return hit !== undefined && Date.now() - hit.at < SCAN_TTL;
}

/** 量一个单元（这是唯一真读盘的入口）。fresh = true 时忽略缓存重算。 */
function measureItem(id, root, fresh = false) {
  const key = itemKeyOf(root, id);
  const hit = itemCache.get(key);
  if (!fresh && hit !== undefined && Date.now() - hit.at < SCAN_TTL) return hit.value;
  const value = measureItemNow(id, root);
  itemCache.set(key, { at: Date.now(), value });
  return value;
}

function measureItemNow(id, root) {
  const item = itemById(id);
  if (item === null) return null;
  const full = join(root, item.path);
  if (!existsSync(full)) return { bytes: 0, files: 0, skipped: 0, missing: [id] };
  if (item.file === true) return { bytes: sizeOf(full), files: 1, skipped: 0, missing: [] };
  const seen = walk(full, { bytes: 0, files: 0, skipped: 0 }, item.path, excludeMatcher(item.exclude));
  return { bytes: seen.bytes, files: seen.files, skipped: seen.skipped, missing: [] };
}

/** 把缓存里已有的单元加总。还没量到的这一项先不计——pending 会告诉面板数字还在变。 */
function compose(items, root) {
  let bytes = 0;
  let files = 0;
  let skipped = 0;
  const missing = [];
  for (const id of items) {
    const value = itemCache.get(itemKeyOf(root, id))?.value;
    if (value === undefined) continue;
    bytes += value.bytes;
    files += value.files;
    skipped += value.skipped;
    missing.push(...value.missing);
  }
  return { bytes, files, missing, skipped };
}

/** 同步、保证新鲜：打包前的体积统计（createBackup 的 scan 阶段）走这里。 */
export function scan(items, root = dataRootOf()) {
  const key = scanKeyOf(root, items);
  if (items.every((id) => isFresh(root, id))) {
    const hit = scanCache.get(key);
    if (hit !== undefined) return hit.value;
  }
  for (const id of items) measureItem(id, root);
  const value = compose(items, root);
  scanCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 给面板用的版本：**绝不阻塞**。手上有数字就先端出去（哪怕过期），要算的丢后台，
 * 下一次轮询就是新的。返回 { value, pending }，pending = 这个数字还会变。
 */
export function scanLazy(items, root = dataRootOf()) {
  const hit = scanCache.get(scanKeyOf(root, items));
  if (hit !== undefined && items.every((id) => isFresh(root, id))) {
    return { value: hit.value, pending: false };
  }
  const value = hit?.value ?? compose(items, root);
  warm(items, root);
  return { value, pending: true };
}

/** 后台补算：同一个组合只跑一份，免得面板轮询把慢盘读穿。 */
function warm(items, root) {
  const todo = items.filter((id) => !isFresh(root, id));
  if (todo.length === 0) return;
  const key = scanKeyOf(root, items);
  if (warming.has(key)) return;
  warming.add(key);
  // 逐项让出事件循环：一项就可能 stat 几万个文件，不让出的话宿主这一段时间谁也别想干活。
  const step = (index) => {
    if (index >= todo.length) {
      warming.delete(key);
      scanCache.set(key, { at: Date.now(), value: compose(items, root) });
      return;
    }
    try {
      measureItem(todo[index], root, true);
    } catch {
      /* 单项量失败（被锁/被删）不该拖垮整组 */
    }
    setImmediate(() => step(index + 1));
  };
  setImmediate(() => step(0));
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate())
    + "-" + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

/** 分块喂哈希：readFileSync 整包读进来，几百 MB 的备份×几个并发请求就能把宿主顶到 OOM。 */
function sha256Of(file) {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(file, "r");
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** 跑 tar 取 stdout（读 manifest、列条目用；输出都是小文本，同步即可）。 */
function tarOut(args) {
  return String(execFileSync("tar", args, {
    encoding: "utf8",
    windowsHide: true,
    // tar 的报错由调用点包装成人话，这里别让它漏到宿主 stderr 上刷屏。
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }));
}

function createArgs(format, target, rest) {
  return format === "tgz" ? ["-czf", target, ...rest] : ["--format", "zip", "-cf", target, ...rest];
}

function extractArgs(format, file, rest = []) {
  return format === "tgz" ? ["-xzf", file, ...rest] : ["-xf", file, ...rest];
}

function listArgs(format, file) {
  return format === "tgz" ? ["-tzf", file] : ["-tf", file];
}

/** 打包走异步 spawn：进度要能边跑边报。 */
function runTar(args, hooks = {}) {
  return new Promise((done, fail) => {
    const child = spawn("tar", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", fail);
    const timer = setInterval(() => hooks.onTick?.(), 400);
    const stop = () => clearInterval(timer);
    hooks.signal?.addEventListener("abort", stop, { once: true });
    child.on("close", (code) => {
      stop();
      if (code === 0) done();
      else fail(new Error("tar 退出码 " + code + "：" + (stderr.trim() || "无输出")));
    });
  });
}

function resolveTargets(options) {
  const ids = itemsOf(options);
  const root = dataRootOf();
  const picked = ids.map(itemById).filter(Boolean)
    .filter((item) => existsSync(join(root, item.path)));
  if (picked.length === 0) throw new Error("勾选的备份内容在本机都不存在，换一项试试");
  return { root, ids, picked };
}

/**
 * 打一个备份。hooks.onPhase(phase, info)：phase = scan | pack | prune | done。
 * 返回 { file, name, bytes, manifest, entry }。
 */
export async function createBackup(options = {}, hooks = {}) {
  const { root, ids, picked } = resolveTargets(options);
  const storeDir = storeDirOf(options);
  const format = formatOf(options);
  mkdirSync(storeDir, { recursive: true });
  hooks.onPhase?.("scan", {});
  const size = scan(ids, root);

  // 同一秒内跑两次（自动定时 + 手点、或测试连打）会撞名覆盖，撞了就加序号。
  const base = "dsh-backup-" + stamp() + FORMAT_EXT[format];
  let name = base;
  for (let n = 2; existsSync(join(storeDir, name)); n += 1) {
    name = base.replace(/(\.zip|\.tar\.gz)$/, "-" + n + "$1");
  }
  const file = join(storeDir, name);
  const tmpDir = join(storeDir, ".tmp-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  const manifest = {
    plugin: PLUGIN,
    pluginVersion: hooks.version ?? "0.1.0",
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    format,
    sourceRoot: root,
    profile: process.env.DSH_PROFILE || "desktop",
    items: picked.map((item) => item.id),
    /** 打这份包时所在机器的 DSH 版本；探不到就是空串（换机时要能看出包是新版还是老版打的）。 */
    dsh: hooks.dsh ?? dshVersionOf(),
    expectedFiles: size.files,
    /** 解压后的原始字节数：还原前算目标盘够不够用，老包没这个字段就走归档体积估算。 */
    unpackedBytes: size.bytes,
    missing: size.missing,
    note: "换机后用本插件的导入功能还原；staged 模式会额外生成 restore.ps1。",
  };
  writeFileSync(join(tmpDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");

  const args = createArgs(format, file, [
    ...picked.flatMap((item) => (item.exclude ?? []).map((p) => "--exclude=" + p)),
    "-C", tmpDir, "./" + MANIFEST_NAME,
    ...picked.flatMap((item) => ["-C", root, item.path]),
  ]);
  hooks.onPhase?.("pack", { name, file });
  try {
    await runTar(args, {
      signal: hooks.signal,
      onTick: () => hooks.onPhase?.("pack", { name, file, bytes: sizeOf(file) }),
    });
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(file, { force: true });
    throw error;
  }
  rmSync(tmpDir, { recursive: true, force: true });

  // tar 少了文件照样 exit 0（--exclude 写错、路径权限不足都算），「备份成功」要到还原那天才露馅。
  // 解出来之前先数一遍条目：只查少不查多——备份期间 DSH 还在写新文件，多出来是正常的。
  const listed = tarOut(listArgs(format, file)).split("\n").filter((line) => line !== "");
  const packed = listed.filter((line) => !line.endsWith("/")).length;
  if (packed < manifest.expectedFiles + 1) {
    rmSync(file, { force: true });
    throw new Error("打包结果不完整：应含 " + (manifest.expectedFiles + 1)
      + " 个文件，实际只有 " + packed + " 个，这份备份已丢弃");
  }

  const bytes = sizeOf(file);
  const entry = {
    name,
    bytes,
    createdAt: manifest.createdAt,
    format,
    items: manifest.items,
    files: size.files,
    sha256: bytes <= HASH_LIMIT ? sha256Of(file) : null,
  };
  hooks.onPhase?.("prune", { name, file, bytes });
  const kept = prune(storeDir, {
    keep: Number(options?.keepCount ?? 10),
    days: Number(options?.keepDays ?? 0),
    bytes: Number(options?.keepBytesGb ?? 0) * 1024 ** 3,
  }, name);
  writeIndex(storeDir, [...readIndex(storeDir).filter((row) => row.name !== name), entry]);
  hooks.onPhase?.("done", { name, file, bytes, kept });
  return { file, name, bytes, manifest, entry };
}

export function listBackupFiles(storeDir) {
  let entries;
  try {
    entries = readdirSync(storeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => mtimeOf(join(storeDir, b)) - mtimeOf(join(storeDir, a)));
}

/**
 * 保留策略：份数、天数、占用三个维度各自独立生效，顺序是
 * 「先按天数过期 → 再按总占用从最旧删到阈值下 → 最后按份数收敛」。
 * 为什么是这个顺序：天数和体积是用户对空间的硬约束，份数是软约束，先满足硬的。
 * policy 可以是数字（= 只限份数，兼容旧调用）或 {keep, days, bytes}；0 一律表示不限。
 * protect 里的那份本次豁免：体积上限比单份包还小时，否则刚打出来的包会被自己删掉。
 */
export function prune(storeDir, policy = {}, protect = "") {
  const raw = typeof policy === "number" ? { keep: policy } : (policy ?? {});
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const keep = Math.max(1, Math.trunc(num(raw.keep, 10)));
  const days = Math.max(0, num(raw.days, 0));
  const bytes = Math.max(0, num(raw.bytes, 0));
  const names = listBackupFiles(storeDir); // 已按 mtime 倒序（新 → 旧）
  const doomed = new Set();

  if (days > 0) {
    const cutoff = Date.now() - days * 86_400_000;
    for (const name of names) if (mtimeOf(join(storeDir, name)) < cutoff) doomed.add(name);
  }

  if (bytes > 0) {
    let total = names.reduce((sum, name) => sum + sizeOf(join(storeDir, name)), 0);
    for (const name of [...names].reverse()) {
      if (total <= bytes) break;
      if (doomed.has(name)) continue;
      total -= sizeOf(join(storeDir, name));
      doomed.add(name);
    }
  }

  for (const name of names.filter((name) => !doomed.has(name)).slice(keep)) doomed.add(name);
  doomed.delete(protect);

  let freed = 0;
  for (const name of doomed) {
    freed += sizeOf(join(storeDir, name));
    rmSync(join(storeDir, name), { force: true });
  }
  return { removed: doomed.size, remaining: names.length - doomed.size, freed };
}

function indexPath(storeDir) {
  return join(storeDir, INDEX_NAME);
}

export function readIndex(storeDir) {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(storeDir), "utf8"));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export function writeIndex(storeDir, entries) {
  mkdirSync(storeDir, { recursive: true });
  const alive = entries.filter((entry) => existsSync(join(storeDir, entry.name)));
  writeFileSync(indexPath(storeDir), JSON.stringify({ version: 1, entries: alive }, null, 2), "utf8");
}

/** 历史列表：index 给 sha256 与勾选项，文件扫描兜底（index 丢了或手删过也能用）。 */
export function listBackups(options = {}) {
  const storeDir = storeDirOf(options);
  const known = new Map(readIndex(storeDir).map((entry) => [entry.name, entry]));
  return listBackupFiles(storeDir).map((name) => {
    const file = join(storeDir, name);
    const entry = known.get(name) ?? {};
    return {
      name,
      bytes: sizeOf(file),
      createdAt: entry.createdAt ?? new Date(mtimeOf(file)).toISOString(),
      format: entry.format ?? formatOfFile(name),
      items: entry.items ?? [],
      sha256: entry.sha256 ?? null,
    };
  });
}

function backupPath(storeDir, raw) {
  const safe = basename(String(raw ?? ""));
  if (!BACKUP_NAME.test(safe)) throw new Error("备份名不合法：" + safe);
  const file = join(storeDir, safe);
  if (!existsSync(file)) throw new Error("备份不存在或已被清理");
  return { safe, file };
}

export function deleteBackup(options = {}, name) {
  const storeDir = storeDirOf(options);
  const { safe, file } = backupPath(storeDir, name);
  rmSync(file, { force: true });
  writeIndex(storeDir, readIndex(storeDir).filter((entry) => entry.name !== safe));
  return { removed: safe };
}

/** 把一份备份复制到用户指定位置（换 U 盘 / 拷给自己）。 */
export function exportBackup(options = {}, name, dest) {
  const storeDir = storeDirOf(options);
  const { safe, file } = backupPath(storeDir, name);
  const target = String(dest ?? "").trim();
  if (target === "") throw new Error("导出目标路径为空");
  let to = resolve(target);
  if (existsSync(to) && statSync(to).isDirectory()) throw new Error("导出目标是目录，请给完整文件名");
  // 备份工具的默认语义不该是「上一次导出那份没了」：撞名就加序号。
  const dot = to.lastIndexOf(".");
  const sep = Math.max(to.lastIndexOf("/"), to.lastIndexOf("\\"));
  const stem = dot > sep ? to.slice(0, dot) : to;
  const ext = stem === to ? "" : to.slice(dot);
  for (let n = 2; existsSync(to); n += 1) to = stem + "-" + n + ext;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(file, to);
  return { from: file, to, bytes: sizeOf(to) };
}

/** 只读解出 manifest：完整性的第一道门（不信文件名，只信内容）。 */
export function readManifest(file) {
  const path = String(file ?? "");
  if (!existsSync(path)) throw new Error("备份文件不存在：" + path);
  const format = formatOfFile(path);
  let text;
  try {
    text = tarOut([...extractArgs(format, path), "-xOf", path, "./" + MANIFEST_NAME]);
  } catch (error) {
    // tar 报的是 "Not found in archive" 之类，看不出「这不是备份」，换成人话。
    throw new Error("归档里没有可读的 manifest（" + String(error?.message ?? error).split("\n")[0]
      + "），文件可能损坏或不是本插件导出的备份");
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("归档里没有可读的 manifest，文件可能损坏或不是本插件导出的备份");
  }
  if (manifest?.plugin !== PLUGIN) throw new Error("这个文件不是 dsh-backup-migrator 的备份");
  if (Number(manifest.schema) > SCHEMA) {
    throw new Error("备份来自更新版本的插件（schema " + manifest.schema + " > " + SCHEMA + "），请先升级插件");
  }
  return manifest;
}

/** 归档来自别的机器：路径越界一律拒绝还原。 */
function unsafeEntries(entries) {
  return entries.filter((name) => name.startsWith("/")
    || name.includes("../") || name === ".."
    || name.includes("..\\") || /^[a-zA-Z]:/.test(name));
}

/** 导入前校验：manifest → 可解 → 条目路径安全 → 勾选项都在 → sha256（若 index 里有）。 */
export function inspectBackup(file, known = null) {
  const path = String(file ?? "");
  const manifest = readManifest(path);
  const format = formatOfFile(path);
  const entries = tarOut(listArgs(format, path))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const bad = unsafeEntries(entries);
  if (bad.length > 0) throw new Error("归档里有越界路径，已拒绝还原：" + bad[0]);
  const missing = (Array.isArray(manifest.items) ? manifest.items : [])
    .filter((id) => {
      const rel = itemById(id)?.path.slice(2);
      return rel === undefined || !entries.some((name) => name.startsWith("./" + rel));
    });
  const bytes = sizeOf(path);
  const problems = [];
  if (manifest.format !== format) {
    problems.push("manifest 里的格式(" + manifest.format + ")与扩展名(" + format + ")对不上");
  }
  if (missing.length > 0) problems.push("归档里缺少：" + missing.join("、"));
  let sha256 = null;
  if (bytes <= HASH_LIMIT) {
    sha256 = sha256Of(path);
    if (typeof known?.sha256 === "string" && known.sha256 !== sha256) {
      problems.push("sha256 与本机历史记录不一致，文件被改过");
    }
  }
  return { file: path, manifest, entries: entries.length, bytes, sha256, problems };
}

function restoreScript(dir, manifest, target) {
  const names = (Array.isArray(manifest.items) ? manifest.items : [])
    .map((id) => itemById(id)?.path.slice(2))
    .filter((rel) => typeof rel === "string");
  const quoted = names.map((rel) => "'" + rel + "'").join(", ");
  return [
    "# 由 dsh-backup-migrator 生成：把暂存区的内容写回 DSH 数据目录。",
    "# 用法：powershell -ExecutionPolicy Bypass -File \"" + dir + "\\restore.ps1\"",
    "#",
    "# 数据目录：" + target,
    "# 备份时间：" + String(manifest.createdAt),
    "# 备份内容：" + (Array.isArray(manifest.items) ? manifest.items.join(", ") : ""),
    "#",
    "# 建议先关掉 DSH 再执行。node_modules 没打进包里，本脚本最后会试着自动装回来。",
    "$ErrorActionPreference = \"Stop\"",
    "$src = \"" + dir.replace(/"/g, '""') + "\"",
    "$dst = \"" + target.replace(/"/g, '""') + "\"",
    "",
    "foreach ($name in @(" + quoted + ")) {",
    "  $from = Join-Path $src $name",
    "  if (-not (Test-Path $from)) { continue }",
    "  $to = Join-Path $dst $name",
    "  if ((Get-Item $from).PSIsContainer) {",
    "    New-Item -ItemType Directory -Force -Path $to | Out-Null",
    "    Copy-Item -Path (Join-Path $from \"*\") -Destination $to -Recurse -Force",
    "  } else {",
    "    # 单文件单元（.credentials.yaml）：源是文件时 \"*\" 通配不到任何东西，",
    "    # Copy-Item 会静默复制 0 个文件，只留一个同名空目录——凭据就这么没了，还不报错。",
    "    Copy-Item -Path $from -Destination $to -Force",
    "  }",
    "  Write-Host \"restored $name\"",
    "}",
    "",
    "# node_modules 没进包，但 package.json / pnpm-lock.yaml 都在。装回来是自动的，",
    "# 没装成功再手动来一遍（DSH 会给出确切命令）。",
    "$dsh = Get-Command dsh -ErrorAction SilentlyContinue",
    "if ($dsh) {",
    "  foreach ($name in @(" + quoted + ")) {",
    "    if ($name -ne 'profiles') { continue }",
    "    foreach ($profile in (Get-ChildItem (Join-Path $dst 'profiles') -Directory -ErrorAction SilentlyContinue)) {",
    "      if (-not (Test-Path (Join-Path $profile.FullName 'package.json'))) { continue }",
    "      Write-Host \"install deps for $($profile.Name)...\"",
    "      dsh plugin --profile $profile.Name install",
    "    }",
    "  }",
    "} else {",
    "  Write-Host \"没找到 dsh 命令：装好 DSH 后手动执行 dsh plugin --profile desktop install\"",
    "}",
    "Write-Host \"全部完成。\"",
    "",
  ].join("\n");
}

/**
 * 备份时那台机器的 DSH 版本。宿主进程里**没有** DSH_* 环境变量，安装目录的 version 文件是
 * Electron 版本（44.0.0）不是 DSH 版本，所以真值只有两个来源：面板从渲染进程探到后报回来的
 * （rememberDshVersion），或 Electron 的 asar 补丁能读到的 app.asar/package.json。
 * 都拿不到就留空——写一个猜的版本号比留空更坏，换机时会让人以为兼容。
 */
let dshVersionCache = "";

export function rememberDshVersion(value) {
  const text = String(value ?? "").trim();
  if (text !== "") dshVersionCache = text;
  return dshVersionCache;
}

export function dshVersionOf(env = process.env) {
  if (dshVersionCache !== "") return dshVersionCache;
  for (const key of ["DSH_VERSION", "DSH_APP_VERSION", "DSH_PRODUCT_VERSION"]) {
    const raw = String(env[key] ?? "").trim();
    if (raw !== "") return raw;
  }
  try {
    const root = dirname(process.execPath);
    const pkg = JSON.parse(readFileSync(join(root, "resources", "app.asar", "package.json"), "utf8"));
    const version = String(pkg?.version ?? "").trim();
    if (version !== "") return version;
  } catch {
    /* 普通 Node 读不到 asar 内部：留空 */
  }
  return "";
}

function gb(bytes) {
  return (Number(bytes) / 1024 ** 3).toFixed(2) + "GB";
}

/**
 * 目标卷可用字节。目标目录还不存在（新机器首装）就从最近的已存在祖先取；
 * 整条链都取不到返回 null，调用方必须把 null 当「查不到」而不是「空间为 0」。
 */
export function freeBytesOf(target) {
  let probe = resolve(String(target ?? ""));
  for (;;) {
    try {
      const stat = statfsSync(probe);
      // bavail（不是 bfree）：文件系统给 root 的预留份额不该算成用户可用。
      return Number(stat.bavail) * Number(stat.bsize);
    } catch {
      /* 这一层不存在或不可访问，往上找 */
    }
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
}

/** 还原需要多少空间：优先用包内声明的原始字节数，老包没有就按归档体积 ×2.5 估，再留 10% 余量。 */
export function needBytesOf(manifest, archiveBytes) {
  const raw = Number(manifest?.unpackedBytes ?? 0);
  const base = Number.isFinite(raw) && raw > 0 ? raw : Number(archiveBytes ?? 0) * 2.5;
  return Math.ceil(base * 1.1);
}

/** 查得到就判，查不到就放行（比误判成「空间不足」把用户挡在门外强）。 */
export function checkSpace(target, manifest, archiveBytes) {
  const need = needBytesOf(manifest, archiveBytes);
  const free = freeBytesOf(target);
  return { need, free, ok: free === null || free >= need };
}

/**
 * 导入还原。mode = staged（解到暂存区 + 生成 restore.ps1，人工确认后自己跑）
 * 或 direct（直接写回数据目录）。
 */
/** 暂存区只留最近 3 份：每份几十 MB 到 GB，没人清就会悄悄吃满磁盘。 */
function pruneStaged(storeDir, keep = 3) {
  let entries;
  try {
    entries = readdirSync(storeDir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(RESTORE_PREFIX))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of names.slice(keep)) rmSync(join(storeDir, name), { recursive: true, force: true });
}

export function restoreBackup(file, mode, options = {}) {
  const path = String(file ?? "");
  const storeDir = storeDirOf(options);
  const known = readIndex(storeDir).find((row) => join(storeDir, row.name) === path) ?? null;
  const report = inspectBackup(path, known);
  if (report.problems.length > 0) throw new Error("校验未通过：" + report.problems.join("；"));
  const format = formatOfFile(path);
  // 空间检查必须早于任何写操作：解到一半才发现盘满，留下的是半份脏数据，
  // 比一开始就拒绝糟得多。direct 写数据目录，staged 写暂存区，两个目标盘可能不同。
  const spaceTarget = mode === "direct" ? dataRootOf() : storeDir;
  const space = checkSpace(spaceTarget, report.manifest, sizeOf(path));
  if (!space.ok) {
    throw new Error("目标盘空间不足：需要约 " + gb(space.need) + "，可用 " + gb(space.free)
      + "（要写到 " + spaceTarget + "）。请先清理空间，或到设置里换一个备份存放目录再还原。");
  }
  if (mode === "direct") {
    const target = dataRootOf();
    // tar -C 不会自建目录：目标数据目录不存在（新机器首装）就直接失败。
    mkdirSync(target, { recursive: true });
    // 覆盖前先把要被替换的顶层项挪到一边：既当回滚点，也当「先关掉 DSH」的硬闸门——
    // DSH 运行时还攥着会话文件的句柄，目录根本搬不动，报错比让它一边写一边被覆盖安全。
    // 同一秒内还原两次会撞名，撞了就加序号，否则 rename 会往已存在的回滚点里塞。
    let aside = join(target, ".pre-restore-" + stamp());
    for (let n = 2; existsSync(aside); n += 1) aside = join(target, ".pre-restore-" + stamp() + "-" + n);
    const moved = [];
    for (const id of report.manifest.items ?? []) {
      const item = itemById(id);
      if (item === null) continue;
      const name = item.path.slice(2);
      const from = join(target, name);
      if (!existsSync(from)) continue;
      mkdirSync(aside, { recursive: true });
      try {
        renameSync(from, join(aside, name));
      } catch (error) {
        throw new Error("挪不开 " + name + "（" + String(error?.message ?? error) + "）。"
          + "若 DSH 正在运行，请先完全退出 DSH 再还原，否则它会一边跑一边把旧内容写回去。");
      }
      moved.push(name);
    }
    try {
      tarOut([...extractArgs(format, path), "--exclude=./" + MANIFEST_NAME, "-C", target]);
    } catch (error) {
      for (const name of moved) {
        try {
          renameSync(join(aside, name), join(target, name));
        } catch { /* 回滚尽力而为，原始错误更该报出去 */ }
      }
      throw new Error("还原失败，已回滚到还原前的状态：" + String(error?.message ?? error));
    }
    rmSync(aside, { recursive: true, force: true });
    return {
      mode: "direct", target, items: report.manifest.items, entries: report.entries, replaced: moved,
    };
  }
  pruneStaged(storeDir);
  const dir = join(storeDir, RESTORE_PREFIX + stamp());
  mkdirSync(dir, { recursive: true });
  tarOut([...extractArgs(format, path), "--exclude=./" + MANIFEST_NAME, "-C", dir]);
  const script = join(dir, "restore.ps1");
  // 带 BOM：Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI(GBK) 读，脚本里的中文注释与
  // 中文字符串会被拆散，直接 ParserError「字符串缺少终止符」。少了这个 BOM 脚本跑不起来。
  writeFileSync(script, "\uFEFF" + restoreScript(dir, report.manifest, dataRootOf()), "utf8");
  return { mode: "staged", dir, script, items: report.manifest.items, entries: report.entries };
}
