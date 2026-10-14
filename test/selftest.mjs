// dsh-backup-migrator 自检：真 tar、真 zip、真还原，跑的是临时目录，不碰真实 ~/.dsh。
//
// 用法：node test/selftest.mjs
//
// 覆盖的是容易出错的地方，不是行数覆盖率：
//  1. 打包后归档里必须没有 node_modules（否则备份从 24MB 变 1.2GB）。
//  2. manifest 与数据在同一个归档里，且能被 tar -xOf 读出来。
//  3. 换机语义：把一份备份 direct 还原到「另一台机器」的数据目录。
//  4. 损坏 / 非本插件的文件必须在校验阶段被拒，不能还原。
//  5. keepCount 生效、手动删除生效。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const { createBackup, deleteBackup, inspectBackup, itemsOf, listBackups,
  prune, readManifest, restoreBackup, dataRootOf, storeDirOf, defaultOptions, scan } =
  await import("../lib/backup.js");

const steps = [];
function step(name, fn) {
  try {
    fn();
    steps.push("  ok   " + name);
  } catch (error) {
    steps.push("  FAIL " + name + "\n       " + String(error?.message ?? error).split("\n")[0]);
    process.exitCode = 1;
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

console.log("dsh-backup-migrator selftest");
console.log(steps.join("\n"));
rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "\nFAILED" : "\nPASSED");
