/* tools/live2d-viewer/viewer.js
 * Live2D 模型预览器 · 交互逻辑
 * 运行库（index.html 中按序加载）：live2dcubismcore.min.js → pixi.min.js → cubism4.min.js
 *
 * 能力：
 *   · 加载本地模型（服务端扫描模型根目录，页面可切换）
 *   · 滚轮缩放（跟随指针）/ 拖动平移 / 单击模型戳一戳
 *   · 表情列表与切换、动作组触发与停止
 *   · 物理演算 / 自动眨眼 / 呼吸 / 视线跟随 / 水平镜像 开关
 */
(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const el = {
    stage: $('stage'),
    canvas: $('canvas'),
    overlay: $('overlay'),
    toast: $('toast'),
    busy: $('busy'),
    busyText: $('busy-text'),
    modelSelect: $('model-select'),
    reload: $('btn-reload'),
    board: $('chk-board'),
    exprList: $('expr-list'),
    expCount: $('exp-count'),
    expClear: $('btn-exp-clear'),
    motionList: $('motion-list'),
    motCount: $('mot-count'),
    motionStop: $('btn-motion-stop'),
    chkPhysics: $('chk-physics'),
    chkBlink: $('chk-blink'),
    chkBreath: $('chk-breath'),
    chkFocus: $('chk-focus'),
    chkMirror: $('chk-mirror'),
    capPhysics: $('cap-physics'),
    capBlink: $('cap-blink'),
    capBreath: $('cap-breath'),
    zoom: $('zoom'),
    zoomVal: $('zoom-val'),
    btnFit: $('btn-fit'),
    btnRecenter: $('btn-recenter'),
    info: $('info')
  }

  const S = {
    app: null,
    model: null,
    rel: '',
    baseScale: 1,
    zoom: 1,
    mirror: false,
    focusFollow: true,
    pokeGroup: null,
    saved: {},          // 被开关"摘掉"的物理/眨眼/呼吸实例
    drag: null,
    seq: 0,             // 加载序号，防止快速切换时串台
    activeExpr: null
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
  const tryDo = (fn, dflt) => { try { return fn() } catch { return dflt } }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  /* ================= 小提示 ================= */
  let toastTimer = 0
  function toast(msg, kind = '') {
    el.toast.textContent = msg
    el.toast.className = 'toast' + (kind ? ' ' + kind : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 1800)
  }
  function setBusy(on, text = '加载中…') {
    el.busyText.textContent = text
    el.busy.classList.toggle('hidden', !on)
  }
  function fatal(msg) {
    el.overlay.textContent = '无法启动预览'
    el.toast.textContent = msg
    el.toast.className = 'toast err'
    el.toast.classList.remove('hidden')
    console.error('[viewer]', msg)
  }

  /* ================= 模型能力查询 ================= */
  const listExpressions = () =>
    tryDo(() => (S.model.internalModel.settings.expressions || []).map((d) => d.Name).filter(Boolean), [])
  const listMotionGroups = () =>
    tryDo(() => Object.keys(S.model.internalModel.settings.motions || {}), [])
  const motionCount = (g) =>
    tryDo(() => (S.model.internalModel.settings.motions[g] || []).length, 0)

  function pickPokeGroup() {
    const groups = listMotionGroups()
    for (const p of ['TapBody', 'Tap', 'Poke', 'Touch']) if (groups.includes(p)) return p
    return groups.find((g) => /tap|poke|touch|hit/i.test(g) && g.toLowerCase() !== 'idle') || null
  }

  /* ================= 视图变换 ================= */
  function applyView() {
    const m = S.model
    if (!m) return
    const s = S.baseScale * S.zoom
    m.scale.set(s * (S.mirror ? -1 : 1), s)
  }

  function syncZoomUI() {
    el.zoom.value = String(Math.round(S.zoom * 100))
    el.zoomVal.textContent = Math.round(S.zoom * 100) + '%'
  }

  function fitView(resetZoom = true) {
    const m = S.model
    if (!m) return
    const w = S.app.screen.width
    const h = S.app.screen.height
    const mw = m.internalModel.originalWidth || m.width
    const mh = m.internalModel.originalHeight || m.height
    m.anchor.set(0.5, 0.5)
    S.baseScale = Math.min(w / mw, h / mh) * 0.92
    if (resetZoom) S.zoom = 1
    applyView()
    m.x = w / 2
    m.y = h / 2
    syncZoomUI()
  }

  function applyZoom(next, ax, ay) {
    const m = S.model
    if (!m) return
    next = clamp(next, 0.15, 6)
    const k = next / S.zoom
    if (Math.abs(k - 1) < 1e-4) return
    S.zoom = next
    applyView()
    if (ax != null) {
      // 保持指针下的点不动
      m.x = ax - (ax - m.x) * k
      m.y = ay - (ay - m.y) * k
    }
    syncZoomUI()
  }

  function onResize() {
    const m = S.model
    if (!m) return
    const w = S.app.screen.width
    const h = S.app.screen.height
    const mw = m.internalModel.originalWidth || m.width
    const mh = m.internalModel.originalHeight || m.height
    S.baseScale = Math.min(w / mw, h / mh) * 0.92
    applyView()
    m.x = clamp(m.x, w * 0.2, w * 0.8)
    m.y = clamp(m.y, h * 0.2, h * 0.8)
  }

  /* ================= 表情 / 动作 ================= */
  function highlightExpr(name) {
    for (const b of el.exprList.querySelectorAll('.chip')) {
      b.classList.toggle('active', !!name && b.dataset.expr === name)
    }
  }

  async function applyExpression(name) {
    const m = S.model
    if (!m) return
    const ok = await tryDo(() => m.expression(name), false)
    if (ok || S.activeExpr === name) {
      S.activeExpr = name
      highlightExpr(name)
      toast('表情：' + name)
    } else {
      toast('表情切换失败：' + name, 'err')
    }
  }

  function clearExpression() {
    const em = tryDo(() => S.model.internalModel.motionManager.expressionManager, null)
    if (!em) return toast('该模型没有表情管理器', 'err')
    tryDo(() => em.resetExpression())
    S.activeExpr = null
    highlightExpr(null)
    toast('已清除表情')
  }

  function playMotion(group) {
    if (!S.model) return
    tryDo(() => S.model.motion(group))
    toast('动作组：' + group)
  }

  function stopMotions() {
    if (!S.model) return
    tryDo(() => S.model.internalModel.motionManager.stopAllMotions())
    toast('已停止动作（待机动作会自动恢复）')
  }

  function buildPanels() {
    const exprs = listExpressions()
    const groups = listMotionGroups()

    // 表情
    el.expCount.textContent = exprs.length ? exprs.length + ' 个' : ''
    el.exprList.innerHTML = ''
    if (exprs.length) {
      for (const name of exprs) {
        const b = document.createElement('button')
        b.className = 'chip'
        b.dataset.expr = name
        b.textContent = name
        b.title = '应用表情 ' + name
        b.addEventListener('click', () => applyExpression(name))
        el.exprList.appendChild(b)
      }
    } else {
      el.exprList.innerHTML = '<span class="chip" style="cursor:default">模型未声明 Expressions</span>'
    }
    el.expClear.disabled = !exprs.length

    // 动作
    el.motCount.textContent = groups.length ? groups.length + ' 组' : ''
    el.motionList.innerHTML = ''
    if (groups.length) {
      for (const g of groups) {
        const b = document.createElement('button')
        b.className = 'chip'
        b.innerHTML = esc(g) + '<span class="n">' + motionCount(g) + '</span>'
        b.title = '播放 ' + g + ' 组动作（随机一个）'
        b.addEventListener('click', () => playMotion(g))
        el.motionList.appendChild(b)
      }
    } else {
      el.motionList.innerHTML = '<span class="chip" style="cursor:default">模型未声明 Motions</span>'
    }
    el.motionStop.disabled = !groups.length
  }

  /* ================= 开关 ================= */
  function setCap(input, cap, has) {
    input.disabled = !has
    input.closest('.chk').classList.toggle('off', !has)
    cap.textContent = has ? '' : '（未提供）'
  }

  function syncToggles() {
    const im = S.model ? S.model.internalModel : null
    S.saved = {}
    const caps = {
      physics: !!(im && im.physics),
      blink: !!(im && im.eyeBlink),
      breath: !!(im && im.breath)
    }
    setCap(el.chkPhysics, el.capPhysics, caps.physics)
    setCap(el.chkBlink, el.capBlink, caps.blink)
    setCap(el.chkBreath, el.capBreath, caps.breath)
    el.chkPhysics.checked = true
    el.chkBlink.checked = true
    el.chkBreath.checked = true
    el.chkFocus.checked = S.focusFollow
    el.chkMirror.checked = S.mirror
  }

  /** 把 internalModel 上的组件"摘掉/挂回"——这些组件在 update 里都是可选调用 */
  function setPart(key, on) {
    const im = S.model ? S.model.internalModel : null
    if (!im) return
    if (on) {
      if (S.saved[key]) {
        im[key] = S.saved[key]
        S.saved[key] = null
      }
    } else if (im[key]) {
      S.saved[key] = im[key]
      im[key] = null
    }
  }

  /* ================= 信息面板 ================= */
  function fillInfo() {
    const m = S.model
    const im = m.internalModel
    const blink = (tryDo(() => im.settings.getEyeBlinkParameters(), []) || []).join(', ')
    const lip = (tryDo(() => im.settings.getLipSyncParameters(), []) || []).join(', ')
    const rows = [
      ['文件', S.rel],
      ['画布', im.originalWidth + ' × ' + im.originalHeight],
      ['贴图', (m.textures ? m.textures.length : 0) + ' 张'],
      ['表情', listExpressions().length + ' 个'],
      ['动作', listMotionGroups().map((g) => g + '×' + motionCount(g)).join(' / ') || '无'],
      ['物理', im.physics ? '模型提供 · 已启用' : '模型未提供'],
      ['眨眼组', blink || '无'],
      ['LipSync', lip || '无']
    ]
    el.info.innerHTML = rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('')
  }

  /* ================= 指针交互 ================= */
  function wirePointer() {
    const canvas = el.canvas

    canvas.addEventListener('wheel', (e) => {
      if (!S.model) return
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      applyZoom(S.zoom * Math.exp(-e.deltaY * 0.0015), mx, my)
    }, { passive: false })

    canvas.addEventListener('pointerdown', (e) => {
      if (!S.model || e.button !== 0) return
      tryDo(() => canvas.setPointerCapture(e.pointerId))
      S.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
      canvas.classList.add('dragging')
    })

    canvas.addEventListener('pointermove', (e) => {
      if (S.drag && S.drag.id === e.pointerId) {
        const dx = e.clientX - S.drag.x
        const dy = e.clientY - S.drag.y
        S.drag.x = e.clientX
        S.drag.y = e.clientY
        S.drag.moved += Math.abs(dx) + Math.abs(dy)
        S.model.x += dx
        S.model.y += dy
        return
      }
      focusFollow(e)
    })

    canvas.addEventListener('pointerup', (e) => {
      if (!S.drag || S.drag.id !== e.pointerId) return
      const moved = S.drag.moved
      S.drag = null
      canvas.classList.remove('dragging')
      tryDo(() => canvas.releasePointerCapture(e.pointerId))
      if (moved < 6) poke(e)          // 位移很小 → 视为点击
    })

    canvas.addEventListener('pointercancel', () => {
      S.drag = null
      canvas.classList.remove('dragging')
    })

    canvas.addEventListener('pointerleave', () => {
      if (S.model && S.focusFollow) tryDo(() => S.model.internalModel.focusController.focus(0, 0))
    })
  }

  function focusFollow(e) {
    const m = S.model
    if (!m || !S.focusFollow || S.drag) return
    const r = el.canvas.getBoundingClientRect()
    tryDo(() => m.focus(e.clientX - r.left, e.clientY - r.top))
  }

  function poke(e) {
    const m = S.model
    if (!m) return
    const r = el.canvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const inside = tryDo(() => m.getBounds(false).contains(x, y), false)
    if (!inside) return
    if (!S.pokeGroup) return toast('该模型没有可触发的动作组')
    const hits = (tryDo(() => m.hitTest(x, y), []) || [])
    tryDo(() => m.motion(S.pokeGroup))
    toast(hits.length ? '戳到 ' + hits.join(' / ') + ' → ' + S.pokeGroup : '戳一戳 → ' + S.pokeGroup)
  }

  /* ================= 顶栏 / 侧栏事件 ================= */
  function wireUI() {
    el.modelSelect.addEventListener('change', () => loadModel(el.modelSelect.value))
    el.reload.addEventListener('click', () => loadModel(S.rel))
    el.board.addEventListener('change', () => el.stage.classList.toggle('board', el.board.checked))

    el.expClear.addEventListener('click', clearExpression)
    el.motionStop.addEventListener('click', stopMotions)

    el.chkPhysics.addEventListener('change', () => setPart('physics', el.chkPhysics.checked))
    el.chkBlink.addEventListener('change', () => setPart('eyeBlink', el.chkBlink.checked))
    el.chkBreath.addEventListener('change', () => setPart('breath', el.chkBreath.checked))
    el.chkMirror.addEventListener('change', () => { S.mirror = el.chkMirror.checked; applyView() })
    el.chkFocus.addEventListener('change', () => {
      S.focusFollow = el.chkFocus.checked
      if (!S.focusFollow && S.model) tryDo(() => S.model.internalModel.focusController.focus(0, 0))
    })

    el.zoom.addEventListener('input', () => {
      const w = S.app.screen.width
      const h = S.app.screen.height
      applyZoom(Number(el.zoom.value) / 100, w / 2, h / 2)
    })
    el.btnFit.addEventListener('click', () => fitView(true))
    el.btnRecenter.addEventListener('click', () => {
      if (!S.model) return
      S.model.x = S.app.screen.width / 2
      S.model.y = S.app.screen.height / 2
    })

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return
      if (e.key === '0') fitView(true)
      if (e.key === 'm' || e.key === 'M') {
        el.chkMirror.checked = !el.chkMirror.checked
        S.mirror = el.chkMirror.checked
        applyView()
      }
    })
  }

  /* ================= 加载模型 ================= */
  function modelUrl(rel) {
    return '/models/' + rel.split('/').map(encodeURIComponent).join('/')
  }

  async function loadModel(rel) {
    const seq = ++S.seq
    S.rel = rel
    setBusy(true, '加载模型 ' + rel + ' …')
    el.overlay.textContent = '加载中…'

    if (S.model) {
      tryDo(() => S.app.stage.removeChild(S.model))
      tryDo(() => S.model.destroy())
      S.model = null
    }
    S.saved = {}
    S.activeExpr = null

    try {
      const m = await PIXI.live2d.Live2DModel.from(modelUrl(rel), { autoInteract: false, autoUpdate: true })
      if (seq !== S.seq) { tryDo(() => m.destroy()); return }   // 已被更新的加载取代
      S.model = m
      S.app.stage.addChild(m)
      S.pokeGroup = pickPokeGroup()
      fitView(true)
      buildPanels()
      syncToggles()
      fillInfo()
      localStorage.setItem('nagi-viewer-model', rel)
      history.replaceState(null, '', '?model=' + encodeURIComponent(rel))
      setBusy(false)
      toast('已加载 ' + rel)
    } catch (err) {
      if (seq !== S.seq) return
      setBusy(false)
      const msg = (err && err.message) || String(err)
      el.overlay.textContent = '加载失败'
      toast('模型加载失败：' + msg, 'err')
      console.error('[viewer] 模型加载失败：', err)
    }
  }

  function fillModelSelect(list) {
    el.modelSelect.innerHTML = ''
    for (const rel of list) {
      const o = document.createElement('option')
      o.value = rel
      o.textContent = rel
      el.modelSelect.appendChild(o)
    }
  }

  /* ================= 状态浮层 ================= */
  function tickOverlay() {
    if (!S.model) return
    const fps = S.app ? Math.round(S.app.ticker.FPS) : 0
    const name = S.rel.split('/').slice(-2, -1)[0] || S.rel
    el.overlay.innerHTML =
      '<b>' + esc(name) + '</b> · FPS ' + fps + ' · 缩放 ' + Math.round(S.zoom * 100) + '%' +
      (S.mirror ? ' · 镜像' : '')
  }

  /* ================= 启动 ================= */
  async function boot() {
    if (typeof window.Live2DCubismCore === 'undefined') {
      return fatal('缺少 Live2D Cubism Core（/vendor/live2dcubismcore.min.js 未加载）')
    }
    if (!window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
      return fatal('缺少 pixi / pixi-live2d-display 运行库')
    }

    PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker)

    S.app = new PIXI.Application({
      view: el.canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      resizeTo: el.stage
    })
    S.app.renderer.on('resize', onResize)

    wireUI()
    wirePointer()

    try {
      const res = await fetch('/api/models')
      const data = await res.json()
      const models = data.models || []
      fillModelSelect(models)
      if (!models.length) {
        el.overlay.textContent = '（模型目录下没有 *.model3.json）'
        toast('模型目录为空，可用 --root 指定其他目录', 'err')
        return
      }
      const want = new URLSearchParams(location.search).get('model') ||
        localStorage.getItem('nagi-viewer-model')
      const rel = models.includes(want) ? want : models[0]
      el.modelSelect.value = rel
      await loadModel(rel)
    } catch (err) {
      fatal('无法获取模型列表：' + ((err && err.message) || err))
    }

    setInterval(tickOverlay, 500)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
