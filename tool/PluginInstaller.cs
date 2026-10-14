using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
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

        /// <summary>像不像 DSH 安装目录：resources\app.asar + resources\runtime\pnpm + 版本文件，三者齐全才算。</summary>
        public static bool IsInstallDir(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            try
            {
                return File.Exists(Path.Combine(dir, "resources", "app.asar"))
                    && Directory.Exists(Path.Combine(dir, "resources", "runtime", "pnpm"))
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
            // 2) dependencies 里加 "dsh-backup-migrator": "file:<exe 所在目录的插件解压目录>"
            if (!Regex.IsMatch(json, "\"" + PluginId + "\"\\s*:"))
            {
                var deps = new Regex("(\"dependencies\"\\s*:\\s*\\{)", RegexOptions.Singleline);
                json = deps.Replace(json, "$1\n    \"" + PluginId + "\": \"file:" + ToPosix(App.PayloadDir) + "\",", 1);
            }
            return json;
        }

        /// <summary>file: spec 用正斜杠并去掉尾分隔符；尾分隔符会让 pnpm 解析出两个不同的目录。</summary>
        public static string ToPosix(string path)
        {
            return path.Replace('\\', '/').TrimEnd('/');
        }
    }
}
