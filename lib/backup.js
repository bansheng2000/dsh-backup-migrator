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
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
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
  { id: "credentials", label: "凭据 .credentials.yaml（敏感）", path: "./.credentials.yaml", file: true, sensitive: true },
]);

const ITEM_IDS = ITEMS.map((item) => item.id);
const DEFAULT_ITEMS = ["sessions", "attachments", "memories", "storages", "integrations", "profiles"];
export const FORMAT_EXT = Object.freeze({ zip: ".zip", tgz: ".tar.gz" });
export const ITEM_CATALOG = ITEMS.map((item) => ({
  id: item.id, label: item.label, path: item.path, sensitive: item.sensitive === true,
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
 * 把 ITEMS.exclude 里的 glob 变成正则。tar 用的是同一种 '*'（不跨 /）语义，
 * 对齐它，面板上的统计才和真正打出来的包一致。
 */
function excludeMatcher(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return () => false;
  const rules = patterns.map((pattern) => new RegExp("^"
    + String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$"));
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

/** 量一个目录有多大（含被排除的），只给面板显示用，不进包。 */
function measure(dir) {
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

/** 扫一遍将要打包的内容，给面板显示多少项 / 多少文件 / 多少字节。 */
export function scan(items, root = dataRootOf()) {
  let bytes = 0;
  let files = 0;
  let skipped = 0;
  const missing = [];
  for (const id of items) {
    const item = itemById(id);
    if (item === null) continue;
    const full = join(root, item.path);
    if (!existsSync(full)) {
      missing.push(id);
      continue;
    }
    if (item.file === true) {
      bytes += sizeOf(full);
      files += 1;
      continue;
    }
    const seen = walk(full, { bytes: 0, files: 0, skipped: 0 }, item.path, excludeMatcher(item.exclude));
    bytes += seen.bytes;
    files += seen.files;
    skipped += seen.skipped;
  }
  return { bytes, files, missing, skipped };
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate())
    + "-" + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
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
    expectedFiles: size.files,
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
  const kept = prune(storeDir, Number(options?.keepCount ?? 10), name);
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

/** 只保留最新 keep 份；protect 里的那份本次豁免（mtime 打平时保住刚写出的）。 */
export function prune(storeDir, keep, protect = "") {
  const raw = Number(keep);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : 10;
  const names = listBackupFiles(storeDir);
  const doomed = names.slice(limit).filter((name) => name !== protect);
  for (const name of doomed) rmSync(join(storeDir, name), { force: true });
  return { removed: doomed.length, remaining: names.length - doomed.length };
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
  const to = resolve(target);
  if (existsSync(to) && statSync(to).isDirectory()) throw new Error("导出目标是目录，请给完整文件名");
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
 * 导入还原。mode = staged（解到暂存区 + 生成 restore.ps1，人工确认后自己跑）
 * 或 direct（直接写回数据目录）。
 */
export function restoreBackup(file, mode, options = {}) {
  const path = String(file ?? "");
  const storeDir = storeDirOf(options);
  const known = readIndex(storeDir).find((row) => join(storeDir, row.name) === path) ?? null;
  const report = inspectBackup(path, known);
  if (report.problems.length > 0) throw new Error("校验未通过：" + report.problems.join("；"));
  const format = formatOfFile(path);
  if (mode === "direct") {
    const target = dataRootOf();
    // tar -C 不会自建目录：目标数据目录不存在（新机器首装）就直接失败。
    mkdirSync(target, { recursive: true });
    tarOut([...extractArgs(format, path), "--exclude=./" + MANIFEST_NAME, "-C", target]);
    return { mode: "direct", target, items: report.manifest.items, entries: report.entries };
  }
  const dir = join(storeDir, RESTORE_PREFIX + stamp());
  mkdirSync(dir, { recursive: true });
  tarOut([...extractArgs(format, path), "--exclude=./" + MANIFEST_NAME, "-C", dir]);
  const script = join(dir, "restore.ps1");
  // 带 BOM：Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI(GBK) 读，脚本里的中文注释与
  // 中文字符串会被拆散，直接 ParserError「字符串缺少终止符」。少了这个 BOM 脚本跑不起来。
  writeFileSync(script, "\uFEFF" + restoreScript(dir, report.manifest, dataRootOf()), "utf8");
  return { mode: "staged", dir, script, items: report.manifest.items, entries: report.entries };
}
