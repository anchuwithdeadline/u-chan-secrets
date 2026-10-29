// SYSTEM-side fixture: emits only the non-text F24 canary, never password data.
public static class UChanProbeCanary
{
    [System.Runtime.InteropServices.DllImport("user32.dll",SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] values,int size);
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] private struct MOUSE { public int x,y; public uint data,flags,time; public System.IntPtr extra; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] private struct KEY { public ushort key,scan; public uint flags,time; public System.IntPtr extra; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit)] private struct UNION { [System.Runtime.InteropServices.FieldOffset(0)] public MOUSE mouse; [System.Runtime.InteropServices.FieldOffset(0)] public KEY keyboard; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] private struct INPUT { public uint kind; public UNION data; }
    public static uint Send()
    {
        INPUT[] values=new INPUT[2];
        values[0].kind=1;values[0].data.keyboard.key=0x87;
        values[1].kind=1;values[1].data.keyboard.key=0x87;values[1].data.keyboard.flags=2;
        return SendInput(2,values,System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
    }
}
