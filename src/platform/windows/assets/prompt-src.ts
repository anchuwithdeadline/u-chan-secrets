export const PROMPT_HELPER_CSHARP = `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace UChan.Platform.Windows.Assets
{
    public static class PromptHelper
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

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
            string lpCommandLine,
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
            if (Process.GetCurrentProcess().SessionId == 0)
            {
                return RelayToActiveSession(args);
            }
            return RunDialog(args);
        }

        private static int RelayToActiveSession(string[] args)
        {
            uint sessionId = WTSGetActiveConsoleSessionId();
            if (sessionId == 0xFFFFFFFF)
            {
                Console.Error.WriteLine("No active user session");
                return 1;
            }

            IntPtr hUserToken;
            if (!WTSQueryUserToken(sessionId, out hUserToken))
            {
                Console.Error.WriteLine("WTSQueryUserToken failed: " + Marshal.GetLastWin32Error());
                return FallbackWtsMessage(args, sessionId);
            }

            IntPtr hPrimaryToken;
            if (!DuplicateTokenEx(hUserToken, 0x10000000, IntPtr.Zero, 2, 1, out hPrimaryToken))
            {
                CloseHandle(hUserToken);
                Console.Error.WriteLine("DuplicateTokenEx failed: " + Marshal.GetLastWin32Error());
                return FallbackWtsMessage(args, sessionId);
            }
            CloseHandle(hUserToken);

            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(sa);
            sa.bInheritHandle = true;

            IntPtr hReadPipe, hWritePipe;
            if (!CreatePipe(out hReadPipe, out hWritePipe, ref sa, 0))
            {
                CloseHandle(hPrimaryToken);
                return FallbackWtsMessage(args, sessionId);
            }

            SetHandleInformation(hReadPipe, 1, 0);

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(si);
            si.lpDesktop = @"winsta0\\default";
            si.dwFlags = 0x00000100;
            si.hStdOutput = hWritePipe;
            si.hStdError = hWritePipe;

            IntPtr lpEnv = IntPtr.Zero;
            CreateEnvironmentBlock(out lpEnv, hPrimaryToken, false);

            string exePath = Process.GetCurrentProcess().MainModule.FileName;
            StringBuilder sb = new StringBuilder();
            sb.Append("\\"").Append(exePath).Append("\\"");
            foreach (string a in args)
            {
                sb.Append(" \\"").Append(a.Replace("\\"", "\\\\\\\"")).Append("\\"");
            }

            PROCESS_INFORMATION pi;
            bool created = CreateProcessAsUser(
                hPrimaryToken,
                null,
                sb.ToString(),
                ref sa,
                ref sa,
                true,
                0x00000400, // CREATE_UNICODE_ENVIRONMENT
                lpEnv,
                null,
                ref si,
                out pi
            );

            CloseHandle(hWritePipe);
            CloseHandle(hPrimaryToken);
            if (lpEnv != IntPtr.Zero)
            {
                DestroyEnvironmentBlock(lpEnv);
            }

            if (!created)
            {
                CloseHandle(hReadPipe);
                Console.Error.WriteLine("CreateProcessAsUser failed: " + Marshal.GetLastWin32Error());
                return FallbackWtsMessage(args, sessionId);
            }

            CloseHandle(pi.hThread);

            StringBuilder output = new StringBuilder();
            byte[] buf = new byte[1024];
            uint bytesRead;
            while (ReadFile(hReadPipe, buf, (uint)buf.Length, out bytesRead, IntPtr.Zero) && bytesRead > 0)
            {
                output.Append(Encoding.UTF8.GetString(buf, 0, (int)bytesRead));
            }
            CloseHandle(hReadPipe);

            WaitForSingleObject(pi.hProcess, 130000);
            uint exitCode;
            GetExitCodeProcess(pi.hProcess, out exitCode);
            CloseHandle(pi.hProcess);

            if (exitCode == 0)
            {
                if (output.Length > 0)
                {
                    Console.Write(output.ToString());
                }
                return 0;
            }

            // If child process failed or could not start, and this is a confirm prompt, fall back to WTSSendMessage
            return FallbackWtsMessage(args, sessionId);
        }

        private static int FallbackWtsMessage(string[] args, uint sessionId)
        {
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

            if (mode != "confirm")
            {
                return 1;
            }

            List<string> lines = ParseLines(rawLines);
            string msg = "Phrase: " + phrase + "\\n\\n" + string.Join("\\n", lines.ToArray()) + "\\n\\nApprove this action?";
            int response;
            bool sent = WTSSendMessage(
                IntPtr.Zero,
                (int)sessionId,
                title,
                title.Length * 2,
                msg,
                msg.Length * 2,
                0x00000004 | 0x00000040 | 0x00040000, // MB_YESNO | MB_ICONQUESTION | MB_TOPMOST
                120,
                out response,
                true
            );

            // response == 6 is IDYES
            if (sent && response == 6)
            {
                return 0;
            }
            return 1;
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
