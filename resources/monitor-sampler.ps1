# 凪 Nagi · 前台窗口采样器（M3 活动监测）
# 常驻进程：Add-Type 编译一次 Win32 调用，之后每 Interval 秒向 stdout 输出一行：
#     <utc_ms><TAB><pid><TAB><app><TAB><title>
# 只做「读 + 输出」，不落盘、不联网——隐私过滤是调用方（主进程）的职责。
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File monitor-sampler.ps1 -Interval 5
param([int]$Interval = 5)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class NagiForeground {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

    public static string Snapshot() {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "0\t\t";
        StringBuilder sb = new StringBuilder(1024);
        GetWindowText(h, sb, 1024);
        int pid = 0;
        GetWindowThreadProcessId(h, out pid);
        string title = sb.ToString();
        title = title.Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
        string app = "";
        try { app = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }
        return pid.ToString() + "\t" + app + "\t" + title;
    }
}
"@

while ($true) {
    $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $snap = [NagiForeground]::Snapshot()
    [Console]::Out.WriteLine($ts.ToString() + "`t" + $snap)
    [Console]::Out.Flush()
    Start-Sleep -Seconds $Interval
}
