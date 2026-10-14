"""枚举顶层窗口，找凪的桌宠窗/工作台窗（验证用）。"""
import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32
EnumWindows = user32.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
GetWindowText = user32.GetWindowTextW
GetWindowText.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
IsWindowVisible = user32.IsWindowVisible
GetWindowRect = user32.GetWindowRect
GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
GetWindowThreadProcessId = user32.GetWindowThreadProcessId
GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]

# electron 进程 pid 集合
import subprocess
pids = set()
try:
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq electron.exe", "/FO", "CSV"],
                         capture_output=True, text=True).stdout
    for line in out.splitlines()[1:]:
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) > 1:
            try:
                pids.add(int(parts[1]))
            except ValueError:
                pass
except Exception as e:
    print("tasklist err", e)

results = []


def cb(hwnd, lparam):
    buf = ctypes.create_unicode_buffer(512)
    GetWindowText(hwnd, buf, 512)
    title = buf.value
    rect = wintypes.RECT()
    GetWindowRect(hwnd, ctypes.byref(rect))
    pid = wintypes.DWORD()
    GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    vis = bool(IsWindowVisible(hwnd))
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    if pid.value in pids or "nagi" in title.lower() or "凪" in title:
        results.append((hwnd, vis, (rect.left, rect.top, w, h), pid.value, title))
    return True


EnumWindows(EnumWindowsProc(cb), 0)

print("electron pids:", sorted(pids))
print("--- 窗口 ---")
for hwnd, vis, rect, pid, title in results:
    print(f"hwnd={hwnd} vis={vis} rect={rect} pid={pid} title={title!r}")
if not results:
    print("（无匹配窗口）")
