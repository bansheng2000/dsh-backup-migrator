using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DshBackupAssistant
{
    /// <summary>
    /// 跑一遍不碰 UI 的关键逻辑，最小自检。用法：
    ///   DSH备份助手.exe --selftest [备份文件路径]
    /// 不带参数时会去备份目录里挑最新一份；一份都没有就只跑路径推导那几项。
    /// </summary>
    internal static class SelfTest
    {
        private static int _failed;

        private static void Check(string what, bool ok, string detail = null)
        {
            if (ok)
            {
                Console.WriteLine("  ok   " + what);
                return;
            }
            _failed += 1;
            Console.WriteLine("  FAIL " + what + (detail == null ? "" : " -> " + detail));
        }

        public static int Run(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine(App.Name + " " + App.Version + " 自检（EXE 目录 " + App.SelfDir + "）");

            Console.WriteLine("[路径推导]");
            // 单文件发布会把程序集解到 %TEMP%\\.net\\...；那个路径当目录用会把文件写进临时区。
            Check("EXE 目录不是 .net 解压目录",
                App.SelfDir.IndexOf("\\.net\\", StringComparison.OrdinalIgnoreCase) < 0, App.SelfDir);
            Check("EXE 目录存在", Directory.Exists(App.SelfDir), App.SelfDir);
            Check("数据根以 .dsh 结尾或已显式设置",
                App.DataRoot.EndsWith(".dsh", StringComparison.OrdinalIgnoreCase)
                || (Environment.GetEnvironmentVariable("DSH_DATA_DIR") ?? "").Trim() != "", App.DataRoot);
            Check("备份目录默认落在数据根下的 backups",
                App.DefaultStoreDir == Path.Combine(App.DataRoot, "backups"), App.DefaultStoreDir);
            Check("备份目录.txt 读出来的是绝对路径",
                App.ReadStoreDirFile() == null || Path.IsPathRooted(App.ReadStoreDirFile()));

            Console.WriteLine("[内嵌插件]");
            string problem = null;
            var payload = App.EnsurePayload(out problem);
            Check("内嵌插件解出来了", problem == null && File.Exists(Path.Combine(payload, "package.json")), problem);
            Check("内嵌插件含 lib/index.js", File.Exists(Path.Combine(payload, "lib", "index.js")));
            Check("内嵌插件含 cordis.patch.yml", File.Exists(Path.Combine(payload, "cordis.patch.yml")));

            Console.WriteLine("[备份项清单与插件同源]");
            // 助手和插件各存一份「备份项 id → 数据目录路径」的表，以前靠人肉同步。
            // 0.3.1 的 0.2.1 兼容提交给插件加了 market，助手没跟上 —— 含 market 的包
            // 会被 Inspect 判成「缺少：market（不认识的内容）」直接导不进来。
            // 这里从内嵌插件的 lib/backup.js 里把 ITEMS 抠出来逐项对账。
            var backupJs = Path.Combine(payload, "lib", "backup.js");
            if (!File.Exists(backupJs))
            {
                Check("内嵌插件里有 lib/backup.js 可以对账", false, backupJs);
            }
            else
            {
                var pairs = Regex.Matches(File.ReadAllText(backupJs),
                    "\\{\\s*id:\\s*\"([^\"]+)\"[^}]*?path:\\s*\"([^\"]+)\"");
                Check("从插件源码里解析出备份项清单", pairs.Count >= 9, pairs.Count.ToString());
                foreach (Match m in pairs)
                {
                    var id = m.Groups[1].Value;
                    var raw = m.Groups[2].Value;
                    var rel = raw.StartsWith("./") ? raw.Substring(2) : raw.TrimStart('/');
                    Check("助手认识插件备份项 " + id + " → " + rel, BackupFile.ItemPath(id) == rel,
                        "助手表里是 " + (BackupFile.ItemPath(id) ?? "（没有这一项）"));
                }
                var pluginIds = pairs.Cast<Match>().Select((m) => m.Groups[1].Value).ToArray();
                Check("助手没有插件不认识的备份项", BackupFile.ItemIds.All((id) => pluginIds.Contains(id)),
                    string.Join(",", BackupFile.ItemIds.Where((id) => !pluginIds.Contains(id))));
            }

            Console.WriteLine("[DSH 发现]");
            var loc = PluginInstaller.Detect();
            Console.WriteLine("  info 检测结果：" + (loc.Usable ? loc.InstallDir + "（" + loc.Source + "，版本 " + loc.Version + "）" : "未检测到"));
            Check("IsInstallDir 拒绝空路径", !PluginInstaller.IsInstallDir(""));
            Check("IsInstallDir 拒绝系统目录", !PluginInstaller.IsInstallDir(Environment.GetFolderPath(Environment.SpecialFolder.Windows)));
            Check("IsInstallDir 接受自己判出的路径", !loc.Usable || PluginInstaller.IsInstallDir(loc.InstallDir), loc.InstallDir);
            Check("没有 DSH 时 profiles 列举不炸", PluginInstaller.Profiles().Any() || !Directory.Exists(PluginInstaller.ProfilesDir));

            Console.WriteLine("[运行时布局：node / pnpm 定位]");
            // 0.2.1 把 resources\runtime\pnpm 挪进了 primary-runtime\dependencies，
            // 这里两种布局各造一棵假目录树——用假目录是因为真安装目录装在用户机器上、不能改。
            var layoutRoot = Path.Combine(Path.GetTempPath(), "dsh-assistant-layout-" + Guid.NewGuid().ToString("N"));
            try
            {
                var oldLayout = Path.Combine(layoutRoot, "old");
                Directory.CreateDirectory(Path.Combine(oldLayout, "resources", "runtime", "pnpm", "bin"));
                Directory.CreateDirectory(Path.Combine(oldLayout, "resources", "runtime", "node", "bin"));
                Directory.CreateDirectory(Path.Combine(oldLayout, "resources", "app.asar.unpacked"));
                File.WriteAllText(Path.Combine(oldLayout, "resources", "app.asar"), "stub");
                File.WriteAllText(Path.Combine(oldLayout, "resources", "runtime", "pnpm", "bin", "pnpm.cjs"), "stub");
                File.WriteAllText(Path.Combine(oldLayout, "resources", "runtime", "node", "bin", "node.exe"), "stub");

                var newLayout = Path.Combine(layoutRoot, "new");
                var deps = Path.Combine(newLayout, "resources", "runtime", "primary-runtime", "dependencies");
                Directory.CreateDirectory(Path.Combine(deps, "pnpm", "bin"));
                Directory.CreateDirectory(Path.Combine(deps, "node", "bin"));
                Directory.CreateDirectory(Path.Combine(newLayout, "resources", "app.asar.unpacked"));
                File.WriteAllText(Path.Combine(newLayout, "resources", "app.asar"), "stub");
                File.WriteAllText(Path.Combine(deps, "pnpm", "bin", "pnpm.cjs"), "stub");
                File.WriteAllText(Path.Combine(deps, "node", "bin", "node.exe"), "stub");

                Check("0.2.0 布局（runtime\\pnpm）被认成安装目录", PluginInstaller.IsInstallDir(oldLayout), oldLayout);
                Check("0.2.1 布局（无 runtime\\pnpm）也被认成安装目录", PluginInstaller.IsInstallDir(newLayout), newLayout);
                Check("0.2.1 布局下找得到 pnpm",
                    DepsInstaller.FindPnpm(newLayout) == Path.Combine(deps, "pnpm", "bin", "pnpm.cjs"),
                    DepsInstaller.FindPnpm(newLayout));
                Check("0.2.0 布局下找得到 pnpm",
                    DepsInstaller.FindPnpm(oldLayout) == Path.Combine(oldLayout, "resources", "runtime", "pnpm", "bin", "pnpm.cjs"),
                    DepsInstaller.FindPnpm(oldLayout));
                Check("0.2.1 布局下找得到 node",
                    DepsInstaller.FindNode(newLayout) == Path.Combine(deps, "node", "bin", "node.exe"),
                    DepsInstaller.FindNode(newLayout));
            }
            finally
            {
                try { if (Directory.Exists(layoutRoot)) Directory.Delete(layoutRoot, true); } catch { }
            }

            Console.WriteLine("[package.json 补丁]");
            var sample = "{\n  \"name\": \"p\",\n  \"dsh\": { \"profile\": { \"bundles\": [\n    \"a\"\n  ] } },\n  \"dependencies\": {\n    \"b\": \"1\"\n  }\n}\n";
            var patched = InvokePatch(sample);
            Check("补丁后 bundles 含插件名", patched != null && patched.Contains("\"" + App.PluginId + "\""), patched);
            Check("补丁后 dependencies 含 file: 指向插件目录",
                patched != null && patched.Contains("file:") && patched.Contains(App.PluginId), patched);
            Check("重复补丁不重复插入", patched != null && InvokePatch(patched) == patched);
            Check("非 profile 的 package.json 直接报错", InvokePatch("{}") == null);

            Console.WriteLine("[备份文件]");
            var file = args.Length > 0 ? args[0] : NewestBackup(App.StoreDir);
            if (file == null)
            {
                Console.WriteLine("  info 备份目录里没有备份文件，跳过解析自检");
            }
            else
            {
                Console.WriteLine("  info 用 " + file);
                try
                {
                    var manifest = BackupFile.Inspect(file);
                    Check("manifest 是本插件的", manifest.Plugin == App.PluginId, manifest.Plugin);
                    Check("schema 不超过本工具认识的值", manifest.Schema <= BackupFile.Schema, manifest.Schema.ToString());
                    Check("勾选项都能映射到路径", manifest.TargetPaths().Length == manifest.Items.Length,
                        manifest.TargetPaths().Length + "/" + manifest.Items.Length);
                    var plan = Restore.Analyze(file);
                    Check("导入计划里每个目标都有名有姓", plan.Targets.Length > 0);
                    Console.WriteLine("  info 将覆盖：" + (plan.Existing.Length == 0 ? "（无）" : string.Join("、", plan.Existing)));
                }
                catch (Exception error)
                {
                    // 自检不该被一份真实备份打死：记 FAIL 继续跑后面的项，退出码照样非 0。
                    Check("备份目录里最新那份能通过完整性检查", false, Log.Friendly(error));
                }
            }

            Console.WriteLine("[manifest 新字段]");
            // manifest 是插件写的、助手读的，两边字段名必须一致。造两份：新的带字段，老的没有。
            var current = Manifest.Parse("{\"plugin\":\"dsh-backup-migrator\",\"schema\":1,\"items\":[\"sessions\"],"
                + "\"dsh\":\"1.7.2\",\"unpackedBytes\":123456789}");
            Check("读到 dsh 版本", current.Dsh == "1.7.2", current.Dsh);
            Check("读到 unpackedBytes", current.UnpackedBytes == 123456789, current.UnpackedBytes.ToString());
            var legacy = Manifest.Parse("{\"plugin\":\"dsh-backup-migrator\",\"schema\":1}");
            Check("老备份没有这两个字段也不炸（dsh 空串、unpackedBytes 0）",
                legacy.Dsh == "" && legacy.UnpackedBytes == 0, legacy.Dsh + "/" + legacy.UnpackedBytes);
            var broken = Manifest.Parse("{\"plugin\":\"dsh-backup-migrator\",\"dsh\":\"\",\"unpackedBytes\":\"不是数字\"}");
            Check("unpackedBytes 类型不对当 0", broken.UnpackedBytes == 0, broken.UnpackedBytes.ToString());

            Console.WriteLine("[还原前空间检查]");
            Check("有 unpackedBytes 就按它算，再留 10% 余量",
                Restore.RequiredBytes(1000, 999999) == 1100, Restore.RequiredBytes(1000, 999999).ToString());
            Check("老备份按包大小 ×2.5 再留 10%",
                Restore.RequiredBytes(0, 1000) == 2750, Restore.RequiredBytes(0, 1000).ToString());
            var freeHere = Restore.FreeBytes(App.DataRoot);
            Check("查得到目标盘可用空间（查不到会静默跳过检查，那样这条自检就假绿了）", freeHere >= 0, freeHere.ToString());
            // 2^50 字节（1 PB）在任何机器上都装不下——用真实路径真跑一遍拒绝分支。
            var absurd = new Restore.Plan
            {
                File = Path.Combine(Path.GetTempPath(), "no-such-backup.zip"),
                Manifest = new Manifest { UnpackedBytes = 1L << 50 },
                Bytes = 1024,
            };
            var refused = false;
            string refusal = null;
            try { Restore.EnsureSpace(absurd, App.DataRoot, "数据目录"); }
            catch (Exception error) { refused = true; refusal = Log.Friendly(error); }
            Check("unpackedBytes 荒谬大时被拒", refused, refusal);
            Check("拒收文案给出需要/可用与清理建议",
                refusal != null && refusal.Contains("需要约") && refusal.Contains("可用") && refusal.Contains("清理"), refusal);

            Console.WriteLine("[卸载纯函数]");
            var installedJson = "{\n  \"name\": \"p\",\n  \"version\": \"1.0.0\",\n  \"dsh\": { \"profile\": { \"bundles\": [\n"
                + "    \"other-plugin\",\n    \"" + App.PluginId + "\"\n  ] } },\n  \"dependencies\": {\n"
                + "    \"other-plugin\": \"1\",\n    \"" + App.PluginId + "\": \"file:/x/y\"\n  },\n"
                + "  \"scripts\": { \"keep\": \"me\" }\n}\n";
            Check("认出这份 package.json 装了本插件", PluginInstaller.InstallsPlugin(installedJson));
            var stripped = PluginInstaller.StripPackageJson(installedJson);
            Check("卸载后两处都不再提本插件", !PluginInstaller.InstallsPlugin(stripped), stripped);
            using (var doc = JsonDocument.Parse(stripped))
            {
                var rootEl = doc.RootElement;
                var bundles = rootEl.GetProperty("dsh").GetProperty("profile").GetProperty("bundles");
                Check("bundles 里恰好只剩 other-plugin",
                    bundles.GetArrayLength() == 1 && bundles[0].GetString() == "other-plugin", stripped);
                var deps = rootEl.GetProperty("dependencies");
                Check("dependencies 里只剩 other-plugin",
                    deps.EnumerateObject().Count() == 1 && deps.TryGetProperty("other-plugin", out _), stripped);
                Check("其它字段原样保留",
                    rootEl.GetProperty("name").GetString() == "p"
                    && rootEl.GetProperty("version").GetString() == "1.0.0"
                    && rootEl.GetProperty("scripts").GetProperty("keep").GetString() == "me", stripped);
            }
            // 定位 profile 靠「谁登记过」而不是目录名：这里故意把装过的那个叫 desktop2。
            var fakeProfiles = Path.Combine(Path.GetTempPath(), "dsh-assistant-profiles-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(Path.Combine(fakeProfiles, "clean"));
                File.WriteAllText(Path.Combine(fakeProfiles, "clean", "package.json"),
                    "{\"dsh\":{\"profile\":{\"bundles\":[\"other\"]}},\"dependencies\":{}}", new UTF8Encoding(false));
                Directory.CreateDirectory(Path.Combine(fakeProfiles, "desktop2"));
                File.WriteAllText(Path.Combine(fakeProfiles, "desktop2", "package.json"), installedJson, new UTF8Encoding(false));
                var found = PluginInstaller.FindInstalledProfile(fakeProfiles);
                Check("定位到装过本插件的 profile（不按目录名猜）",
                    found != null && Path.GetFileName(found) == "desktop2", found);
                Check("profiles 目录不存在时返回 null",
                    PluginInstaller.FindInstalledProfile(Path.Combine(fakeProfiles, "nope")) == null);
            }
            finally
            {
                try { if (Directory.Exists(fakeProfiles)) Directory.Delete(fakeProfiles, true); } catch { }
            }

            Console.WriteLine("[装插件（临时 profile）]");
            // 真跑一遍 Install：文件拷贝 + package.json 改写都过一遍，才算这块真的有底。
            // 用临时数据根，装完就删，绝不碰真实的 ~/.dsh。
            var realDataRoot = Environment.GetEnvironmentVariable("DSH_DATA_DIR");
            var fakeRoot = Path.Combine(Path.GetTempPath(), "dsh-assistant-install-" + Guid.NewGuid().ToString("N"));
            try
            {
                var fakeProfile = Path.Combine(fakeRoot, "profiles", "desktop");
                Directory.CreateDirectory(fakeProfile);
                File.WriteAllText(Path.Combine(fakeProfile, "package.json"),
                    "{\n  \"name\": \"fake\",\n  \"dsh\": { \"profile\": { \"bundles\": [\n    \"other\"\n  ] } },\n  \"dependencies\": {\n    \"x\": \"1\"\n  }\n}\n",
                    new UTF8Encoding(false));
                Environment.SetEnvironmentVariable("DSH_DATA_DIR", fakeRoot);
                var installDir = loc.Usable ? loc.InstallDir : Path.Combine(fakeRoot, "fake-dsh");
                if (!PluginInstaller.IsInstallDir(installDir))
                {
                    Directory.CreateDirectory(Path.Combine(installDir, "resources", "app.asar.unpacked"));
                    Directory.CreateDirectory(Path.Combine(installDir, "resources", "runtime", "pnpm"));
                    File.WriteAllText(Path.Combine(installDir, "resources", "app.asar"), "stub");
                }
                var installed = PluginInstaller.Install(installDir, "desktop");
                var nodeModules = Path.Combine(fakeProfile, "node_modules", App.PluginId);
                Check("插件文件都拷过去了",
                    File.Exists(Path.Combine(nodeModules, "package.json"))
                    && File.Exists(Path.Combine(nodeModules, "cordis.patch.yml"))
                    && File.Exists(Path.Combine(nodeModules, "lib", "index.js"))
                    && File.Exists(Path.Combine(nodeModules, "lib", "backup.js"))
                    && File.Exists(Path.Combine(nodeModules, "lib", "client.js")),
                    nodeModules);
                var patchedReal = File.ReadAllText(Path.Combine(fakeProfile, "package.json"));
                var quote = "\"";
                Check("bundles 里出现包名（不是短名 backup-migrator）",
                    patchedReal.Contains(quote + App.PluginId + quote) && !patchedReal.Contains(quote + "backup-migrator" + quote),
                    patchedReal);
                // file: 指向数据根下那个稳定目录（插件源码就解在那里），不是 profile 的 node_modules——
                // EXE 会跟着备份目录搬家，指向 EXE 旁边的路径搬一次就失效。
                Check("dependencies 指向数据根下的插件目录",
                    patchedReal.Contains(quote + App.PluginId + quote + ": " + quote + "file:")
                    && patchedReal.Contains(quote + "file:" + PluginInstaller.ToPosix(App.PayloadDir) + quote), patchedReal);
                Check("file: spec 是正斜杠、无尾分隔符、落在数据根下",
                    PluginInstaller.ToPosix(App.PayloadDir).StartsWith(PluginInstaller.ToPosix(App.DataRoot) + "/"),
                    App.PayloadDir);
                Check("原 package.json 留了备份", File.Exists(installed.Backup), installed.Backup);

                // 落盘那一层也真跑一遍：备份 → 改写 → 删目录，三件事都在这里过一遍。
                var removed = PluginInstaller.Uninstall();
                Check("卸载后 package.json 里既没有 bundle 名也没有依赖",
                    !PluginInstaller.InstallsPlugin(File.ReadAllText(Path.Combine(fakeProfile, "package.json"))));
                Check("卸载后 node_modules 里的插件目录删掉了", !Directory.Exists(nodeModules), nodeModules);
                Check("卸载前留了 package.json.bak-<时间戳>",
                    File.Exists(removed.Backup) && Path.GetFileName(removed.Backup).StartsWith("package.json.bak-"), removed.Backup);

                // 再卸一遍，这次 node_modules 里那条是 junction。删它绝不能顺穿链接删到目标里去——
                // 本机踩过一次：对含 junction 的目录递归删，把别处 node_modules 里 9 个插件包一起删了。
                var external = Path.Combine(fakeRoot, "external-plugin");
                var linked = Path.Combine(fakeProfile, "node_modules", App.PluginId);
                Directory.CreateDirectory(external);
                File.WriteAllText(Path.Combine(external, "keep.txt"), "别处那份插件的内容", new UTF8Encoding(false));
                File.WriteAllText(Path.Combine(fakeProfile, "package.json"), installedJson, new UTF8Encoding(false));
                Directory.CreateDirectory(Path.GetDirectoryName(linked));
                // .NET 没有建 junction 的公开 API（CreateSymbolicLink 要开发者模式/管理员），叫 cmd 干这事。
                var mklink = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd",
                    "/c mklink /J \"" + linked + "\" \"" + external + "\"")
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true });
                mklink.WaitForExit();
                Check("能造出 junction 来测",
                    (new DirectoryInfo(linked).Attributes & FileAttributes.ReparsePoint) != 0, "cmd exit " + mklink.ExitCode);
                PluginInstaller.Uninstall();
                Check("删 junction 没有跟进去删目标（外面那份内容还在）",
                    File.Exists(Path.Combine(external, "keep.txt")), external);
                Check("junction 本身删掉了", !Directory.Exists(linked), linked);
            }
            catch (Exception error)
            {
                Check("临时 profile 安装走通", false, Log.Friendly(error));
            }
            finally
            {
                Environment.SetEnvironmentVariable("DSH_DATA_DIR", realDataRoot);
                try { if (Directory.Exists(fakeRoot)) Directory.Delete(fakeRoot, true); } catch { }
            }

            Console.WriteLine("[备份目录变更 → 助手搬家]");
            // 需求里最容易漏的一条：改了备份位置，助手本身要跟过去。
            // CopySelf 复制的是 49MB 的自己，跑一次约 50ms，值得真跑。
            var storeDirFileBackup = File.Exists(App.StoreDirFile) ? File.ReadAllBytes(App.StoreDirFile) : null;
            var tempStore = Path.Combine(Path.GetTempPath(), "dsh-assistant-store-" + Guid.NewGuid().ToString("N"));
            var copied = "";
            try
            {
                App.WriteStoreDirFile(tempStore);
                Check("备份目录跟着 备份目录.txt 变了", App.StoreDir == Path.GetFullPath(tempStore), App.StoreDir);
                copied = Restore.CopySelf(tempStore);
                Check("助手已复制到新备份目录", File.Exists(copied), copied);
                Check("复制后体积一致", new FileInfo(copied).Length == new FileInfo(App.SelfPath).Length);
                // 同名不覆盖：再搬一次应该拿到 -2
                var again = Restore.CopySelf(tempStore);
                Check("同名不覆盖，自动加序号", again != copied && File.Exists(again), again);
                Check("原位置的助手还在（复制不是移动）", File.Exists(App.SelfPath));
            }
            catch (Exception error)
            {
                Check("搬家走通", false, Log.Friendly(error));
            }
            finally
            {
                if (storeDirFileBackup == null) File.Delete(App.StoreDirFile);
                else File.WriteAllBytes(App.StoreDirFile, storeDirFileBackup);
                try { if (Directory.Exists(tempStore)) Directory.Delete(tempStore, true); } catch { }
            }

            Console.WriteLine("[拒收坏文件]");
            var tmp = Path.Combine(Path.GetTempPath(), "dsh-assistant-selftest-" + Guid.NewGuid().ToString("N") + ".zip");
            try
            {
                File.WriteAllText(tmp, "not an archive at all");
                var rejected = false;
                try { BackupFile.ReadManifest(tmp); }
                catch (Exception error) { rejected = true; Console.WriteLine("  info 拒收理由：" + Log.Friendly(error)); }
                Check("随便一个 zip 名会被拒", rejected);
                var fake = Path.Combine(Path.GetTempPath(), "dsh-assistant-fake-" + Guid.NewGuid().ToString("N") + ".zip");
                tarCreate(fake, "{}");
                var rejected2 = false;
                try { BackupFile.ReadManifest(fake); }
                catch (Exception error) { rejected2 = true; Console.WriteLine("  info 拒收理由：" + Log.Friendly(error)); }
                Check("没有 manifest 的归档会被拒", rejected2);
                File.Delete(fake);
            }
            finally
            {
                File.Delete(tmp);
            }

            Console.WriteLine(_failed == 0 ? "全部通过。" : _failed + " 项失败。");
            return _failed == 0 ? 0 : 1;
        }

        /// <summary>PatchPackageJson 是私有的，自检用反射调它——比把它改成 public 只为测试干净。</summary>
        private static string InvokePatch(string json)
        {
            var method = typeof(PluginInstaller).GetMethod("PatchPackageJson",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            try
            {
                return (string)method.Invoke(null, new object[] { json, App.DataRoot });
            }
            catch (System.Reflection.TargetInvocationException)
            {
                return null;
            }
        }

        private static string NewestBackup(string dir)
        {
            return BackupFile.List(dir).FirstOrDefault();
        }

        /// <summary>造一个"是 zip 但没有 manifest"的归档，用系统 tar 写，免得多一个依赖。</summary>
        private static void tarCreate(string file, string content)
        {
            var work = Path.Combine(Path.GetTempPath(), "dsh-assistant-tar-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            File.WriteAllText(Path.Combine(work, "junk.txt"), content, new UTF8Encoding(false));
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo("tar", "\"" + "--format" + "\" \"zip\" \"-cf\" \"" + file + "\" \"-C\" \"" + work + "\" \".\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (var proc = System.Diagnostics.Process.Start(psi)) proc.WaitForExit();
            }
            finally
            {
                Directory.Delete(work, true);
            }
        }
    }
}
