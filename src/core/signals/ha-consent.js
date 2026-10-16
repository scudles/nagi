import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function mayControlHa(grants, quiet = false) {
  return Boolean(grants?.readAt && grants?.controlAt && !quiet)
}

export class HaConsent {
  constructor(userDataDir) {
    this.file = join(userDataDir, 'signals', 'ha.json')
  }

  status() {
    if (!existsSync(this.file)) return { readAt: null, controlAt: null }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return { readAt: Number(raw.readAt) || null, controlAt: Number(raw.controlAt) || null }
    } catch { return { readAt: null, controlAt: null } }
  }

  write(next) {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = this.file + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify({ version: 1, ...next }), 'utf8')
    renameSync(temp, this.file)
    return this.status()
  }

  allowRead(at = Date.now()) {
    const current = this.status()
    return this.write({ ...current, readAt: current.readAt || at })
  }

  allowControl(at = Date.now()) {
    const current = this.status()
    if (!current.readAt) throw new Error('请先授权只读设备状态')
    return this.write({ ...current, controlAt: at })
  }

  revokeControl() {
    const current = this.status()
    if (!current.readAt) return current
    return this.write({ ...current, controlAt: null })
  }

  revokeAll() {
    rmSync(this.file, { force: true })
    return { readAt: null, controlAt: null }
  }
}
