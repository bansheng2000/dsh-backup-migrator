# dsh-backup-migrator

给 DSH 做的**配置保存 + 一键换机**插件：把本机的聊天记录、长期记忆、插件与 profile 配置打成一份单文件备份，换台电脑导入就能接着用，不用重新配置。

## 它做什么

- **备份内容在设置页里勾** —— 聊天记录 / 附件 / 长期记忆 / 存储与状态 / 集成配置 / 插件与 profile / 启动自愈 / IM 渠道。
  另有几项**只在你勾了才进包**（都是插件自己写出来的状态，默认不带）：插件市场数据（含登录态）、渠道包数据（含 API Key）、OpenAI 网关配置、远程访问登记表、远程访问设备表、插件工作树记录、凭据 `.credentials.yaml`。
- **单文件导出** —— 一份 `.zip`（默认）或 `.tar.gz`，拷到 U 盘 / 网盘 / 别的盘符都行。
- **自动定时备份** —— 间隔自己设（分钟，低于 10 按 10 算；0 = 关），超量自动删旧的。
- **换机导入** —— 导入前先校验（manifest、条目路径安全、勾选项齐全、sha256），通过后两种方式还原：
  - **暂存区**：解到备份目录里的一个 `.restore-*` 文件夹 + `restore.ps1`，你确认无误再自己跑一次脚本落盘；
  - **直接写回**：当场解到数据目录（覆盖同名文件）。

## 不备份什么（故意的）

| 目录 | 原因 |
| --- | --- |
| `profiles/*/node_modules` | 本机 1248MB 里 1248.16MB 是它；换机后一条 `pnpm install` 就有 |
| `dsh-runtimes` | 自带的 node/python/pnpm，装 DSH 时会重新下载 |
| `cache` / `telemetry` | 可再生 / 无价值 |
| `origin-plugin-venv` `opencode-bridge` `.cloudflared-live` | 都是几百 MB 的可再生运行时，换机后由对应插件自己重建（面板里也写明了） |

实测：勾上「插件与 profile + 聊天记录 + 长期记忆 + 存储与状态 + 集成配置 + 附件」打出来的包约 **24MB**，不带勾选的话更小。

## 安装

在 DSH 的 profile 目录（`%USERPROFILE%\.dsh\profiles\desktop`）的 `package.json` 里加两处。

**注意 bundle 名必须是包名 `dsh-backup-migrator`** —— 写短了（如 `backup-migrator`）宿主会一直报 `cannot resolve profile bundle`，插件永远挂不上：

```jsonc
{
  "dependencies": {
    "dsh-backup-migrator": "github:bansheng2000/dsh-backup-migrator"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-backup-migrator"]
    }
  }
}
```

本地开发时把依赖换成绝对正斜杠的 `file:` 路径：`"dsh-backup-migrator": "file:E:/path/to/dsh-backup-migrator"`。

然后在该目录里装依赖（用 DSH 自带的 pnpm）：

```powershell
# DSH 0.2.1 起 pnpm 挪进了 primary-runtime（旧版在 resources\runtime\pnpm\bin\pnpm.mjs）
node "F:\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs" --dir "$env:USERPROFILE\.dsh\profiles\desktop" install --config.minimumReleaseAge=0 --config.strictStorePkgContentCheck=false
```

重启 DSH，设置页出现「备份与换机」。

> `file:` 依赖装进 profile 的是**真实拷贝**不是链接 —— 改了仓库代码必须重跑一次 `install`，否则改动不生效。

> `github:` 简写会走 `git ls-remote git+ssh://git@github.com/...`，没配 ssh key 的机器会 exit 128。配一条 `git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"` 即可。

想完全绕开 git 解析，就直接给 tarball 地址（版本写死最稳）：

```jsonc
"dsh-backup-migrator": "https://codeload.github.com/bansheng2000/dsh-backup-migrator/tar.gz/refs/tags/v0.3.2"
```

## 用法

设置页 →「备份与换机」：

1. 勾要备份的内容；
2. 点「选择文件夹…」定备份目录（留空 = `%USERPROFILE%\.dsh\backups`），再定格式、保留份数、自动间隔；
3. 点「备份到 …」，进度条跑完即完成；
4. 换机时把备份文件拷到新电脑，在同一面板里「选择备份文件…」上传 → 看校验结果 → 选还原方式。

## 更多设置（同一个面板里往下拉）

- **保留策略三个维度**：保留份数（默认 10）、保留天数、占用上限 GB，后两个 0 = 不限。清理顺序是先按天数过期 → 再按总占用从最旧删到阈值下 → 最后收敛份数；**刚打出来的那份永远豁免**（不然占用上限比单份包还小时，新包会把自己删掉）。
- **还原前查空间**：按 manifest 里记的原始体积（老包按归档 ×2.5）留 10% 余量算需求，不够就在写任何文件之前拒绝，并告诉你差多少；目标盘查不到就不再挡。
- **manifest 记下 DSH 版本**：插件自报（面板读 `__DSH_BOOT__`）优先，其次环境变量，再其次读 app.asar 的 package.json；导入时面板会显示这是哪个 DSH 版本打的包。
- **备份失败通知**：接了宿主 dsh-im 时，失败会往你选的机器人/会话发一条（动作、时间、原因）；没装 dsh-im 就在面板里说明原因，不假装发过。
- **云端备份（WebDAV）**：填地址、远端目录、账号、口令即可上传/列目录/下载（坚果云、Nextcloud 这类都行），零第三方依赖。口令是**明文存在本机配置**里的，建议用应用专用密码。
- **设置页点一下就有反应**：勾备份内容、切开关都是**乐观更新** —— 界面立刻变，写盘在后台按顺序排队；只有写失败才回到磁盘真值并提示。文件体积在后台统计，面板先显示上次的数字、旁边标「正在统计…」，不再卡住点击。
- **卸载本插件**：从 profile 的 package.json 里摘掉并删包目录，改前先存一份 `package.json.bak-<时间戳>`。**聊天记录、备份文件、配置都不删**，重启 DSH 后插件才真正消失。

## 备份助手 EXE（换机不用先装插件）

插件要装进 profile 才能用，但换机那台电脑上还没有 profile —— 这是个死锁。`tool/` 里是一个自包含的单文件 EXE，把插件源码**嵌在自己身上**：新电脑上先跑它，插件就装好了。

### 四个入口

```powershell
& "DSH备份助手.exe"                # 打开窗口（默认，就用这个）
& "DSH备份助手.exe" --selftest     # 自检，76 项，用来确认这份 EXE 本身没坏
& "DSH备份助手.exe" --restore 备份.zip   # 无界面直写数据目录（给脚本用）
& "DSH备份助手.exe" --stage   备份.zip   # 无界面解到暂存区 + restore.ps1
```

窗口里四块：**装插件**（检测 DSH → 选 profile → 装，检测来自注册表 `HKLM\...\Uninstall`）、**导入备份**（选文件 → 校验 → 直写或解暂存区）、**备份目录**（可改，会把 EXE 自己复制过去）、**备份列表**。装插件、导入、保存并搬动助手这三个动作都要再确认一次。

下载（v0.3.2，win-x64，49MB）：

```
https://github.com/bansheng2000/dsh-backup-migrator/releases/download/v0.3.2/DSH-Backup-Assistant-0.3.2-win-x64.exe
```

（release 的附件名只能用 ASCII，所以下载下来的名字是 `DSH-Backup-Assistant-0.3.2-win-x64.exe`，双击一样能跑。）

### 目录结构

```
DSH备份助手.exe        49MB，自包含，带 .NET 运行时，目标机不用装任何东西
备份目录.txt           可选，一行绝对路径；没有就用 <数据根>\backups
dsh-backup-assistant.log
plugin\               EXE 首次运行时从内嵌 zip 解出来的插件源码
```

换机：把 `DSH备份助手.exe` 拷到 U 盘 → 新电脑上双击 → 「装插件」→ 「导入备份」选 U 盘里的备份文件。

### 构建

```powershell
pwsh -ExecutionPolicy Bypass -File tool/build.ps1 -Output C:\out
```

四步：把插件的六个文件组到 `payload\stage` → 打成 `payload\plugin.zip` → `dotnet publish` 单文件自包含（win-x64，约 35 秒）→ 删掉输出目录里除 EXE 外的文件。要 .NET SDK 10；只用得到系统自带的 `tar.exe`，没有第三方运行时依赖。

### 默认值与理由

| 项 | 默认 | 为什么 |
| --- | --- | --- |
| 备份目录 | `<数据根>\backups` | 与插件侧空值时的默认值同源，两边不会各存一份 |
| 改目录时怎么搬 EXE | **复制**，同名加 `-2` 序号 | 原件留作退路；绝不覆盖目标目录里的未知文件 |
| 导入方式 | 默认**直写**，旁边另有「解到暂存区…」 | 直写是大多数情况；不确定就先解暂存区看一遍 |
| 数字签名 | 无 | 没有证书；README 说明了 SmartScreen 怎么办 |

签名之外只有一个已知摩擦：SmartScreen 可能弹「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」。

### 已知限制

- **它不装 `node_modules`** —— 只把插件源码放进 profile 的 `node_modules\dsh-backup-migrator` 并改 `package.json` 两处（`bundles` 加**包名**、`dependencies` 加 `file:`），真正的依赖安装交给 DSH 自带的 node + pnpm 跑一次（找不到时会打印手动命令）。
- 导入前请**完全退出 DSH**，否则正在运行的宿主会和还原过程抢同一批文件。窗口会检测并在状态行提示。
## 测试

```powershell
node test/selftest.mjs
```

真 tar、真 zip、真还原，跑在临时目录，不碰真实 `~/.dsh`。覆盖：打包内容对不对（node_modules 不能漏进去）、manifest 校验、非本插件归档被拒、staged/direct 两种还原、`keepCount` 与删除。

## 实现要点

- 打包用系统自带 `tar`（本机是 bsdtar 3.8.8，支持 `tar --format zip -cf`），**没有第三方依赖**；zip 和 tar.gz 同一套代码。
- manifest（`dsh-backup-manifest.json`）和数据写在**同一次 `-cf`** 里 —— bsdtar 不能追加进 zip，实测 `-rf` 必失败。
- 还原前扫全部条目，拒绝 `/` 开头、`../`、`..\`、`C:` 这类越界路径。
- 文件名只认 `dsh-backup-*.zip|.tar.gz`，且操作前一律 `basename()` + 拼回 storeDir，防路径穿越。
- **写接口走宿主连接层，不挂裸 `webServer` 路由**：裸路由**不在宿主的浏览器鉴权墙后面**，而且经 cloudflared 之类的隧道打进来时 `req.socket.remoteAddress` 恒为回环、连 Host 判据都不好使（实测公网无凭据就能读写别的插件的裸路由）。所以面板的每个动作都走 `ctx.connection.rpc.handle(CHANNEL, handler)` + 渲染进程 `connection.rpc.call()`，浏览器凭据与 Host/Origin 信任由宿主把关；响应信封由连接层拼（失败对象必须带 `error.details`，否则客户端解析直接报 `invalid server-response failure`）。
- 上传备份（几百 MB）**不能**走 RPC 的 JSON 信封，单独注册一条流式 fetch 路由 `/api/dsh-backup-migrator/import`（`requestBody: "streaming"`，无大小上限）。注意流式路由必须把请求体读干净，否则连接层会 `req.destroy()` 把响应截断。

## 已知限制

- `node_modules` 不进包（1.2GB 的可再生文件）。换机还原时 `restore.ps1` 会自己遍历 profile 目录跑 `dsh plugin --profile <name> install` 把插件装回来；找不到 `dsh` 命令才需要你手动来一遍。
- profile 里插件的 `package.json` 用的是**绝对路径** `file:` 依赖（本机实测写成了乱码路径），换盘符后这些 `file:` 会失效 —— 需要在 profile 里改成相对路径或改成已发布版本，再 `pnpm install`。聊天记录、记忆等数据不受影响。
- 云端备份只做了 WebDAV；下载撞名会加 `-2/-3` 序号，不覆盖本地唯一那份。
- 卸载只摘掉插件的挂载与包目录，不删备份、不删聊天记录。
- 文件夹用宿主自带的原生对话框点选（桌面端 preload `__DSH_DIRECTORY_PICKER__.pick()`，Web GUI 走 `uiWorkspace.pickDirectory()`）；远程连过来、宿主也拿不到对话框时，按钮会提示改用文本框手填。
