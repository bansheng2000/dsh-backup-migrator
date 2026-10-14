using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace DshBackupAssistant
{
    /// <summary>主窗口。四块：装插件 / 导入备份 / 备份目录 / 备份列表。</summary>
    internal sealed class MainForm : Form
    {
        private readonly ListView _backups = new ListView();
        private readonly TextBox _storeDir = new TextBox();
        private readonly TextBox _dshDir = new TextBox();
        private readonly ComboBox _profile = new ComboBox();
        private readonly Label _dshFound = new Label();
        private readonly Label _status = new Label();
        private readonly Button _install = new Button();
        private readonly Button _browseDsh = new Button();
        private readonly Button _browseStore = new Button();
        private readonly Button _applyStore = new Button();
        private readonly Button _import = new Button();
        private readonly Button _stage = new Button();
        private readonly Button _openStore = new Button();
        private readonly Button _openLog = new Button();

        public MainForm()
        {
            Text = App.Name + " " + App.Version;
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            // 导入那行有四个按钮（选文件 / 校验并导入 / 解到暂存区），窄了最后一个会被裁掉。
            ClientSize = new System.Drawing.Size(920, 600);
            Font = new System.Drawing.Font("Microsoft YaHei UI", 9F);
            AutoScaleMode = AutoScaleMode.Dpi;

            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 5,
                Padding = new System.Windows.Forms.Padding(12),
            };
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // 抬头
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // 装插件
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // 导入备份
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // 备份目录
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F)); // 备份列表
            Controls.Add(root);

            root.Controls.Add(BuildHeader(), 0, 0);
            root.Controls.Add(BuildInstallGroup(), 0, 1);
            root.Controls.Add(BuildImportGroup(), 0, 2);
            root.Controls.Add(BuildStoreGroup(), 0, 3);
            root.Controls.Add(BuildListGroup(), 0, 4);

            Shown += OnShown;
        }

        private Control BuildHeader()
        {
            var box = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, AutoSize = true };
            box.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            box.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            box.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            box.Controls.Add(new Label
            {
                Text = App.Name + " · 给「" + App.PluginId + "」搬家用",
                Font = new System.Drawing.Font(Font, System.Drawing.FontStyle.Bold),
                AutoSize = true,
            }, 0, 0);
            box.Controls.Add(new Label
            {
                Text = "数据目录：" + App.DataRoot + "　|　本工具：" + App.SelfPath,
                AutoSize = true,
                ForeColor = System.Drawing.Color.DimGray,
                Margin = new System.Windows.Forms.Padding(0, 4, 0, 0),
            }, 0, 1);
            _status.Text = "";
            _status.AutoSize = true;
            _status.ForeColor = System.Drawing.Color.DarkGreen;
            _status.Margin = new System.Windows.Forms.Padding(0, 4, 0, 8);
            box.Controls.Add(_status, 0, 2);
            return box;
        }

        private GroupBox BuildInstallGroup()
        {
            var box = new GroupBox { Text = "一、把插件装到这台电脑", Dock = DockStyle.Fill, AutoSize = true, Padding = new System.Windows.Forms.Padding(10) };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 3, AutoSize = true };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            _dshFound.Text = "正在检测 DSH…";
            _dshFound.AutoSize = true;
            _dshFound.Margin = new System.Windows.Forms.Padding(0, 3, 0, 6);
            grid.Controls.Add(_dshFound, 0, 0);
            grid.SetColumnSpan(_dshFound, 4);

            grid.Controls.Add(new Label { Text = "DSH 安装目录：", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new System.Windows.Forms.Padding(0, 3, 6, 3) }, 0, 1);
            _dshDir.Dock = DockStyle.Fill;
            _dshDir.Margin = new System.Windows.Forms.Padding(0, 3, 6, 3);
            grid.Controls.Add(_dshDir, 1, 1);
            _browseDsh.Text = "选择目录…";
            _browseDsh.AutoSize = true;
            _browseDsh.Click += (s, e) => BrowseInto(_dshDir, "选择 DSH 安装目录");
            grid.Controls.Add(_browseDsh, 2, 1);
            _install.Text = "装到这台电脑";
            _install.AutoSize = true;
            _install.Click += OnInstall;
            grid.Controls.Add(_install, 3, 1);

            grid.Controls.Add(new Label { Text = "目标 profile：", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new System.Windows.Forms.Padding(0, 3, 6, 3) }, 0, 2);
            _profile.Dock = DockStyle.Fill;
            _profile.DropDownStyle = ComboBoxStyle.DropDownList;
            _profile.Margin = new System.Windows.Forms.Padding(0, 3, 6, 3);
            grid.Controls.Add(_profile, 1, 2);
            box.Controls.Add(grid);
            return box;
        }

        private GroupBox BuildImportGroup()
        {
            var box = new GroupBox { Text = "二、把备份导入这台电脑", Dock = DockStyle.Fill, AutoSize = true, Padding = new System.Windows.Forms.Padding(10) };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 1, AutoSize = true };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            var hint = new Label
            {
                Text = "选一份备份文件。先校验完整性，再让你确认要覆盖哪些内容。导入前请完全退出 DSH。",
                AutoSize = true,
                Dock = DockStyle.Fill,
                Margin = new System.Windows.Forms.Padding(0, 3, 8, 3),
            };
            grid.Controls.Add(hint, 0, 0);
            var pick = new Button { Text = "选择备份文件…", AutoSize = true };
            pick.Click += OnPickBackup;
            grid.Controls.Add(pick, 1, 0);
            _import.Text = "校验并导入（覆盖）";
            _import.AutoSize = true;
            _import.Enabled = false;
            _import.Click += OnImport;
            grid.Controls.Add(_import, 2, 0);
            _stage.Text = "解到暂存区…";
            _stage.AutoSize = true;
            _stage.Enabled = false;
            _stage.Click += OnStage;
            grid.Controls.Add(_stage, 3, 0);
            box.Controls.Add(grid);
            return box;
        }

        private GroupBox BuildStoreGroup()
        {
            var box = new GroupBox { Text = "三、备份目录（助手跟着它搬家）", Dock = DockStyle.Fill, AutoSize = true, Padding = new System.Windows.Forms.Padding(10) };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 1, AutoSize = true };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            _storeDir.Text = App.StoreDir;
            _storeDir.Dock = DockStyle.Fill;
            _storeDir.Margin = new System.Windows.Forms.Padding(0, 3, 6, 3);
            grid.Controls.Add(_storeDir, 0, 0);
            _browseStore.Text = "选择目录…";
            _browseStore.AutoSize = true;
            _browseStore.Click += (s, e) => BrowseInto(_storeDir, "选择备份目录");
            grid.Controls.Add(_browseStore, 1, 0);
            _applyStore.Text = "保存并搬动助手";
            _applyStore.AutoSize = true;
            _applyStore.Click += OnApplyStore;
            grid.Controls.Add(_applyStore, 2, 0);
            _openStore.Text = "打开目录";
            _openStore.AutoSize = true;
            _openStore.Click += (s, e) => OpenPath(App.StoreDir);
            grid.Controls.Add(_openStore, 3, 0);
            box.Controls.Add(grid);
            return box;
        }

        private GroupBox BuildListGroup()
        {
            var box = new GroupBox { Text = "四、这个目录里的备份", Dock = DockStyle.Fill, Padding = new System.Windows.Forms.Padding(8) };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            _backups.Dock = DockStyle.Fill;
            _backups.View = View.Details;
            _backups.FullRowSelect = true;
            _backups.HideSelection = false;
            _backups.MultiSelect = true;
            _backups.Columns.Add("文件名", 260);
            _backups.Columns.Add("备份时间", 140);
            _backups.Columns.Add("大小", 90);
            _backups.Columns.Add("内容", 220);
            _backups.SelectedIndexChanged += OnBackupSelected;
            grid.Controls.Add(_backups, 0, 0);

            var row = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
            var use = new Button { Text = "把选中的当备份导入", AutoSize = true };
            use.Click += (s, e) => OnPickBackup();
            row.Controls.Add(use);
            _openLog.Text = "打开日志";
            _openLog.AutoSize = true;
            _openLog.Click += (s, e) => OpenPath(App.LogFile);
            row.Controls.Add(_openLog);
            grid.Controls.Add(row, 0, 1);
            box.Controls.Add(grid);
            return box;
        }

        private void OnShown(object sender, EventArgs e)
        {
            var loc = PluginInstaller.Detect();
            _dshFound.Text = loc.Usable
                ? "已检测到 DSH：" + loc.InstallDir + "（版本 " + (loc.Version == "" ? "未知" : loc.Version) + "，来源：" + loc.Source + "）"
                : "未检测到 DSH 安装。装 DSH 之后点「选择目录…」手动指一下也行。";
            _dshFound.ForeColor = loc.Usable ? System.Drawing.Color.DarkGreen : System.Drawing.Color.DarkOrange;
            if (loc.Usable) _dshDir.Text = loc.InstallDir;
            _profile.Items.Clear();
            foreach (var name in PluginInstaller.Profiles())
            {
                _profile.Items.Add(Path.GetFileName(name));
            }
            if (_profile.Items.Count == 0)
            {
                _profile.Items.Add("desktop");
                _profile.Items.Add("headless");
                _profile.Text = "desktop";
                _status.Text = "数据目录里还没有 profile 目录，先启动一次 DSH 吧。";
            }
            else if (_profile.SelectedIndex < 0)
            {
                _profile.SelectedIndex = 0;
            }
            RefreshBackups();
        }

        private void RefreshBackups()
        {
            var picked = _backups.SelectedItems;
            var names = new List<string>();
            foreach (ListViewItem item in picked) names.Add(item.Text);
            _backups.BeginUpdate();
            try
            {
                _backups.Items.Clear();
                foreach (var file in BackupFile.List(App.StoreDir))
                {
                    string time = "?";
                    string what = "";
                    try
                    {
                        var manifest = BackupFile.ReadManifest(file);
                        time = BackupFile.DescribeTime(manifest.CreatedAt);
                        what = string.Join("、", manifest.Items.Select(BackupFile.ItemLabel));
                    }
                    catch (Exception error)
                    {
                        what = "读不出 manifest：" + Log.Friendly(error);
                    }
                    var row = new ListViewItem(Path.GetFileName(file));
                    row.SubItems.Add(time);
                    row.SubItems.Add(BackupFile.DescribeSize(BackupFile.Size(file)));
                    row.SubItems.Add(what);
                    row.Tag = file;
                    _backups.Items.Add(row);
                }
            }
            finally
            {
                _backups.EndUpdate();
            }
            foreach (ListViewItem item in _backups.Items)
            {
                if (names.Contains(item.Text)) item.Selected = true;
            }
            _backups.Enabled = _backups.Items.Count > 0;
        }

        private void OnBackupSelected(object sender, EventArgs e)
        {
            var file = SelectedBackup();
            if (file == null)
            {
                _import.Enabled = false;
                return;
            }
            _import.Enabled = true;
        }

        /// <summary>
        /// 暂存模式：解到备份目录下的 .restore-&lt;时间戳&gt;\ 并生成 restore.ps1，人工看过再跑。
        /// 不碰数据目录，所以 DSH 开着也能点——这是这条路的全部意义。
        /// </summary>
        private void OnStage(object sender, EventArgs e)
        {
            var plan = _import.Tag as Restore.Plan;
            if (plan == null)
            {
                MessageBox.Show(this, "先选一份备份文件（校验通过后这里才能点）。", "解到暂存区", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var body = new System.Text.StringBuilder();
            body.AppendLine("把备份解到暂存区，不动数据目录：");
            body.AppendLine("　" + Path.Combine(App.StoreDir, ".restore-&lt;时间戳&gt;"));
            body.AppendLine();
            body.AppendLine("同目录会生成 restore.ps1，你看过之后再自己跑，它才写回数据目录。");
            body.AppendLine("DSH 开着也能做这一步。");
            body.AppendLine();
            body.AppendLine("继续？");
            if (MessageBox.Show(this, body.ToString(), "解到暂存区", MessageBoxButtons.OKCancel,
                MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK)
            {
                return;
            }
            try
            {
                _stage.Enabled = false;
                _status.Text = "正在解包…";
                Refresh();
                Application.DoEvents();
                var dir = Restore.RestoreStaged(plan);
                _status.Text = "解好了：" + dir;
                _status.ForeColor = System.Drawing.Color.DarkGreen;
                MessageBox.Show(this, "已解到：\r\n　" + dir + "\r\n\r\n里面的 restore.ps1 需要你确认后自己跑，它才会写回数据目录。",
                    "解好了", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception error)
            {
                Log.Write("error", "解到暂存区失败：" + error);
                _status.Text = "解到暂存区失败：" + Log.Friendly(error);
                _status.ForeColor = System.Drawing.Color.Firebrick;
                MessageBox.Show(this, "失败：\r\n" + Log.Friendly(error), "解到暂存区", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                _stage.Enabled = true;
            }
        }

        /// <summary>「校验并导入」按钮：已有校验过的 plan 就直接导入，没有就先弹文件选择框。</summary>
        private void OnImport(object sender, EventArgs e)
        {
            if (_import.Tag is Restore.Plan plan)
            {
                PrepareImport(plan.File);
                return;
            }
            OnPickBackup();
        }

        private string SelectedBackup()
        {
            if (_backups.SelectedItems.Count == 0) return null;
            return _backups.SelectedItems[0].Tag as string;
        }

        private void OnPickBackup(object sender = null, EventArgs e = null)
        {
            var selected = SelectedBackup();
            using (var dialog = new OpenFileDialog
            {
                Title = "选择 DSH 备份文件",
                Filter = "DSH 备份 (*.zip;*.tar.gz)|*.zip;*.tar.gz|所有文件 (*.*)|*.*",
                InitialDirectory = App.StoreDir,
                FileName = selected == null ? "" : Path.GetFileName(selected),
            })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                PrepareImport(dialog.FileName);
            }
        }

        private void PrepareImport(string file)
        {
            try
            {
                var plan = Restore.Analyze(file);
                _import.Tag = plan;
                _import.Enabled = true;
                _status.Text = "已校验：" + Path.GetFileName(file) + "（" + BackupFile.DescribeSize(plan.Bytes)
                    + "，" + BackupFile.DescribeTime(plan.Manifest.CreatedAt) + "）";
                _status.ForeColor = System.Drawing.Color.DarkGreen;

                var body = new System.Text.StringBuilder();
                body.AppendLine("备份文件：" + file);
                body.AppendLine("备份时间：" + BackupFile.DescribeTime(plan.Manifest.CreatedAt));
                body.AppendLine("备份内容：" + string.Join("、", plan.Manifest.Items.Select(BackupFile.ItemLabel)));
                body.AppendLine("将写入：" + App.DataRoot);
                if (plan.WillOverwrite)
                {
                    body.AppendLine();
                    body.AppendLine("以下内容将被覆盖（不会被删除，只会被包里的版本替换）：");
                    foreach (var rel in plan.Existing) body.AppendLine("　· " + rel);
                }
                else
                {
                    body.AppendLine();
                    body.AppendLine("目标位置当前为空，不会覆盖任何东西。");
                }
                body.AppendLine();
                body.AppendLine("请确认 DSH 已完全退出。导入后需要重启 DSH。");

                var answer = MessageBox.Show(this, body.ToString(), "确认导入",
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (answer != DialogResult.OK)
                {
                    _import.Tag = null;
                    _import.Enabled = false;
                    _status.Text = "已取消导入。";
                    return;
                }
                if (Restore.DshRunning())
                {
                    MessageBox.Show(this, "检测到 DSH 还在运行。开着它写回数据会写坏数据，请完全退出 DSH（含托盘图标）后重试。",
                        "DSH 还在运行", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    _import.Tag = null;
                    _import.Enabled = false;
                    return;
                }
                _status.Text = "正在导入…";
                _import.Enabled = false;
                _backups.Enabled = false;
                Refresh();
                Application.DoEvents();
                Restore.Apply(plan);
                _status.Text = "导入完成：" + string.Join("、", plan.Targets) + "。重启 DSH 后生效。";
                _status.ForeColor = System.Drawing.Color.DarkGreen;
                RefreshBackups();
                // profiles 在包里但 node_modules 不在：装不装依赖交给用户决定，免得静默跑几分钟网络操作。
                if (plan.Manifest.Items.Contains("profiles")
                    && MessageBox.Show(this, "备份里的 profile 没带 node_modules（那样备份会大一倍多）。\r\n"
                        + "现在用 DSH 自带的 pnpm 把依赖装回来吗？", "装回依赖",
                        MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button1) == DialogResult.OK)
                {
                    _status.Text = "正在装依赖…";
                    Refresh();
                    Application.DoEvents();
                    var installDir = _dshDir.Text.Trim();
                    var done = new System.Text.StringBuilder();
                    var failed = new System.Text.StringBuilder();
                    foreach (var dir in PluginInstaller.Profiles())
                    {
                        var name = Path.GetFileName(dir);
                        var deps = DepsInstaller.Install(installDir, name);
                        if (deps.Ran && deps.ExitCode == 0) done.Append(name + " ");
                        else failed.Append(name + "（" + (deps.Reason == "" ? "退出码 " + deps.ExitCode : deps.Reason) + "）");
                    }
                    _status.Text = done.Length > 0 || failed.Length == 0
                        ? "依赖装好了：" + done.ToString().Trim()
                        : "依赖没装上：" + failed.ToString();
                    _status.ForeColor = failed.Length == 0 ? System.Drawing.Color.DarkGreen : System.Drawing.Color.DarkOrange;
                }
            }
            catch (Exception error)
            {
                Log.Write("error", "导入失败：" + error);
                _import.Tag = null;
                _import.Enabled = false;
                _status.Text = "导入失败：" + Log.Friendly(error);
                _status.ForeColor = System.Drawing.Color.Firebrick;
                MessageBox.Show(this, "导入失败：\r\n" + Log.Friendly(error)
                    + "\r\n\r\n详情见日志：" + App.LogFile, "导入失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OnInstall(object sender, EventArgs e)
        {
            var dir = _dshDir.Text.Trim();
            if (dir == "") return;
            if (!PluginInstaller.IsInstallDir(dir))
            {
                MessageBox.Show(this, "选中的目录不像 DSH 安装目录。\r\n里面应该有 resources\\app.asar 和 resources\\runtime\\pnpm。",
                    "目录不对", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            var profile = Convert.ToString(_profile.SelectedItem);
            var message = "将把插件装进这个 profile：\r\n　" + Path.Combine(App.DataRoot, "profiles", profile)
                + "\r\n\r\n会做的事：\r\n· 复制插件文件到 profile 的 node_modules\\" + App.PluginId
                + "\r\n· 在 profile 的 package.json 里登记依赖与 bundle 名"
                + "\r\n（原 package.json 会先备份成 package.json.dshbackupbak）\r\n\r\n继续？";
            if (MessageBox.Show(this, message, "确认安装", MessageBoxButtons.OKCancel,
                MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK)
            {
                return;
            }
            try
            {
                _install.Enabled = false;
                _status.Text = "正在安装…";
                Refresh();
                Application.DoEvents();
                var result = PluginInstaller.Install(dir, profile);
                _status.Text = "插件文件已就位，正在装依赖…";
                Refresh();
                Application.DoEvents();
                var deps = DepsInstaller.Install(dir, profile);
                var tail = deps.Ran && deps.ExitCode == 0
                    ? "依赖也装好了。"
                    : "依赖没能自动装上（" + (deps.Reason == "" ? "退出码 " + deps.ExitCode : deps.Reason)
                      + "）。重启 DSH 后它会给出确切命令，或手动跑：" + DepsInstaller.SuggestCommand(profile);
                _status.Text = "安装完成。重启 DSH 后插件生效。";
                _status.ForeColor = deps.Ran && deps.ExitCode == 0 ? System.Drawing.Color.DarkGreen : System.Drawing.Color.DarkOrange;
                MessageBox.Show(this, "插件已装进 profile " + profile + "。\r\n\r\n" + tail
                    + "\r\n\r\n下一步：完全退出并重启 DSH，插件会自动挂载。\r\n（package.json 原文件备份在 " + result.Backup + "）",
                    "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception error)
            {
                Log.Write("error", "安装失败：" + error);
                _status.Text = "安装失败：" + Log.Friendly(error);
                _status.ForeColor = System.Drawing.Color.Firebrick;
                MessageBox.Show(this, "安装失败：\r\n" + Log.Friendly(error)
                    + "\r\n\r\n详情见日志：" + App.LogFile, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                _install.Enabled = true;
            }
        }

        private void OnApplyStore(object sender, EventArgs e)
        {
            var dir = _storeDir.Text.Trim();
            if (dir == "")
            {
                MessageBox.Show(this, "先选一个目录。", "备份目录", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.Equals(Path.GetFullPath(dir), Path.GetFullPath(App.SelfDir), StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(this, "新目录就是助手当前所在目录，不用搬。", "备份目录", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var body = new System.Text.StringBuilder();
            body.AppendLine("备份目录改为：");
            body.AppendLine("　" + dir);
            body.AppendLine();
            body.AppendLine("同时会做两件事：");
            body.AppendLine("· 把助手 EXE 复制一份到新目录（原来的那份保留，当退路）");
            body.AppendLine("· 在 EXE 旁边写一份「" + App.StoreDirFileName + "」记录新路径，跟着 EXE 一起搬家");
            body.AppendLine();
            body.AppendLine("要改插件设置页里的备份目录，请到 DSH 设置 → 插件 → dsh-backup-migrator 改。");
            body.AppendLine();
            body.AppendLine("继续？");
            if (MessageBox.Show(this, body.ToString(), "确认改备份目录", MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.OK)
            {
                return;
            }
            try
            {
                Directory.CreateDirectory(dir);
                App.WriteStoreDirFile(dir);
                var copied = Restore.CopySelf(dir);
                _status.Text = "已保存。新位置：" + copied;
                _status.ForeColor = System.Drawing.Color.DarkGreen;
                RefreshBackups();
                MessageBox.Show(this, "已复制助手到：\r\n　" + copied
                    + "\r\n\r\n用新位置那个 EXE 打开即可；原位置那份建议删掉。",
                    "改好了", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception error)
            {
                Log.Write("error", "改备份目录失败：" + error);
                _status.Text = "改备份目录失败：" + Log.Friendly(error);
                _status.ForeColor = System.Drawing.Color.Firebrick;
                MessageBox.Show(this, "失败：\r\n" + Log.Friendly(error), "备份目录", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void BrowseInto(TextBox target, string title)
        {
            using (var dialog = new FolderBrowserDialog
            {
                Description = title,
                SelectedPath = target.Text.Trim() == "" ? App.StoreDir : target.Text.Trim(),
                ShowNewFolderButton = true,
            })
            {
                if (dialog.ShowDialog(this) == DialogResult.OK) target.Text = dialog.SelectedPath;
            }
        }

        private void OpenPath(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true });
                }
                else
                {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true });
                }
            }
            catch (Exception error)
            {
                Log.Write("warn", "打开 " + path + " 失败：" + error.Message);
                MessageBox.Show(this, "打不开：\r\n" + Log.Friendly(error), "打开失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _backups.Dispose();
            base.Dispose(disposing);
        }
    }
}
