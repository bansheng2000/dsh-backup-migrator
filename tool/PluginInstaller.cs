using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace DshBackupAssistant
{
    /// <summary>
    /// 装 DSH 这一侧的发现与安装。
    ///
    /// ponytail: 插件本体只有 3 个 lib 文件 + patch + package.json，加依赖也只有 schemastery 一棵小树
    /// （8 个文件 / 118KB），所以「安装」= 把这几个文件拷到 profile 的 node_modules 并改 package.json，
    /// 不去复刻 pnpm 的 lockfile / 虚拟store。真要严格复现得把 pnpm 也塞进 EXE，代价与收益不成比例。
    /// 装完 DSH 自己的 plugin-manager 仍会校验依赖，缺什么会报缺什么。
    /// </summary>
    internal static class PluginInstaller
    {
        public const string PluginId = "dsh-backup-migrator";
        private const string Marker = "dsh.profile.bundles";

        /// <summary>要拷的文件（相对插件根）。与插件 package.json 的 files 字段同源。</summary>
        private static readonly string[] PluginFiles =
        {
            "package.json", "cordis.patch.yml", "README.md",
            "lib/index.js", "lib/backup.js", "lib/client.js",
        };

        public sealed class DshLocation
        {
            public string InstallDir = "";
            public string Version = "";
            public string Source = "";
            public bool Usable => IsInstallDir(InstallDir);
        }

        /// <summary>
        /// 找 DSH：注册表优先（最准），再退回常见安装路径。返回第一条可用的。
        /// </summary>
        public static DshLocation Detect()
        {
            foreach (var row in RegistryScan())
            {
                var loc = new DshLocation { InstallDir = row.InstallLocation, Version = row.DisplayVersion, Source = "注册表" };
                if (loc.Usable) return loc;
            }
            foreach (var candidate in CommonDirs())
            {
                if (IsInstallDir(candidate))
                {
                    return new DshLocation { InstallDir = candidate, Version = VersionOf(candidate), Source = "常见安装路径" };
                }
            }
            return new DshLocation { InstallDir = "", Version = "", Source = "未检测到" };
        }

        private sealed class RegRow
        {
            public string DisplayName;
            public string DisplayVersion;
            public string InstallLocation;
        }

        private static IEnumerable<RegRow> RegistryScan()
        {
            // 不引 Microsoft.Win32.Registry 之外的依赖；三个 hive 用反射读，64/32 位都能命中。
            var rows = new List<RegRow>();
            foreach (var hive in new[] { "HKEY_LOCAL_MACHINE", "HKEY_CURRENT_USER" })
            {
                foreach (var sub in new[]
                {
                    @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                    @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
                })
                {
                    string full = hive + @"\" + sub;
                    Microsoft.Win32.RegistryKey root = null;
                    try
                    {
                        root = hive == "HKEY_LOCAL_MACHINE"
                            ? Microsoft.Win32.Registry.LocalMachine.OpenSubKey(sub)
                            : Microsoft.Win32.Registry.CurrentUser.OpenSubKey(sub);
                    }
                    catch (Exception error)
                    {
                        Log.Write("warn", "读注册表 " + full + " 失败：" + error.Message);
                    }
                    if (root == null) continue;
                    using (root)
                    {
                        foreach (var name in root.GetSubKeyNames())
                        {
                            using (var item = root.OpenSubKey(name))
                            {
                                string display = item?.GetValue("DisplayName") as string;
                                if (display == null || display.IndexOf("DeepSeek", StringComparison.OrdinalIgnoreCase) < 0) continue;
                                rows.Add(new RegRow
                                {
                                    DisplayName = display,
                                    DisplayVersion = item.GetValue("DisplayVersion") as string ?? "",
                                    InstallLocation = item.GetValue("InstallLocation") as string ?? "",
                                });
                            }
                        }
                    }
                }
            }
            return rows;
        }

        private static IEnumerable<string> CommonDirs()
        {
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DeepSeek Harness");
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DeepSeek Harness");
            var x86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            if (!string.IsNullOrEmpty(x86)) yield return Path.Combine(x86, "DeepSeek Harness");
            var programFiles2 = Environment.GetEnvironmentVariable("ProgramW6432");
            if (!string.IsNullOrEmpty(programFiles2)) yield return Path.Combine(programFiles2, "DeepSeek Harness");
        }

        /// <summary>
        /// 像不像 DSH 安装目录：resources\app.asar + resources\app.asar.unpacked 齐全就算。
        /// 别拿 resources\runtime\pnpm 当判据——0.2.1 起没这个目录了（pnpm 挪进 primary-runtime\dependencies），
        /// 用它当条件会把新版本机器上的目录一律拒掉。app.asar.unpacked 两代都有，够区分真安装目录。
        /// </summary>
        public static bool IsInstallDir(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            try
            {
                return File.Exists(Path.Combine(dir, "resources", "app.asar"))
                    && Directory.Exists(Path.Combine(dir, "resources", "app.asar.unpacked"));
            }
            catch
            {
                return false;
            }
        }

        private static string VersionOf(string dir)
        {
            try
            {
                var text = File.ReadAllText(Path.Combine(dir, "version"));
                return Regex.Replace(text.Trim(), "\\s+", "");
            }
            catch
            {
                return "";
            }
        }

        public static string DataRoot => App.DataRoot;

        public static string ProfilesDir => Path.Combine(DataRoot, "profiles");

        public static IEnumerable<string> Profiles()
        {
            if (!Directory.Exists(ProfilesDir)) return new string[0];
            return Directory.GetDirectories(ProfilesDir)
                .OrderBy((x) => x, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        /// <summary>把插件装进某个 profile。会改写 package.json，所以先备份一份。</summary>
        public static InstallResult Install(string installDir, string profileName)
        {
            var result = new InstallResult();
            if (!IsInstallDir(installDir))
            {
                throw new DirectoryNotFoundException("选中的目录不像 DSH 安装目录（缺 resources\\app.asar）：" + installDir);
            }
            if (!Directory.Exists(Path.Combine(ProfilesDir, profileName)))
            {
                throw new DirectoryNotFoundException("数据目录里没有这个 profile：" + profileName);
            }
            var profile = Path.Combine(ProfilesDir, profileName);
            var target = Path.Combine(profile, "node_modules", PluginId);
            Log.Write("info", "安装 " + PluginId + " → " + target);

            // 插件源码现在住在数据根下的稳定目录里，而数据根是运行时才定的：
            // 先确保它在那儿（换过数据根、或被谁删了都能自愈），再往下拷。
            string payloadProblem = null;
            App.EnsurePayload(out payloadProblem);
            if (payloadProblem != null) throw new IOException(payloadProblem);

            Directory.CreateDirectory(target);
            foreach (var rel in PluginFiles)
            {
                var from = Path.Combine(App.PayloadDir, rel);
                if (!File.Exists(from))
                {
                    throw new FileNotFoundException("助手 EXE 里缺少插件文件：" + rel + "（EXE 可能损坏了）");
                }
                var to = Path.Combine(target, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(to));
                File.Copy(from, to, true);
            }

            // package.json：往 dependencies 与 bundles 里补两处，两处都得有，缺一个插件都不会挂载。
            var manifestPath = Path.Combine(profile, "package.json");
            var packageJson = File.ReadAllText(manifestPath);
            var saved = manifestPath + ".dshbackupbak";
            File.WriteAllText(saved, packageJson, new UTF8Encoding(false));
            var updated = PatchPackageJson(packageJson, installDir);
            File.WriteAllText(manifestPath, updated, new UTF8Encoding(false));
            result.ProfilePackageJson = manifestPath;
            result.Backup = saved;
            Log.Write("info", "已改 " + manifestPath + "（原文件备份在 " + saved + "）");
            return result;
        }

        public sealed class InstallResult
        {
            public string ProfilePackageJson = "";
            public string Backup = "";
        }

        /// <summary>
        /// 在 JSON 文本里补两处，尽量少解析：正则找不到就老实报错，不要写半截文件。
        /// </summary>
        private static string PatchPackageJson(string json, string installDir)
        {
            // 1) bundles 数组里加插件名（顶层扁平 - id: 形态无效，这里必须是包名）
            if (!Regex.IsMatch(json, "\"" + PluginId + "\""))
            {
                var bundles = new Regex(@"(""dsh""\s*:\s*\{.*?""bundles""\s*:\s*\[)", RegexOptions.Singleline);
                if (!bundles.IsMatch(json))
                {
                    throw new InvalidDataException("profile package.json 里找不到 dsh.profile.bundles 数组，装不了（请确认这是 DSH 的 profile 目录）");
                }
                json = bundles.Replace(json, "$1\n        \"" + PluginId + "\",", 1);
            }
            if (!Regex.IsMatch(json, "\"dependencies\""))
            {
                throw new InvalidDataException("profile package.json 里找不到 dependencies，装不了");
            }
            // 2) dependencies 里加 "dsh-backup-migrator": "file:<数据根下那个稳定的插件解压目录>"
            if (!Regex.IsMatch(json, "\"" + PluginId + "\"\\s*:"))
            {
                var deps = new Regex("(\"dependencies\"\\s*:\\s*\\{)", RegexOptions.Singleline);
                json = deps.Replace(json, "$1\n    \"" + PluginId + "\": \"file:" + ToPosix(App.PayloadDir) + "\",", 1);
            }
            return json;
        }

        // ---- 卸载 ----

        /// <summary>改完写回时的格式：2 空格缩进（跟 profile 里原生那份一致），中文原样输出。</summary>
        private static readonly JsonSerializerOptions WriteOptions = new JsonSerializerOptions
        {
            WriteIndented = true,
            // 默认编码器会把中文转成 \uXXXX，改完 package.json 就没法读了。
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        /// <summary>
        /// 这份 package.json 是不是装了本插件：bundles 数组里有包名，或 dependencies 里有这个 key。
        /// 任一处命中就算——装的时候被打断会留下只登记了一半的文件，那种也得能卸掉。
        /// </summary>
        public static bool InstallsPlugin(string json)
        {
            JsonNode root;
            try { root = JsonNode.Parse(json); }
            catch { return false; }
            if (!(root is JsonObject obj)) return false;
            if (obj["dsh"] is JsonObject dsh && dsh["profile"] is JsonObject profile
                && profile["bundles"] is JsonArray bundles)
            {
                foreach (var item in bundles)
                {
                    if (item is JsonValue value && value.TryGetValue<string>(out var name) && name == PluginId) return true;
                }
            }
            return obj["dependencies"] is JsonObject dependencies && dependencies.ContainsKey(PluginId);
        }

        /// <summary>
        /// 扫 &lt;数据根&gt;\profiles\* 找装了本插件的那个 profile，找不到返回 null。
        /// 不按目录名猜——用户完全可能把它装进 desktop2 或自己起的名字，谁登记过就是谁。
        /// </summary>
        public static string FindInstalledProfile(string profilesDir)
        {
            if (!Directory.Exists(profilesDir)) return null;
            foreach (var dir in Directory.GetDirectories(profilesDir).OrderBy((x) => x, StringComparer.OrdinalIgnoreCase))
            {
                var manifest = Path.Combine(dir, "package.json");
                if (!File.Exists(manifest)) continue;
                try
                {
                    if (InstallsPlugin(File.ReadAllText(manifest))) return dir;
                }
                catch (Exception error)
                {
                    Log.Write("warn", "读 " + manifest + " 失败，跳过：" + error.Message);
                }
            }
            return null;
        }

        /// <summary>
        /// 从 package.json 文本里摘掉本插件（纯函数：给文本、还文本，落盘在 Uninstall 里做）。
        /// 两处都得摘：只摘 bundles，DSH 会按 dependencies 继续把它当插件；只摘 dependencies，
        /// 它会留在挂载列表里，启动时报「缺这个包」。
        /// </summary>
        public static string StripPackageJson(string json)
        {
            JsonObject root;
            try { root = JsonNode.Parse(json) as JsonObject; }
            catch (Exception error)
            {
                throw new InvalidDataException("profile 的 package.json 不是合法 JSON，卸载会写坏它，已中止：" + Log.Friendly(error), error);
            }
            if (root == null) throw new InvalidDataException("profile 的 package.json 不是 JSON 对象，卸载会写坏它，已中止");
            if (root["dsh"] is JsonObject dsh && dsh["profile"] is JsonObject profile
                && profile["bundles"] is JsonArray bundles)
            {
                // 倒着删：RemoveAt 之后后面的下标会前移。
                for (var i = bundles.Count - 1; i >= 0; i--)
                {
                    if (bundles[i] is JsonValue value && value.TryGetValue<string>(out var name) && name == PluginId)
                    {
                        bundles.RemoveAt(i);
                    }
                }
            }
            if (root["dependencies"] is JsonObject dependencies) dependencies.Remove(PluginId);
            return root.ToJsonString(WriteOptions);
        }

        public sealed class UninstallResult
        {
            public string Profile = "";
            public string PackageJson = "";
            public string Backup = "";
            public string NodeModules = "";
            public bool RemovedLink;
        }

        /// <summary>落盘那一层：备份 package.json → 改写 → 删插件目录。三步都走完才返回。</summary>
        public static UninstallResult Uninstall()
        {
            var result = new UninstallResult();
            var profile = FindInstalledProfile(ProfilesDir);
            if (profile == null)
            {
                throw new DirectoryNotFoundException("没找到装过本插件的 profile（扫的是 " + ProfilesDir + "）。");
            }
            var manifest = Path.Combine(profile, "package.json");
            // 先把新文本算出来再动文件：解析失败时一个字节都还没改。
            var updated = StripPackageJson(File.ReadAllText(manifest));
            var stem = manifest + ".bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var backup = stem;
            for (var n = 2; File.Exists(backup); n++) backup = stem + "-" + n;
            File.Copy(manifest, backup, false);
            Log.Write("info", "卸载前备份 " + manifest + " → " + backup);
            File.WriteAllText(manifest, updated, new UTF8Encoding(false));
            Log.Write("info", "已从 " + manifest + " 摘掉 " + PluginId);
            var target = Path.Combine(profile, "node_modules", PluginId);
            result.RemovedLink = RemovePluginDir(target);
            result.Profile = profile;
            result.PackageJson = manifest;
            result.Backup = backup;
            result.NodeModules = target;
            Log.Write("info", "卸载完成：" + profile);
            return result;
        }

        /// <summary>
        /// 删 &lt;profile&gt;\node_modules\包名。
        /// **先判 reparse point**：Windows 上对含 junction 的目录递归删会顺着链接删进目标里去
        /// （本机踩过：一次删掉了别处 node_modules 里 9 个插件包）。是链接就只删链接本身。
        /// 目录不存在返回 false（本来就没装，不算失败）。
        /// </summary>
        private static bool RemovePluginDir(string dir)
        {
            FileAttributes attributes;
            try { attributes = new DirectoryInfo(dir).Attributes; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                Directory.Delete(dir, false);
                Log.Write("info", "已删掉指向别处的链接（没有跟进去删目标）：" + dir);
                return true;
            }
            Directory.Delete(dir, true);
            Log.Write("info", "已删除插件目录：" + dir);
            return false;
        }

        /// <summary>file: spec 用正斜杠并去掉尾分隔符；尾分隔符会让 pnpm 解析出两个不同的目录。</summary>
        public static string ToPosix(string path)
        {
            return path.Replace('\\', '/').TrimEnd('/');
        }
    }
}
