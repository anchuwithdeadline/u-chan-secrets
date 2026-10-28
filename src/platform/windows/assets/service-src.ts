export const SERVICE_HOST_CSHARP = `using System;
using System.Diagnostics;
using System.ServiceProcess;
using System.Threading;

namespace UChan.Platform.Windows.Assets
{
    public class UChanService : ServiceBase
    {
        private Process _process;
        private readonly string[] _args;
        private volatile bool _stopping;
        private string _targetExe;
        private string _targetArgs;

        public UChanService(string[] args)
        {
            ServiceName = "UChanSecrets";
            _args = args;
        }

        protected override void OnStart(string[] args)
        {
            _stopping = false;
            string[] effectiveArgs = (args != null && args.Length > 0) ? args : _args;
            string targetExe = null;
            string targetArgs = "";

            if (effectiveArgs != null && effectiveArgs.Length > 0)
            {
                targetExe = effectiveArgs[0];
                if (effectiveArgs.Length > 1)
                {
                    string[] rest = new string[effectiveArgs.Length - 1];
                    Array.Copy(effectiveArgs, 1, rest, 0, rest.Length);
                    targetArgs = string.Join(" ", rest);
                }
            }
            else
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string targetFile = System.IO.Path.Combine(baseDir, "service-target.txt");
                if (System.IO.File.Exists(targetFile))
                {
                    string[] lines = System.IO.File.ReadAllLines(targetFile);
                    if (lines.Length > 0)
                    {
                        targetExe = lines[0].Trim();
                        if (lines.Length > 1)
                        {
                            targetArgs = lines[1].Trim();
                        }
                    }
                }
            }

            if (string.IsNullOrEmpty(targetExe))
            {
                throw new InvalidOperationException("No target executable specified for UChanSecrets service.");
            }

            _targetExe = targetExe;
            _targetArgs = targetArgs;
            StartChild();
        }

        private void StartChild()
        {
            if (_stopping) return;
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = _targetExe;
            psi.Arguments = _targetArgs;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;

            string logFile = System.IO.Path.GetFullPath(System.IO.Path.Combine(baseDir, "..", "service.log"));
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            Process proc = new Process();
            proc.StartInfo = psi;
            proc.EnableRaisingEvents = true;
            proc.OutputDataReceived += (s, e) => {
                if (!string.IsNullOrEmpty(e.Data)) {
                    try { System.IO.File.AppendAllText(logFile, string.Format("[{0:s}] {1}", DateTime.Now, e.Data) + Environment.NewLine); } catch {}
                }
            };
            proc.ErrorDataReceived += (s, e) => {
                if (!string.IsNullOrEmpty(e.Data)) {
                    try { System.IO.File.AppendAllText(logFile, string.Format("[{0:s}] [ERR] {1}", DateTime.Now, e.Data) + Environment.NewLine); } catch {}
                }
            };
            proc.Exited += OnChildExited;
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            _process = proc;
        }

        private void OnChildExited(object sender, EventArgs e)
        {
            if (_stopping) return;
            Thread.Sleep(500);
            if (_stopping) return;
            try
            {
                StartChild();
            }
            catch
            {
            }
        }

        protected override void OnStop()
        {
            _stopping = true;
            if (_process != null && !_process.HasExited)
            {
                try
                {
                    Process killer = Process.Start("taskkill.exe", string.Format("/F /T /PID {0}", _process.Id));
                    if (killer != null)
                    {
                        killer.WaitForExit(5000);
                    }
                }
                catch
                {
                    try
                    {
                        _process.Kill();
                    }
                    catch
                    {
                    }
                }
            }
        }

        public static void Main(string[] args)
        {
            ServiceBase.Run(new UChanService(args));
        }
    }
}
`
