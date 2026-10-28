export const SERVICE_HOST_CSHARP = `using System;
using System.Diagnostics;
using System.ServiceProcess;

namespace UChan.Platform.Windows.Assets
{
    public class UChanService : ServiceBase
    {
        private Process _process;
        private readonly string[] _args;

        public UChanService(string[] args)
        {
            ServiceName = "UChanSecrets";
            _args = args;
        }

        protected override void OnStart(string[] args)
        {
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

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = targetExe;
            psi.Arguments = targetArgs;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;

            _process = Process.Start(psi);
        }

        protected override void OnStop()
        {
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
