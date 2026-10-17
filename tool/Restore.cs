using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

namespace DshBackupAssistant
{
    /// <summary>
    /// 备份导入（换机那一步）与 EXE 自身的迁移。
    ///
    /// 两个"写"的动作都在这里，因为它们共用一个前提：先关掉 DSH。
    /// 开着 DSH 写回 sessions 会得到半个文件、node_modules 会被占用，这类损坏事后没法补。
    /// </summary>
    internal static class Restore
    {
        /// <summary>
        /// 正在被占用的数据目录吗？往运行中的 DSH 数据目录里写，等于自毁。
        /// 只在写默认数据根时才查进程：显式设了 DSH_DATA_DIR 的话，那不是这个 DSH 在用的目录。
        /// </summary>
        public static bool DshRunning()
        {
            if (App.DataRoot != App.DefaultDataRoot) return false;
            try
            {
                var names = Process.GetProcessesByName("DeepSeek Harness");
                foreach (var p in names)
                {
                    p.Dispose();
                    return true;
                }
                foreach (var p in Process.GetProcessesByName("dsh"))
                {
                    p.Dispose();
                    return true;
                }
                return false;
            }
            catch (Exception error)
            {
                Log.Write("warn", "检测进程失败：" + error.Message);
                return false;
            }
        }

        public sealed class Plan
        {
            public string File = "";
            public Manifest Manifest;
            public string[] Targets = new string[0];
            public string[] Existing = new string[0];
            public long Bytes;
            public bool WillOverwrite;
        }

        /// <summary>导入前先看清楚要覆盖什么——二次确认框里要显示的就是这份清单。</summary>
        public static Plan Analyze(string file)
        {
            var manifest = BackupFile.Inspect(file);
            var plan = new Plan
            {
                File = file,
                Manifest = manifest,
                Targets = manifest.TargetPaths(),
                Bytes = BackupFile.Size(file),
            };
            var root = App.DataRoot;
            plan.Existing = plan.Targets.Where((rel) =>
            {
                var full = Path.Combine(root, rel);
                return Directory.Exists(full) || File.Exists(full);
            }).ToArray();
            plan.WillOverwrite = plan.Existing.Length > 0;
            // 空间不够就在这一步拒掉：等用户点完确认、旧数据都挪走了才发现写不下，回滚代价太大。
            EnsureSpace(plan, root, "数据目录");
            return plan;
        }

        /// <summary>
        /// 落盘前先算要多少地方：有 unpackedBytes 就用真数；老备份没有这个字段，退回按归档大小 ×2.5 估
        /// （聊天记录和附件多是文本、压缩比高，估小了会写到一半才发现盘满）。最后再留 10% 给临时文件与文件系统开销。
        /// </summary>
        public static long RequiredBytes(long unpackedBytes, long archiveBytes)
        {
            long raw = unpackedBytes > 0 ? unpackedBytes : (long)Math.Ceiling(archiveBytes * 2.5);
            return (long)Math.Ceiling(raw * 1.1);
        }

        public static long RequiredBytes(Plan plan)
        {
            return RequiredBytes(plan.Manifest == null ? 0 : plan.Manifest.UnpackedBytes, plan.Bytes);
        }

        /// <summary>
        /// 目标路径所在卷的可用字节，查不到返回 -1。
        /// 查不到不拦人：UNC 共享、盘符还没挂上都会抛，那种情况宁可少查一次也要让还原继续。
        /// </summary>
        public static long FreeBytes(string dir)
        {
            try
            {
                var root = Path.GetPathRoot(Path.GetFullPath(dir));
                if (string.IsNullOrEmpty(root)) return -1;
                var drive = new DriveInfo(root);
                return drive.IsReady ? drive.AvailableFreeSpace : -1;
            }
            catch (Exception error)
            {
                Log.Write("warn", "查不到 " + dir + " 所在盘的可用空间，跳过空间检查：" + error.Message);
                return -1;
            }
        }

        /// <summary>空间不够就地抛，一个文件都不写。</summary>
        public static void EnsureSpace(Plan plan, string targetDir, string what)
        {
            long need = RequiredBytes(plan);
            long free = FreeBytes(targetDir);
            if (free < 0) return;
            if (free < need)
            {
                var message = "目标盘空间不足（" + what + "：" + targetDir + "）：需要约 "
                    + BackupFile.DescribeSize(need) + " / 可用 " + BackupFile.DescribeSize(free)
                    + "，请清理磁盘或换个数据目录。";
                Log.Write("error", message);
                throw new IOException(message);
            }
            Log.Write("info", "空间检查通过：" + what + " 需要约 " + BackupFile.DescribeSize(need)
                + "，可用 " + BackupFile.DescribeSize(free));
        }

        /// <summary>
        /// 直写模式：解包进数据目录。覆盖已有内容（不删多余文件——删要人确认，插件那边也是这个取舍）。
        /// 覆盖前先把要覆盖的顶层项挪到数据根下的 .pre-restore-&lt;时间戳&gt;\，解包成功才删；
        /// 中途失败就把它们挪回来——原来那几个目录一个都不许丢。
        /// </summary>
        public static void Apply(Plan plan)
        {
            if (DshRunning())
            {
                throw new IOException("检测到 DSH 还在运行。请完全退出 DSH（含托盘图标）后再导入，否则可能写坏数据。");
            }
            var root = App.DataRoot;
            // 校验之后盘上可能又塞满了，落盘前再确认一次（这一步还不写任何文件）。
            EnsureSpace(plan, root, "数据目录");
            Log.Write("info", "开始导入 " + plan.File + " → " + root
                + "（覆盖：" + string.Join("、", plan.Existing) + "）");
            Directory.CreateDirectory(root);
            var stash = FreshStashDir(root);
            var moved = new List<string>();
            try
            {
                foreach (var rel in plan.Targets)
                {
                    var from = Path.Combine(root, rel);
                    if (!Directory.Exists(from) && !File.Exists(from)) continue;
                    Directory.CreateDirectory(stash);
                    var to = Path.Combine(stash, Path.GetFileName(rel));
                    Move(from, to);
                    moved.Add(rel);
                    Log.Write("info", "覆盖前旁路保存 " + rel + " → " + to);
                }
                BackupFile.ExtractTo(plan.File, root, plan.Manifest);
            }
            catch
            {
                Log.Write("error", "导入失败，回滚 " + string.Join("、", moved));
                // 先清掉这次可能解了一半的内容，再把旁路保存的挪回来。
                foreach (var rel in plan.Targets) TryRemove(Path.Combine(root, rel));
                foreach (var rel in moved)
                {
                    try { Move(Path.Combine(stash, Path.GetFileName(rel)), Path.Combine(root, rel)); }
                    catch (Exception rollbackError) { Log.Write("error", "回滚 " + rel + " 失败：" + rollbackError.Message); }
                }
                TryRemove(stash);
                throw;
            }
            TryRemove(stash);
            Log.Write("info", "导入完成，已还原：" + string.Join("、", plan.Targets));
        }

        /// <summary>旁路目录名：同一秒内重试也不撞车。</summary>
        private static string FreshStashDir(string root)
        {
            var stem = ".pre-restore-" + Stamp();
            var dir = Path.Combine(root, stem);
            for (var n = 2; Directory.Exists(dir); n++) dir = Path.Combine(root, stem + "-" + n);
            return dir;
        }

        private static void Move(string from, string to)
        {
            if (Directory.Exists(from)) Directory.Move(from, to);
            else File.Move(from, to);
        }

        /// <summary>ponytail: 递归删，不做 junction 甄别——这里删的都是刚解出来的内容，不是用户的 node_modules。</summary>
        private static void TryRemove(string path)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
                else if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception error)
            {
                Log.Write("warn", "清理 " + path + " 失败：" + error.Message);
            }
        }

        /// <summary>暂存模式：解到备份目录下的 .restore-&lt;时间戳&gt;\，写一份 restore.ps1，人工看过再跑。</summary>
        public static string RestoreStaged(Plan plan)
        {
            // 暂存区就在备份目录下，同样得先看地方够不够——解到一半没地方比不解更糟。
            EnsureSpace(plan, App.StoreDir, "暂存目录");
            var dir = Path.Combine(App.StoreDir, ".restore-" + Stamp());
            Directory.CreateDirectory(dir);
            Log.Write("info", "解包到暂存区 " + dir);
            BackupFile.ExtractTo(plan.File, dir, plan.Manifest);
            // 带 BOM：Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI(GBK) 读，
            // 中文注释和字符串会被拆散，直接 ParserError。少个 BOM 脚本就跑不起来。
            File.WriteAllText(Path.Combine(dir, "restore.ps1"), RestoreScript(dir, plan.Manifest, App.DataRoot), new UTF8Encoding(true));
            return dir;
        }

        private static string Stamp()
        {
            var now = DateTime.Now;
            return now.ToString("yyyyMMdd-HHmmss");
        }

        /// <summary>
        /// 暂存模式的手工脚本。逻辑与插件生成的 restore.ps1 同源，但用 PowerShell 原生
        /// 而不是逐行拼 tar 命令——一个能直接 double-click 跑的脚本，容错比省几行重要。
        /// </summary>
        private static string RestoreScript(string dir, Manifest manifest, string target)
        {
            var names = manifest.TargetPaths();
            var quoted = names.Select((n) => "  '" + n.Replace("'", "''") + "'").ToArray();
            var lines = new List<string>
            {
                "# 由 DSH 备份助手生成：把暂存区的内容写回 DSH 数据目录。",
                "# 用法：右键本文件 → 使用 PowerShell 运行；或 powershell -ExecutionPolicy Bypass -File \"" + Path.Combine(dir, "restore.ps1") + "\"",
                "#",
                "# 数据目录：" + target,
                "# 备份时间：" + BackupFile.DescribeTime(manifest.CreatedAt),
                "# 备份内容：" + (manifest.Items.Length == 0 ? "（空）" : string.Join("、", manifest.Items)),
                "#",
                "# 先完全退出 DSH 再执行。node_modules 没打进包里，需要的话脚本最后会提示怎么装回来。",
                "$ErrorActionPreference = 'Stop'",
                "$src = '" + dir.Replace("'", "''") + "'",
                "$dst = '" + target.Replace("'", "''") + "'",
                "",
                "foreach ($name in @(",
            };
            lines.AddRange(quoted);
            lines.AddRange(new[]
            {
                ")) {",
                "  $from = Join-Path $src $name",
                "  if (-not (Test-Path $from)) { continue }",
                "  $to = Join-Path $dst $name",
                "  if ((Get-Item $from).PSIsContainer) {",
                "    New-Item -ItemType Directory -Force -Path $to | Out-Null",
                "    Copy-Item -Path (Join-Path $from '*') -Destination $to -Recurse -Force",
                "  } else {",
                "    # 单文件单元（.credentials.yaml）：源是文件时 Join-Path $from '*' 通配不到任何东西，",
                "    # Copy-Item 会静默复制 0 个文件，只留一个同名空目录——凭据就这么没了，还不报错。",
                "    Copy-Item -Path $from -Destination $to -Force",
                "  }",
                "  Write-Host \"已还原 $name\"",
                "}",
                "",
                "# node_modules 不在包里。装回依赖需要在 DSH 终端里执行：",
                "#   dsh plugin --profile <profile 名> install",
                "Write-Host '全部完成。建议重启 DSH 后检查设置页。' -ForegroundColor Green",
                "",
            });
            return string.Join("\r\n", lines);
        }

        /// <summary>
        /// EXE 搬家：备份位置改了就把助手复制过去，让它永远和备份同目录。
        /// 用复制不用移动——原位置那份还能当退路；同名默认加 -2 序号，不覆盖未知文件。
        /// </summary>
        public static string CopySelf(string targetDir)
        {
            var from = App.SelfPath;
            Directory.CreateDirectory(targetDir);
            var name = Path.GetFileName(from);
            var to = Path.Combine(targetDir, name);
            if (string.Equals(Path.GetFullPath(to), Path.GetFullPath(from), StringComparison.OrdinalIgnoreCase))
            {
                return to;
            }
            if (File.Exists(to))
            {
                to = UniquePath(to);
            }
            File.Copy(from, to, false);
            Log.Write("info", "已把助手复制到 " + to);
            return to;
        }

        public static string UniquePath(string path)
        {
            var dir = Path.GetDirectoryName(path);
            var stem = Path.GetFileNameWithoutExtension(path);
            var ext = Path.GetExtension(path);
            for (var n = 2; ; n++)
            {
                var candidate = Path.Combine(dir, stem + "-" + n + ext);
                if (!File.Exists(candidate)) return candidate;
            }
        }

        /// <summary>备份目录不存在就建一个；返回给 GUI 用的完整路径。</summary>
        public static string EnsureStoreDir(string dir)
        {
            Directory.CreateDirectory(dir);
            return dir;
        }
    }
}
