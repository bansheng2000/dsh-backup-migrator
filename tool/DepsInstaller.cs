using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

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
        /// <summary>找 node：优先 DSH 数据根下自带的 runtimes，再找安装目录里的。</summary>
        public static string FindNode(string installDir)
        {
            var runtimes = Path.Combine(App.DataRoot, "dsh-runtimes");
            if (Directory.Exists(runtimes))
            {
                foreach (var dir in Directory.GetDirectories(runtimes).OrderBy((x) => x, StringComparer.OrdinalIgnoreCase))
                {
                    var hit = Path.Combine(dir, "dependencies", "node", "bin", "node.exe");
                    if (File.Exists(hit)) return hit;
                }
            }
            var bundled = string.IsNullOrEmpty(installDir)
                ? ""
                : Path.Combine(installDir, "resources", "runtime", "node", "bin", "node.exe");
            return File.Exists(bundled) ? bundled : null;
        }

        /// <summary>找 pnpm：安装目录 resources\runtime\pnpm\bin\pnpm.cjs。</summary>
        public static string FindPnpm(string installDir)
        {
            if (string.IsNullOrEmpty(installDir)) return null;
            var hit = Path.Combine(installDir, "resources", "runtime", "pnpm", "bin", "pnpm.cjs");
            return File.Exists(hit) ? hit : null;
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
                    var output = proc.StandardOutput.ReadToEnd();
                    var error = proc.StandardError.ReadToEnd();
                    proc.WaitForExit();
                    result.Ran = true;
                    result.ExitCode = proc.ExitCode;
                    result.Output = (output + "\n" + error).Trim();
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
