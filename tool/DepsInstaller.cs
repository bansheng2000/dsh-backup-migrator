using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

namespace DshBackupAssistant
{
    /// <summary>
    /// 备份里没有 node_modules，装回依赖这一步得有人做。
    /// 插件的 restore.ps1 里那句 dsh plugin --profile <name> install 在本机不管用——
    /// 宿主没装 dsh 命令（app.asar 内 dsh/package.json 没有 bin 字段，DeepSeek Harness.exe 只是把参数透传给 node）。
    /// 所以这里直接用宿主自带的 pnpm + node 跑 pnpm install，参数与当初手工安装插件用的完全一致。
    /// </summary>
    internal static class DepsInstaller
    {
        /// <summary>
        /// node / pnpm 可能的所在地。两代 DSH 的布局不一样，所以不猜版本、只列位置：
        ///   0.2.0 及更早：resources\runtime\{node,pnpm}\bin
        ///   0.2.1 及更新：resources\runtime\primary-runtime\dependencies\{node,pnpm}\bin
        /// 0.2.1 删掉了顶层 runtime\pnpm，但 primary-runtime 里那份一直都在。
        /// 数据根下的 dsh-runtimes 兜底：DSH 在这台机器上跑过一次就有。
        /// </summary>
        private static IEnumerable<string> RuntimeRoots(string installDir)
        {
            if (!string.IsNullOrEmpty(installDir))
            {
                var runtime = Path.Combine(installDir, "resources", "runtime");
                yield return runtime;
                yield return Path.Combine(runtime, "primary-runtime", "dependencies");
            }
            var runtimes = Path.Combine(App.DataRoot, "dsh-runtimes");
            if (Directory.Exists(runtimes))
            {
                foreach (var dir in Directory.GetDirectories(runtimes).OrderBy((x) => x, StringComparer.OrdinalIgnoreCase))
                {
                    yield return Path.Combine(dir, "dependencies");
                }
            }
        }

        /// <summary>在候选根目录下逐个找 root\a\b\file，第一个存在的胜出。</summary>
        private static string FirstFile(IEnumerable<string> roots, string a, string b, string file)
        {
            foreach (var root in roots)
            {
                try
                {
                    var hit = Path.Combine(root, a, b, file);
                    if (File.Exists(hit)) return hit;
                }
                catch
                {
                    // 路径里有非法字符（候选目录不存在时经常如此）——跳过这个候选就好。
                }
            }
            return null;
        }

        /// <summary>找 node。</summary>
        public static string FindNode(string installDir)
        {
            return FirstFile(RuntimeRoots(installDir), "node", "bin", "node.exe");
        }

        /// <summary>找 pnpm。</summary>
        public static string FindPnpm(string installDir)
        {
            return FirstFile(RuntimeRoots(installDir), "pnpm", "bin", "pnpm.cjs");
        }

        public sealed class Result
        {
            public bool Ran;
            public int ExitCode;
            public string Output = "";
            public string Reason = "";
        }

        /// <summary>
        /// 在一个 profile 里装回依赖。跑不起来不算失败——只是依赖没装上，
        /// 用户重启 DSH 后还能让 DSH 自己给出确切命令。
        /// </summary>
        public static Result Install(string installDir, string profileName, Action<string> onOutput = null)
        {
            var result = new Result();
            var profile = Path.Combine(App.DataRoot, "profiles", profileName);
            if (!File.Exists(Path.Combine(profile, "package.json")))
            {
                result.Reason = "没有 " + profile + "\\package.json，跳过";
                return result;
            }
            var node = FindNode(installDir);
            var pnpm = FindPnpm(installDir);
            if (node == null || pnpm == null)
            {
                result.Reason = node == null
                    ? "找不到 node（DSH 的 dsh-runtimes 里应该有），请重启一次 DSH 再试"
                    : "找不到安装目录里的 pnpm，装不了依赖";
                Log.Write("warn", result.Reason);
                return result;
            }
            var args = "\"" + pnpm + "\" --dir \"" + profile
                + "\" install --config.minimumReleaseAge=0 --config.strictStorePkgContentCheck=false";
            Log.Write("info", "装回依赖：" + node + " " + args);
            try
            {
                var psi = new ProcessStartInfo(node, args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    WorkingDirectory = profile,
                };
                using (var proc = Process.Start(psi))
                {
                    // pnpm 的输出量很容易超过管道缓冲，必须两个流同时开始收：顺序 ReadToEnd 会死锁。
                    var output = new StringBuilder();
                    var error = new StringBuilder();
                    proc.OutputDataReceived += (s, x) => { if (x.Data != null) output.AppendLine(x.Data); };
                    proc.ErrorDataReceived += (s, x) => { if (x.Data != null) error.AppendLine(x.Data); };
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    proc.WaitForExit();   // 无参重载会等两个异步读取都收到 EOF 才返回
                    result.Ran = true;
                    result.ExitCode = proc.ExitCode;
                    result.Output = (output.ToString() + "\n" + error.ToString()).Trim();
                }
            }
            catch (Exception error)
            {
                result.Reason = Log.Friendly(error);
                Log.Write("error", "装依赖失败：" + result.Reason);
                return result;
            }
            Log.Write("info", "装依赖退出码 " + result.ExitCode);
            onOutput?.Invoke(result.Output);
            return result;
        }

        public static string SuggestCommand(string profileName)
        {
            return "dsh plugin --profile " + profileName + " install";
        }
    }
}
