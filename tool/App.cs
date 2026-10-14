using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace DshBackupAssistant
{
    /// <summary>
    /// 全局常量 + 路径推导 + 日志。三条路径各有来源，优先级写在这里而不是散在调用点：
    ///   数据根    DSH_DATA_DIR > %USERPROFILE%\.dsh
    ///   备份目录  同目录的「备份目录.txt」> &lt;数据根&gt;\backups（= 插件 storeDir 为空时的默认值）
    ///   EXE 自身  它自己（跟着备份目录搬家，所以永远同目录）
    /// </summary>
    internal static class App
    {
        public const string Name = "DSH 备份助手";
        public const string PluginId = "dsh-backup-migrator";
        public const string ExeName = "DSH备份助手.exe";
        public const string StoreDirFileName = "备份目录.txt";

        public static string Version
        {
            get
            {
                var v = Assembly.GetExecutingAssembly().GetName().Version;
                return v == null ? "0.0.0" : string.Format(CultureInfo.InvariantCulture, "{0}.{1}.{2}", v.Major, v.Minor, v.Build);
            }
        }

        /// <summary>EXE 所在目录。单文件发布时程序集路径是 :memory:，要退到 BaseDirectory / 进程目录。</summary>
        public static string SelfDir
        {
            get
            {
                string p = null;
                try
                {
                    p = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                }
                catch
                {
                }
                if (IsFake(p)) { p = null; try { p = AppContext.BaseDirectory; } catch { } }
                if (IsFake(p)) p = Process.GetCurrentProcess().MainModule.FileName;
                if (string.IsNullOrEmpty(p)) p = Environment.CurrentDirectory;
                if (IsInsideDotnetTemp(p)) p = Environment.CurrentDirectory;
                return Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
        }

        private static bool IsFake(string p)
        {
            return string.IsNullOrEmpty(p) || p.IndexOf(":memory:", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>单文件 EXE 被解压到 TEMP\.net\... 时拿到的假目录：拿它当目录会把文件写到临时区。</summary>
        private static bool IsInsideDotnetTemp(string p)
        {
            if (string.IsNullOrEmpty(p)) return false;
            if (p.IndexOf(".net", StringComparison.OrdinalIgnoreCase) < 0) return false;
            string temp = Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return p.StartsWith(temp, StringComparison.OrdinalIgnoreCase);
        }

        public static string SelfPath
        {
            get { return Path.Combine(SelfDir, ExeName); }
        }

        public static string DataRoot
        {
            get
            {
                string raw = (Environment.GetEnvironmentVariable("DSH_DATA_DIR") ?? "").Trim();
                if (raw == "") raw = Path.Combine(UserProfile, ".dsh");
                return Path.GetFullPath(raw);
            }
        }

        public static string UserProfile
        {
            get { return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); }
        }

        /// <summary>
        /// 备份目录：同目录的「备份目录.txt」优先，其次 &lt;数据根&gt;\backups。
        /// 这个 txt 是 EXE 换机后唯一跟着走的配置——它与 EXE 同目录，拷 EXE 就把配置一起拷走了。
        /// </summary>
        public static string StoreDir
        {
            get
            {
                string fromFile = ReadStoreDirFile();
                if (fromFile != null) return fromFile;
                return DefaultStoreDir;
            }
        }

        public static string DefaultStoreDir
        {
            get { return Path.Combine(DataRoot, "backups"); }
        }

        /// <summary>不设 DSH_DATA_DIR 时的数据根。等于 DataRoot 才说明写的是这台机器正在用的目录。</summary>
        public static string DefaultDataRoot
        {
            get { return Path.Combine(UserProfile, ".dsh"); }
        }

        public static string StoreDirFile
        {
            get { return Path.Combine(SelfDir, StoreDirFileName); }
        }

        public static string LogFile
        {
            get { return Path.Combine(SelfDir, "dsh-backup-assistant.log"); }
        }

        /// <summary>EXE 内嵌插件的解压目录。放 EXE 旁边，package.json 里就能写 file: 绝对路径。</summary>
        public static string PayloadDir
        {
            get { return Path.Combine(SelfDir, "plugin"); }
        }

        /// <summary>
        /// 把 EXE 资源里的插件解压出来。已存在就跳过——解压一次不到 1MB，没必要每次启动都做。
        /// 解压失败不当致命错误：备份导入不依赖它，只有"装插件"这一项会用到。
        /// </summary>
        public static string EnsurePayload(out string problem)
        {
            problem = null;
            var dir = PayloadDir;
            try
            {
                if (!File.Exists(Path.Combine(dir, "package.json")))
                {
                    using (var stream = typeof(App).Assembly.GetManifestResourceStream("DshBackupAssistant.Payload.zip"))
                    {
                        if (stream == null)
                        {
                            problem = "这个 EXE 里没有内嵌插件（构建时漏了 payload），装插件功能不可用；备份导入仍可正常使用。";
                            return dir;
                        }
                        using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                        {
                            foreach (var entry in zip.Entries)
                            {
                                if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) continue;
                                var to = Path.Combine(dir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                                Directory.CreateDirectory(Path.GetDirectoryName(to));
                                entry.ExtractToFile(to, true);
                            }
                        }
                    }
                    Log.Write("info", "已解出内嵌插件到 " + dir);
                }
            }
            catch (Exception error)
            {
                problem = "解出内嵌插件失败：" + Log.Friendly(error);
                Log.Write("error", problem);
            }
            return dir;
        }

        /// <summary>读同目录的「备份目录.txt」；不存在/读不了返回 null（不是错误，落到默认值）。</summary>
        public static string ReadStoreDirFile()
        {
            try
            {
                string text = File.ReadAllText(StoreDirFile, new UTF8Encoding(false)).Trim();
                if (text == "") return null;
                return Path.GetFullPath(text.Trim('"'));
            }
            catch (Exception error)
            {
                Log.Write("warn", "读 " + StoreDirFile + " 失败：" + error.Message);
                return null;
            }
        }

        public static void WriteStoreDirFile(string dir)
        {
            File.WriteAllText(StoreDirFile, Path.GetFullPath(dir), new UTF8Encoding(false));
        }
    }

    /// <summary>日志：文件一行一条，跟着 EXE 走。写日志失败绝不连带崩掉主流程。</summary>
    internal static class Log
    {
        private static readonly object Gate = new object();

        public static void Write(string level, string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                + " [" + level.ToUpperInvariant() + "] " + message;
            try
            {
                lock (Gate)
                {
                    File.AppendAllText(App.LogFile, line + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch
            {
            }
        }

        /// <summary>把 Win32/IO 异常翻成能读懂的中文，别把 "Access to the path is denied" 甩给用户。</summary>
        public static string Friendly(Exception error)
        {
            for (Exception e = error; e != null; e = e.InnerException)
            {
                int win = Marshal.GetHRForException(e) & 0xFFFF;
                if (win == 5) return "权限不足：请以管理员身份运行，或把目标目录换成你能写的路径。";
                if (win == 32) return "文件正被别的程序占用（多半是 DSH 还在跑），关掉它再试。";
                if (win == 3) return "路径不存在。";
            }
            return error.Message;
        }
    }
}
