export const AUTH_HELPER_CSHARP = `using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace UChan.Platform.Windows.Assets
{
    public static class AuthHelper
    {
        private const uint PROCESS_QUERY_INFORMATION = 0x0400;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint PROCESS_DUP_HANDLE = 0x0040;
        private const uint TOKEN_QUERY = 0x0008;
        private const uint DUPLICATE_SAME_ACCESS = 0x0002;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(
            IntPtr hSourceProcessHandle,
            IntPtr hSourceHandle,
            IntPtr hTargetProcessHandle,
            out IntPtr lpTargetHandle,
            uint dwDesiredAccess,
            bool bInheritHandle,
            uint dwOptions);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNamedPipeClientProcessId(IntPtr pipeHandle, out uint clientProcessId);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private static string GetProcessUserSid(uint pid)
        {
            IntPtr hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hProcess == IntPtr.Zero)
            {
                hProcess = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid);
            }
            if (hProcess == IntPtr.Zero) return null;

            try
            {
                IntPtr hToken;
                if (!OpenProcessToken(hProcess, TOKEN_QUERY, out hToken))
                {
                    return null;
                }

                try
                {
                    using (WindowsIdentity identity = new WindowsIdentity(hToken))
                    {
                        if (identity.User != null)
                        {
                            return identity.User.Value;
                        }
                    }
                }
                finally
                {
                    CloseHandle(hToken);
                }
            }
            finally
            {
                CloseHandle(hProcess);
            }
            return null;
        }

        public static int Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("Usage: auth-helper <serverPid> [targetSid]");
                return 1;
            }

            uint serverPid;
            if (!uint.TryParse(args[0], out serverPid))
            {
                Console.Error.WriteLine("Invalid server PID");
                return 1;
            }

            string targetSid = args.Length > 1 ? args[1] : null;
            bool hasTargetSid = !string.IsNullOrEmpty(targetSid) && !string.Equals(targetSid, "dummy", StringComparison.OrdinalIgnoreCase);

            long pipeHandle = 0;
            if (args.Length > 2)
            {
                long.TryParse(args[2], out pipeHandle);
            }

            string matchedSid = null;
            string fallbackNonSystemSid = null;
            string anySid = null;

            IntPtr hServer = OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_INFORMATION, false, serverPid);
            if (hServer != IntPtr.Zero)
            {
                try
                {
                    // Exact handle of this connection when the server passes it; otherwise scan.
                    int start = pipeHandle > 0 ? (int)pipeHandle : 4;
                    int end = pipeHandle > 0 ? (int)pipeHandle + 4 : 0x10000;
                    for (int h = start; h < end; h += 4)
                    {
                        IntPtr hLocal;
                        if (DuplicateHandle(hServer, (IntPtr)h, GetCurrentProcess(), out hLocal, 0, false, DUPLICATE_SAME_ACCESS))
                        {
                            try
                            {
                                uint candidatePid;
                                if (GetNamedPipeClientProcessId(hLocal, out candidatePid) && candidatePid != 0 && candidatePid != serverPid)
                                {
                                    string sid = GetProcessUserSid(candidatePid);
                                    if (!string.IsNullOrEmpty(sid))
                                    {
                                        if (hasTargetSid && string.Equals(sid, targetSid, StringComparison.OrdinalIgnoreCase))
                                        {
                                            matchedSid = sid;
                                            break;
                                        }

                                        if (!string.Equals(sid, "S-1-5-18", StringComparison.OrdinalIgnoreCase))
                                        {
                                            fallbackNonSystemSid = sid;
                                        }

                                        if (anySid == null)
                                        {
                                            anySid = sid;
                                        }
                                    }
                                }
                            }
                            finally
                            {
                                CloseHandle(hLocal);
                            }
                        }
                    }
                }
                finally
                {
                    CloseHandle(hServer);
                }
            }

            string clientSid = matchedSid ?? fallbackNonSystemSid ?? anySid;

            // Fail closed: if clientSid could not be identified on any pipe handle, reject
            if (string.IsNullOrEmpty(clientSid))
            {
                Console.Error.WriteLine("Could not identify client process on pipe");
                return 1;
            }

            // Verify string sid parses as SecurityIdentifier
            try
            {
                SecurityIdentifier secId = new SecurityIdentifier(clientSid);
            }
            catch
            {
                Console.Error.WriteLine("Resolved SID is invalid");
                return 1;
            }

            if (hasTargetSid && !string.Equals(clientSid, targetSid, StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine("SID mismatch: expected " + targetSid + " but got " + clientSid);
                return 1;
            }

            Console.WriteLine("AUTHORIZED:" + clientSid);
            return 0;
        }
    }
}
`
