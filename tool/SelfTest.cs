using System;
using System.IO;
using System.Linq;
using System.Text;

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

            Console.WriteLine("[DSH 发现]");
            var loc = PluginInstaller.Detect();
            Console.WriteLine("  info 检测结果：" + (loc.Usable ? loc.InstallDir + "（" + loc.Source + "，版本 " + loc.Version + "）" : "未检测到"));
            Check("IsInstallDir 拒绝空路径", !PluginInstaller.IsInstallDir(""));
            Check("IsInstallDir 拒绝系统目录", !PluginInstaller.IsInstallDir(Environment.GetFolderPath(Environment.SpecialFolder.Windows)));
            Check("IsInstallDir 接受自己判出的路径", !loc.Usable || PluginInstaller.IsInstallDir(loc.InstallDir), loc.InstallDir);
            Check("没有 DSH 时 profiles 列举不炸", PluginInstaller.Profiles().Any() || !Directory.Exists(PluginInstaller.ProfilesDir));

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
                var manifest = BackupFile.Inspect(file);
                Check("manifest 是本插件的", manifest.Plugin == App.PluginId, manifest.Plugin);
                Check("schema 不超过本工具认识的值", manifest.Schema <= BackupFile.Schema, manifest.Schema.ToString());
                Check("勾选项都能映射到路径", manifest.TargetPaths().Length == manifest.Items.Length,
                    manifest.TargetPaths().Length + "/" + manifest.Items.Length);
                var plan = Restore.Analyze(file);
                Check("导入计划里每个目标都有名有姓", plan.Targets.Length > 0);
                Console.WriteLine("  info 将覆盖：" + (plan.Existing.Length == 0 ? "（无）" : string.Join("、", plan.Existing)));
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
                // file: 指向 EXE 旁边的 plugin 目录（插件源码就解在那里），不是 profile 的 node_modules。
                Check("dependencies 指向 EXE 旁的插件目录",
                    patchedReal.Contains(quote + App.PluginId + quote + ": " + quote + "file:"), patchedReal);
                Check("file: spec 是正斜杠且无尾分隔符",
                    patchedReal.Contains(quote + "file:" + PluginInstaller.ToPosix(App.PayloadDir) + quote), patchedReal);
                Check("原 package.json 留了备份", File.Exists(installed.Backup), installed.Backup);
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
