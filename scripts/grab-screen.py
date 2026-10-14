"""全屏截图（用于无头/远程验证 GUI）。"""
import sys
from PIL import ImageGrab

out = sys.argv[1] if len(sys.argv) > 1 else "screenshot.png"
img = ImageGrab.grab()
img.save(out)
print("saved", out, img.size)
