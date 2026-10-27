export const PROMPT_HELPER_CSHARP = `using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace UChan.Platform.Windows.Assets
{
    public static class PromptHelper
    {
        [STAThread]
        public static int Main(string[] args)
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
                MatchCollection matches = Regex.Matches(input, "\"((?:\\\\.|[^\"\\\\])*)\"");
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
