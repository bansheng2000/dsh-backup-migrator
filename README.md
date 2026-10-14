# dsh-backup-migrator

给 DSH 做的**配置保存 + 一键换机**插件：把本机的聊天记录、长期记忆、插件与 profile 配置打成一份单文件备份，换台电脑导入就能接着用，不用重新配置。

## 它做什么

- **备份内容在设置页里勾** —— 聊天记录 / 附件 / 长期记忆 / 存储与状态 / 集成配置 / 插件与 profile / 启动自愈 / IM 渠道 / 凭据（默认不带）。
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
node "F:\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs" --dir "$env:USERPROFILE\.dsh\profiles\desktop" install --config.minimumReleaseAge=0 --config.strictStorePkgContentCheck=false
```

重启 DSH，设置页出现「备份与换机」。

> `file:` 依赖装进 profile 的是**真实拷贝**不是链接 —— 改了仓库代码必须重跑一次 `install`，否则改动不生效。

> `github:` 简写会走 `git ls-remote git+ssh://git@github.com/...`，没配 ssh key 的机器会 exit 128。配一条 `git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"` 即可。

想完全绕开 git 解析，就直接给 tarball 地址（版本写死最稳）：

```jsonc
"dsh-backup-migrator": "https://codeload.github.com/bansheng2000/dsh-backup-migrator/tar.gz/refs/tags/v0.1.0"
```

## 用法

设置页 →「备份与换机」：

1. 勾要备份的内容；
2. 填备份目录（留空 = `%USERPROFILE%\.dsh\backups`）、格式、保留份数、自动间隔；
3. 点「备份到 …」，进度条跑完即完成；
4. 换机时把备份文件拷到新电脑，在同一面板里「选择备份文件…」上传 → 看校验结果 → 选还原方式。

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

## 已知限制

- `node_modules` 不进包（1.2GB 的可再生文件）。换机还原时 `restore.ps1` 会自己遍历 profile 目录跑 `dsh plugin --profile <name> install` 把插件装回来；找不到 `dsh` 命令才需要你手动来一遍。
- profile 里插件的 `package.json` 用的是**绝对路径** `file:` 依赖（本机实测写成了乱码路径），换盘符后这些 `file:` 会失效 —— 需要在 profile 里改成相对路径或改成已发布版本，再 `pnpm install`。聊天记录、记忆等数据不受影响。
- 浏览器弹不出系统文件选择框，导出用的是「文本框填路径 + 复制」。
