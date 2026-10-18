using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DshBackupAssistant
{
    /// <summary>manifest 字段。字段名与插件 lib/backup.js 写出的完全一致，改一边就要改另一边。</summary>
    internal sealed class Manifest
    {
        public string Plugin = "";
        public string PluginVersion = "";
        public int Schema;
        public string CreatedAt = "";
        public string Format = "zip";
        /// <summary>备份那台机器的 DSH 版本，探不到就是空串。老备份没有这个字段。</summary>
        public string Dsh = "";
        public string SourceRoot = "";
        public string Profile = "";
        public string[] Items = new string[0];
        public int ExpectedFiles;
        /// <summary>解压后的原始字节数，还原前按它做空间检查。老备份没有这个字段（= 0），回退到按包大小估。</summary>
        public long UnpackedBytes;
        public string[] Missing = new string[0];
        public string Note = "";

        public static Manifest Parse(string json)
        {
            using (var doc = JsonDocument.Parse(json))
            {
                var root = doc.RootElement;
                var m = new Manifest
                {
                    Plugin = Str(root, "plugin"),
                    PluginVersion = Str(root, "pluginVersion"),
                    Schema = root.TryGetProperty("schema", out var s) && s.TryGetInt32(out var n) ? n : 0,
                    CreatedAt = Str(root, "createdAt"),
                    Format = Str(root, "format") ?? "zip",
                    Dsh = Str(root, "dsh") ?? "",
                    SourceRoot = Str(root, "sourceRoot"),
                    Profile = Str(root, "profile"),
                    Items = Arr(root, "items"),
                    ExpectedFiles = root.TryGetProperty("expectedFiles", out var e) && e.TryGetInt32(out var c) ? c : 0,
                    // 缺失或类型不对都当 0：老备份没有这个字段，0 表示「按包大小估」。
                    // 必须先看 ValueKind——TryGetInt64 拿到非 Number 会抛 InvalidOperationException，不是返回 false。
                    UnpackedBytes = root.TryGetProperty("unpackedBytes", out var u)
                        && u.ValueKind == JsonValueKind.Number && u.TryGetInt64(out var b) ? b : 0,
                    Missing = Arr(root, "missing"),
                    Note = Str(root, "note"),
                };
                return m;
            }
        }

        private static string Str(JsonElement root, string name)
        {
            return root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        }

        private static string[] Arr(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Array) return new string[0];
            return v.EnumerateArray().Where((x) => x.ValueKind == JsonValueKind.String)
                .Select((x) => x.GetString()).ToArray();
        }

        /// <summary>归档里勾了哪些内容 → 数据根下的相对路径（.credentials.yaml 是文件，其余是目录）。</summary>
        public string[] TargetPaths()
        {
            return Items.Select((id) => BackupFile.ItemPath(id)).Where((p) => p != null).ToArray();
        }
    }

    /// <summary>
    /// 备份文件这一层：认出备份、读 manifest、列条目、解包。
    /// 归档格式与插件 lib/backup.js 一致（bsdtar 写的 zip / tar.gz），所以这里也调系统 tar。
    /// </summary>
    internal static class BackupFile
    {
        public const string ManifestName = "dsh-backup-manifest.json";
        public const string PluginId = "dsh-backup-migrator";
        /// <summary>插件认识的备份单元 → 数据根下的相对路径。换插件版本时这里跟着改。</summary>
        public const int Schema = 1;

        private static readonly Regex NamePattern =
            new Regex(@"^dsh-backup-.+(\.zip|\.tar\.gz)$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private static readonly Dictionary<string, string> ItemPaths = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "sessions", "sessions" },
            { "attachments", "attachments" },
            { "memories", "memories" },
            { "storages", "storages" },
            { "integrations", "integrations" },
            { "profiles", "profiles" },
            { "guardian", "guardian" },
            { "im", "im" },
            { "market", "dsh-market" },
            { "credentials", ".credentials.yaml" },
        };

        private static readonly Dictionary<string, string> ItemLabels = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "sessions", "聊天记录" },
            { "attachments", "附件" },
            { "memories", "长期记忆" },
            { "storages", "存储与状态" },
            { "integrations", "集成配置" },
            { "profiles", "插件与 profile 配置" },
            { "guardian", "启动自愈记录" },
            { "im", "IM 渠道配置" },
            { "market", "插件市场数据（含登录态）" },
            { "credentials", "凭据 .credentials.yaml（敏感）" },
        };

        /// <summary>本工具认识的备份项 id（自检里拿去和插件源码对账）。</summary>
        public static string[] ItemIds
        {
            get { return ItemPaths.Keys.ToArray(); }
        }

        public static string ItemPath(string id)
        {
            return id != null && ItemPaths.TryGetValue(id, out var p) ? p : null;
        }

        public static string ItemLabel(string id)
        {
            return id != null && ItemLabels.TryGetValue(id, out var p) ? p : (id ?? "?");
        }

        public static bool IsBackupName(string name)
        {
            return name != null && NamePattern.IsMatch(name);
        }

        public static string FormatOf(string file)
        {
            return file != null && file.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase) ? "tgz" : "zip";
        }

        public static long Size(string file)
        {
            try { return new FileInfo(file).Length; } catch { return 0; }
        }

        /// <summary>目录里的备份，最新的在前。index.json 只是插件的缓存，这里不依赖它——丢了也能用。</summary>
        public static List<string> List(string dir)
        {
            var rows = new List<string>();
            if (!Directory.Exists(dir)) return rows;
            foreach (var path in Directory.GetFiles(dir))
            {
                var name = Path.GetFileName(path);
                if (!IsBackupName(name)) continue;
                rows.Add(path);
            }
            rows.Sort((a, b) => string.CompareOrdinal(Path.GetFileName(b), Path.GetFileName(a)));
            return rows;
        }

        private static string[] ExtractArgs(string file, params string[] rest)
        {
            var head = FormatOf(file) == "tgz" ? new[] { "-xzf", file } : new[] { "-xf", file };
            return head.Concat(rest).ToArray();
        }

        private static string TarOut(string[] args)
        {
            var psi = new ProcessStartInfo("tar", Quote(args))
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = new UTF8Encoding(false),
            };
            using (var proc = Process.Start(psi))
            {
                // 两个管道都必须在等退出之前就开始读：先 ReadToEnd(stdout) 再读 stderr，
                // stderr 那 4KB 缓冲一满子进程就卡在写，父进程卡在读，双方永久挂死。
                var output = new StringBuilder();
                var error = new StringBuilder();
                proc.OutputDataReceived += (s, x) => { if (x.Data != null) output.AppendLine(x.Data); };
                proc.ErrorDataReceived += (s, x) => { if (x.Data != null) error.AppendLine(x.Data); };
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                proc.WaitForExit();   // 无参重载会等两个异步读取都收到 EOF 才返回
                if (proc.ExitCode != 0)
                {
                    throw new IOException("tar 退出码 " + proc.ExitCode + "：" + (error.ToString().Trim().Split('\n')[0] ?? "无输出"));
                }
                return output.ToString();
            }
        }

        /// <summary>逐个加引号：路径里有空格/中文/括号时，ProcessStartInfo 不加引号会被拆成两个参数。</summary>
        private static string Quote(IEnumerable<string> args)
        {
            return string.Join(" ", args.Select((a) => "\"" + a.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""));
        }

        /// <summary>
        /// 完整性的第一道门：只信内容不信文件名。manifest 读不出来 / 不是本插件的 / 来自更新版本，一律拒绝。
        /// </summary>
        public static Manifest ReadManifest(string file)
        {
            if (!File.Exists(file)) throw new FileNotFoundException("备份文件不存在：" + file, file);
            string text;
            try
            {
                text = TarOut(ExtractArgs(file, "-xOf", file, "./" + ManifestName));
            }
            catch (Exception error)
            {
                throw new IOException("这个文件解不开，里面没有可读的 " + ManifestName + "：" + Log.Friendly(error), error);
            }
            Manifest manifest;
            try
            {
                manifest = Manifest.Parse(text);
            }
            catch (Exception error)
            {
                throw new IOException("manifest 不是合法 JSON：" + Log.Friendly(error), error);
            }
            if (manifest.Plugin != PluginId) throw new IOException("这个文件不是 " + PluginId + " 的备份");
            if (manifest.Schema > Schema)
            {
                throw new IOException("备份来自更新版本的插件（manifest schema " + manifest.Schema
                    + " > 本工具认识的 " + Schema + "），请先换新版助手 EXE 再导入");
            }
            return manifest;
        }

        /// <summary>归档条目名（./sessions/... 这种）。越界的条目直接拒绝，不给后面挖坑的机会。</summary>
        public static string[] Entries(string file)
        {
            var args = FormatOf(file) == "tgz"
                ? new[] { "-tzf", file }
                : new[] { "-tf", file };
            var rows = TarOut(args)
                .Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries)
                .Select((x) => x.Trim())
                .Where((x) => x != "")
                .ToArray();
            var bad = rows.FirstOrDefault((name) => name.StartsWith("/")
                || name.Contains("../") || name == ".." || name.Contains("..\\")
                || (name.Length > 1 && name[1] == ':'));
            if (bad != null) throw new IOException("归档里有越界路径，已拒绝还原：" + bad);
            return rows;
        }

        /// <summary>
        /// 完整性的第二道门：勾选的每一项都得真在归档里。缺一项说明包被截断或人工动过。
        /// </summary>
        public static Manifest Inspect(string file)
        {
            var manifest = ReadManifest(file);
            var entries = Entries(file);
            var missing = new List<string>();
            foreach (var id in manifest.Items)
            {
                var rel = ItemPath(id);
                if (rel == null) { missing.Add(id + "（不认识的内容）"); continue; }
                bool hit = entries.Any((name) => name.StartsWith("./" + rel, StringComparison.Ordinal));
                if (!hit) missing.Add(ItemLabel(id));
            }
            if (missing.Count > 0)
            {
                throw new IOException("归档里缺少：" + string.Join("、", missing) + "。文件可能不完整，先别导入。");
            }
            RejectExtra(manifest, entries);
            return manifest;
        }

        /// <summary>
        /// 完整性的第三道门：归档里不能有清单之外的顶层条目。多出来的条目会原样落到数据根下，
        /// 等于让备份包往 DSH 数据目录里塞任意文件，所以直接拒收、不落盘。
        /// </summary>
        private static void RejectExtra(Manifest manifest, IEnumerable<string> entries)
        {
            var allowed = new HashSet<string>(manifest.TargetPaths(), StringComparer.OrdinalIgnoreCase);
            foreach (var name in entries)
            {
                var rel = (name.StartsWith("./", StringComparison.Ordinal) ? name.Substring(2) : name).TrimEnd('/');
                if (rel.Length == 0 || rel == ManifestName) continue;
                var top = rel.Split('/')[0];
                if (allowed.Contains(top)) continue;
                throw new IOException("归档里有备份清单之外的条目，已拒绝还原：" + name);
            }
        }

        /// <summary>解到目标目录（不含 manifest）。解之前再核一遍条目白名单。</summary>
        public static void ExtractTo(string file, string targetDir, Manifest manifest)
        {
            RejectExtra(manifest, Entries(file));
            Directory.CreateDirectory(targetDir);
            TarOut(ExtractArgs(file, "--exclude=./" + ManifestName, "-C", targetDir));
        }

        public static string DescribeSize(long bytes)
        {
            double mb = bytes / 1024.0 / 1024.0;
            if (mb < 1) return (bytes / 1024.0).ToString("0.0", CultureInfo.InvariantCulture) + " KB";
            if (mb < 1024) return mb.ToString("0.0", CultureInfo.InvariantCulture) + " MB";
            return (mb / 1024.0).ToString("0.00", CultureInfo.InvariantCulture) + " GB";
        }

        public static string DescribeTime(string iso)
        {
            if (DateTime.TryParse(iso, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d))
            {
                return d.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
            }
            return iso == "" ? "未知时间" : iso;
        }
    }
}
