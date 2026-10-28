// Disposable fixture only. Records F24 canary counts, never ordinary keystrokes or images.
using System;
using System.IO;
using System.IO.Pipes;
using System.Drawing;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

public static class UChanDesktopAttacker
{
    private delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    private static Hook callback = ObserveCanary;
    private static int canaries;
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int kind, Hook hook, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [StructLayout(LayoutKind.Sequential)] private struct MOUSE { public int x,y; public uint data,flags,time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] private struct KEY { public ushort key,scan; public uint flags,time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] private struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint kind; public UNION data; }

    private static IntPtr ObserveCanary(int code, IntPtr message, IntPtr data)
    {
        if(code >= 0 && Marshal.ReadInt32(data) == 0x87) canaries++;
        return CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    private static uint Key(ushort key)
    {
        INPUT[] values = new INPUT[2];
        values[0].kind=1; values[0].data.keyboard.key=key;
        values[1].kind=1; values[1].data.keyboard.key=key; values[1].data.keyboard.flags=2;
        return SendInput(2,values,Marshal.SizeOf(typeof(INPUT)));
    }
    private static void Pump(int milliseconds)
    {
        Stopwatch watch=Stopwatch.StartNew();
        while(watch.ElapsedMilliseconds < milliseconds){ Application.DoEvents(); Thread.Sleep(5); }
    }
    private static int Markers(Bitmap image)
    {
        int count=0;
        for(int x=0;x<image.Width;x+=4) for(int y=0;y<image.Height;y+=4)
        { Color c=image.GetPixel(x,y); if(c.R==1 && c.G==254 && c.B==71) count++; }
        return count;
    }
    private static bool RenderMarker(IntPtr window, int width, int height)
    {
        using(Bitmap bitmap=new Bitmap(width,height)) using(Graphics graphics=Graphics.FromImage(bitmap))
        {
            IntPtr dc=graphics.GetHdc();
            try { PrintWindow(window,dc,0); } finally { graphics.ReleaseHdc(dc); }
            return Markers(bitmap)>32;
        }
    }
    private static bool DeniedDesktop(string name,uint access)
    {
        IntPtr desktop=OpenDesktop(name,0,false,access);
        if(desktop!=IntPtr.Zero){CloseDesktop(desktop);return false;}
        return Marshal.GetLastWin32Error()==5;
    }
    private static void Put(List<string> results,string key,object value){results.Add(key+"="+value);}

    [STAThread] public static int Main(string[] args)
    {
        List<string> results=new List<string>();
        IntPtr hook=IntPtr.Zero;
        try
        {
            bool medium=!WindowsIdentity.GetCurrent().IsSystem && !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
            Put(results,"nonElevated",medium);
            if(!medium)throw new InvalidOperationException("Non-elevated caller required");
            hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0);
            if(hook==IntPtr.Zero)throw new InvalidOperationException("Hook positive control unavailable");
            bool captureControl;
            using(Form control=new Form())
            {
                control.Text="U-Chan disposable positive control";
                control.ClientSize=new Size(96,96); control.BackColor=Color.FromArgb(1,254,71); control.TopMost=true;
                control.Show(); ShowWindow(control.Handle,5); control.Activate(); control.Update(); Pump(200);
                captureControl=RenderMarker(control.Handle,128,128);
                Key(0x87); Pump(300);
                control.Close();
            }
            Put(results,"hookPositiveControl",canaries>0); Put(results,"capturePositiveControl",captureControl);
            if(canaries==0 || !captureControl)throw new InvalidOperationException("Positive control failed");
            canaries=0;
            File.WriteAllText(args[1]+".armed","ready");
            Stopwatch watch=Stopwatch.StartNew();
            while(!File.Exists(args[0]+".metadata") && watch.ElapsedMilliseconds<120000)Pump(20);
            string[] metadata=File.ReadAllLines(args[0]+".metadata");
            if(metadata.Length!=6 || metadata[4]!=args[2])throw new InvalidOperationException("Stale fixture metadata");
            Put(results,"runId",args[2]);
            Put(results,"desktopReadDenied",DeniedDesktop(metadata[0],1));
            Put(results,"desktopHookDenied",DeniedDesktop(metadata[0],8));
            Put(results,"desktopSwitchDenied",DeniedDesktop(metadata[0],0x100));
            bool pipeDenied=false,spoofDenied=false,connected=false;
            try {using(NamedPipeClientStream pipe=new NamedPipeClientStream(".",metadata[5],PipeDirection.Out)){pipe.Connect(300);connected=true;}}
            catch(UnauthorizedAccessException){pipeDenied=true;}
            catch(IOException e){pipeDenied=(e.HResult&0xffff)==5;Put(results,"replyPipeErrorCode",e.HResult&0xffff);}
            catch(TimeoutException){Put(results,"replyPipeErrorCode","timeout");}
            Put(results,"replyPipeConnectDenied",pipeDenied);
            Put(results,"replyPipeConnected",connected);
            try {using(NamedPipeServerStream pipe=new NamedPipeServerStream(metadata[1],PipeDirection.In,1)){}}
            catch(IOException){spoofDenied=true;} catch(UnauthorizedAccessException){spoofDenied=true;}
            Put(results,"replyPipeSpoofDenied",spoofDenied);
            IntPtr form=new IntPtr(long.Parse(metadata[2])), button=new IntPtr(long.Parse(metadata[3]));
            Put(results,"postClickAccepted",PostMessage(button,0xF5,IntPtr.Zero,IntPtr.Zero));
            Put(results,"sendInputCount",Key(0x0D));
            Put(results,"printWindowSawMarker",RenderMarker(form,500,420));
            bool screenMarker=false;
            try {
                Rectangle bounds=Screen.PrimaryScreen.Bounds;
                using(Bitmap image=new Bitmap(bounds.Width,bounds.Height)) using(Graphics graphics=Graphics.FromImage(image))
                { graphics.CopyFromScreen(bounds.Location,Point.Empty,bounds.Size); screenMarker=Markers(image)>32; }
            } catch(System.ComponentModel.Win32Exception) { }
            Put(results,"screenCaptureSawMarker",screenMarker);
            watch.Restart();
            while(!File.Exists(args[0]+".done") && watch.ElapsedMilliseconds<10000)Pump(20);
            Pump(100); Put(results,"protectedCanaryEvents",canaries);
        }
        catch(Exception e){Put(results,"errorType",e.GetType().Name);Put(results,"errorCode",e.HResult&0xffff);}
        finally {if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);}
        File.WriteAllLines(args[1]+".attacker",results);
        return 0;
    }
}
