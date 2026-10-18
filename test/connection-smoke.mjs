/**
 * 连接层接线冒烟：用假 ctx／假 settings 把 lib/index.js 拉起来，验宿主侧新接口真的挂对了。
 *
 * 为什么单开一个文件而不是塞进 selftest.mjs：这里要跑**真备份**（真 tar、真落盘），
 * 跟 selftest 的纯逻辑用例不是一回事；而且它必须原样重放连接层的契约——
 * 信封形状（{ok,value} / {ok:false,error:{code,message,details}}）、流式上传的收尾、
 * 撞名加序号、失败时不留 .part 残渣。
 *
 * 0.3.3 起面板的写接口是**每个 endpoint 一条精确 fetch 路由**（/api/dsh-backup-migrator/<endpoint>）：
 * 本代 DSH 里 connection.rpc.handle 对任何插件都注册失败（见 lib/index.js 头部注释），面板只能走
 * 连接层自己挂的 /api 前缀。这里就按那个契约逐条验：路径、方法、requestBody 模式。
 *
 * 跑法（PATH 必须先找到系统 bsdtar，否则 GNU tar 不认 --format zip）：
 *   PATH="/c/Windows/system32:$PATH" node test/connection-smoke.mjs
 * 传参可以指到装机副本上验「装进去的那份」：
 *   node test/connection-smoke.mjs ~/.dsh/profiles/desktop/node_modules/dsh-backup-migrator/lib/index.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 被测入口：默认仓库自己的 lib/index.js，也可传路径（用来验装机副本）。
// 仓库里没有 node_modules（插件依赖装在 profile 里），所以直接 import 仓库入口会
// ERR_MODULE_NOT_FOUND —— 那就退到本机 profile 里的装机副本，并回报用的是哪一份。
function installedCopy() {
  const home = os.homedir();
  const profiles = path.join(home, ".dsh", "profiles");
  if (!fs.existsSync(profiles)) return null;
  for (const profile of fs.readdirSync(profiles)) {
    const candidate = path.join(profiles, profile, "node_modules", "dsh-backup-migrator", "lib", "index.js");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
let entry = process.argv[2] ?? fileURLToPath(new URL("../lib/index.js", import.meta.url));
let mod;
try {
  mod = await import(pathToFileURL(entry).href);
} catch (error) {
  if (process.argv[2] !== undefined || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  const fallback = installedCopy();
  if (fallback === null) throw error;
  entry = fallback;
  console.log("# 仓库里没有 node_modules，改用装机副本 " + fallback);
  mod = await import(pathToFileURL(entry).href);
}
const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), "bm-rpc-"));
const state = { options: { storeDir: tmpStore }, revision: 3 };
const settings = {
  configure() {},
  // 宿主的 describe() 形状：{ namespaces: [{ ns, value, revision }] }（namespaceOf 就是从这取）
  describe() { return { namespaces: [{ ns: mod.NS, value: { options: state.options }, revision: state.revision }] }; },
  async read() { return { namespaces: [{ ns: mod.NS, value: { options: state.options }, revision: state.revision }] }; },
  async update(ns, patch, revision) {
    assert.equal(ns, mod.NS, "命名空间");
    assert.equal(revision, state.revision, "revision 要对上（并发写会被宿主挡）");
    state.options = { ...state.options, ...(patch.options ?? {}) };
    state.revision += 1;
    return {};
  },
};
let rpcHandler = null;
/** 精确 fetch 路由登记表：pathname → route（与连接层 fetchRoutes 的键法一致）。 */
const routes = new Map();
const ctx = {
  logger: { info() {}, debug() {}, error() {}, warn(...a) { console.log("[warn]", ...a); } },
  effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {}; },
  inject(names, cb) { cb(ctx); },
  get() { return undefined; },
  on() {},
  settings,
  connection: {
    // rpc.handle 在本代 DSH 里必抛（连接层拿自己的 ctx 找 webServer），但我们仍保留注册。
    rpc: { handle(channel, handler) { assert.equal(channel, "/dsh-backup-migrator"); rpcHandler = handler; return () => { rpcHandler = null; }; } },
    fetch: {
      register(route) {
        assert.ok(!routes.has(route.path), "路径重复注册：" + route.path);
        routes.set(route.path, route);
        return () => { routes.delete(route.path); };
      },
    },
  },
};
mod.apply(ctx, mod.Config({}));
assert.ok(rpcHandler !== null, "备用通道 rpc.handle 也要注册（将来 DSH 修好即恢复）");

const PANEL = ["status", "backup", "options", "inspect", "restore", "delete", "export", "hello",
  "notify-targets", "cloud/list", "cloud/upload", "cloud/download", "uninstall"];
for (const ep of PANEL) {
  const route = routes.get("/api/dsh-backup-migrator/" + ep);
  assert.ok(route !== undefined, "缺面板精确路由：" + ep + "（现有 " + [...routes.keys()].join(", ") + "）");
  assert.deepEqual([...route.methods], ["POST"], ep + " 只该收 POST");
  // 缺省 requestBody 会被连接层判成流式通道（request.json() 在那种形态下不可靠），必须显式 buffered。
  assert.equal(route.requestBody, "buffered", ep + " 必须 buffered");
}
const fetchRoute = routes.get("/api/dsh-backup-migrator/import");
assert.ok(fetchRoute !== undefined, "上传路由没注册");
assert.deepEqual([...fetchRoute.methods], ["POST"]);
assert.equal(fetchRoute.requestBody, "streaming");
assert.equal(routes.size, PANEL.length + 1, "路由条数不对：" + routes.size);
console.log("ok   " + PANEL.length + " 条面板精确 fetch 路由（buffered）+ 上传路由 " + fetchRoute.path + "（streaming）");

/** 像面板那样打一条 JSON 路由（默认带 x-backup-migrator 头），返回 {status, json}。 */
async function callRaw(endpoint, payload, headers) {
  const route = routes.get("/api/dsh-backup-migrator/" + endpoint);
  assert.ok(route !== undefined, "没有这条路由：" + endpoint);
  const res = await route.fetch(new Request("http://127.0.0.1:1/api/dsh-backup-migrator/" + endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-backup-migrator": "1", ...(headers ?? {}) },
    body: JSON.stringify(payload ?? {}),
  }));
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
/** 面板 api() 的等价物：只认 200 + {ok:true,value}。 */
async function call(endpoint, payload) {
  const r = await callRaw(endpoint, payload);
  assert.equal(r.status, 200, endpoint + " → HTTP " + r.status + " " + JSON.stringify(r.json));
  return r.json;
}

const nohead = await callRaw("status", {}, { "x-backup-migrator": "" });
assert.equal(nohead.status, 403);
assert.equal(nohead.json.ok, false);
assert.equal(nohead.json.error.code, "backup-migrator/forbidden");
console.log("ok   缺 x-backup-migrator 头 → 403 " + nohead.json.error.message);

// 无 body 无 content-type：面板有端点就是空 POST（status / notify-targets）。
const bareRes = await routes.get("/api/dsh-backup-migrator/status").fetch(
  new Request("http://127.0.0.1:1/api/dsh-backup-migrator/status", { method: "POST", headers: { "x-backup-migrator": "1" } }));
assert.equal(bareRes.status, 200);
assert.equal((await bareRes.json()).ok, true);
console.log("ok   空请求体当 {} 处理（不带参数的端点照样 200）");

// 精确路由表里没有的就是没有：未知 endpoint 连路由都没有（连接层给 404），
// 面板那边表现为「拿不到接口」，不会伪装成成功。
assert.equal(routes.get("/api/dsh-backup-migrator/nope"), undefined, "未知 endpoint 不该有路由");
console.log("ok   未知 endpoint 没有路由（连接层 404），不是假成功");

const hello = await call("hello", { version: "0.2.1-rc.2" });
assert.deepEqual(hello, { ok: true, value: { dsh: "0.2.1-rc.2" } });
console.log("ok   hello 记住 DSH 版本 → " + hello.value.dsh);

const nt = await call("notify-targets", {});
assert.equal(nt.ok, true);
assert.deepEqual(nt.value, { available: false, targets: [] });
console.log("ok   没装 dsh-im 时 notify-targets 如实报不可用");

const restore = await call("restore", {});
assert.equal(restore.ok, false);
assert.ok(restore.error.message.includes("选一份备份"), restore.error.message);
assert.deepEqual(restore.error.details, {});
assert.deepEqual(restore.error.details, {});
console.log("ok   处理器抛错被 run() 兜住 → ok:false（不是 500 纯文本）");

const opt = await call("options", { patch: { keepCount: 3 } });
assert.equal(opt.ok, true);
assert.equal(opt.value.options.keepCount, 3);
assert.equal(state.options.keepCount, 3, "要真写进 settings");
assert.equal(opt.value.selectionPending, true, "冷缓存先报 pending（snapshot 的字段名是 selectionPending）");
console.log("ok   options 写盘 + 回全量快照（乐观更新用）");

const st = await call("status", {});
assert.equal(st.ok, true);
const ids = st.value.catalog.map((i) => i.id);
for (const id of ["channel-pack", "openai-gateway", "remote-web-ui-registry", "remote-web-ui-devices", "worktrees"]) {
  assert.ok(ids.includes(id), "catalog 缺 " + id);
}
const dev = st.value.catalog.find((i) => i.id === "remote-web-ui-devices");
assert.equal(dev.optIn, true);
assert.equal(dev.sensitive, true);
assert.ok(String(dev.path).endsWith(".json"), "设备表是单个文件：" + dev.path);
assert.ok(!st.value.options.items.includes("worktrees"), "默认集不该自己带上新项");
console.log("ok   catalog 15 项，新项带 optIn，默认集未变");

const url = "http://127.0.0.1:1/api/dsh-backup-migrator/import";
const denied = await fetchRoute.fetch(new Request(url, { method: "POST", body: "x" }));
assert.equal(denied.status, 403);
const deniedJson = await denied.json();
assert.equal(deniedJson.ok, false);
assert.equal(deniedJson.error.code, "backup-migrator/forbidden");
console.log("ok   缺 x-backup-migrator 头 → 403 " + deniedJson.error.message);

const junk = await fetchRoute.fetch(new Request(url, {
  method: "POST", headers: { "x-backup-migrator": "1" }, body: "this is not a backup",
}));
assert.equal(junk.status, 400);
const junkJson = await junk.json();
assert.equal(junkJson.ok, false);
assert.ok(junkJson.error.message.includes("备份"), junkJson.error.message);
const leftovers = fs.readdirSync(tmpStore);
assert.deepEqual(leftovers, [], "失败的收尾要清掉 .part 临时文件，实际：" + leftovers.join(","));
console.log("ok   垃圾上传 → 400 且不落残渣：" + junkJson.error.message);


// ── 成功路径：真造一份备份，走流式路由送进来（顺带验撞名加序号）──────────────
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "bm-rpc-data-"));
fs.mkdirSync(path.join(tmpData, "sessions"), { recursive: true });
fs.mkdirSync(path.join(tmpData, "memories"), { recursive: true });
fs.writeFileSync(path.join(tmpData, "sessions", "session-1.json"), JSON.stringify({ hello: "world" }));
fs.writeFileSync(path.join(tmpData, "memories", "MEMORY.md"), "# 记忆\n");
const prevRoot = process.env.DSH_DATA_DIR;
process.env.DSH_DATA_DIR = tmpData;
const bmod = await import(pathToFileURL(path.join(path.dirname(entry), "backup.js")).href);
const made = await bmod.createBackup({ storeDir: tmpStore, items: ["sessions", "memories"] });
assert.ok(fs.existsSync(made.file), "造出来的备份不存在：" + made.file);
const bytes = fs.readFileSync(made.file);

async function upload() {
  const res = await fetchRoute.fetch(new Request(url, {
    method: "POST",
    headers: { "x-backup-migrator": "1", "content-type": "application/octet-stream" },
    body: new Blob([bytes]),
    duplex: "half",
  }));
  const json = await res.json();
  return { status: res.status, json };
}

const up1 = await upload();
assert.equal(up1.status, 200, JSON.stringify(up1.json));
assert.equal(up1.json.ok, true);
assert.match(up1.json.value.name, /^dsh-backup-\d{8}-\d{6}\.zip$/, up1.json.value.name);
assert.equal(up1.json.value.report.manifest.plugin, "dsh-backup-migrator");
assert.deepEqual(up1.json.value.report.problems, [], JSON.stringify(up1.json.value.report.problems));
assert.equal(up1.json.value.report.manifest.dsh, "0.2.1-rc.2", "包里的 dsh 版本要当面记下来");
assert.ok(fs.existsSync(path.join(tmpStore, up1.json.value.name)), "文件没落到备份目录");
assert.equal(fs.readFileSync(path.join(tmpStore, up1.json.value.name)).length, bytes.length, "落盘字节数要对上");
console.log("ok   真备份上传 → 200，落到 " + up1.json.value.name + "，report.ok=true");

// 撞名是「同一秒」的事，靠连打两次必然偶发跨秒 —— 把时间冻住，让它确定性地撞上。
const RealDate = Date;
const frozen = RealDate.now();
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length === 0 ? [frozen] : args)); }
  static now() { return frozen; }
};
const up2 = await upload();
globalThis.Date = RealDate;
assert.equal(up2.status, 200);
assert.notEqual(up2.json.value.name, up1.json.value.name, "同一秒的第二次上传不能覆盖第一份");
assert.ok(up2.json.value.name.endsWith("-2.zip"), "撞名要加序号：" + up2.json.value.name);
console.log("ok   同一秒连传两次 → 第二份自动加序号 " + up2.json.value.name);

if (prevRoot === undefined) delete process.env.DSH_DATA_DIR; else process.env.DSH_DATA_DIR = prevRoot;
fs.rmSync(tmpData, { recursive: true, force: true });

// ── 走一次真备份：settings → startBackup → createBackup → 进度/状态 → prune ──
state.options = { ...state.options, items: ["memories"], format: "zip", keepCount: 10 };
const before = new Set(fs.readdirSync(tmpStore));
const started = await call("backup", { label: "harness" });
assert.equal(started.ok, true, JSON.stringify(started));
let st2 = null;
const phases = new Set();
for (let i = 0; i < 240; i += 1) {
  st2 = await call("status", {});
  assert.equal(st2.ok, true);
  if (st2.value.progress?.phase !== undefined) phases.add(st2.value.progress.phase);
  if (st2.value.running !== true) break;
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal(st2.value.running, false, "备份没跑完：running=" + JSON.stringify(st2.value.running));
assert.equal(st2.value.failure, null, "这次备份不该记失败：" + JSON.stringify(st2.value.failure));
// 跑完在 finally 里把 progress 清成 null（面板靠 backups 列表显示结果），但过程中要报过阶段。
assert.equal(st2.value.progress, null, "跑完该清掉 progress：" + JSON.stringify(st2.value.progress));
assert.ok(phases.size > 0, "整个过程一个进度阶段都没报过");
for (const p of phases) assert.ok(["scan", "pack", "prune", "done"].includes(p), "认不出的阶段：" + p);
console.log("   phases = " + [...phases].join(" → "));
const after = fs.readdirSync(tmpStore);
const added = after.filter((n) => !before.has(n));
assert.equal(added.length, 1, "真备份该多出一个文件：" + after.join(",") + "（新增 " + added.join(",") + "）");
const fresh = after.filter((n) => n.endsWith(".zip")).map((n) => path.join(tmpStore, n))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
assert.equal(st2.value.backups[0].name, path.basename(fresh), "历史列表第一条 = 最新那份");
assert.ok(st2.value.backups[0].bytes > 0, "最新那份有体积");
console.log("ok   走真备份端点 → done，历史列表 " + st2.value.backups.length + " 份，最新 " + st2.value.backups[0].name);
fs.rmSync(tmpStore, { recursive: true, force: true });
console.log("SMOKE_PASSED");
