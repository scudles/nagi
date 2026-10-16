// 确认仅在当前请求仍有效且收到布尔 true 时生效；取消不等待 UI 或超时。
export function waitForConfirmation(request, signal) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (approved) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      resolve(approved === true && !signal?.aborted)
    }
    const cancel = () => finish(false)
    if (signal?.aborted) return cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    try { Promise.resolve(request()).then(finish, cancel) }
    catch { cancel() }
  })
}

export function createConfirmationGate({ timeoutMs = 30000 } = {}) {
  const pending = new Map()
  return {
    async request(id, signal) {
      // 同一 token 不得替换仍在等待的操作。
      if (pending.has(id)) return false
      let timer
      let entry
      try {
        return await waitForConfirmation(() => new Promise((resolve) => {
          entry = { resolve, signal }
          pending.set(id, entry)
          timer = setTimeout(() => resolve(false), timeoutMs)
          timer.unref?.()
        }), signal)
      } finally {
        clearTimeout(timer)
        if (pending.get(id) === entry) pending.delete(id)
      }
    },
    resolve(id, approved) {
      const entry = pending.get(id)
      if (!entry || entry.signal?.aborted) {
        pending.delete(id)
        return { ok: false, error: '没有等待中的确认' }
      }
      pending.delete(id)
      entry.resolve(approved === true)
      return { ok: true }
    }
  }
}
