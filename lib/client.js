/**
 * dsh-duplicate-file-check — client half.
 *
 * 分组面板（除来源目录外都可折叠，默认折叠）：
 *   ① 来源目录（公共参数）
 *   ② 完全一致文件校验（快速/严格）
 *   ③ 抓帧疑似重复（仅 MP4）
 *   ④ 批量改后缀
 *   ⑤ 随机文件名
 *   ⑥ 按大小重命名并移动
 *   ⑦ 按视频长度重命名并移动
 * 每个任务都有独立状态、独立进度条与独立开始按钮；执行期间全局互斥。
 */
window.__ModuleLoader__.load({
  id: 'dsh-duplicate-file-check',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    var PANEL_ID = 'duplicate-file-check'
    var API = '/dupfc/api'
    var TOKEN = ''


    var CSS = [
      '.dfc-root{padding:12px 14px;font-size:13px;height:100%;overflow:auto;color:var(--dsw-alias-label-primary,#1f2937)}',
      '.dfc-sec{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;margin-bottom:10px;overflow:hidden}',
      '.dfc-ph{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));user-select:none}',
      '.dfc-ph.fixed{cursor:default}',
      '.dfc-ph b{flex:none;font-size:13.5px}',
      '.dfc-label{margin-left:auto;color:var(--dsw-alias-label-secondary,#9ca3af);font-weight:400;font-size:11.5px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:62%;text-align:right}',
      '.dfc-caret{width:12px;color:var(--dsw-alias-label-secondary,#9ca3af)}',
      '.dfc-body{padding:10px 12px}',
      '.dfc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}',
      '.dfc-in{flex:1;min-width:200px;padding:4px 8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:transparent;color:inherit}',
      '.dfc-num{width:100px;padding:4px 8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:transparent;color:inherit}',
      '.dfc-sel{appearance:none;-webkit-appearance:none;width:auto;min-width:110px;padding:4px 26px 4px 8px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background-color:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));background-image:url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%276%27><path d=%27M0 0l5 6 5-6z%27 fill=%27%239ca3af%27/></svg>");background-repeat:no-repeat;background-position:right 8px center;color:var(--dsw-alias-label-primary,inherit);cursor:pointer}',
      '.dfc-runbar{display:flex;align-items:center;gap:12px;justify-content:space-between;background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.45);border-radius:8px;padding:8px 10px;margin-bottom:10px}',
      '.dfc-runbar .dfc-meta{color:#dc2626;font-weight:700;font-size:13px}',
      '.dfc-stop{background:#dc2626;color:#ffffff;border:1px solid #b91c1c;border-radius:8px;padding:9px 22px;font-size:15px;font-weight:800;letter-spacing:1px;cursor:pointer;box-shadow:0 3px 10px rgba(220,38,38,.45)}',
      '.dfc-stop:hover:not(:disabled){background:#ef4444;border-color:#dc2626;box-shadow:0 4px 14px rgba(220,38,38,.6)}',
      '.dfc-stop:active:not(:disabled){transform:translateY(1px)}',
      '.dfc-stop:disabled{opacity:.5;cursor:not-allowed}',
      '.dfc-sel:disabled{opacity:.5;cursor:not-allowed}',
      '.dfc-sel option{background:var(--dsw-alias-bg-layer-1,#1f2937);color:var(--dsw-alias-label-primary,#e5e7eb)}',
      '.dfc-btn{border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}',
      '.dfc-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}',
      '.dfc-btn.primary{background:#ffffff;color:#111827;border-color:#9ca3af;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10)}',
      '.dfc-btn.primary:hover:not(:disabled){background:#ffffff;border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}',
      '.dfc-btn.primary:disabled{background:rgba(0,0,0,.06);color:var(--dsw-alias-label-secondary,#9ca3af);border-color:var(--dsw-alias-border-l2,#e5e7eb);box-shadow:none;filter:grayscale(1)}',
      '.dfc-btn:disabled{opacity:.5;cursor:not-allowed;background:rgba(0,0,0,.06);color:var(--dsw-alias-label-secondary,#9ca3af);border-color:var(--dsw-alias-border-l2,#e5e7eb);filter:grayscale(1)}',
      '.dfc-btn.danger:hover:not(:disabled){border-color:#b91c1c;color:#b91c1c}',
      '.dfc-dir{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:3px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));margin-bottom:4px}',
      '.dfc-help{margin-left:0;flex:none;width:18px;height:18px;line-height:16px;text-align:center;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:#ffffff;color:#374151;font-size:12px;font-weight:700;cursor:pointer;padding:0}',
      '.dfc-help:hover{border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}',
      '.dfc-help-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999}',
      '.dfc-help-card{background:#ffffff;color:#111827;border-radius:10px;padding:16px 18px;max-width:560px;width:calc(100% - 48px);max-height:70vh;overflow:auto;box-shadow:0 12px 32px rgba(0,0,0,.28)}',
      '.dfc-help-title{font-weight:700;font-size:14px;margin-bottom:10px}',
      '.dfc-help-body{font-size:12px;line-height:1.7}',
      '.dfc-help-item{margin-bottom:8px}',
      '.dfc-help-item b{color:#111827}',
      '.dfc-help-foot{text-align:right;margin-top:12px}',
      '.dfc-warn{color:#b45309;font-size:12px}',
      '.dfc-dir code{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dfc-meta{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px}',
      '.dfc-note{margin:6px 0 0;padding:6px 9px;border-left:3px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));border-radius:0 4px 4px 0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dfc-note b{color:var(--dsw-alias-label-primary,#374151);font-weight:600}',
      '.dfc-err{color:#b91c1c;font-size:12.5px}',
      '.dfc-fail{margin-top:6px;border-left:3px solid #b91c1c;padding:4px 8px;background:rgba(185,28,28,.05);border-radius:0 4px 4px 0;max-height:160px;overflow:auto}',
      '.dfc-failrow{display:flex;gap:6px;font-size:11.5px;line-height:1.5}',
      '.dfc-failname{color:#b91c1c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}',
      '.dfc-ok{color:#15803d;font-size:12.5px}',
      '.dfc-status{margin-top:8px;border-left:4px solid var(--dsw-alias-border-l2,#d1d5db);padding:6px 10px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));border-radius:0 6px 6px 0}',
      '.dfc-status.run{border-left-color:#2563eb}',
      '.dfc-status.err{border-left-color:#b91c1c}',
      '.dfc-phase{font-size:14.5px;font-weight:700;display:flex;align-items:center;gap:8px}',
      '.dfc-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;flex:none}',
      '.dfc-dot.run{background:#2563eb;animation:dfcp 1s ease-in-out infinite}',
      '.dfc-dot.err{background:#b91c1c}',
      '@keyframes dfcp{0%,100%{opacity:1}50%{opacity:.25}}',
      '.dfc-bar{height:5px;border-radius:3px;background:rgba(0,0,0,.08);overflow:hidden;margin:6px 0 4px}',
      '.dfc-bar>i{display:block;height:100%;background:#2563eb;transition:width .3s}',
      '.dfc-log{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.55;max-height:130px;overflow:auto;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#4b5563);margin:6px 0 0}',
      '.dfc-g{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:6px;margin:6px 0;overflow:hidden}',
      '.dfc-gh{padding:5px 8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));font-size:12px;font-weight:600}',
      '.dfc-f{display:flex;gap:8px;padding:3px 8px;border-top:1px dashed var(--dsw-alias-border-l2,#eceff3);font-size:11px}',
      '.dfc-f span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dfc-path{flex:1;min-width:0}',
      '.dfc-keep{color:#15803d}',
      '.dfc-browse{margin-top:8px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;overflow:hidden}',
      '.dfc-bh{display:flex;gap:8px;align-items:center;padding:6px 8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));font-size:12px}',
      '.dfc-bh code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dfc-blist{max-height:200px;overflow:auto}',
      '.dfc-bitem{padding:4px 10px;font-size:12px;cursor:pointer}',
      '.dfc-bitem:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}',
      '.dfc-broots{display:flex;gap:6px;flex-wrap:wrap;padding:6px 8px;border-bottom:1px dashed var(--dsw-alias-border-l2,#e5e7eb)}',
      '.dfc-radio{display:flex;gap:6px;align-items:center;font-size:12.5px;margin-right:14px}',
      '.dfc-entry{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;font-size:15px;line-height:1}',
    ].join('\n')

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dupfc]')) return
      var el = document.createElement('style')
      el.setAttribute('data-dupfc', '')
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /**
     * 调本机插件接口的统一封装。
     * 自动带 accept/JSON；写接口优先用 GET /config 返回的
     * X-Dupfc-Bootstrap 写进 x-dupfc-token，HttpOnly cookie 作为
     * 桌面端不保留 cookie 时的兜底。
     * 网络失败不抛异常，而是返回 { _status: 0, error }，调用方按统一格式处理。
     * @param {string} pathname 接口路径（如 '/video-intro/scan'）
     * @param {object} [init] fetch 配置（method/headers/body）
     * @returns {Promise<object>} 解析后的 JSON，附加 _status（HTTP 状态码）
     */
    function api(pathname, init) {
      var opts = Object.assign({}, init || {})
      var headers = Object.assign({ accept: 'application/json', 'x-dupfc-ui': '1' }, opts.headers || {})
      if (TOKEN) headers['x-dupfc-token'] = TOKEN
      opts.headers = headers
      opts.credentials = 'same-origin'
      return fetch(API + pathname, opts).then(function (r) {
        var boot = r.headers.get('x-dupfc-bootstrap')
        if (boot) TOKEN = boot
        return r.text().then(function (t) {
          var j = {}
          try { j = JSON.parse(t) } catch (e) { j = { error: 'HTTP ' + r.status + '，返回的不是 JSON' } }
          if (r.status === 403 && !opts._authRetry && pathname !== '/config') {
            opts._authRetry = true
            TOKEN = ''
            return api('/config').then(function () { return api(pathname, opts) })
          }
          return Object.assign({ _status: r.status }, j)
        })
      }).catch(function (e) {
        return { _status: 0, error: '连不上本机插件接口：' + (e && e.message ? e.message : e) + '（DSH 是否还没重启？）' }
      })
    }

    function fmtSize(n) {
      if (!n) return '0 B'
      var u = ['B', 'KB', 'MB', 'GB']
      var i = 0
      var v = n
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1 }
      return (Math.round(v * 10) / 10) + ' ' + u[i]
    }

    var clampNum = function (v, lo, hi, fallback) {
      var n = Number(v)
      if (!Number.isFinite(n)) return fallback
      return Math.min(hi, Math.max(lo, n))
    }

    /* ---------------- 通用小块 ---------------- */

    function Progress(props) {
      var t = props.task || {}
      if (!t.running && !t.total) return null
      var pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0
      return h('div', null,
        h('div', { className: 'dfc-bar' }, h('i', { style: { width: pct + '%' } })),
        h('div', { className: 'dfc-meta' }, t.done + ' / ' + t.total + '（' + pct + '%）'))
    }

    function Status(props) {
      var t = props.task || {}
      var cls = 'dfc-status' + (t.running ? ' run' : '') + (t.error ? ' err' : '')
      var dot = 'dfc-dot' + (t.running ? ' run' : '') + (t.error ? ' err' : '')
      return h('div', { className: cls },
        h('div', { className: 'dfc-phase' }, h('span', { className: dot }), t.phase || '空闲'),
        t.error ? h('div', { className: 'dfc-err', style: { marginTop: '4px' } }, t.error) : null,
        props.children || null,
        Progress({ task: t }),
        (t.log && t.log.length) ? h('pre', { className: 'dfc-log' }, t.log.slice(-10).join('\n')) : null)
    }

    function Section(props) {
      var hs = useState(false)
      var help = hs[0]
      var setHelp = hs[1]
      var collapsed = props.collapsed
      return h('div', { className: 'dfc-sec' },
        h('div', {
          className: 'dfc-ph' + (props.fixed ? ' fixed' : ''),
          onClick: props.fixed ? undefined : function () { props.onToggle(!collapsed) },
        },
          props.fixed ? null : h('span', { className: 'dfc-caret' }, collapsed ? '▸' : '▾'),
          h('b', null, props.title),
          props.help ? h('button', {
            className: 'dfc-help', title: '查看这一组的配置说明',
            onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); setHelp(true) },
          }, '?') : null,
          (collapsed && props.label) ? h('small', { className: 'dfc-label' }, props.label) : null),
        (!collapsed || props.fixed) ? h('div', { className: 'dfc-body' },
          props.hint ? h('div', { className: 'dfc-meta', style: { marginBottom: '8px' } }, props.hint) : null,
          props.children) : null,
        help ? h('div', { className: 'dfc-help-mask', onClick: function () { setHelp(false) } },
          h('div', { className: 'dfc-help-card', onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation() } },
            h('div', { className: 'dfc-help-title' }, props.title + ' · 配置说明'),
            h('div', { className: 'dfc-help-body' }, props.help.map(function (it) {
              return h('div', { className: 'dfc-help-item', key: it.name }, h('b', null, it.name), h('span', null, '：' + it.desc))
            })),
            h('div', { className: 'dfc-help-foot' }, h('button', { className: 'dfc-btn primary', onClick: function () { setHelp(false) } }, '知道了')))) : null)
    }

    function Browse(props) {
      var b = props.browse
      if (!b) return null
      return h('div', { className: 'dfc-browse' },
        h('div', { className: 'dfc-bh' },
          h('code', { title: b.path || '' }, b.path || '选择盘符'),
          b.parent ? h('button', { className: 'dfc-btn', onClick: function () { props.onOpen(b.parent) } }, '上一级') : null,
          h('button', { className: 'dfc-btn primary', onClick: props.onPick, disabled: !b.path }, props.pickLabel || '选这个目录'),
          h('button', { className: 'dfc-btn', onClick: props.onClose }, '关闭')),
        h('div', { className: 'dfc-broots' }, (b.roots || []).map(function (r) {
          return h('button', { key: r.path, className: 'dfc-btn', onClick: function () { props.onOpen(r.path) } }, r.name)
        })),
        h('div', { className: 'dfc-blist' },
          (b.dirs || []).length
            ? b.dirs.map(function (d) {
                return h('div', { key: d.path, className: 'dfc-bitem', onClick: function () { props.onOpen(d.path) } }, '📁 ' + d.name)
              })
            : h('div', { className: 'dfc-meta', style: { padding: '8px 10px' } }, '（没有子目录）')))
    }

    /* ---------------- 主面板 ---------------- */
    function Panel() {
      var [cfg, setCfg] = useState({
        sources: [], outputDir: '', durationToleranceMs: 100, frameFps: 2, frameSimilarity: 0.9, frameSeconds: 10, concurrency: 0,
        exactMode: 'fast', ext: 'mp4', uuidExt: 'mp4', sizeExt: 'mp4', durationExt: 'mp4',
        sizeTargetDir: '', durationTargetDir: '', unifyTargetDir: '', unifyWorkDir: '', keepOriginal: true,
        hdrMode: 'force8', smartCopy: true, encoder: 'libx264',
        fingerprintCache: true, fingerprintDb: '', syncFingerprintsRenameExt: false,
        syncFingerprintsUuid: false, syncFingerprintsBySize: false, syncFingerprintsByDuration: false,
      })
      // 同步保存链使用的最新配置；只靠 cfg 闭包会让快速连点后一个请求覆盖前一个。
      var cfgRef = useRef(null)
      if (cfgRef.current === null) cfgRef.current = cfg
      var [tasks, setTasks] = useState({})
      var [lock, setLock] = useState('')
      var [collapsed, setCollapsed] = useState({ exact: true, video: true, videoIntro: true, renameExt: true, uuid: true, bySize: true, byDuration: true, unify: true, emptyDirs: true })
      var [browse, setBrowse] = useState(null)
      var [msg, setMsg] = useState({ kind: '', text: '' })
      var [newDir, setNewDir] = useState('')
      var [tolText, setTolText] = useState('100')
      var [simText, setSimText] = useState('0.9')
      var [fsText, setFsText] = useState('10')
      var [fsFpsText, setFsFpsText] = useState('2')
      var [concText, setConcText] = useState('0')
      var [viSecText, setViSecText] = useState('40')
      var [viFpsText, setViFpsText] = useState('2')
      var [viOffText, setViOffText] = useState('10')
      var [viFailText, setViFailText] = useState('8')
      var [viResetText, setViResetText] = useState('15')
      var [viMadText, setViMadText] = useState('15')
      var [viDhText, setViDhText] = useState('4')
      var [viPhText, setViPhText] = useState('8')
      var [viCovText, setViCovText] = useState('90')
      var [viRunText, setViRunText] = useState('85')
      var [fromExt, setFromExt] = useState('dat')
      var [toExt, setToExt] = useState('mp4')
      var timer = useRef(null)
      var busyRef = useRef(false)
      var lastRunning = useRef(false)
      var busyTimer = useRef(null)
      var saveChain = useRef(Promise.resolve())
      var [busy, setBusy] = useState(false)
      var [fpMsg, setFpMsg] = useState({ kind: '', text: '' })
      var [fpStats, setFpStats] = useState(null)
      var [quickPath, setQuickPath] = useState('')
      var [quickBusy, setQuickBusy] = useState(false)
      var [quickRes, setQuickRes] = useState(null)

      useEffect(function () {
        api('/config').then(function (c) {
          if (c.error) { setMsg({ kind: 'err', text: c.error }); return }
          var next = Object.assign({ sources: [] }, c)
          cfgRef.current = next
          setCfg(next)
          if (c.clearedSources) {
            setMsg({ kind: '', text: '检测到 ' + c.clearedSources + ' 个来源目录不存在（未改动配置）' })
          }
          if (c.clearedDirs && c.clearedDirs.length) {
            setMsg({ kind: '', text: '检测到目录不存在（未改动配置）：' + c.clearedDirs.map(function (x) { return x.path }).join('、') })
          }
          setTolText(String(next.durationToleranceMs))
          setSimText(String(next.frameSimilarity))
        setFsText(String(next.frameSeconds || 10))
        setFsFpsText(String(next.frameFps || 2))
          setConcText(String(next.concurrency || 0))
          setViSecText(String(next.videoIntroSeconds || 40))
          setViFpsText(String(next.videoIntroFps || 2))
          setViOffText(String(next.videoIntroOffset || 0))
          setViFailText(String(next.videoIntroFailMax ?? 8))
          setViResetText(String(next.videoIntroFailReset ?? 15))
          setViMadText(String(next.videoIntroMadMax ?? 15))
          setViDhText(String(next.videoIntroDHashMax ?? 4))
          setViPhText(String(next.videoIntroPHashMax ?? 8))
          setViCovText(String(next.videoIntroCoverage ?? 90))
          setViRunText(String(next.videoIntroRunRatio ?? 85))
        })
        poll()
        loadFpStats()
        return function () { if (timer.current) clearInterval(timer.current) }
      }, [])

      function clearBusy() {
        busyRef.current = false
        setBusy(false)
        if (busyTimer.current) { clearTimeout(busyTimer.current); busyTimer.current = null }
      }

      function beep() {
        try {
          var AC = window.AudioContext || window.webkitAudioContext
          if (!AC) return
          var ac = new AC()
          var o = ac.createOscillator()
          var g = ac.createGain()
          o.type = 'sine'; o.frequency.value = 880
          g.gain.setValueAtTime(0.0001, ac.currentTime)
          g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.02)
          g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.4)
          o.connect(g); g.connect(ac.destination)
          o.start(); o.stop(ac.currentTime + 0.45)
          setTimeout(function () { try { ac.close() } catch (e) {} }, 900)
        } catch (e) {}
      }

      /**
       * 每 1.5 秒拉一次 /status，刷新所有任务进度与全局锁。
       * 只有它持续轮询，界面上的 done/total/phase/result 才会动；
       * 从“有任务在跑”变为“全部结束”时响一声，提醒主人回来看结果。
       * 同时负责在服务端已接单后解除 busy（按钮禁用）。
       */
      function poll() {
        if (timer.current) return
        timer.current = setInterval(function () {
          api('/status').then(function (s) {
            if (s.error) return
            setTasks(s.tasks || {})
            var anyRunning = Object.keys(s.tasks || {}).some(function (k) { return s.tasks[k] && s.tasks[k].running })
            var active = anyRunning || !!s.lock || busyRef.current
            if ((lastRunning.current || busyRef.current) && !active) { beep(); loadFpStats() }
            lastRunning.current = anyRunning
            setLock(s.lock || '')
            if (busyRef.current && (s.lock || Object.keys(s.tasks || {}).some(function (k) { return s.tasks[k] && s.tasks[k].running }))) {
              clearBusy()
            }
          })
        }, 1500)
      }

      function applyTaskResponse(r, okText) {
        if (r._status === 0) { setMsg({ kind: 'err', text: r.error }); return false }
        if (r.error) { setMsg({ kind: 'err', text: r.error }); return false }
        if (okText) setMsg({ kind: 'ok', text: okText })
        return true
      }

      function currentConfig() {
        // 以 cfgRef 为基准：addSource/removeSource 会先同步更新 ref，
        // 这里若仍读旧 cfg 闭包，紧接着点“开始”会把新来源覆盖掉。
        return Object.assign({}, cfgRef.current || cfg, {
          durationToleranceMs: clampNum(tolText, 0, 10000, cfg.durationToleranceMs),
          frameSimilarity: clampNum(simText, 0.1, 1, cfg.frameSimilarity),
          frameSeconds: clampNum(fsText, 1, 120, cfg.frameSeconds || 10),
          frameFps: clampNum(fsFpsText, 1, 5, cfg.frameFps || 2),
          concurrency: clampNum(concText, 0, 32, cfg.concurrency || 0),
          videoIntroSeconds: clampNum(viSecText, 1, 60, cfg.videoIntroSeconds || 40),
          videoIntroFps: clampNum(viFpsText, 1, 5, cfg.videoIntroFps || 2),
          videoIntroOffset: clampNum(viOffText, 0, Math.min(20, Math.max(0, clampNum(viSecText, 1, 60, 40) - 5)), cfg.videoIntroOffset || 0),
          videoIntroFailMax: clampNum(viFailText, 1, 100, cfg.videoIntroFailMax || 8),
          videoIntroFailReset: clampNum(viResetText, 1, 300, cfg.videoIntroFailReset || 15),
          videoIntroMadMax: clampNum(viMadText, 1, 64, cfg.videoIntroMadMax || 15),
          videoIntroDHashMax: clampNum(viDhText, 0, 7, cfg.videoIntroDHashMax ?? 4),
          videoIntroPHashMax: clampNum(viPhText, 0, 24, cfg.videoIntroPHashMax ?? 8),
          videoIntroCoverage: clampNum(viCovText, 50, 100, cfg.videoIntroCoverage || 90),
          videoIntroRunRatio: clampNum(viRunText, 50, 100, cfg.videoIntroRunRatio || 85),
        })
      }

      // 表单里的即时编辑：同步更新 ref，onBlur 的 currentConfig 才不会丢刚输入的值。
      function updateCfgLocal(patch) {
        var next = Object.assign({}, cfgRef.current || cfg, patch)
        cfgRef.current = next
        setCfg(next)
      }

      function saveConfig(patch) {
        // 合并到最新配置，而不是调用时的旧 cfg 闭包。
        var next = Object.assign({}, cfgRef.current || cfg, patch)
        cfgRef.current = next
        setCfg(next)
        var p = saveChain.current.then(function () {
          return api('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) })
        })
        saveChain.current = p.catch(function () {})
        return p.then(function (r) {
            if (r.error) { setMsg({ kind: 'err', text: r.error }); return false }
            // 服务端会剔除不存在的来源目录，以它返回的配置为准，别让旧状态把它写回来
            if (r.config) {
              var srv = Object.assign({}, r.config)
              if (r.missingSources && r.missingSources.length) {
                setMsg({ kind: '', text: '来源目录暂时不存在（配置已保留）：' + r.missingSources.join('、') })
              }
              cfgRef.current = srv
              setCfg(srv)
            }
            return true
          })
      }

      function commitNumbers() {
        var next = currentConfig()
        setTolText(String(next.durationToleranceMs))
        setSimText(String(next.frameSimilarity))
        setFsText(String(next.frameSeconds))
        setFsFpsText(String(next.frameFps || 2))
        setConcText(String(next.concurrency))
        setViSecText(String(next.videoIntroSeconds || 40))
        setViFpsText(String(next.videoIntroFps || 2))
        setViOffText(String(next.videoIntroOffset || 0))
        setViFailText(String(next.videoIntroFailMax ?? 8))
        setViResetText(String(next.videoIntroFailReset ?? 15))
        setViMadText(String(next.videoIntroMadMax ?? 15))
        setViDhText(String(next.videoIntroDHashMax ?? 4))
        setViPhText(String(next.videoIntroPHashMax ?? 8))
        setViCovText(String(next.videoIntroCoverage ?? 90))
        setViRunText(String(next.videoIntroRunRatio ?? 85))
        saveConfig(next)
      }

      /** 四个改名/移动任务共用的“同步指纹记录”勾选。 */
      function syncCheck(key, label) {
        return h('label', { className: 'dfc-radio', title: '任务成功后把指纹记录里的路径一起改掉；失败不影响文件操作' },
          h('input', {
            type: 'checkbox', checked: cfg[key] === true,
            onChange: function (e) { saveConfig({ [key]: e.target.checked }) },
            disabled: locked,
          }), label)
      }

      function loadFpStats() {
        api('/fingerprints/stats').then(function (r) {
          if (r._status === 0 || r.error) return
          setFpStats(r)
        })
      }

      function cleanupFingerprints() {
        if (locked) return
        if (!window.confirm('清理指纹记录？会删除文件已不存在、大小已变化的记录；修改时间变化不会删除。离线目录会跳过。')) return
        setFpMsg({ kind: '', text: '正在清理…' })
        api('/fingerprints/cleanup', { method: 'POST' }).then(function (r) {
          if (r._status === 0 || r.error) { setFpMsg({ kind: 'err', text: r.error || '清理失败' }); return }
          var nextStats = Object.assign({}, fpStats || {}, r)
          if (r.afterRows !== undefined && r.afterRows !== null) nextStats.rows = r.afterRows
          setFpStats(nextStats)
          loadFpStats()
          setFpMsg({ kind: 'ok', text: '清理完成：检查 ' + r.scanned + ' 条，删除 ' + r.deleted + ' 条，清理孤儿关联 ' + (r.orphanLuma || 0) + ' 帧 / ' + (r.orphanBands || 0) + ' band，跳过离线目录 ' + r.skippedDirs + ' 个' })
        })
      }

      /** 强制清空所有 profile 的指纹缓存；只重置数据库，不改任何文件。 */
      function clearAllFingerprints() {
        if (locked) return
        if (!window.confirm('强制清空所有指纹缓存？下次扫描会重新抓帧，耗时较长；不会删除或移动任何视频文件。')) return
        setFpMsg({ kind: '', text: '正在清空…' })
        api('/fingerprints/clear', { method: 'POST' }).then(function (r) {
          if (r._status === 0 || r.error) { setFpMsg({ kind: 'err', text: r.error || '清空失败' }); return }
          setFpStats(Object.assign({}, fpStats || {}, { rows: 0, bandRows: 0, lumaRows: 0 }))
          loadFpStats()
          setFpMsg({ kind: 'ok', text: '已清空：删除 ' + r.deleted + ' 条指纹记录，关联表已清空（' + r.beforeRows + ' -> ' + r.afterRows + '）' })
        })
      }

      function openBrowse(target, mode) {
        api('/browse?path=' + encodeURIComponent(target || '')).then(function (r) {
          if (r.error) { setMsg({ kind: 'err', text: r.error }); return }
          if (r.fallback && r.requested) {
            setMsg({ kind: '', text: '「' + r.requested + '」不存在，已回到 ' + (r.path || '盘符列表') })
          }
          setBrowse(Object.assign({ mode: mode || 'source' }, r))
        })
      }

      function pickBrowse() {
        if (!browse || !browse.path) return
        var base = cfgRef.current || cfg
        var patch = {}
        if (browse.mode === 'output') patch.outputDir = browse.path
        else if (browse.mode === 'sizeTarget') patch.sizeTargetDir = browse.path
        else if (browse.mode === 'durationTarget') patch.durationTargetDir = browse.path
        else if (browse.mode === 'unifyTarget') patch.unifyTargetDir = browse.path
        else if (browse.mode === 'unifyWork') patch.unifyWorkDir = browse.path
        else if (browse.mode === 'videoIntroOut') patch.videoIntroOutDir = browse.path
        else if ((base.sources || []).indexOf(browse.path) < 0) patch.sources = (base.sources || []).concat([browse.path])
        saveConfig(patch)
        setBrowse(null)
      }

      function addSource() {
        var v = newDir.trim()
        if (!v) return
        var base = cfgRef.current || cfg
        if ((base.sources || []).indexOf(v) >= 0) { setMsg({ kind: 'err', text: '这个目录已经在列表里了' }); return }
        saveConfig({ sources: (base.sources || []).concat([v]) })
        setNewDir('')
      }

      function removeSource(s) {
        var base = cfgRef.current || cfg
        saveConfig({ sources: (base.sources || []).filter(function (x) { return x !== s }) })
      }

      function stopAll() {
        if (busyRef.current) return
        api('/stop', { method: 'POST' }).then(function (r) { applyTaskResponse(r, r.note) })
      }

      /**
       * 启动一个任务：POST 接单后立即进入 busy，靠 /status 轮询确认真跑起来。
       * 6 秒兜底解锁，防止接口异常导致按钮永久禁用；
       * 若服务端已加锁或任意任务在跑，则提前 clearBusy。
       * @param {string} pathname 开始接口路径
       * @param {string} okText 接单成功的提示文案
       * @param {object} [body] 可选 JSON 请求体
       */
      function start(pathname, okText, body) {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
        // 先把当前输入落盘，避免 onBlur 还没发完就开始用旧配置
        saveConfig(currentConfig()).then(function (saved) {
          if (!saved) { clearBusy(); return }
          var opts = { method: 'POST' }
          if (body) { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(body) }
          api(pathname, opts).then(function (r) {
            var ok = applyTaskResponse(r, okText)
            poll()
            if (!ok) { clearBusy(); return }
            // 服务器已接单：保持禁用，等状态轮询看到任务在跑（或 6 秒兜底）再解锁
            if (busyTimer.current) clearTimeout(busyTimer.current)
            busyTimer.current = setTimeout(clearBusy, 6000)
            setTimeout(function () {
              api('/status').then(function (s) {
                if (s.error) return
                setTasks(s.tasks || {})
                setLock(s.lock || '')
                if (s.lock || Object.keys(s.tasks || {}).some(function (k) { return s.tasks[k] && s.tasks[k].running })) clearBusy()
              })
            }, 300)
          })
        })
      }

      function deleteExact() {
        if (!window.confirm('删除完全一致文件：每组只保留最早的一个，其余删除。\n不可撤销，确定继续？')) return
        start('/exact/delete', '删除已执行')
      }

      function moveSuspects() {
        if (!cfg.outputDir) { setMsg({ kind: 'err', text: '先设置疑似重复输出目录' }); return }
        if (!window.confirm('把疑似重复视频移动到：\n' + cfg.outputDir + '\n并按 1xxxxx.mp4 递增重命名。确定继续？')) return
        start('/video/move', '移动已执行')
      }

      function resetFiles(pathname, label, opts) {
        var extra = opts && opts.extras ? "\n分组目录/对比目录里记录之外的文件会统一 UUID 改名移到 resetFail。" : ""
        if (!window.confirm(label + "：把已移动的文件搬回各自原来的目录？\n已被删除的会跳过；原目录不存在时会报错，文件留在原处。" + extra)) return
        api(pathname, { method: "POST" }).then(function (r) {
          if (r.error) { setMsg({ kind: "err", text: r.error }); return }
          if (!r.ok) { setMsg({ kind: "err", text: r.error || "复位失败" }); return }
          var text = "复位完成：恢复 " + (r.restored || 0) + " 个，已被删除 " + (r.deleted || 0) + " 个" + ((r.resetFail || 0) ? "，记录外文件 " + r.resetFail + " 个已移入 resetFail" : "") + ((r.left || 0) ? "，留在原处 " + r.left + " 个" : "")
          setMsg({ kind: r.missingDirs && r.missingDirs.length ? "err" : "", text: text })
        })
      }

      function moveIntroSuspects() {
        if (!cfg.videoIntroOutDir) { setMsg({ kind: 'err', text: '先设置本模块的疑似重复输出目录' }); return }
        if (!window.confirm('把「忽略片头」模块检出的疑似重复文件按组移动：\n' + cfg.videoIntroOutDir + '\n每组一个子文件夹（重复组_001、重复组_002…），组内保留原文件名。确定继续？')) return
        start('/video-intro/move', '移动已执行')
      }

      /** 指定文件快速查重：只查已有指纹缓存，不再扫全目录。 */
      function findIntroFile() {
        var p = String(quickPath || '').trim()
        if (!p) { setMsg({ kind: 'err', text: '先填写要查重的视频完整路径' }); return }
        setQuickBusy(true)
        setQuickRes(null)
        api('/video-intro/find', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p }),
        }).then(function (r) {
          setQuickBusy(false)
          if (r.error) { setQuickRes({ ok: false, error: r.error }); return }
          setQuickRes(r)
        }).catch(function (e) {
          setQuickBusy(false)
          setQuickRes({ ok: false, error: String((e && e.message) || e) })
        })
      }

      var anyRunning = Object.keys(tasks).some(function (k) { return tasks[k] && tasks[k].running })
      var locked = anyRunning || !!lock || busy

      var t = function (k) { return tasks[k] || {} }
      var toggle = function (k) {
        return function (v) { setCollapsed(Object.assign({}, collapsed, (function () { var o = {}; o[k] = v; return o })())) }
      }
      var HINTS = {
        exact: '处理对象：来源目录（上方列表）里的全部文件',
        video: '处理对象：来源目录里的 MP4 视频；并发数在上方「来源目录」统一设置',
        videoIntro: '处理对象：来源目录里的 MP4 视频；并发数用上方「来源目录」的公共设置，本模块只独立设置抓帧时长/片头容差/失败容忍/输出目录',
        renameExt: '处理对象：来源目录里的指定后缀文件',
        uuid: '处理对象：来源目录里的指定后缀文件',
        emptyDirs: '处理对象：来源目录（上方列表）下的所有子目录（来源目录本身不删）',
        bySize: '处理对象：来源目录里的指定后缀文件；并发数在上方「来源目录」统一设置',
        byDuration: '处理对象：来源目录里的指定后缀视频；并发数在上方「来源目录」统一设置',
        unify: '处理对象：来源目录里的 MOV / AVI / WMV（按文件头识别）；并发数在上方「来源目录」统一设置',
      }
      var HELP = {
        exact: [
          { name: '校验模式', desc: '快速=按大小分组后只比头/中/尾各 100KB；严格=同大小文件逐字节全量比对。严格更可靠但慢很多。' },
          { name: '删除完全一致文件', desc: '每组保留修改时间最早的一个，其余删除。删除不可撤销。' },
        ],
        video: [
          { name: '疑似重复输出目录', desc: '点「移动疑似重复」时，把检测出的疑似重复文件整组移动到这里（2 个及以上算一组，不做取舍），并重命名为 1xxxxx.mp4，方便人工确认。' },
          { name: '复位文件', desc: '移动后在输出目录写一份 _dupfc_restore.json 记录；复位时按它把文件搬回各自原目录，已被删除的跳过并计数，原目录不存在会报错并留在原处。只认本模块自己的移动记录。' },
          { name: '时长容差(ms)', desc: '两个视频时长差在这个范围内才归为同一组，默认 100ms。容差越大分组越宽松，也越容易误判。' },
          { name: '抓帧相似度', desc: '按抓帧频率抽帧、缩到 16×16 灰度后逐帧比较；相似度 ≥ 该值算同一段画面。默认 0.9。' },
          { name: '抓帧时长(秒)', desc: '只比对每个视频的前 N 秒，默认 10 秒。长视频同样只取前 N 秒，不会整段跳过。' },
          { name: '抓帧频率(帧/秒)', desc: '每秒抓几帧来比较，默认 2；调高更细但更慢，调低更快但容易漏。范围 1–5。' },
        ],
        videoIntro: [
          { name: '抓帧时长(秒)', desc: '只抓每条视频前 N 秒，默认 40、最大 60。片头按不超过 20 秒设计；片头更长时查不出来。' },
          { name: '抓帧频率(帧/秒)', desc: '每秒抓几帧来比较，默认 2；调高更细但更慢，调低更快但容易漏。范围 1–5。' },
          { name: '太短的视频会被跳过', desc: '有效帧少于 5 个的视频不参与比对，会记在日志里；调高抓帧频率或抓帧时长即可让它参与。' },
          { name: '片头容差(秒)', desc: '允许两个视频的第一对匹配帧错开多少秒，默认 10、最多 20；0 = 片头必须对齐。' },
          { name: '单帧灰度差上限', desc: '把两帧都缩成 16×16 黑白小图，逐点比较亮度，差值平均后不能超过这个数。默认 15（范围 1–64），数字越小越严格；画面暗、压缩重时可以适当调大。' },
          { name: 'dHash 差异上限', desc: 'dHash 是看画面明暗结构的指纹，两个指纹不同的位数不能超过这个数。默认 4，越小越严格。' },
          { name: 'pHash 差异上限', desc: 'pHash 是看画面整体轮廓的指纹。非纯色帧先比灰度 MAD；MAD 不中时，才要求 dHash 与 pHash 同时达标。纯色帧只比 MAD。默认 8，越小越严格。' },
          { name: '整组吻合率(%)', desc: '从候选发现帧到 A 段结束，命中帧数占两段剩余较短长度的比例；达到这个值才成组。默认 90%。' },
          { name: '连续吻合率(%)', desc: '同一段里最长连续命中占上述分母的比例。默认 85%，用来防止零散几帧碰巧相似拼成一组。' },
          { name: '失败容忍帧数', desc: '候选累计失败超过这个帧数就淘汰。默认 8；调大更宽松，但慢且更容易误判。' },
  { name: '失败清零所需连续成功帧数', desc: '失败计数不会因一次短暂成功就清零；只有连续成功达到这个帧数后才清零。默认 15；失败帧会从吻合率分母扣除，短暂特效不再把整段判死。' },
          { name: '逐帧反查', desc: '每个 A 帧都去反查其他视频的同指纹帧，每个 B 最多保留 4 个候选起点；候选按游标逐帧推进，不是只比第一帧。' },
          { name: '共享片头守卫', desc: '片头按最多 20 秒设计。片头相同、正片不同时，20 秒之后至少要 3 帧 pHash 轮廓一致，否则整组拒绝；不依赖中段抽样，也不靠热桶。' },
          { name: '时长守卫', desc: '两片时长差超过 15 秒或较短片 15% 的对直接跳过，避免同片头不同长度的长视频硬比。' },
          { name: '完全一致文件也参与', desc: '内容完全相同的文件不再先排除，会按 100% 吻合率进入本模块的疑似组；需要只交给「完全一致文件校验」时可改用那个模块。' },
          { name: '疑似重复输出目录', desc: '点「移动疑似重复」时，在目标目录下为每个相似组新建一个子文件夹（重复组_001、重复组_002…），把该组文件移进去并保留原文件名；与旧模块的输出目录互不影响。' },
          { name: '复位文件', desc: '每个重复组目录里都有一个 _dupfc_restore.json 记录文件，复位按它把文件搬回原目录；已被删除的跳过并计数；原目录不存在会报错并留在原处；分组目录里不在记录内的文件会统一 UUID 改名移到输出目录下的 resetFail。' },
        ],
        renameExt: [
          { name: '原后缀 / 新后缀', desc: '把来源目录里所有「原后缀」的文件改成「新后缀」，内容不动，同名目标自动跳过。' },
        ],
        uuid: [
          { name: '后缀', desc: '只处理这个后缀的文件，文件名改成 UUID，后缀保持不变。' },
        ],
        emptyDirs: [
          { name: '删除空文件夹', desc: '递归扫描来源目录下的所有子目录；某个目录里没有任何文件（也不含还有文件的子目录）就删掉它。深层先删，父目录变空后也会被删；来源目录本身、符号链接和联接点不动；.git/node_modules 等目录跳过，输出目录即使为空也保留。' },
        ],
        bySize: [
          { name: '后缀', desc: '只处理这个后缀的文件。' },
          { name: '目标目录', desc: '按文件大小从小到大排序，重命名为 100000 起的序号并移动到这里；不能放在来源目录内部。' },
          { name: '复位文件', desc: '目标目录里有 _dupfc_restore.json 记录；复位按它把文件搬回各自原目录，已删除的跳过计数，原目录不存在会报错并留在原处。' },
        ],
        byDuration: [
          { name: '后缀', desc: '只处理这个后缀的视频文件。' },
          { name: '目标目录', desc: '用 ffprobe 读真实时长，从短到长排序，重命名为 100000 起的序号并移动到这里；读不到时长的文件会跳过并报数量。' },
          { name: '复位文件', desc: '目标目录里有 _dupfc_restore.json 记录；复位按它把文件搬回各自原目录，已删除的跳过计数，原目录不存在会报错并留在原处。' },
        ],
        unify: [
          { name: '对比目录', desc: '按文件头识别出的 MOV/AVI/WMV 会先移动到这里，再转成同名 MP4。' },
          { name: '临时目录', desc: 'ffmpeg 先写 .part 到这里，校验通过后再搬回对比目录；留空则自动选一个 ffmpeg 能写的目录。' },
          { name: '保留原文件', desc: '勾选=原件留在对比目录（同名 .mp4 原件进 original\\）；取消=转码成功且校验通过后才删原件。' },
          { name: '智能直通', desc: '源本来就是 H.264+AAC 且非 HDR 时只换容器不重编码，秒级完成、零画质损失。' },
          { name: '编码器', desc: 'x264 兼容最好；NVENC/QSV/AMF 用硬件加速，失败会自动退回 x264 重试一次。' },
          { name: 'HDR 处理', desc: '强制 8bit=直接压成 SDR 可能偏暗；色调映射=用 zscale 转 SDR（需 ffmpeg 支持）；保留 HDR=输出 HEVC 10bit。' },
          { name: '复位文件', desc: '对比目录里有 _dupfc_restore.json 记录原件位置；复位把原件搬回来源目录，转码产出的 MP4 不在记录内，会统一 UUID 改名移到对比目录下的 resetFail。' },
        ],
      }
      var secProps = function (k) { return { collapsed: collapsed[k] !== false ? true : false, onToggle: toggle(k), hint: HINTS[k], help: HELP[k] } }
      var has = function (k) { return collapsed[k] !== false }

      return h('div', { className: 'dfc-root' },

        (anyRunning || lock) ? h('div', { className: 'dfc-runbar' },
          h('span', { className: 'dfc-meta' }, '正在执行：' + (lock || '任务')),
          h('button', { className: 'dfc-stop', onClick: stopAll, title: '立即终止正在运行的转码/扫描' }, '■ 强制停止')) : null,

        (msg.text) ? h('div', { className: msg.kind === 'err' ? 'dfc-err' : 'dfc-ok', style: { marginBottom: '8px' } }, msg.text) : null,

        /* ① 来源目录：公共、不可折叠 */
        h(Section, { title: '来源目录', fixed: true, help: [
          { name: '来源目录', desc: '所有任务的处理对象：递归扫描这些目录（含子目录），同一个文件只会处理一次；不存在的目录会被自动剔除。' },
          { name: '并发数', desc: '0=自动。统一编码转码 ≤4、读时长/扫文件头 ≤16、搬移 ≤8、完全一致与抓帧直接使用该值。' },
        ] },
          (cfg.sources || []).map(function (s) {
            return h('div', { className: 'dfc-dir', key: s },
              h('code', { title: s }, s),
              h('button', { className: 'dfc-btn', onClick: function () { removeSource(s) }, disabled: locked }, '移除'))
          }),
          h('div', { className: 'dfc-row' },
            h('input', {
              className: 'dfc-in', placeholder: '例如 D:\\videos 或 E:\\素材', value: newDir,
              onChange: function (e) { setNewDir(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') addSource() },
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse('', 'source') }, disabled: locked }, '浏览…'),
            h('button', { className: 'dfc-btn', onClick: addSource, disabled: locked }, '+ 添加')),
            h('div', { className: 'dfc-row' },
              h('span', null, '并发数'),
              h('input', {
                className: 'dfc-num', type: 'number', min: 0, max: 32, step: 1, value: concText,
                title: '0 = 自动；统一编码最多 4 个 ffmpeg，读时长/扫头最多 16，搬运最多 8',
                onChange: function (e) { setConcText(e.target.value) }, onBlur: commitNumbers, disabled: locked,
              }),
              h('span', { className: 'dfc-meta' }, '0 = 自动；统一编码上限 4，读时长/扫头上限 16，搬移上限 8')),
          browse && browse.mode === 'source' ? h(Browse, {
            browse: browse, pickLabel: '选这个目录',
            onOpen: function (p) { openBrowse(p, 'source') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null),

        /* 指纹缓存：按目录复用抓帧结果；清理按钮只动数据库，不动文件 */
        h(Section, { title: '指纹缓存', fixed: true, help: [
          { name: '启用缓存', desc: '抓帧扫描按“目录 + 绝对路径 + 大小 + 扫描参数”复用上次指纹；修改时间变化不影响命中。首次仍会抓帧，之后同目录重复扫描可跳过 ffmpeg。' },
          { name: '数据库路径', desc: '留空=默认 %LOCALAPPDATA%\\dupfc\\fingerprints.db；必须放在本机固定盘，不要放 DSH 用户目录。' },
          { name: '同步勾选', desc: '四个改名/移动任务成功后，顺手把数据库里的路径改掉；默认不勾，失败只记日志，不影响文件操作。' },
          { name: '清理无效记录', desc: '删除文件已不存在、大小已变化的记录；修改时间变化不会删除。父目录整个离线时跳过，不会清空整盘缓存。' },
          { name: '强制清空所有指纹缓存', desc: '删除数据库里的全部指纹记录，所有视频下次扫描都会重新抓帧；不会删除或移动任何视频文件。' },
        ] },
          h('div', { className: 'dfc-row' },
            h('label', { className: 'dfc-radio' },
              h('input', {
                type: 'checkbox', checked: cfg.fingerprintCache !== false,
                onChange: function (e) { saveConfig({ fingerprintCache: e.target.checked }) },
                disabled: locked,
              }), '启用指纹缓存（抓帧扫描复用）')),
          h('div', { className: 'dfc-row' },
            h('span', null, '数据库路径'),
            h('input', {
              className: 'dfc-in', placeholder: '留空=默认 %LOCALAPPDATA%\\dupfc\\fingerprints.db', value: cfg.fingerprintDb || '',
              onChange: function (e) { updateCfgLocal({ fingerprintDb: e.target.value }) },
              onBlur: function () { saveConfig(currentConfig()) },
              disabled: locked,
            })),
          h('div', { className: 'dfc-row' },
            h('button', { className: 'dfc-btn', onClick: cleanupFingerprints, disabled: locked }, '清理无效指纹记录'),
            h('button', { className: 'dfc-btn', onClick: clearAllFingerprints, disabled: locked }, '强制清空所有指纹缓存'),
            fpStats ? h('span', { className: 'dfc-meta' }, '当前 ' + fpStats.rows + ' 条 · 关联 ' + (fpStats.bandRows || 0) + ' band / ' + (fpStats.lumaRows || 0) + ' 帧 · ' + (fpStats.dbPath || cfg.fingerprintDb || '默认数据库')) : null),
          fpMsg.text ? h('div', { className: fpMsg.kind === 'err' ? 'dfc-err' : 'dfc-ok' }, fpMsg.text) : null,
          (function () {
            var d = cfg.dependencies || {}
            var errs = []
            if (d.ffmpeg && !d.ffmpeg.ok) errs.push('ffmpeg 缺失')
            if (d.ffprobe && !d.ffprobe.ok) errs.push('ffprobe 缺失')
            if (d.sqlite && !d.sqlite.ok) errs.push('node:sqlite 不可用（需要 Node 22.5+）')
            return errs.length ? h('div', { className: 'dfc-err' },
              '依赖未就绪：' + errs.join('、') + '。安装时请保留 optionalDependencies，或按 README 设置路径。') : null
          })()),

        /* ② 完全一致文件校验 */
        h(Section, Object.assign({ title: '完全一致文件校验', label: '对来源目录里的文件先按大小分组，再抽样或逐字节确认内容完全相同，可一键删除多余副本。' }, secProps('exact')),
          h('div', { className: 'dfc-row' },
            h('label', { className: 'dfc-radio' },
              h('input', {
                type: 'radio', name: 'exactMode', checked: cfg.exactMode !== 'strict',
                onChange: function () { saveConfig({ exactMode: 'fast' }) },
                disabled: locked,
              }), '快速校验（长度 + 头/中/尾各 100KB）'),
            h('label', { className: 'dfc-radio' },
              h('input', {
                type: 'radio', name: 'exactMode', checked: cfg.exactMode === 'strict',
                onChange: function () { saveConfig({ exactMode: 'strict' }) },
                disabled: locked,
              }), '严格校验（逐字节全量比对，慢）')),
          h('div', { className: 'dfc-row' },
            h('button', { className: 'dfc-btn primary', onClick: function () { start('/exact/scan', '完全一致扫描已开始') }, disabled: locked }, '开始扫描'),
            h('button', {
              className: 'dfc-btn danger',
              onClick: deleteExact,
              disabled: locked || !(t('exact').resultCount || (t('exact').result && t('exact').result.length)),
            }, '删除完全一致文件' + ((t('exact').resultCount || (t('exact').result && t('exact').result.length)) ? '（' + (t('exact').resultCount || t('exact').result.length) + ' 组）' : ''))),
          h(Status, { task: t('exact') },
            (t('exact').result && t('exact').result.length) ? h('div', null,
              h('div', { className: 'dfc-meta' }, '共 ' + (t('exact').resultCount || t('exact').result.length) + ' 组' + (t('exact').resultCount > 200 ? '（只展示前 200 组）' : '')),
              t('exact').result.slice(0, 20).map(function (g, i) {
                return h('div', { className: 'dfc-g', key: 'e' + i },
                  h('div', { className: 'dfc-gh' }, '组 ' + (i + 1) + ' · ' + fmtSize(g.size) + ' × ' + g.files.length),
                  g.files.map(function (f) {
                    return h('div', { className: 'dfc-f', key: f.path },
                      h('span', { className: 'dfc-path', title: f.path }, f.path),
                      h('span', { className: f.path === g.keep ? 'dfc-keep' : 'dfc-meta' }, f.path === g.keep ? '保留' : '重复'))
                  }))
              })) : null)),

        /* ③ 抓帧疑似重复 */
        h(Section, Object.assign({ title: '抓帧疑似重复校验_时长匹配', label: '仅处理来源目录里的 MP4：排除完全一致的文件后，按时长分组并比对前 N 秒画面（默认 10 秒，可配置），找出转码过的同一段视频；命中的整组文件都会被移动。' }, secProps('video')),
          h('div', { className: 'dfc-row' },
            h('span', null, '疑似重复输出目录'),
            h('input', {
              className: 'dfc-in', placeholder: '移动目标目录，会自动创建', value: cfg.outputDir || '',
              onChange: function (e) { updateCfgLocal({ outputDir: e.target.value }) },
              onBlur: function () { saveConfig(currentConfig()) },
              disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.outputDir || '', 'output') }, disabled: locked }, '浏览…')),
          browse && browse.mode === 'output' ? h(Browse, {
            browse: browse, pickLabel: '设为输出目录',
            onOpen: function (p) { openBrowse(p, 'output') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          h('div', { className: 'dfc-row' },
            h('span', null, '时长容差(ms)'),
            h('input', { className: 'dfc-num', type: 'number', min: 0, max: 10000, value: tolText, onChange: function (e) { setTolText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
            h('span', null, '抓帧相似度'),
            h('input', { className: 'dfc-num', type: 'number', min: 0.1, max: 1, step: 0.01, value: simText, onChange: function (e) { setSimText(e.target.value) }, onBlur: commitNumbers, disabled: locked })),
            h('div', { className: 'dfc-row' },
              h('span', null, '抓帧时长(秒)'),
              h('input', { className: 'dfc-num', type: 'number', min: 1, max: 120, step: 1, value: fsText, title: '默认 10 秒，最大 120 秒', onChange: function (e) { setFsText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
              h('span', null, '抓帧频率(帧/秒)'),
              h('input', { className: 'dfc-num', type: 'number', min: 1, max: 5, step: 1, value: fsFpsText, title: '默认每秒 2 帧', onChange: function (e) { setFsFpsText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
              h('span', { className: 'dfc-warn' }, '长视频只比对开头 N 秒，不做整段比对')),
          h('div', { className: 'dfc-row' },
            h('button', { className: 'dfc-btn primary', onClick: function () { start('/video/scan', '抓帧扫描已开始') }, disabled: locked }, '开始扫描'),
            h('button', {
              className: 'dfc-btn', onClick: moveSuspects,
              disabled: locked || !(t('video').resultCount || (t('video').result && t('video').result.length)),
            }, '移动疑似重复'),
            h('button', { className: 'dfc-btn', onClick: function () { resetFiles('/video/reset', '「时长匹配」输出目录') }, disabled: locked }, '复位文件')),
          h(Status, { task: t('video') },
            (t('video').result && t('video').result.length) ? (function () {
              var groups = t('video').result
              var total = 0
              var files = 0
              for (var i = 0; i < groups.length; i += 1) {
                var cs = groups[i].clusters || []
                total += cs.length
                for (var j = 0; j < cs.length; j += 1) files += (cs[j] || []).length
              }
              var seq = 0
              return h('div', null,
                h('div', { className: 'dfc-meta' }, '共 ' + total + ' 组相似视频，涉及 ' + files + ' 个文件'),
                groups.map(function (g, gi) {
                  return h('div', { key: 'v' + gi },
                    h('div', { className: 'dfc-gh' }, '时长 ≈ ' + g.durationMs + ' ms'),
                    (g.clusters || []).map(function (c) {
                      seq += 1
                      var no = seq
                      return h('div', { className: 'dfc-g', key: 'c' + no },
                        h('div', { className: 'dfc-gh' }, '相似组 ' + no + ' · ' + c.length + ' 个'),
                        c.map(function (f) { return h('div', { className: 'dfc-f', key: f.path }, h('span', { className: 'dfc-path', title: f.path }, f.path)) }))
                    }))
                }))
            })() : null)),

        /* ③.5 抓帧疑似重复_忽略片头（独立模块） */
        h(Section, Object.assign({ title: '抓帧疑似重复校验_忽略片头', label: '仅处理来源目录里的 MP4：按画面结构跨时长比对，允许片头错开，不再要求时长接近；命中的整组文件都会被移动。' }, secProps('videoIntro')),
          h('div', { className: 'dfc-row' },
            h('span', null, '疑似重复输出目录'),
            h('input', {
              className: 'dfc-in', placeholder: '本模块独立的移动目标目录，会自动创建', value: cfg.videoIntroOutDir || '',
              onChange: function (e) { updateCfgLocal({ videoIntroOutDir: e.target.value }) },
              onBlur: function () { saveConfig(currentConfig()) },
              disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.videoIntroOutDir || '', 'videoIntroOut') }, disabled: locked }, '浏览…')),
          browse && browse.mode === 'videoIntroOut' ? h(Browse, {
            browse: browse, pickLabel: '设为输出目录',
            onOpen: function (p) { openBrowse(p, 'videoIntroOut') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          h('div', { className: 'dfc-row' },
            h('span', null, '抓帧时长(秒)'),
            h('input', { className: 'dfc-num', type: 'number', min: 1, max: 60, step: 1, value: viSecText, title: '只抓每条视频前 N 秒，默认 40、最大 60；片头超过 20 秒查不出来', onChange: function (e) { setViSecText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
            h('span', null, '抓帧频率(帧/秒)'),
            h('input', { className: 'dfc-num', type: 'number', min: 1, max: 5, step: 1, value: viFpsText, title: '默认每秒 2 帧', onChange: function (e) { setViFpsText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
            h('span', null, '片头容差(秒)'),
            h('input', { className: 'dfc-num', type: 'number', min: 0, max: Math.min(20, Math.max(0, clampNum(viSecText, 1, 60, 40) - 5)), step: 1, value: viOffText, title: '允许片头错开的秒数；0=必须对齐；上限取「抓帧时长-5」与 20 的较小值', onChange: function (e) { setViOffText(e.target.value) }, onBlur: commitNumbers, disabled: locked })),
            h('div', { className: 'dfc-row' },
              h('span', null, '失败容忍帧数'),
              h('input', { className: 'dfc-num', type: 'number', min: 1, max: 100, step: 1, value: viFailText, title: '候选连续失败超过这个帧数就淘汰；默认 8；越大越宽松但更慢', onChange: function (e) { setViFailText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
              h('span', null, '片头最长按 20 秒算')),
            h('div', { className: 'dfc-row' },
              h('span', null, '失败计数清零所需连续成功帧数'),
              h('input', { className: 'dfc-num', type: 'number', min: 1, max: 300, step: 1, value: viResetText, title: '失败计数只有在之后连续成功这么多帧后才清零；默认 15；越大越严格', onChange: function (e) { setViResetText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
              h('span', null, '失败帧会从吻合率分母扣除')),
            h('div', { className: 'dfc-row' },
              h('span', null, '单帧灰度差上限'),
              h('input', { className: 'dfc-num', type: 'number', min: 1, max: 64, step: 1, value: viMadText, title: '默认 15；越小越严格', onChange: function (e) { setViMadText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
              h('span', null, 'dHash 差异上限'),
              h('input', { className: 'dfc-num', type: 'number', min: 0, max: 7, step: 1, value: viDhText, title: '默认 4；越小越严格；最大 7，8bit×8 band 的召回保证在 D≤7 内有效', onChange: function (e) { setViDhText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
              h('span', null, 'pHash 差异上限'),
              h('input', { className: 'dfc-num', type: 'number', min: 0, max: 24, step: 1, value: viPhText, title: '默认 8；越小越严格', onChange: function (e) { setViPhText(e.target.value) }, onBlur: commitNumbers, disabled: locked })),
            h('div', { className: 'dfc-row' },
              h('span', null, '整组吻合率(%)'),
              h('input', { className: 'dfc-num', type: 'number', min: 50, max: 100, step: 1, value: viCovText, title: '默认 90；越高越严格', onChange: function (e) { setViCovText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
              h('span', null, '连续吻合率(%)'),
              h('input', { className: 'dfc-num', type: 'number', min: 50, max: 100, step: 1, value: viRunText, title: '默认 85；越高越严格', onChange: function (e) { setViRunText(e.target.value) }, onBlur: commitNumbers, disabled: locked })),
          h('div', { className: 'dfc-row' },
            h('span', null, '指定文件快速查重'),
            h('input', {
              className: 'dfc-in', value: quickPath, placeholder: '填一个已扫描过的视频完整路径，例如 D:\\forTest\\ori.mp4',
              onChange: function (e) { setQuickPath(e.target.value) }, disabled: locked || quickBusy,
            }),
            h('button', { className: 'dfc-btn primary', onClick: findIntroFile, disabled: locked || quickBusy }, quickBusy ? '查询中…' : '快速查重')),
          quickRes ? h('div', { className: 'dfc-meta' },
            quickRes.ok === false ? ('查询失败：' + quickRes.error)
              : ('候选 ' + (quickRes.candidateCount || 0) + ' 个，命中 ' + ((quickRes.candidates || []).length) + ' 个' +
                ((quickRes.message) ? '；' + quickRes.message : ''))) : null,
          (quickRes && quickRes.ok && (quickRes.candidates || []).length) ? h('div', null,
            quickRes.candidates.map(function (c) {
              return h('div', { className: 'dfc-f', key: c.path },
                h('span', { className: 'dfc-path', title: c.path }, c.path),
                h('span', { className: 'dfc-meta' }, '吻合 ' + c.coveragePct + '% · 连续 ' + c.runPct + '% · 偏移 ' + c.offsetSec + 's'))
            })) : null,
          h('div', { className: 'dfc-row' },
            h('button', { className: 'dfc-btn primary', onClick: function () { start('/video-intro/scan', '抓帧扫描（忽略片头）已开始') }, disabled: locked }, '开始扫描'),
            h('button', {
              className: 'dfc-btn', onClick: moveIntroSuspects,
              disabled: locked || !(t('videoIntro').resultCount || (t('videoIntro').result && t('videoIntro').result.length)),
            }, '移动疑似重复'),
            h('button', { className: 'dfc-btn', onClick: function () { resetFiles('/video-intro/reset', '「忽略片头」输出目录', { extras: true }) }, disabled: locked }, '复位文件')),
          h(Status, { task: t('videoIntro') },
            (t('videoIntro').result && t('videoIntro').result.length) ? (function () {
              var groups = t('videoIntro').result
              var total = 0
              var files = 0
              for (var i = 0; i < groups.length; i += 1) {
                var cs = groups[i].clusters || []
                total += cs.length
                for (var j = 0; j < cs.length; j += 1) files += (cs[j] || []).length
              }
              var seq = 0
              return h('div', null,
                h('div', { className: 'dfc-meta' }, '共 ' + total + ' 组相似视频，涉及 ' + files + ' 个文件'),
                groups.map(function (g, gi) {
                  return h('div', { key: 'vi' + gi },
                    h('div', { className: 'dfc-gh' }, '时长 ≈ ' + g.durationMs + ' ms'),
                    (g.clusters || []).map(function (c) {
                      seq += 1
                      var no = seq
                      return h('div', { className: 'dfc-g', key: 'viC' + no },
                        h('div', { className: 'dfc-gh' }, '相似组 ' + no + ' · ' + c.length + ' 个'),
                        c.map(function (f) { return h('div', { className: 'dfc-f', key: f.path }, h('span', { className: 'dfc-path', title: f.path }, f.path)) }))
                    }))
                }))
            })() : null)),

        /* ④ 批量改后缀 */
        h(Section, Object.assign({ title: '批量改后缀', label: '把来源目录里指定后缀的文件只改扩展名（如 dat→mp4），不动内容，同名目标自动跳过。' }, secProps('renameExt')),
          h('div', { className: 'dfc-row' },
            h('span', null, '原后缀'),
            h('input', { className: 'dfc-num', value: fromExt, onChange: function (e) { setFromExt(e.target.value) }, disabled: locked }),
            h('span', null, '新后缀'),
            h('input', { className: 'dfc-num', value: toExt, onChange: function (e) { setToExt(e.target.value) }, disabled: locked }),
            h('button', { className: 'dfc-btn', onClick: function () { start('/rename-ext', '预览完成', { from: fromExt, to: toExt, dryRun: true }) }, disabled: locked }, '预览'),
            h('button', {
              className: 'dfc-btn primary', disabled: locked,
              onClick: function () {
                if (!window.confirm('把来源目录里的 .' + fromExt + ' 改名为 .' + toExt + '？同名目标会跳过。')) return
                start('/rename-ext', '改名已开始', { from: fromExt, to: toExt })
              },
            }, '开始执行')),
          h('div', { className: 'dfc-row' }, syncCheck('syncFingerprintsRenameExt', '同步指纹记录')),
          h(Status, { task: t('renameExt') })),

        /* ⑤ 随机文件名 */
        h(Section, Object.assign({ title: '随机文件名（UUID）', label: '把来源目录里指定后缀的文件改名为 UUID，后缀保持不变。' }, secProps('uuid')),
          h('div', { className: 'dfc-row' },
            h('span', null, '处理后缀'),
            h('input', { className: 'dfc-num', value: cfg.uuidExt || 'mp4', onChange: function (e) { updateCfgLocal({ uuidExt: e.target.value }) }, onBlur: function () { saveConfig(currentConfig()) }, disabled: locked }),
            h('button', { className: 'dfc-btn primary', disabled: locked, onClick: function () { if (window.confirm('把来源目录里所有 .' + (cfg.uuidExt || 'mp4') + ' 文件改名为 UUID？')) start('/uuid', 'UUID 改名已开始') } }, '开始执行')),
          h('div', { className: 'dfc-row' }, syncCheck('syncFingerprintsUuid', '同步指纹记录')),
          h(Status, { task: t('uuid') })),

        /* ⑤.5 删除空文件夹 */
        h(Section, Object.assign({ title: '删除空文件夹', label: '检查来源目录下的每个子目录，里面没有任何文件就删掉；先删深层再删父目录，来源目录本身、符号链接/联接点、.git/node_modules 与输出目录不动。' }, secProps('emptyDirs')),
          h('div', { className: 'dfc-row' },
            h('button', {
              className: 'dfc-btn primary', disabled: locked,
              onClick: function () {
                if (!(cfg.sources || []).length) { setMsg({ kind: 'err', text: '先添加来源目录' }); return }
                if (!window.confirm('删除空文件夹：只删除「里面没有任何文件」的子目录，来源目录本身保留。\n不可撤销，确定继续？')) return
                start('/empty-dirs', '空文件夹清理已开始')
              },
            }, '开始清理')),
          h(Status, { task: t('emptyDirs') },
            (t('emptyDirs').result && typeof t('emptyDirs').result.deleted === 'number') ? h('div', { className: 'dfc-meta' },
              '已删除 ' + t('emptyDirs').result.deleted + ' 个 · 扫描 ' + (t('emptyDirs').result.scanned || 0) + ' 个子目录' +
              ((t('emptyDirs').result.failed && t('emptyDirs').result.failed.length) ? ' · 失败 ' + t('emptyDirs').result.failed.length : '')) : null)),

        /* ⑥ 按大小重命名并移动 */
        h(Section, Object.assign({ title: '按文件大小重命名并移动', label: '把来源目录里指定后缀的文件按大小从小到大排序，重命名为 100000 起的序号并移动到目标目录。' }, secProps('bySize')),
          h('div', { className: 'dfc-row' },
            h('span', null, '处理后缀'),
            h('input', { className: 'dfc-num', value: cfg.sizeExt || 'mp4', onChange: function (e) { updateCfgLocal({ sizeExt: e.target.value }) }, onBlur: function () { saveConfig(currentConfig()) }, disabled: locked }),
            h('span', null, '目标目录'),
            h('input', {
              className: 'dfc-in', value: cfg.sizeTargetDir || '', placeholder: '不能与来源目录相同',
              onChange: function (e) { updateCfgLocal({ sizeTargetDir: e.target.value }) },
              onBlur: function () { saveConfig(currentConfig()) }, disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.sizeTargetDir || '', 'sizeTarget') }, disabled: locked }, '浏览…'),
            h('button', { className: 'dfc-btn primary', disabled: locked, onClick: function () { if (window.confirm('按文件大小排序后重命名为 100000 起并移动到目标目录？')) start('/by-size', '按大小重命名已开始') } }, '开始执行'),
            h('button', { className: 'dfc-btn', onClick: function () { resetFiles('/by-size/reset', '「按大小重命名并移动」目标目录') }, disabled: locked }, '复位文件')),
          browse && browse.mode === 'sizeTarget' ? h(Browse, {
            browse: browse, pickLabel: '设为目标目录',
            onOpen: function (p) { openBrowse(p, 'sizeTarget') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          h('div', { className: 'dfc-row' }, syncCheck('syncFingerprintsBySize', '同步指纹记录')),
          h(Status, { task: t('bySize') })),

        /* ⑦ 按视频长度重命名并移动 */
        h(Section, Object.assign({ title: '按视频长度重命名并移动', label: '把来源目录里指定后缀的视频按时长从短到长排序，重命名为 100000 起的序号并移动到目标目录。' }, secProps('byDuration')),
          h('div', { className: 'dfc-row' },
            h('span', null, '处理后缀'),
            h('input', { className: 'dfc-num', value: cfg.durationExt || 'mp4', onChange: function (e) { updateCfgLocal({ durationExt: e.target.value }) }, onBlur: function () { saveConfig(currentConfig()) }, disabled: locked }),
            h('span', null, '目标目录'),
            h('input', {
              className: 'dfc-in', value: cfg.durationTargetDir || '', placeholder: '不能与来源目录相同',
              onChange: function (e) { updateCfgLocal({ durationTargetDir: e.target.value }) },
              onBlur: function () { saveConfig(currentConfig()) }, disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.durationTargetDir || '', 'durationTarget') }, disabled: locked }, '浏览…'),
            h('button', { className: 'dfc-btn primary', disabled: locked, onClick: function () { if (window.confirm('按视频长度排序后重命名为 100000 起并移动到目标目录？')) start('/by-duration', '按时长重命名已开始') } }, '开始执行'),
            h('button', { className: 'dfc-btn', onClick: function () { resetFiles('/by-duration/reset', '「按时长重命名并移动」目标目录') }, disabled: locked }, '复位文件')),
          browse && browse.mode === 'durationTarget' ? h(Browse, {
            browse: browse, pickLabel: '设为目标目录',
            onOpen: function (p) { openBrowse(p, 'durationTarget') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          h('div', { className: 'dfc-row' }, syncCheck('syncFingerprintsByDuration', '同步指纹记录')),
          h(Status, { task: t('byDuration') })),

        /* 统一编码 */
        h(Section, Object.assign({ title: '统一编码', label: '在来源目录里按文件头找出 MOV/AVI/WMV，移到对比目录并转成同名 MP4，分辨率帧率码率与原片一致。' }, secProps('unify')),
          h('div', { className: 'dfc-row' },
            h('span', null, '对比目录'),
            h('input', {
              className: 'dfc-in', value: cfg.unifyTargetDir || '', placeholder: '转码后的 MP4 与原文件放这里',
              onChange: function (e) { updateCfgLocal({ unifyTargetDir: e.target.value }) },
              onBlur: function () { saveConfig(currentConfig()) }, disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.unifyTargetDir || '', 'unifyTarget') }, disabled: locked }, '浏览…')),
          h('div', { className: 'dfc-row' },
            h('span', null, '临时目录'),
            h('input', {
              className: 'dfc-in', value: cfg.unifyWorkDir || '', placeholder: '可留空；自动 .bin/.work 均失败时，可指定一个确定可写的目录',
              onChange: function (e) { updateCfgLocal({ unifyWorkDir: e.target.value }) },
              onBlur: function () { saveConfig(currentConfig()) }, disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.unifyWorkDir || '', 'unifyWork') }, disabled: locked }, '浏览…')),
          browse && browse.mode === 'unifyWork' ? h(Browse, {
            browse: browse, pickLabel: '设为临时目录',
            onOpen: function (p) { openBrowse(p, 'unifyWork') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          browse && browse.mode === 'unifyTarget' ? h(Browse, {
            browse: browse, pickLabel: '设为对比目录',
            onOpen: function (p) { openBrowse(p, 'unifyTarget') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          h('div', { className: 'dfc-row' },
            h('span', null, '编码器'),
            h('select', {
              className: 'dfc-num dfc-sel', value: cfg.encoder || 'libx264', disabled: locked,
              onChange: function (e) { saveConfig(Object.assign({}, currentConfig(), { encoder: e.target.value })) },
            },
              h('option', { value: 'libx264' }, 'x264（兼容最好）'),
              h('option', { value: 'h264_nvenc' }, 'NVIDIA NVENC'),
              h('option', { value: 'h264_qsv' }, 'Intel QSV'),
              h('option', { value: 'h264_amf' }, 'AMD AMF')),
            h('span', null, 'HDR'),
            h('select', {
              className: 'dfc-num dfc-sel', value: cfg.hdrMode || 'force8', disabled: locked,
              onChange: function (e) { saveConfig(Object.assign({}, currentConfig(), { hdrMode: e.target.value })) },
            },
              h('option', { value: 'force8' }, '强制 8bit'),
              h('option', { value: 'tonemap' }, '色调映射到 SDR'),
              h('option', { value: 'passthrough' }, '保留 HDR（HEVC）'))),
          h('div', { className: 'dfc-row' },
            h('label', { className: 'dfc-radio' },
              h('input', {
                type: 'checkbox', checked: cfg.smartCopy !== false, disabled: locked,
                onChange: function (e) { saveConfig(Object.assign({}, currentConfig(), { smartCopy: e.target.checked })) },
              }), '智能直通：本来就是 h264+aac 的文件只换容器，不重编码（秒级、无损）')),
          h('div', { className: 'dfc-row' },
            h('label', { className: 'dfc-radio' },
              h('input', {
                type: 'checkbox', checked: cfg.keepOriginal !== false,
                onChange: function (e) { saveConfig(Object.assign({}, currentConfig(), { keepOriginal: e.target.checked })) },
                disabled: locked,
              }), '保留原文件（默认勾选；取消后转码成功即删除对比目录里的原件）')),
          h('div', { className: 'dfc-note' },
            '出现「写入被拒绝 / Permission denied」多半是 ffmpeg / ffprobe 所在目录权限（完整性级别）过低，交给帮你装插件的 AI 调整即可。'),
          h('div', { className: 'dfc-row' },
            h('button', {
              className: 'dfc-btn primary', disabled: locked,
              onClick: function () {
                if (!cfg.unifyTargetDir) { setMsg({ kind: 'err', text: '先设置对比目录' }); return }
                if (!window.confirm('把来源目录里的 MOV/AVI/WMV 移到：\n' + cfg.unifyTargetDir + '\n并转成同名 MP4？' + (cfg.keepOriginal !== false ? '\n原文件保留在对比目录。' : '\n转码成功后删除原文件。'))) return
                start('/unify', '统一编码已开始')
              },
            }, '开始执行'),
            h('button', { className: 'dfc-btn', onClick: function () { resetFiles('/unify/reset', '「统一编码」对比目录', { extras: true }) }, disabled: locked }, '复位文件')),
          h(Status, { task: t('unify') },
            (t('unify').result && t('unify').result.converted !== undefined) ? h('div', null,
              h('div', { className: 'dfc-meta' },
                '已转码 ' + t('unify').result.converted + ' 个 · 失败 ' +
                (t('unify').result.failedCount || (t('unify').result.failed || []).length) +
                (t('unify').result.stoppedCount ? ' · 停止 ' + t('unify').result.stoppedCount : '') +
                ' · 原文件' + (t('unify').result.keep ? '保留' : '已删除') +
                ((t('unify').result.failed && t('unify').result.failed.length) ? ' · 失败原件在 ' + (t('unify').result.failDir || '对比目录\\fail') : '')),
              (t('unify').result.failed && t('unify').result.failed.length) ? h('div', { className: 'dfc-fail' },
                t('unify').result.failed.slice(0, 50).map(function (f, i) {
                  return h('div', { className: 'dfc-failrow', key: 'f' + i },
                    h('span', { className: 'dfc-failname', title: f.path }, f.path.split(/[\\/]/).pop()),
                    h('span', { className: 'dfc-meta' }, ' — ' + (f.error || '未知原因')))
                }),
                (t('unify').result.failedCount || t('unify').result.failed.length) > 50
                  ? h('div', { className: 'dfc-meta' }, '…… 还有 ' + ((t('unify').result.failedCount || t('unify').result.failed.length) - 50) + ' 个，见任务日志')
                  : null
              ) : null
            ) : null
          ))
      )
    }

    function Entry(props) {
      var size = typeof props.size === 'number' ? props.size : 18
      return h('span', { title: '小视频整理', className: 'dfc-entry', style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.78) + 'px' } }, '🧹')
    }

    function apply(ctx) {
      ensureCss()
      ctx.slots.inject('main', function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          var stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID, inject: function () { return {} } }, Panel)
          var stopEntry = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: function () { return '小视频整理' } }, Entry)
          return function () {
            try { stopMain && stopMain() } catch (e) {}
            try { stopEntry && stopEntry() } catch (e) {}
          }
        })
      })
    }

    return { inject: ['slots'], apply: apply }
  },
})
