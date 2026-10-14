using System;
using System.Linq;
using System.Windows.Forms;

namespace DshBackupAssistant
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--selftest")
            {
                // WinExe 没有自己的控制台，输出得挂到调用方那个，否则自检结果一片死寂。
                AttachToParent();
                Console.OutputEncoding = new System.Text.UTF8Encoding(false);
                Environment.Exit(SelfTest.Run(args.Skip(1).ToArray()));
            }
            // 无界面的导入：给脚本/CI 用，也是自检里唯一能验证写入链路的那条路。
            // DSH_DATA_DIR 指到哪就写哪，测试时可以整块导到临时目录。
            if (args.Length > 1 && args[0] == "--restore")
            {
                AttachToParent();
                Console.OutputEncoding = new System.Text.UTF8Encoding(false);
                try
                {
                    var plan = Restore.Analyze(args[1]);
                    Console.WriteLine("写入 " + App.DataRoot + "：" + string.Join("、", plan.Targets));
                    Restore.Apply(plan);
                    Console.WriteLine("完成。重启 DSH 后生效。");
                    Environment.Exit(0);
                }
                catch (Exception error)
                {
                    Console.WriteLine("失败：" + Log.Friendly(error));
                    Environment.Exit(1);
                }
            }
            if (args.Length > 1 && args[0] == "--stage")
            {
                AttachToParent();
                Console.OutputEncoding = new System.Text.UTF8Encoding(false);
                try
                {
                    var plan = Restore.Analyze(args[1]);
                    var dir = Restore.RestoreStaged(plan);
                    Console.WriteLine(dir);
                    Environment.Exit(0);
                }
                catch (Exception error)
                {
                    Console.WriteLine("失败：" + Log.Friendly(error));
                    Environment.Exit(1);
                }
            }
            Log.Write("info", "启动 " + App.Name + " " + App.Version + "，EXE 目录 " + App.SelfDir);
            string problem = null;
            App.EnsurePayload(out problem);
            if (problem != null) Log.Write("warn", problem);
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
            Log.Write("info", "退出");
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern bool AttachConsole(int processId);

        private static void AttachToParent()
        {
            try { AttachConsole(-1); }
            catch { }
        }
    }
}