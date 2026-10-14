// src/main/native-tools.js
// Electron 原生能力打包成统一工具返回结构：截屏 / 剪贴板 / 系统通知。

import { desktopCapturer, clipboard, Notification, screen, shell, app } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export function createNativeTools({ getWorkbenchWindow } = {}) {
  return {
    /** screenshot() —— 全屏截图存到临时目录，返回路径 */
    async screenshot() {
      try {
        const { width, height } = screen.getPrimaryDisplay().size
        const sources = await desktopCapturer.getSources(
          { types: ['screen'], thumbnailSize: { width: width * 2, height: height * 2 } },
          () => {}
        )
        const src = sources.find((s) => s.thumbnail) || sources[0]
        if (!src) return { ok: false, summary: '截屏失败：没有可用的屏幕源' }
        const png = src.thumbnail.toPNG()
        const dir = join(app.getPath('temp'), 'nagi-screenshots')
        await mkdir(dir, { recursive: true })
        const file = join(dir, `screen-${Date.now()}.png`)
        await writeFile(file, png)
        return {
          ok: true,
          summary: `已截屏：${file}（${png.length} 字节，${src.thumbnail.getSize().width}×${src.thumbnail.getSize().height}）`,
          data: { path: file }
        }
      } catch (err) {
        return { ok: false, summary: '截屏失败：' + err.message }
      }
    },

    async clipboardRead() {
      const text = clipboard.readText()
      return {
        ok: Boolean(text),
        summary: text ? `剪贴板内容（${text.length} 字符）：\n${text.slice(0, 2000)}` : '剪贴板为空或无文本'
      }
    },

    async clipboardWrite({ text } = {}) {
      clipboard.writeText(String(text ?? ''))
      return { ok: true, summary: `已写入剪贴板（${String(text ?? '').length} 字符）` }
    },

    /** notify {title, body} */
    async notify({ title, body } = {}) {
      try {
        if (!Notification.isSupported()) return { ok: false, summary: '当前系统不支持通知' }
        const n = new Notification({ title: `凪 · ${title || '提醒'}`, body: String(body || '') })
        n.on('click', () => {
          const win = getWorkbenchWindow ? getWorkbenchWindow() : null
          if (win) {
            win.show()
            win.focus()
          }
        })
        n.show()
        return { ok: true, summary: `已发通知：${title || ''} ${body || ''}`.trim() }
      } catch (err) {
        return { ok: false, summary: '通知失败：' + err.message }
      }
    }
  }
}

/** 供"打开截图所在文件夹"用 */
export function revealFile(path) {
  shell.showItemInFolder(path)
}
