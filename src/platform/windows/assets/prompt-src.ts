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
                            return RunProtectedDialog(args);
                        }
                    }
                    catch { return 1; }
                }
            }
            return 1;
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

            Form form = new Form();
            form.Text = title;
            form.TopMost = true;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.ClientSize = new Size(460, mode == "password" ? 380 : 320);

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

            int yOffset = 60;
            foreach (string line in lines)
            {
                Label lbl = new Label();
                lbl.Text = line;
                lbl.Location = new Point(16, yOffset);
                lbl.Size = new Size(428, 22);
                lbl.AutoEllipsis = true;
                contentPanel.Controls.Add(lbl);
                yOffset += 24;
            }

            TextBox txtPassword = null;
            if (mode == "password")
            {
                Label pwdLabel = new Label();
                pwdLabel.Text = "Master Password:";
                pwdLabel.Location = new Point(16, yOffset + 8);
                pwdLabel.Size = new Size(428, 20);
                contentPanel.Controls.Add(pwdLabel);
                yOffset += 30;

                txtPassword = new TextBox();
                txtPassword.Location = new Point(16, yOffset);
                txtPassword.Size = new Size(428, 24);
                txtPassword.UseSystemPasswordChar = true;
                txtPassword.MaxLength = 512;
                contentPanel.Controls.Add(txtPassword);
            }

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
                if (txtPassword != null)
                {
                    txtPassword.Focus();
                }
            };

            DialogResult result = form.ShowDialog();
            timer.Stop();

            if (result == DialogResult.OK)
            {
                if (mode == "password" && txtPassword != null)
                {
                    Console.Write(txtPassword.Text);
                }
                return 0;
            }

            return 1;
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
