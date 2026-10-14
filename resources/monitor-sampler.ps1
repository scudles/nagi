# 凪 Nagi · 前台窗口采样器（M3 活动监测）
# 常驻进程：Add-Type 编译一次 Win32 调用，之后每 Interval 秒向 stdout 输出一行：
#     <utc_ms><TAB><pid><TAB><app><TAB><title>
# 只做「读 + 输出」，不落盘、不联网——隐私过滤是调用方（主进程）的职责。
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File monitor-sampler.ps1 -Interval 5
#
# 重要：本文件必须以「UTF-8 带 BOM」保存。
#   Windows PowerShell 5.1 在无 BOM 时按系统代码页（中文 Windows = GBK）解析脚本，
#   中文注释会被拆错字节、甚至吞掉换行，导致后续语句被并入注释而静默失效。
param([int]$Interval = 5)

$ErrorActionPreference = 'SilentlyContinue'

# 输出编码：调用方（Node）以 utf8 解码 stdout。
# 不处理时 PowerShell 按系统代码页输出（中文 Windows = GBK），中文窗口标题到达 Node 会变乱码，
# 使隐私黑名单里的中文规则（*密码*/*银行* 等）失效。这里直接用 UTF-8 StreamWriter 写标准输出，
# 不依赖 Console.OutputEncoding（后者在 stdout 被重定向时并不可靠）。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$stdout = $null
try {
    $stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
    $stdout.AutoFlush = $true
} catch { $stdout = $null }

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
    $line = $ts.ToString() + "`t" + $snap
    if ($stdout) {
        $stdout.WriteLine($line)
    } else {
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
    }
    Start-Sleep -Seconds $Interval
}
