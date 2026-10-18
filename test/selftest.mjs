// dsh-backup-migrator 自检：真 tar、真 zip、真还原，跑的是临时目录，不碰真实 ~/.dsh。
//
// 用法：node test/selftest.mjs
//
// 覆盖的是容易出错的地方，不是行数覆盖率：
//  1. 打包后归档里必须没有 node_modules（否则备份从 24MB 变 1.2GB）。
//  2. manifest 与数据在同一个归档里，且能被 tar -xOf 读出来。
//  3. 换机语义：把一份备份 direct 还原到「另一台机器」的数据目录。
//  4. 损坏 / 非本插件的文件必须在校验阶段被拒，不能还原。
//  5. 保留策略三个维度（份数 / 天数 / 占用）都生效，手动删除生效。
//  6. 还原前的空间检查：够不够要用 manifest 声明的原始体积算，不够就一个文件都不写。
//  7. WebDAV 云端上传 / 下载 / 列目录（用假 fetch，不真连网）。
//  8. 卸载：profile 的 package.json 改写是纯函数，落盘后包目录真被删掉。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "bm-selftest-"));
const source = join(tmp, "source");          // 「旧电脑」的数据目录
const store = join(tmp, "store");            // 备份存放目录
const target = join(tmp, "target");          // 「新电脑」的数据目录

function put(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf8");
}

put(join(source, "sessions", "ws", "session-a", "session.v4.json"), "{\"a\":1}");
put(join(source, "attachments", "v1", "shot.png"), "not-really-a-png");
put(join(source, "memories", "MEMORY.md"), "# memory");
put(join(source, "storages", "workspace.json"), "{}");
put(join(source, "integrations", "dsh-im", "config.json"), "{}");
put(join(source, "profiles", "desktop", "package.json"), "{\"name\":\"desktop\"}");
put(join(source, "profiles", "desktop", "cordis.patch.yml"), "# patch");
put(join(source, "profiles", "desktop", "cordis.patch.yml.bak-old"), "# junk");
put(join(source, "profiles", "desktop", "node_modules", "big", "index.js"), "// 1.2GB 的地方");
put(join(source, ".credentials.yaml"), "token: secret");

process.env.DSH_DATA_DIR = source;

const { createBackup, deleteBackup, exportBackup, inspectBackup, invalidateScan, itemsOf, listBackupFiles,
  listBackups, prune, readManifest, restoreBackup, dataRootOf, storeDirOf, defaultOptions, scan, scanLazy,
  checkSpace, dshVersionOf, freeBytesOf, needBytesOf, rememberDshVersion } =
  await import("../lib/backup.js");
const { cloudDownload, cloudList, cloudUpload, cloudOf, parsePropfind, remoteUrl, authHeaders, CLOUD_BACKUP_NAME } =
  await import("../lib/cloud.js");
const { findProfiles, planUninstall, uninstallProfile } = await import("../lib/uninstall.js");

const steps = [];
function record(name, error) {
  if (error === undefined) {
    steps.push("  ok   " + name);
  } else {
    steps.push("  FAIL " + name + "\n       " + String(error?.message ?? error).split("\n")[0]);
    process.exitCode = 1;
  }
}

function step(name, fn) {
  try {
    fn();
    record(name);
  } catch (error) {
    record(name, error);
  }
}

async function stepAsync(name, fn) {
  try {
    await fn();
    record(name);
  } catch (error) {
    record(name, error);
  }
}


const options = { ...defaultOptions(), storeDir: store, items: ["sessions", "memories", "profiles"] };

// ---- 1. 配置解析 -------------------------------------------------------------
step("勾选项过滤；默认集不含凭据", () => {
  assert.deepEqual(itemsOf({ items: ["sessions", "credentials"] }), ["sessions", "credentials"]);
  assert.deepEqual(itemsOf({ items: ["sessions", "bogus"] }), ["sessions"], "未知 id 应被丢掉");
  const fallback = itemsOf({ items: [] });
  assert.ok(fallback.includes("sessions"), "全空应退回默认集");
  assert.ok(!fallback.includes("credentials"), "默认集不该带凭据");
});

step("数据目录 / 备份目录推导", () => {
  assert.equal(dataRootOf({ DSH_DATA_DIR: "D:\\x" }), "D:\\x");
  assert.equal(storeDirOf({}, { DSH_DATA_DIR: "D:\\x" }), join("D:\\x", "backups"));
  assert.equal(storeDirOf({ storeDir: "E:\\bk" }, { DSH_DATA_DIR: "D:\\x" }), "E:\\bk");
});

// ---- 2. 打包 -----------------------------------------------------------------
const first = await createBackup(options);
steps.push("  ok   打出 zip：" + first.name + "（" + first.bytes + " B）");

// 后面几步（版本 / 云端）还要用一份归档，可保留策略那两步会把 store 清空，先留一份在旁边。
const keptFile = join(tmp, "kept", first.name);
mkdirSync(join(tmp, "kept"), { recursive: true });
writeFileSync(keptFile, readFileSync(first.file));

const entries = String(execFileSync("tar", ["-tf", first.file], { encoding: "utf8" }));
step("归档含 manifest + 勾选内容", () => {
  assert.ok(entries.includes("./dsh-backup-manifest.json"), "缺 manifest");
  assert.ok(entries.includes("./sessions/ws/session-a/session.v4.json"), "缺 sessions");
  assert.ok(entries.includes("./memories/MEMORY.md"), "缺 memories");
  assert.ok(entries.includes("./profiles/desktop/package.json"), "缺 profiles");
});
step("面板统计与实际打包一致：node_modules 只报体积不计文件", () => {
  // 面板上的「多少 MB」如果把 node_modules 算进去，勾了 profiles 会显示 1.2GB，
  // 打包出来却只有几百 KB——用户看到的就是「数字不准」。分开报，两个数都不骗人。
  const seen = scan(["profiles"], source);
  assert.ok(seen.bytes > 0 && seen.bytes < 100, "bytes 不该把 node_modules 算进去：" + seen.bytes);
  assert.equal(seen.files, 2, "node_modules 里的文件不该计入 files：" + seen.files);
  assert.ok(seen.skipped > 0, "node_modules 的体积必须单独报出来");
  assert.equal(seen.missing.length, 0);
});

step("归档不含未勾选项 / node_modules / bak", () => {
  assert.ok(!entries.includes("./attachments/"), "attachments 未勾选却打进去了");
  assert.ok(!entries.includes("./.credentials.yaml"), "凭据未勾选却打进去了");
  assert.ok(!entries.includes("node_modules"), "node_modules 泄漏：" + entries.split("\n").filter((l) => l.includes("node_modules")).join(","));
  assert.ok(!entries.includes("cordis.patch.yml.bak-old"), "bak 文件泄漏");
});

// ---- 3. 校验 -----------------------------------------------------------------
const report = inspectBackup(first.file, first.entry);
step("校验通过且能读回 manifest", () => {
  assert.deepEqual(report.problems, [], "校验问题：" + report.problems.join("；"));
  assert.equal(report.manifest.plugin, "dsh-backup-migrator");
  assert.ok(report.entries > 0);
  assert.equal(report.sha256, first.entry.sha256, "sha256 应与写索引时一致");
  assert.deepEqual(report.manifest.items, ["sessions", "memories", "profiles"]);
});

step("非本插件的归档被拒", () => {
  const foreign = join(tmp, "foreign");
  mkdirSync(join(foreign, "sub"), { recursive: true });
  writeFileSync(join(foreign, "sub", "a.txt"), "hello", "utf8");
  const zipped = join(tmp, "foreign.zip");
  execFileSync("tar", ["--format", "zip", "-cf", zipped, "-C", foreign, "./sub"], { stdio: "ignore" });
  assert.throws(() => inspectBackup(zipped), /不是 dsh-backup-migrator|没有可读的 manifest/);
});

// ---- 4. 换机还原 -------------------------------------------------------------
// 「换机」= 同一个备份、换一台机器的数据目录：把 DSH_DATA_DIR 指到目标目录再还原。
process.env.DSH_DATA_DIR = target;
assert.equal(dataRootOf(), target);

const staged = restoreBackup(first.file, "staged", options);
steps.push("  ok   staged 解到 " + staged.dir);
step("staged 产出 restore.ps1 且内容已解出", () => {
  assert.ok(existsSync(staged.script), "缺 restore.ps1");
  assert.ok(existsSync(join(staged.dir, "sessions", "ws", "session-a", "session.v4.json")));
  assert.ok(!existsSync(join(staged.dir, "dsh-backup-manifest.json")), "manifest 不该落进暂存区");
  const script = readFileSync(staged.script, "utf8");
  // 带 BOM 才能被 Windows PowerShell 5.1 当 UTF-8 读，否则中文被按 GBK 拆散直接 ParserError。
  assert.ok(script.charCodeAt(0) === 0xFEFF, "restore.ps1 必须以 BOM 开头（PS 5.1 读无 BOM UTF-8 会按 GBK 解）");
  assert.ok(script.includes("sessions") && script.includes("memories") && script.includes("profiles"));
  assert.ok(script.includes(target), "脚本里应写明目标数据目录");
  // 换机闭环：脚本最后要自己把插件依赖装回来，否则「备份能导入但插件全缺」。
  assert.ok(script.includes("dsh plugin --profile"), "脚本没装依赖，换机后插件全是坏的");
  assert.ok(script.includes("profiles"), "脚本没遍历 profiles 目录");
  // .credentials.yaml 是单文件单元：源是文件时 Join-Path $from "*" 通配不到任何东西，
  // Copy-Item 静默复制 0 个文件，凭据会变成一个同名空目录而且不报错。
  assert.ok(script.includes("Copy-Item -Path $from -Destination $to -Force"),
    "脚本没用文件分支还原 .credentials.yaml，凭据会被还原成一个空目录");
});

const direct = restoreBackup(first.file, "direct", options);
steps.push("  ok   direct 写到 " + direct.target);
step("direct 把内容落到目标数据目录", () => {
  assert.ok(existsSync(join(target, "sessions", "ws", "session-a", "session.v4.json")), "sessions 没落盘");
  assert.ok(existsSync(join(target, "memories", "MEMORY.md")), "memories 没落盘");
  assert.ok(existsSync(join(target, "profiles", "desktop", "package.json")), "profiles 没落盘");
  assert.ok(!existsSync(join(target, "dsh-backup-manifest.json")), "manifest 不该写进数据目录");
});

step("direct 再还原一次：先挪开旧内容再覆盖，不留 .pre-restore 残渣", () => {
  // 覆盖前把要替换的顶层项挪到一边，是「导入失败能回滚」和「DSH 开着就拒绝还原」的同一套机制：
  // 宿主还攥着会话文件句柄时目录搬不动，rename 直接抛错。
  const again = restoreBackup(first.file, "direct", options);
  assert.ok(again.replaced.includes("sessions"), "应挪开已有的 sessions：" + again.replaced);
  assert.deepEqual(readdirSync(target).filter((n) => n.startsWith(".pre-restore-")),
    [], "回滚点用完必须删掉，别留在数据目录里");
  assert.ok(existsSync(join(target, "sessions", "ws", "session-a", "session.v4.json")));
});

step("导出撞名不覆盖，自动加序号", () => {
  // 覆盖式导出会让「上一次拷到 U 盘那份」静默消失——备份工具不该有这种默认语义。
  const dest = join(tmp, "out", "copy.zip");
  const one = exportBackup(options, first.name, dest);
  const two = exportBackup(options, first.name, dest);
  assert.equal(one.to, resolve(dest));
  assert.equal(two.to, resolve(dest).replace(/\.zip$/, "-2.zip"));
  assert.ok(existsSync(one.to) && existsSync(two.to), "两份都要在");
});

// ---- 5. tar.gz 也能走通 ------------------------------------------------------
const tgz = await createBackup({ ...options, format: "tgz" });
step("tar.gz 打包 + 校验", () => {
  assert.ok(tgz.name.endsWith(".tar.gz"), "扩展名不对：" + tgz.name);
  assert.ok(tgz.bytes > 0);
  const r = inspectBackup(tgz.file, tgz.entry);
  assert.deepEqual(r.problems, [], "tgz 校验问题：" + r.problems.join("；"));
  assert.equal(readManifest(tgz.file).format, "tgz");
});

// ---- 6. 数量上限与删除 -------------------------------------------------------
const back = await createBackup(options);
step("keepCount 生效（新的一份被豁免）", () => {
  const before = listBackups(options).length;
  assert.ok(before >= 3, "应至少有 3 份，实际 " + before);
  const left = prune(store, 1, back.name);
  const names = listBackups(options);
  assert.equal(names.length, 1, "应只剩 1 份，实际 " + names.length);
  assert.equal(names[0].name, back.name, "剩下的是被豁免的那份");
  assert.ok(left.removed > 0);
});

step("列表 / 删除", () => {
  const [one] = listBackups(options);
  assert.ok(one.sha256, "index 里应有 sha256");
  const removed = deleteBackup(options, one.name);
  assert.equal(removed.removed, one.name);
  assert.ok(!existsSync(join(store, one.name)), "文件应已删除");
  assert.deepEqual(listBackups(options), []);
});

step("删除不存在的 / 越界的名字会被挡", () => {
  assert.throws(() => deleteBackup(options, "dsh-backup-19990101-000000.zip"), /不存在/);
  assert.throws(() => deleteBackup(options, "../evil.zip"), /不合法/);
});

// ---- 7. 客户端样式的作用域（这条是 CSS 全部静默失效的根因）------------------
// lib/client.js 的 STYLE 是字符串数组，拆成规则后每一条都必须以自建祖先类
// .bm-wrap 打头。用注入 <style> 的 data-plugin-css 属性做前缀是错的：它不在组件
// 祖先链上，所有规则会静默失效（表现是元素露出浏览器默认样式）。
step("CSS 每条规则都以自建 DOM 祖先类 .bm-wrap 为前缀", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const start = source.indexOf("const STYLE = [");
  const end = source.indexOf("].join(\"\");", start);
  assert.ok(start > 0 && end > start, "找不到 STYLE 数组");
  const body = source.slice(start, end)
    .replace(/\/\/[^"\n]*/g, "")          // 先剥注释，注释里的关键字会让断言假绿
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = body.match(/["'][.#][^"']*["']/g) ?? [];
  assert.ok(rules.length > 5, "规则太少，可能没抓到：" + rules.length);
  assert.ok(rules.some((rule) => rule.startsWith('".bm-wrap')),
    "根节点类 .bm-wrap 必须自己存在");
  for (const rule of rules) {
    // 不用宿主 CSS 里的类做前缀——那样规则会跑到别人的 DOM 上，或整条失效。
    // .bm-* 全是本组件自己渲染出来的类，宿主不可能撞名。
    assert.ok(rule.startsWith('".bm-'),
      "选择器用了非本插件的类（作用域会漏或失效）：" + rule);
  }
  assert.ok(source.includes('className: "bm-wrap"'), "渲染树根节点必须带 .bm-wrap，否则前缀选择器匹配不到");
});

// ---- 8. 选文件夹接的是宿主现成能力，不是自己画的输入框 -----------------------
// 用户明确要求「像选备份文件那样点选文件夹，不要填地址」。桌面端 preload 暴露
// __DSH_DIRECTORY_PICKER__.pick()；Web GUI 没有 preload，退回 ctx.uiWorkspace.pickDirectory()
// （它转 remote 由主进程弹框）。两条都拿不到才回 null，面板提示手动填。
step("选文件夹走宿主原生对话框，并留了手动填的退路", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("__DSH_DIRECTORY_PICKER__"), "没接桌面端原生文件夹对话框");
  assert.ok(source.includes("pickDirectory()"), "没接宿主 uiWorkspace.pickDirectory");
  assert.ok(source.includes("chooseDir"), "面板没挂 chooseDir");
  // 备份目录与导出目的地都要能点选，两个入口都在。
  assert.equal((source.match(/chooseDir\("选目录中"/g) ?? []).length, 2, "备份目录与导出目的地两个入口都要能点选");
  assert.ok(!source.includes("插件弹不了系统文件选择框"), "过时的说明文案没删");
});

// ---- 8. 保留策略的三个维度 ---------------------------------------------------
step("保留策略：天数 / 占用 / 份数各自生效，protect 豁免刚打出来的那份", () => {
  const dir = join(tmp, "policy");
  mkdirSync(dir, { recursive: true });
  const names = ["a", "b", "c", "d"].map((tag) => "dsh-backup-20260101-00000" + tag + ".zip");
  for (const name of names) writeFileSync(join(dir, name), "x".repeat(1000));
  const stale = new Date(Date.now() - 30 * 86400000);
  utimesSync(join(dir, names[0]), stale, stale);
  utimesSync(join(dir, names[1]), new Date(stale.getTime() + 60000), new Date(stale.getTime() + 60000));

  const byDays = prune(dir, { keep: 99, days: 7, bytes: 0 });
  assert.equal(byDays.removed, 2, "超过 7 天的两份该走：" + JSON.stringify(byDays));
  assert.equal(listBackupFiles(dir).length, 2, "天数维度：该只剩 2 份");

  const byBytes = prune(dir, { keep: 99, days: 0, bytes: 1500 });
  assert.equal(byBytes.removed, 1, "1000 B/份、上限 1500 B 只能留 1 份：" + JSON.stringify(byBytes));
  assert.equal(listBackupFiles(dir).length, 1, "占用维度");
  assert.equal(prune(dir, { keep: 99, days: 0, bytes: 0 }).removed, 0, "两个维度都是 0 = 不限，不该删");

  writeFileSync(join(dir, "dsh-backup-20260101-00000e.zip"), "y".repeat(1000));
  const sorted = listBackupFiles(dir);
  assert.equal(sorted.length, 2);
  assert.equal(prune(dir, { keep: 1 }, sorted[1]).removed, 0, "protect 里的那份必须豁免，否则新包会删掉自己");
  assert.equal(prune(dir, 1).removed, 1, "数字形态（只限份数）仍要兼容");
});

// ---- 9. 还原前的空间检查 -----------------------------------------------------
step("空间需求：manifest 声明的原始体积优先，老包退回按归档估", () => {
  assert.equal(needBytesOf({ unpackedBytes: 1000 }, 999999), 1100, "有声明就用声明，另留 10% 余量");
  assert.equal(needBytesOf({}, 1000), 2750, "老包没声明就按归档 ×2.5 再留 10%");
  const free = freeBytesOf(target);
  assert.ok(free === null || free > 0, "查得到就得是正数，查不到是 null：" + free);
  assert.equal(checkSpace(target, { unpackedBytes: 1024 }, 1024).ok, true, "1 KB 总装得下");
  const huge = checkSpace(target, { unpackedBytes: 1024 ** 5 }, 1);
  assert.equal(huge.ok, false, "1 PB 应该被拒：" + JSON.stringify(huge));
  assert.ok(typeof huge.free === "number", "被拒时要报得出可用空间");
});

step("空间不够时，还原阶段一个文件都不写", () => {
  const dir = join(tmp, "space");
  put(join(dir, "sessions", "s.json"), "{}");
  writeFileSync(join(dir, "dsh-backup-manifest.json"), JSON.stringify({
    plugin: "dsh-backup-migrator", pluginVersion: "test", schema: 1, createdAt: new Date().toISOString(),
    format: "zip", sourceRoot: source, profile: "desktop", items: ["sessions"], expectedFiles: 1,
    missing: [], unpackedBytes: 1024 ** 5, note: "test",
  }));
  const file = join(tmp, "huge.zip");
  execFileSync("tar", ["--format", "zip", "-cf", file, "-C", dir, "./sessions", "./dsh-backup-manifest.json"], { stdio: "ignore" });
  const victim = join(tmp, "space-target");
  process.env.DSH_DATA_DIR = victim;
  try {
    assert.throws(() => restoreBackup(file, "direct", options), /空间不足/);
    assert.ok(!existsSync(victim), "被拒时不该建目标目录，更不该写文件");
  } finally {
    process.env.DSH_DATA_DIR = target;
  }
});

// ---- 10. manifest 里的 DSH 版本 ----------------------------------------------
step("manifest 记下 DSH 版本；面板报回来的值最优先", () => {
  const blank = dshVersionOf({});
  assert.equal(typeof blank, "string", "版本号应是字符串");
  const back = readManifest(keptFile);
  assert.equal(typeof back.dsh, "string", "manifest 要有 dsh 字段");
  assert.ok(back.unpackedBytes > 0, "manifest 要记下原始体积，空间检查靠它：" + back.unpackedBytes);
  rememberDshVersion("9.9.9-test");
  assert.equal(dshVersionOf({}), "9.9.9-test", "面板报回来的值最优先");
  assert.equal(dshVersionOf({ DSH_VERSION: "1.2.3" }), "9.9.9-test", "已经报过一次就不该被环境变量顶掉");
});

// ---- 11. WebDAV 云端备份（假 fetch，不连网）-----------------------------------
step("WebDAV 地址拼装 / Basic 认证头 / 中文目录与文件名都转义", () => {
  const cloud = cloudOf({ cloudUrl: "https://dav.jianguoyun.com/dav/", cloudDir: "dsh 备份/子目录", cloudUser: "u", cloudPass: "p" });
  assert.equal(cloud.base, "https://dav.jianguoyun.com/dav", "末尾斜杠要去掉");
  assert.equal(authHeaders(cloud).authorization, "Basic " + Buffer.from("u:p").toString("base64"));
  const url = remoteUrl(cloud, "dsh-backup-20260101-000000.zip");
  assert.ok(url.includes(encodeURIComponent("dsh 备份") + "/" + encodeURIComponent("子目录")), "目录段要转义：" + url);
  assert.ok(url.endsWith("/dsh-backup-20260101-000000.zip"));
  assert.throws(() => cloudOf({ cloudUrl: "" }), /请先填写 WebDAV 地址/);
  assert.ok(CLOUD_BACKUP_NAME.test("dsh-backup-20260101-000000.zip"), "备份名要认");
  assert.ok(!CLOUD_BACKUP_NAME.test("readme.txt"), "别人的文件不要列进去");
});

step("WebDAV 列目录：解析 PROPFIND，跳掉目录自身与子目录", () => {
  const xml = [
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">',
    '<d:response><d:href>/dav/bk/</d:href></d:response>',
    '<d:response><d:href>/dav/bk/sub/</d:href></d:response>',
    '<d:response><d:href>/dav/bk/dsh-backup-20260101-000000.zip</d:href>',
    '<d:propstat><d:prop><d:getcontentlength>1024</d:getcontentlength>',
    '<d:getlastmodified>Fri, 02 Jan 2026 03:04:05 GMT</d:getlastmodified></d:prop></d:propstat></d:response>',
    '<d:response><d:href>/dav/bk/readme.txt</d:href></d:response>',
    "</d:multistatus>",
  ].join("");
  const rows = parsePropfind(xml, "bk");
  assert.deepEqual(rows.map((r) => r.name).sort(), ["dsh-backup-20260101-000000.zip", "readme.txt"],
    "目录自身与子目录都要跳过：" + JSON.stringify(rows));
  assert.ok(JSON.stringify(rows[0]).includes("1024"), "要带上体积：" + JSON.stringify(rows[0]));
});

await stepAsync("WebDAV 上传 / 列目录 / 下载：撞名不覆盖本地唯一一份", async () => {
  // 假 fetch 顶掉全局，字节留在内存里，一点网都不连。
  const jar = new Map();
  const fakeFetch = async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const key = decodeURIComponent(String(url).split("/").pop());
    if (method === "PROPFIND") {
      const body = [...jar.keys()].map((n) => '<d:response><d:href>/dav/bk/' + encodeURIComponent(n)
        + '</d:href><d:propstat><d:prop><d:getcontentlength>' + jar.get(n).length
        + "</d:getcontentlength></d:prop></d:propstat></d:response>").join("");
      return { ok: true, status: 207, text: async () => '<d:multistatus xmlns:d="DAV:">' + body + "</d:multistatus>" };
    }
    if (method === "PUT") {
      const chunks = [];
      for await (const chunk of init.body) chunks.push(chunk);
      jar.set(key, Buffer.concat(chunks));
      return { ok: true, status: 201, text: async () => "" };
    }
    if (method === "GET") {
      const bytes = jar.get(key);
      if (bytes === undefined) return { ok: false, status: 404, text: async () => "not found" };
      return { ok: true, status: 200, body: Readable.toWeb(Readable.from([bytes])), text: async () => "" };
    }
    return { ok: false, status: 405, text: async () => "nope" };
  };
  const cloudOptions = { ...options, cloudUrl: "https://dav.example.com/dav", cloudDir: "bk", cloudUser: "u", cloudPass: "p" };
  const name = "dsh-backup-20260101-000000.zip";

  await cloudUpload(cloudOptions, keptFile, name, fakeFetch);
  assert.ok(jar.has(name), "PUT 没发出去");
  assert.equal(jar.get(name).length, readFileSync(keptFile).length, "传上去的字节数要和本地一致");

  const rows = await cloudList(cloudOptions, fakeFetch);
  assert.equal(rows.length, 1, "云端列表：" + JSON.stringify(rows));
  assert.equal(rows[0].name, name);

  const dest = join(tmp, "cloud-down");
  mkdirSync(dest, { recursive: true });
  await cloudDownload(cloudOptions, name, dest, fakeFetch);
  assert.equal(readdirSync(dest).length, 1, "下载应落一份：" + readdirSync(dest).join(","));
  assert.equal(readFileSync(join(dest, readdirSync(dest)[0])).length, readFileSync(keptFile).length, "下载内容不完整");
  await cloudDownload(cloudOptions, name, dest, fakeFetch);
  assert.equal(readdirSync(dest).length, 2, "撞名要加序号，不能覆盖本地唯一一份：" + readdirSync(dest).join(","));
});

// ---- 12. 卸载 -----------------------------------------------------------------
step("卸载：package.json 改写是纯函数，落盘后包目录真被删掉", () => {
  const root = join(tmp, "un-root");
  const profile = join(root, "profiles", "desktop");
  mkdirSync(join(profile, "node_modules", "dsh-backup-migrator", "lib"), { recursive: true });
  writeFileSync(join(profile, "node_modules", "dsh-backup-migrator", "lib", "index.js"), "// plugin");
  writeFileSync(join(profile, "package.json"), JSON.stringify({
    name: "desktop",
    dependencies: { "dsh-backup-migrator": "file:E:/x/dsh-backup-migrator", "dsh-task-notify": "file:E:/x/t" },
    dsh: { profile: { bundles: ["dsh-backup-migrator", "dsh-task-notify"] } },
  }, null, 2) + "\n");

  const found = findProfiles(root);
  assert.equal(found.length, 1, "应认出装过本插件的 profile：" + JSON.stringify(found));
  const plan = planUninstall(found[0]);
  assert.equal(plan.before, readFileSync(plan.file, "utf8"), "before 要是改写前的原文");
  assert.ok(!plan.after.includes("dsh-backup-migrator"), "改后的文本里不该再有本插件");
  assert.ok(plan.after.includes("dsh-task-notify"), "别人的插件不能被顺手删掉");
  assert.equal(JSON.parse(plan.after).dsh.profile.bundles.length, 1);

  uninstallProfile(found[0], "20260101-000000");
  assert.ok(existsSync(join(profile, "package.json.bak-20260101-000000")), "改写前要先备份 package.json");
  assert.ok(!existsSync(join(profile, "node_modules", "dsh-backup-migrator")), "包目录应被删掉");
  assert.ok(!readFileSync(join(profile, "package.json"), "utf8").includes("dsh-backup-migrator"));
  assert.deepEqual(findProfiles(root), [], "卸完就该认不出来了");
  assert.deepEqual(findProfiles(join(tmp, "nope")), [], "没有 profiles 目录时给空数组，不抛错");
});

// ---- 13. 设置页响应：扫盘不许挡在请求路径上 -----------------------------------
await stepAsync("scanLazy 不阻塞：冷缓存先给 pending，后台算完再给准数", async () => {
  invalidateScan();
  const t0 = Date.now();
  const first = scanLazy(["sessions", "profiles"], source);
  const cost = Date.now() - t0;
  // 这条断言才是回归护栏：1.7 秒的全量扫盘一旦被挪回请求路径，这里就不再是 pending。
  assert.equal(first.pending, true, "冷缓存第一次必须报 pending（数字还会变）");
  assert.ok(cost < 50, "冷缓存也不该阻塞请求：" + cost + "ms");

  const deadline = Date.now() + 5000;
  let settled = scanLazy(["sessions", "profiles"], source);
  while (settled.pending === true && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
    settled = scanLazy(["sessions", "profiles"], source);
  }
  assert.equal(settled.pending, false, "后台补算应在 5 秒内完成");
  assert.deepEqual(settled.value, scan(["sessions", "profiles"], source), "后台算出来的数字要和同步扫的一致");
});

await stepAsync("换组合不重扫：量过的单元直接复用，未量到的先不计", async () => {
  invalidateScan();
  const only = scan(["sessions"], source);
  const mixed = scanLazy(["sessions", "memories"], source);
  assert.equal(mixed.pending, true, "memories 还没量过 → 数字还会变");
  assert.equal(mixed.value.files, only.files, "已量过的 sessions 应立刻体现在部分结果里");
  assert.equal(mixed.value.bytes, only.bytes);

  const deadline = Date.now() + 5000;
  let settled = scanLazy(["sessions", "memories"], source);
  while (settled.pending === true && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
    settled = scanLazy(["sessions", "memories"], source);
  }
  const both = scan(["sessions", "memories"], source);
  assert.deepEqual(settled.value, both, "补完之后要和同步扫的一致");
  assert.ok(both.bytes >= only.bytes && both.files >= only.files);
});

step("面板：写配置不再等两趟往返（乐观更新 + 不回扫）", () => {
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 点击这条路必须同步回显、不能 await 任何 HTTP：以前就是 await api("/options") 才勾上。
  const start = client.indexOf("const save = useCallback((patch) => {");
  const end = client.indexOf("const fail =", start);
  assert.ok(start > 0 && end > start, "没找到 save()");
  const click = client.slice(start, end);
  assert.ok(click.includes("applyOptions("), "点下去要立刻回显（同步改本地那一份 options）");
  assert.ok(!click.includes("await api("), "点击这条路上不能同步等 HTTP");
  assert.ok(!click.includes("stateRef"), "乐观更新的基准必须是「最新 options」，不能是渲染期的旧快照");
  assert.ok(click.includes('typeof patch === "function"'), "patch 要支持函数式：勾选差集基于最新 options 算");

  // 写成功之后不能再同步等一次 /status（第二趟往返），回读只留给失败分支。
  const ws = client.indexOf("const writeOptions = useCallback");
  const we = client.indexOf("const save = useCallback", ws);
  assert.ok(ws > 0 && we > ws, "没找到 writeOptions()");
  const write = client.slice(ws, we);
  assert.ok(write.includes('api("/options"'), "写配置仍要落盘");
  assert.equal((write.match(/reload\(true\)/g) ?? []).length, 1, "只有写失败那条路才回读一次（且要 adopt 磁盘真相）");
  assert.ok(write.indexOf("catch (e)") < write.indexOf("reload(true)"), "回读只该发生在失败分支");

  assert.ok(client.includes("selectionPending"), "面板要知道数字还在后台算");
  for (const token of ["保存中…", "已保存", "正在统计…"]) {
    assert.ok(client.includes(token), "面板缺反馈文案：" + token);
  }
});

// 真机上「一次连点好几个勾」会丢：点完立刻回显（乐观更新），但那条**早于点击发出**的 /status
// 会把服务端还没包含新勾的 options 盖回来；随后落盘完成的重试又拉回来 → 「点完没了、过会又出来」。
// 两侧都堵住：本地用最新 options 算差集（不读渲染期快照），快照只在「飞完/要 adopt」时才覆盖 options。
step("面板连点勾选不丢：最新 options 算差集 + 在飞的快照不覆盖本地勾", () => {
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const found = /function mergeSnapshot\(old, snap, adopt\) \{[\s\S]*?\n    \}/.exec(client);
  assert.ok(found !== null, "没找到 mergeSnapshot()（快照回填规则）");
  const mergeSnapshot = new Function("return (" + found[0] + ")")();
  const old = { options: { items: ["a", "b"], keepCount: 3 }, selection: { files: 1 }, running: false };
  const snap = { options: { items: ["a"] }, selection: { files: 9 }, running: true };

  const kept = mergeSnapshot(old, snap, false);
  assert.deepEqual(kept.options, old.options, "在飞的写请求还没落盘，不能用服务端快照盖掉本地勾选");
  assert.equal(kept.selection.files, 9, "服务端算出来的数字要回填");
  assert.equal(kept.running, true, "非 options 字段照旧以服务端为准");
  assert.deepEqual(mergeSnapshot(old, snap, true).options, snap.options,
    "adopt=true 要以磁盘为准（首帧/写失败回读用）");
  assert.equal(mergeSnapshot(null, snap, false), snap, "没有旧状态时直接用快照");

  assert.ok(client.includes("const latestOptions = useRef(null)"), "缺「最新 options」镜像");
  assert.ok(client.includes("const inflight = useRef(0)"), "缺在飞写请求计数");
  assert.ok(client.includes("const save = useCallback((patch) => {"));
  assert.ok(client.includes("const adopt = inflight.current === 0"), "写回音要看在飞计数：飞完才以服务端为准");
  assert.ok(client.includes("await reload(true)"), "写失败要强制回读磁盘真相");
  assert.ok(client.includes("save((cur) => {"), "勾选切换必须用函数 patch 读最新勾选");
  assert.ok(client.includes("if (adopt === true || latestOptions.current === null)"),
    "首帧/回读要把本地镜像对齐服务端");
  // 输入框的本地改动也走同一个口子，否则会把在飞的勾覆盖掉。
  assert.ok(!client.includes("setState({ ...state, options: { ...options,"),
    "输入框本地改动不能拿渲染闭包里的 state 拼新状态");
});

step("面板接上了新功能的入口", () => {
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  for (const token of ["/cloud/list", "/cloud/upload", "/cloud/download", "/uninstall",
    "/notify-targets", "probeVersion", "keepDays", "keepBytesGb", "notifyOnFailure"]) {
    assert.ok(client.includes(token), "面板里缺 " + token);
  }
});

// ---- 14. 写接口走宿主连接层（浏览器鉴权 + Host 信任由宿主把关） ----------------
step("写接口全走宿主连接层，上传走流式 fetch 路由", () => {
  const index = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 裸 webServer 路由不在鉴权墙后面，隧道还会把公网请求伪造成回环来源——不能退回去。
  assert.ok(!index.includes("webServer.register("), "别再挂裸 webServer 路由");
  // rpc.handle 在本代 DSH 里对任何插件都注册失败（见 lib/index.js 头部注释），只当备用通道留着。
  assert.ok(index.includes("connection.rpc.handle("), "备用通道 rpc.handle 不该删掉");
  assert.ok(index.includes("connection.fetch.register({"), "宿主侧没有连接层 fetch 路由");
  // 面板写接口：每个 endpoint 一条精确路由 + 显式 buffered（缺省会被连接层当流式通道）。
  assert.ok(index.includes('path: API_PREFIX + "/" + name'), "面板端点必须逐条注册精确 fetch 路由");
  assert.ok(index.includes('requestBody: "buffered"'), "面板 JSON 路由必须显式 buffered");
  assert.ok(index.includes('requestBody: "streaming"'), "上传必须 streaming：几百 MB 进不了 JSON 信封");
  // streaming 路由不把请求体读干净，连接层会 req.destroy() 把响应截断。
  assert.ok(index.includes("Readable.fromWeb("), "上传体要有流式落盘通道");
  // 上传落盘也不能把已有备份覆盖掉：同一秒连传两次要自动加序号（createBackup/export 同款）。
  assert.ok(index.includes("existsSync(join(storeDir, name))"), "上传落盘要防撞名覆盖");
  assert.ok(index.includes('name = stem + "-" + n + ext'), "撞名要加 -2/-3 序号");

  const chan = /const CHANNEL = "([^"]+)"/.exec(index);
  const chanClient = /const CHANNEL = "([^"]+)"/.exec(client);
  assert.ok(chan !== null && chanClient !== null, "两边都要有 CHANNEL");
  assert.equal(chanClient[1], chan[1], "客户端与宿主的通道名必须一致");

  const prefix = /const API_PREFIX = "([^"]+)"/.exec(index);
  const prefixClient = /const API_PREFIX = "([^"]+)"/.exec(client);
  const imp = /const IMPORT_PATH = API_PREFIX \+ "([^"]+)"/.exec(index);
  const up = /const ENDPOINT_UPLOAD = "([^"]+)"/.exec(client);
  assert.ok(prefix !== null && prefixClient !== null && imp !== null && up !== null,
    "两边都要有 API_PREFIX / IMPORT_PATH / ENDPOINT_UPLOAD");
  // 客户端用相对 URL（靠 document.baseURI 解析），所以只比去掉前导斜杠的那半截。
  assert.equal(prefixClient[1], prefix[1].replace(/^\//, ""), "客户端与宿主的 API_PREFIX 必须同源");
  assert.equal("/" + up[1], prefix[1] + imp[1], "上传路径必须与宿主 IMPORT_PATH 同源");

  // 注：rpc.handle 的 webServer 守卫看的是**连接层插件那条 fiber**，不是我们的 inject 名单
  // （实测调用方 inject 空/满都抛），所以 inject 里有没有 webServer 都不影响它失败。
  // 这里保留 webServer 只是因为面板的 /api 前缀路由也依赖它——服务齐了再注册更省心。
  assert.ok(index.includes('ctx.inject(["settings", "webServer", "connection"]'),
    "inject 名单保持 settings/webServer/connection");
  // 启动诊断：宿主半插件挂没挂只能靠 trace 落盘（<数据根>/.backup-migrator-plugin/boot.log）。
  for (const token of ['trace("模块已加载 v" + VERSION)', "trace(\"inject 回调进入", "inject 回调 20 秒仍未进入",
    'trace("面板 fetch 路由注册 "', 'trace("fetch 路由注册失败 " + name + "：" + messageOf(error))',
    'trace("rpc.handle 注册成功：" + CHANNEL)', 'trace("fetch.register 注册成功：" + IMPORT_PATH)',
    'trace("rpc.handle 注册失败：" + messageOf(error))', 'trace("fetch.register 注册失败：" + messageOf(error))']) {
    assert.ok(index.includes(token), "缺启动诊断：" + token);
  }
  // 一处注册失败不能拖垮另一处（rpc 挂了路由还得在），disposer 清理也不能再抛。
  assert.ok(index.includes("for (const dispose of onJson) { try { dispose?.(); } catch"), "面板路由 disposer 要逐条兜住");
  assert.ok(index.includes("try { onRpc?.(); } catch"), "disposer 清理要各自兜住");
  assert.ok(index.includes("clearTimeout(pendingTimer)"), "inject 回调进入后要停掉等待探针");

  // 连接层客户端的 parseConnectionResponse 要求 error.details 是对象，缺了整个请求会变成
  // 「connection: invalid server-response failure」，用户看不到真正的错因。
  assert.ok(index.includes("details: {}"), "bad() 必须带 details 对象");
  for (const ep of ["status", "options", "backup", "inspect", "restore", "delete", "export",
    "hello", "notify-targets", "cloud/list", "cloud/upload", "cloud/download", "uninstall"]) {
    // 键可能带引号（"cloud/list":）也可能不带（status:），两种写法都认。
    assert.ok(index.includes('"' + ep + '":') || index.includes(ep + ":"), "缺 endpoint：" + ep);
  }
});

step("面板声明了连接层客户端包（否则 connection 服务不会加载，面板整块挂不上）", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-connection"),
    "dsh.client.inject 少了 @deepseek-ai/dsh-client-connection");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(client.includes('const inject = ["slots", "connection"]'), "客户端没注入 connection");
  assert.ok(!client.includes("BASE = "), "旧的自建路由前缀没删干净");
  // 面板首选精确 fetch 路由，只有老宿主（没有这条路由）才回退 RPC。
  assert.ok(client.includes("async function viaFetch(endpoint, payload)"), "面板没有 fetch 路由通道");
  assert.ok(client.includes('headers: { "content-type": "application/json", "x-backup-migrator": "1" }'),
    "面板 fetch 要带 content-type 与自定义头");
  assert.ok(client.includes("res.status === 404 || res.status === 405 || res.status === 501"),
    "只该在路由缺失（404/405/501）时回退 RPC，鉴权被拒不能回退");
  assert.ok(client.includes("await connection.rpc.call(CHANNEL, endpoint, payload)"), "回退路径没了");
});

step("新增的可选项都不在默认集里（默认打包行为不变）", () => {
  const backup = readFileSync(new URL("../lib/backup.js", import.meta.url), "utf8");
  const def = /const DEFAULT_ITEMS = \[([^\]]+)\]/.exec(backup);
  assert.ok(def !== null, "没找到 DEFAULT_ITEMS");
  for (const id of ["market", "channel-pack", "openai-gateway", "remote-web-ui-registry",
    "remote-web-ui-devices", "worktrees"]) {
    assert.ok(backup.includes('id: "' + id + '"'), "ITEMS 里没有 " + id);
    assert.ok(!def[1].includes('"' + id + '"'), id + " 不该在默认集里");
  }
});

step("版本号三处同步（package.json / csproj / README）", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const v = String(pkg.version).replace(/\./g, "\\.");
  assert.ok(new RegExp("<Version>" + v + "</Version>").test(
    readFileSync(new URL("../tool/DshBackupAssistant.csproj", import.meta.url), "utf8")),
    "csproj 版本没跟上 package.json：" + pkg.version);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("/refs/tags/v" + pkg.version), "README 的安装 spec 版本没跟上");
  assert.ok(readme.includes("DSH-Backup-Assistant-" + pkg.version + "-win-x64.exe"), "README 的 EXE 地址没跟上");
});

console.log("dsh-backup-migrator selftest");
console.log(steps.join("\n"));
rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "\nFAILED" : "\nPASSED");
