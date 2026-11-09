export const PROMPT_HELPER_CSHARP = `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Security.Principal;
using System.IO.Pipes;
using System.Security.AccessControl;

namespace UChan.Platform.Windows.Assets
{
    public static class PromptHelper
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool SetTokenInformation(IntPtr token, int kind, ref uint value, int size);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SECURITY_ATTRIBUTES attributes);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SwitchDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint code);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern bool DuplicateTokenEx(
            IntPtr hExistingToken,
            uint dwDesiredAccess,
            IntPtr lpTokenAttributes,
            int ImpersonationLevel,
            int TokenType,
            out IntPtr phNewToken);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public bool bInheritHandle;
        }

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessAsUser(
            IntPtr hToken,
            string lpApplicationName,
            StringBuilder lpCommandLine,
            ref SECURITY_ATTRIBUTES lpProcessAttributes,
            ref SECURITY_ATTRIBUTES lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("userenv.dll", SetLastError = true)]
        private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

        [DllImport("userenv.dll", SetLastError = true)]
        private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSSendMessage(
            IntPtr hServer,
            int SessionId,
            string pTitle,
            int TitleLength,
            string pMessage,
            int MessageLength,
            int Style,
            int Timeout,
            out int pResponse,
            bool bWait);

        [STAThread]
        public static int Main(string[] args)
        {
            // Never collect secrets or accept approval in the desktop user's identity.
            if (!WindowsIdentity.GetCurrent().IsSystem) return 1;
            if (args.Length >= 2 && args[0] == "--relay")
            {
                try { args = Encoding.UTF8.GetString(Convert.FromBase64String(args[1])).Split((char)0); }
                catch { return 1; }
            }
            if (Process.GetCurrentProcess().SessionId == 0) return RelayToActiveSession(args);
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (args[i] != "--output-pipe") continue;
                using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", args[i + 1], PipeDirection.Out))
                {
                    try
                    {
                        pipe.Connect(10000);
                        using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false)))
                        {
                            writer.AutoFlush = true;
                            Console.SetOut(writer);
                            return RunDialogOnCleanThread(args);
                        }
                    }
                    catch { return 1; }
                }
            }
            return 1;
        }

        private static int RunDialogOnCleanThread(string[] args)
        {
            int result = 1;
            // The relay thread can own CLR/COM windows. Desktop assignment requires a clean thread.
            System.Threading.Thread thread = new System.Threading.Thread(delegate()
            {
                try { result = RunProtectedDialog(args); }
                catch { result = 1; }
            });
            thread.SetApartmentState(System.Threading.ApartmentState.STA);
            thread.Start();
            thread.Join();
            return result;
        }

        private static int RunProtectedDialog(string[] args)
        {
            IntPtr original = OpenInputDesktop(0, false, 0x0100);
            if (original == IntPtr.Zero) return 1;
            IntPtr descriptor = IntPtr.Zero;
            IntPtr desktop = IntPtr.Zero;
            uint size;
            try
            {
                if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)", 1, out descriptor, out size)) return 1;
                SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
                sa.nLength = Marshal.SizeOf(sa);
                sa.lpSecurityDescriptor = descriptor;
                desktop = CreateDesktop("UChan-" + Guid.NewGuid().ToString("N"), IntPtr.Zero, IntPtr.Zero, 0, 0x01FF, ref sa);
                if (desktop == IntPtr.Zero || !SetThreadDesktop(desktop) || !SwitchDesktop(desktop)) return 1;
                return RunDialog(args);
            }
            finally
            {
                SwitchDesktop(original);
                if (desktop != IntPtr.Zero) CloseDesktop(desktop);
                CloseDesktop(original);
                if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            }
        }

        private static int RelayToActiveSession(string[] args)
        {
            uint sessionId = WTSGetActiveConsoleSessionId();
            if (sessionId == 0xFFFFFFFF) return 1;
            IntPtr source;
            if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x000B, out source)) return 1;
            IntPtr token;
            bool duplicated = DuplicateTokenEx(source, 0x10000000, IntPtr.Zero, 2, 1, out token);
            CloseHandle(source);
            if (!duplicated) return 1;
            try
            {
                if (!SetTokenInformation(token, 12, ref sessionId, 4)) return 1;
                string name = "UChanPrompt-" + Guid.NewGuid().ToString("N");
                PipeSecurity security = new PipeSecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
                using (NamedPipeServerStream pipe = new NamedPipeServerStream(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security))
                {
                    List<string> childArgs = new List<string>(args);
                    childArgs.Add("--output-pipe");
                    childArgs.Add(name);
                    string payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join(((char)0).ToString(), childArgs.ToArray())));
                    string executable = Process.GetCurrentProcess().MainModule.FileName;
                    StringBuilder command = new StringBuilder();
                    command.Append((char)34).Append(executable).Append((char)34).Append(" --relay ").Append(payload);
                    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
                    sa.nLength = Marshal.SizeOf(sa);
                    STARTUPINFO si = new STARTUPINFO();
                    si.cb = Marshal.SizeOf(si);
                    si.lpDesktop = string.Concat("winsta0", (char)92, "default");
                    PROCESS_INFORMATION pi;
                    // Cross-session handles cannot be inherited; use a SYSTEM-only named pipe.
                    if (!CreateProcessAsUser(token, executable, command, ref sa, ref sa, false, 0x00000400, IntPtr.Zero, null, ref si, out pi)) return 1;
                    CloseHandle(pi.hThread);
                    try
                    {
                        if (!pipe.WaitForConnectionAsync().Wait(10000)) return 1;
                        using (StreamReader reader = new StreamReader(pipe, Encoding.UTF8))
                        {
                            var reply = reader.ReadToEndAsync();
                            if (!reply.Wait(125000) || reply.Result.Length > 2048) return 1;
                            if (WaitForSingleObject(pi.hProcess, 5000) != 0) return 1;
                            uint code;
                            if (!GetExitCodeProcess(pi.hProcess, out code) || code != 0) return 1;
                            Console.Write(reply.Result);
                            return 0;
                        }
                    }
                    catch { return 1; }
                    finally
                    {
                        uint code;
                        if (GetExitCodeProcess(pi.hProcess, out code) && code == 259) TerminateProcess(pi.hProcess, 1);
                        CloseHandle(pi.hProcess);
                    }
                }
            }
            finally { CloseHandle(token); }
        }

        private static int RunDialog(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string mode = "confirm";
            string title = "U-Chan Secrets";
            string phrase = "u-chan-phrase";
            string rawLines = "";

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--mode" && i + 1 < args.Length) mode = args[++i];
                else if (args[i] == "--title" && i + 1 < args.Length) title = args[++i];
                else if (args[i] == "--phrase" && i + 1 < args.Length) phrase = args[++i];
                else if (args[i] == "--lines" && i + 1 < args.Length) rawLines = args[++i];
            }

            List<string> lines = ParseLines(rawLines);

            if (mode == "manage")
            {
                List<string> domains = new List<string>();
                for (int i = 0; i + 1 < args.Length; i++)
                    if (args[i] == "--domains") domains = ParseLines(args[i + 1]);
                return RunManagement(title, phrase, lines, domains);
            }
            if (mode == "password") return RunPasswordDialog(title, phrase, lines);
            if (mode == "pick")
            {
                List<string> choices = new List<string>();
                for (int i = 0; i + 1 < args.Length; i++)
                    if (args[i] == "--choices") choices = ParseLines(args[i + 1]);
                return RunPickDialog(title, phrase, lines, choices);
            }

            Form form = new Form();
            form.Text = title;
            form.TopMost = true;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.ClientSize = new Size(760, 520);

            // Anti-phishing phrase banner
            Panel banner = new Panel();
            banner.Dock = DockStyle.Top;
            banner.Height = 50;
            banner.BackColor = Color.FromArgb(235, 243, 255);
            banner.BorderStyle = BorderStyle.FixedSingle;

            Label phraseLabel = new Label();
            phraseLabel.Text = "Phrase: " + phrase;
            phraseLabel.Font = new Font(form.Font.FontFamily, 11f, FontStyle.Bold);
            phraseLabel.ForeColor = Color.FromArgb(16, 44, 87);
            phraseLabel.Dock = DockStyle.Fill;
            phraseLabel.TextAlign = ContentAlignment.MiddleCenter;
            banner.Controls.Add(phraseLabel);
            form.Controls.Add(banner);

            // Context lines panel
            Panel contentPanel = new Panel();
            contentPanel.Dock = DockStyle.Fill;
            contentPanel.Padding = new Padding(16);
            contentPanel.AutoScroll = true;

            TextBox details = new TextBox();
            details.Multiline = true;
            details.ReadOnly = true;
            details.WordWrap = true;
            details.ScrollBars = ScrollBars.Vertical;
            details.MaxLength = 65536;
            details.Location = new Point(16, 60);
            details.Size = new Size(728, 330);
            details.Text = string.Join(Environment.NewLine, lines.ToArray());
            contentPanel.Controls.Add(details);

            // Bottom panel for countdown & buttons
            Panel bottomPanel = new Panel();
            bottomPanel.Dock = DockStyle.Bottom;
            bottomPanel.Height = 60;

            int remainingSeconds = 120; // 2-minute countdown timer
            Label timerLabel = new Label();
            timerLabel.Text = "Expires in 120s";
            timerLabel.Location = new Point(16, 20);
            timerLabel.Size = new Size(150, 24);
            timerLabel.ForeColor = Color.Gray;
            bottomPanel.Controls.Add(timerLabel);

            Button btnOk = new Button();
            btnOk.Text = "OK";
            btnOk.Location = new Point(270, 16);
            btnOk.Size = new Size(80, 30);
            btnOk.DialogResult = DialogResult.OK;

            Button btnCancel = new Button();
            btnCancel.Text = "Cancel";
            btnCancel.Location = new Point(360, 16);
            btnCancel.Size = new Size(80, 30);
            btnCancel.DialogResult = DialogResult.Cancel;

            bottomPanel.Controls.Add(btnOk);
            bottomPanel.Controls.Add(btnCancel);
            form.Controls.Add(bottomPanel);
            form.Controls.Add(contentPanel);

            form.AcceptButton = btnOk;
            form.CancelButton = btnCancel;

            Timer timer = new Timer();
            timer.Interval = 1000;
            timer.Tick += (s, e) =>
            {
                remainingSeconds--;
                if (remainingSeconds <= 0)
                {
                    timer.Stop();
                    form.DialogResult = DialogResult.Cancel;
                    form.Close();
                }
                else
                {
                    timerLabel.Text = "Expires in " + remainingSeconds + "s";
                }
            };

            form.Shown += (s, e) =>
            {
                timer.Start();
            };

            DialogResult result = form.ShowDialog();
            timer.Stop();

            if (result == DialogResult.OK)
            {
                return 0;
            }

            return 1;
        }

        private static int RunPasswordDialog(string title, string phrase, List<string> lines)
        {
            using (Form form = new Form())
            using (Timer timer = new Timer())
            {
                bool unlock = lines.Count == 1 && lines[0] == "Unlock the vault";
                bool hc = SystemInformation.HighContrast;
                Color navy = hc ? SystemColors.Highlight : Color.FromArgb(11, 31, 75);
                Color onNavy = hc ? SystemColors.HighlightText : Color.White;
                Color tint = hc ? SystemColors.Info : Color.FromArgb(238, 242, 250);
                Color onTint = hc ? SystemColors.InfoText : Color.FromArgb(11, 31, 75);
                Color line = hc ? SystemColors.WindowFrame : Color.FromArgb(201, 209, 227);
                Color muted = hc ? SystemColors.GrayText : Color.FromArgb(90, 101, 128);
                int width = unlock ? 380 : 520;
                int inner = width - 40;

                form.Text = title;
                form.Font = new Font("Segoe UI", 9f);
                form.AutoScaleDimensions = new SizeF(96f, 96f);
                form.AutoScaleMode = AutoScaleMode.Dpi;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MaximizeBox = false;
                form.MinimizeBox = false;
                form.TopMost = true;
                form.BackColor = SystemColors.Window;
                form.ForeColor = SystemColors.WindowText;
                form.ClientSize = new Size(width, 260);

                Panel header = new Panel();
                header.Dock = DockStyle.Top;
                header.Height = 52;
                header.BackColor = navy;
                Label heading = new Label();
                heading.Text = unlock ? "Unlock vault" : "Confirm action";
                heading.Font = new Font("Segoe UI Semibold", 13f);
                heading.AutoSize = true;
                heading.ForeColor = onNavy;
                heading.Location = new Point(18, 13);
                header.Controls.Add(heading);

                Panel body = new Panel();
                body.Dock = DockStyle.Fill;
                body.Padding = new Padding(20, 16, 20, 16);

                TableLayoutPanel layout = new TableLayoutPanel();
                layout.Dock = DockStyle.Top;
                layout.AutoSize = true;
                layout.ColumnCount = 1;
                layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
                layout.RowCount = 6;
                for (int row = 0; row < layout.RowCount; row++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

                Label verification = new Label();
                verification.Text = "Verification phrase: " + phrase;
                verification.AutoSize = true;
                verification.MaximumSize = new Size(inner, 0);
                verification.Dock = DockStyle.Fill;
                verification.Padding = new Padding(10, 8, 10, 8);
                verification.Margin = new Padding(0, 0, 0, 14);
                verification.BackColor = tint;
                verification.ForeColor = onTint;
                verification.Font = new Font("Segoe UI Semibold", 9f);

                TextBox details = new TextBox();
                details.Multiline = true;
                details.ReadOnly = true;
                details.WordWrap = true;
                details.ScrollBars = lines.Count > 1 ? ScrollBars.Vertical : ScrollBars.None;
                details.BorderStyle = BorderStyle.None;
                details.BackColor = SystemColors.Window;
                details.ForeColor = SystemColors.WindowText;
                details.Text = string.Join(Environment.NewLine, lines.ToArray());
                details.Height = Math.Min(144, Math.Max(32, lines.Count * 22));
                details.Dock = DockStyle.Fill;
                details.Margin = new Padding(0, 0, 0, 14);
                details.AccessibleName = "Requested action";
                details.TabStop = false;
                details.Visible = !unlock;

                Label passwordLabel = new Label();
                passwordLabel.Text = "Master password";
                passwordLabel.AutoSize = true;
                passwordLabel.Margin = new Padding(0, 0, 0, 4);

                TextBox txtPassword = new TextBox();
                txtPassword.UseSystemPasswordChar = true;
                txtPassword.MaxLength = 512;
                txtPassword.Dock = DockStyle.Fill;
                txtPassword.Font = new Font("Segoe UI", 10.5f);
                txtPassword.BorderStyle = BorderStyle.FixedSingle;
                txtPassword.Margin = new Padding(0, 0, 0, 6);
                txtPassword.AccessibleName = "Master password";
                txtPassword.TabIndex = 0;

                Label hint = new Label();
                hint.Text = "Only type your password if the phrase matches.";
                hint.AutoSize = true;
                hint.MaximumSize = new Size(inner, 0);
                hint.ForeColor = muted;
                hint.Margin = new Padding(0, 0, 0, 16);

                TableLayoutPanel footer = new TableLayoutPanel();
                footer.Dock = DockStyle.Fill;
                footer.AutoSize = true;
                footer.ColumnCount = 3;
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                footer.Margin = new Padding(0);
                Label countdown = new Label();
                countdown.AutoSize = true;
                countdown.Anchor = AnchorStyles.Left;
                countdown.Margin = new Padding(0, 0, 12, 0);
                countdown.ForeColor = muted;
                countdown.Text = "Closes in 2:00";

                Button cancel = new Button();
                cancel.Text = "Cancel";
                cancel.Size = new Size(84, 32);
                cancel.Margin = new Padding(0, 0, 8, 0);
                cancel.DialogResult = DialogResult.Cancel;
                cancel.TabIndex = 2;
                cancel.FlatStyle = FlatStyle.Flat;
                cancel.FlatAppearance.BorderColor = line;
                cancel.UseVisualStyleBackColor = false;
                cancel.BackColor = SystemColors.Window;
                cancel.ForeColor = hc ? SystemColors.WindowText : navy;
                if (!hc) cancel.FlatAppearance.MouseOverBackColor = tint;
                Button submit = new Button();
                submit.Text = unlock ? "Unlock" : "Confirm";
                submit.Size = new Size(92, 32);
                submit.Margin = new Padding(0);
                submit.DialogResult = DialogResult.OK;
                submit.Enabled = false;
                submit.TabIndex = 1;
                submit.FlatStyle = FlatStyle.Flat;
                submit.FlatAppearance.BorderSize = 1;
                submit.UseVisualStyleBackColor = false;
                submit.Font = new Font("Segoe UI Semibold", 9f);
                Color disabledBack = hc ? SystemColors.Control : Color.FromArgb(230, 234, 242);
                submit.BackColor = disabledBack;
                submit.ForeColor = SystemColors.GrayText;
                submit.FlatAppearance.BorderColor = disabledBack;
                if (!hc) submit.FlatAppearance.MouseOverBackColor = Color.FromArgb(27, 52, 110);
                txtPassword.TextChanged += delegate {
                    submit.Enabled = txtPassword.Text.Length > 0;
                    submit.BackColor = submit.Enabled ? navy : disabledBack;
                    submit.ForeColor = submit.Enabled ? onNavy : SystemColors.GrayText;
                    submit.FlatAppearance.BorderColor = submit.Enabled ? navy : disabledBack;
                };
                footer.Controls.Add(countdown, 0, 0);
                footer.Controls.Add(cancel, 1, 0);
                footer.Controls.Add(submit, 2, 0);
                layout.Controls.Add(verification, 0, 0);
                layout.Controls.Add(details, 0, 1);
                layout.Controls.Add(passwordLabel, 0, 2);
                layout.Controls.Add(txtPassword, 0, 3);
                layout.Controls.Add(hint, 0, 4);
                layout.Controls.Add(footer, 0, 5);
                body.Controls.Add(layout);
                form.Controls.Add(body);
                form.Controls.Add(header);
                form.AcceptButton = submit;
                form.CancelButton = cancel;
                form.Load += delegate {
                    layout.PerformLayout();
                    form.ClientSize = new Size(form.ClientSize.Width, header.Height + layout.GetPreferredSize(new Size(layout.Width, 0)).Height + body.Padding.Vertical);
                };
                int remainingSeconds = 120;
                timer.Interval = 1000;
                timer.Tick += delegate {
                    remainingSeconds--;
                    countdown.Text = "Closes in " + (remainingSeconds / 60).ToString() + ":" + (remainingSeconds % 60).ToString("00");
                    if (remainingSeconds <= 0) { form.DialogResult = DialogResult.Cancel; form.Close(); }
                };
                form.Shown += delegate { txtPassword.Focus(); timer.Start(); };
                DialogResult result = form.ShowDialog();
                timer.Stop();
                if (result == DialogResult.OK) Console.Write(txtPassword.Text);
                txtPassword.Clear();
                return result == DialogResult.OK ? 0 : 1;
            }
        }

        private static int RunPickDialog(string title, string phrase, List<string> lines, List<string> choices)
        {
            using (Form form = new Form())
            using (Timer timer = new Timer())
            {
                bool hc = SystemInformation.HighContrast;
                Color navy = hc ? SystemColors.Highlight : Color.FromArgb(11, 31, 75);
                Color onNavy = hc ? SystemColors.HighlightText : Color.White;
                Color tint = hc ? SystemColors.Info : Color.FromArgb(238, 242, 250);
                Color onTint = hc ? SystemColors.InfoText : Color.FromArgb(11, 31, 75);
                Color muted = hc ? SystemColors.GrayText : Color.FromArgb(90, 101, 128);
                int width = 420, inner = width - 40;

                form.Text = title;
                form.Font = new Font("Segoe UI", 9f);
                form.AutoScaleDimensions = new SizeF(96f, 96f);
                form.AutoScaleMode = AutoScaleMode.Dpi;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MaximizeBox = false;
                form.MinimizeBox = false;
                form.TopMost = true;
                form.BackColor = SystemColors.Window;
                form.ClientSize = new Size(width, 300);

                Panel header = new Panel();
                header.Dock = DockStyle.Top;
                header.Height = 52;
                header.BackColor = navy;
                Label heading = new Label();
                heading.Text = "Choose Bitwarden item";
                heading.Font = new Font("Segoe UI Semibold", 13f);
                heading.AutoSize = true;
                heading.ForeColor = onNavy;
                heading.Location = new Point(18, 13);
                header.Controls.Add(heading);

                Panel body = new Panel();
                body.Dock = DockStyle.Fill;
                body.Padding = new Padding(20, 16, 20, 16);
                TableLayoutPanel layout = new TableLayoutPanel();
                layout.Dock = DockStyle.Top;
                layout.AutoSize = true;
                layout.ColumnCount = 1;
                layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
                layout.RowCount = 4;
                for (int row = 0; row < layout.RowCount; row++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

                Label verification = new Label();
                verification.Text = "Verification phrase: " + phrase;
                verification.AutoSize = true;
                verification.MaximumSize = new Size(inner, 0);
                verification.Dock = DockStyle.Fill;
                verification.Padding = new Padding(10, 8, 10, 8);
                verification.Margin = new Padding(0, 0, 0, 12);
                verification.BackColor = tint;
                verification.ForeColor = onTint;
                verification.Font = new Font("Segoe UI Semibold", 9f);

                Label context = new Label();
                context.Text = string.Join(Environment.NewLine, lines.ToArray());
                context.AutoSize = true;
                context.MaximumSize = new Size(inner, 0);
                context.Margin = new Padding(0, 0, 0, 8);

                ListBox list = new ListBox();
                list.Dock = DockStyle.Fill;
                list.BorderStyle = BorderStyle.FixedSingle;
                list.Font = new Font("Segoe UI", 10f);
                list.IntegralHeight = false;
                list.Height = Math.Min(8, Math.Max(3, choices.Count)) * 22 + 4;
                list.Margin = new Padding(0, 0, 0, 16);
                list.AccessibleName = "Bitwarden item";
                foreach (string choice in choices) list.Items.Add(choice);
                if (list.Items.Count > 0) list.SelectedIndex = 0;
                list.TabIndex = 0;

                TableLayoutPanel footer = new TableLayoutPanel();
                footer.Dock = DockStyle.Fill;
                footer.AutoSize = true;
                footer.ColumnCount = 3;
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                footer.Margin = new Padding(0);
                Label countdown = new Label();
                countdown.AutoSize = true;
                countdown.Anchor = AnchorStyles.Left;
                countdown.ForeColor = muted;
                countdown.Text = "Closes in 2:00";
                Button cancel = new Button();
                cancel.Text = "Cancel";
                cancel.Size = new Size(84, 32);
                cancel.Margin = new Padding(0, 0, 8, 0);
                cancel.DialogResult = DialogResult.Cancel;
                cancel.FlatStyle = FlatStyle.Flat;
                cancel.UseVisualStyleBackColor = false;
                cancel.BackColor = SystemColors.Window;
                cancel.ForeColor = hc ? SystemColors.WindowText : navy;
                cancel.TabIndex = 2;
                Button submit = new Button();
                submit.Text = "Use item";
                submit.Size = new Size(92, 32);
                submit.Margin = new Padding(0);
                submit.DialogResult = DialogResult.OK;
                submit.Enabled = list.Items.Count > 0;
                submit.FlatStyle = FlatStyle.Flat;
                submit.UseVisualStyleBackColor = false;
                submit.BackColor = navy;
                submit.ForeColor = onNavy;
                submit.FlatAppearance.BorderColor = navy;
                submit.Font = new Font("Segoe UI Semibold", 9f);
                submit.TabIndex = 1;
                list.DoubleClick += delegate { if (list.SelectedIndex >= 0) { form.DialogResult = DialogResult.OK; form.Close(); } };

                footer.Controls.Add(countdown, 0, 0);
                footer.Controls.Add(cancel, 1, 0);
                footer.Controls.Add(submit, 2, 0);
                layout.Controls.Add(verification, 0, 0);
                layout.Controls.Add(context, 0, 1);
                layout.Controls.Add(list, 0, 2);
                layout.Controls.Add(footer, 0, 3);
                body.Controls.Add(layout);
                form.Controls.Add(body);
                form.Controls.Add(header);
                form.AcceptButton = submit;
                form.CancelButton = cancel;
                form.Load += delegate {
                    layout.PerformLayout();
                    form.ClientSize = new Size(form.ClientSize.Width, header.Height + layout.GetPreferredSize(new Size(layout.Width, 0)).Height + body.Padding.Vertical);
                };
                int remainingSeconds = 120;
                timer.Interval = 1000;
                timer.Tick += delegate {
                    remainingSeconds--;
                    countdown.Text = "Closes in " + (remainingSeconds / 60).ToString() + ":" + (remainingSeconds % 60).ToString("00");
                    if (remainingSeconds <= 0) { form.DialogResult = DialogResult.Cancel; form.Close(); }
                };
                form.Shown += delegate { list.Focus(); timer.Start(); };
                DialogResult result = form.ShowDialog();
                timer.Stop();
                if (result != DialogResult.OK || list.SelectedIndex < 0) return 1;
                Console.Write(list.SelectedIndex.ToString());
                return 0;
            }
        }

        private static int RunManagement(string title, string phrase, List<string> lines, List<string> domains)
        {
            using (Form form = new Form())
            using (Timer timer = new Timer())
            {
                form.Text = title;
                form.Font = new Font("Segoe UI", 10f);
                form.StartPosition = FormStartPosition.CenterScreen;
                form.ClientSize = new Size(780, 650);
                form.MinimumSize = new Size(640, 520);
                form.TopMost = true;
                TableLayoutPanel layout = new TableLayoutPanel();
                layout.Dock = DockStyle.Fill;
                layout.Padding = new Padding(16);
                layout.ColumnCount = 1;
                layout.RowCount = 5;
                layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 60));
                layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
                layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
                layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
                layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
                Label banner = new Label();
                banner.Text = "Phrase: " + phrase;
                banner.Dock = DockStyle.Fill;
                banner.Font = new Font(form.Font.FontFamily, 12, FontStyle.Bold);
                banner.ForeColor = Color.FromArgb(16, 44, 87);
                TextBox details = new TextBox();
                details.Multiline = true;
                details.ReadOnly = true;
                details.TabStop = false;
                details.HideSelection = true;
                details.WordWrap = true;
                details.ScrollBars = ScrollBars.Vertical;
                details.Dock = DockStyle.Fill;
                details.Text = string.Join(Environment.NewLine, lines.ToArray());
                Label label = new Label();
                label.Text = "Select the exact domain to revoke:";
                label.Dock = DockStyle.Fill;
                ComboBox select = new ComboBox();
                select.DropDownStyle = ComboBoxStyle.DropDownList;
                select.Dock = DockStyle.Fill;
                select.Items.AddRange(domains.ToArray());
                if (domains.Count > 0) select.SelectedIndex = 0;
                FlowLayoutPanel buttons = new FlowLayoutPanel();
                buttons.Dock = DockStyle.Fill;
                buttons.FlowDirection = FlowDirection.RightToLeft;
                string[] commands = { "close", "revoke", "unlock", "lock", "next", "previous", "refresh" };
                string[] labels = { "Close", "Revoke selected", "Unlock", "Lock", "Next", "Previous", "Refresh" };
                for (int i = 0; i < commands.Length; i++)
                {
                    string command = commands[i];
                    Button button = new Button();
                    button.Text = labels[i];
                    button.AutoSize = true;
                    button.Height = 32;
                    button.Enabled = command != "revoke" || domains.Count > 0;
                    button.Click += delegate {
                        string value = command;
                        if (command == "revoke")
                        {
                            if (select.SelectedIndex < 0 || select.SelectedIndex >= domains.Count) return;
                            value += ":" + domains[select.SelectedIndex];
                        }
                        Console.Write(value);
                        form.DialogResult = DialogResult.OK;
                        form.Close();
                    };
                    buttons.Controls.Add(button);
                    if (command == "close") form.CancelButton = button;
                    if (command == "refresh") form.AcceptButton = button;
                }
                layout.Controls.Add(banner, 0, 0);
                layout.Controls.Add(details, 0, 1);
                layout.Controls.Add(label, 0, 2);
                layout.Controls.Add(select, 0, 3);
                layout.Controls.Add(buttons, 0, 4);
                form.Controls.Add(layout);
                timer.Interval = 120000;
                timer.Tick += delegate { form.Close(); };
                form.Shown += delegate { select.Focus(); timer.Start(); };
                return form.ShowDialog() == DialogResult.OK ? 0 : 1;
            }
        }

        private static List<string> ParseLines(string raw)
        {
            List<string> list = new List<string>();
            if (string.IsNullOrEmpty(raw)) return list;

            string input = raw.Trim();
            if (input.StartsWith("[") && input.EndsWith("]"))
            {
                MatchCollection matches = Regex.Matches(input, @"""((?:\\\\.|[^""\\\\])*)""");
                foreach (Match m in matches)
                {
                    list.Add(Regex.Unescape(m.Groups[1].Value));
                }
            }
            else
            {
                try
                {
                    byte[] data = Convert.FromBase64String(input);
                    string decoded = Encoding.UTF8.GetString(data);
                    return ParseLines(decoded);
                }
                catch
                {
                    string[] split = input.Split(new char[] { '\\r', '\\n' }, StringSplitOptions.RemoveEmptyEntries);
                    list.AddRange(split);
                }
            }
            return list;
        }
    }
}
`
