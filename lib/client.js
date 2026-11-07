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

    function api(pathname, init) {
      var opts = Object.assign({}, init || {})
      var headers = Object.assign({ accept: 'application/json' }, opts.headers || {})
      if (TOKEN) headers['x-dupfc-token'] = TOKEN
      opts.headers = headers
      return fetch(API + pathname, opts).then(function (r) {
        return r.text().then(function (t) {
          var j = {}
          try { j = JSON.parse(t) } catch (e) { j = { error: 'HTTP ' + r.status + '，返回的不是 JSON' } }
          if (j && typeof j.token === 'string' && j.token) TOKEN = j.token
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
        sources: [], outputDir: '', durationToleranceMs: 100, frameSimilarity: 0.9, frameSeconds: 10, concurrency: 0,
        exactMode: 'fast', ext: 'mp4', uuidExt: 'mp4', sizeExt: 'mp4', durationExt: 'mp4',
        sizeTargetDir: '', durationTargetDir: '', unifyTargetDir: '', unifyWorkDir: '', keepOriginal: true,
        hdrMode: 'force8', smartCopy: true, encoder: 'libx264',
      })
      var [tasks, setTasks] = useState({})
      var [lock, setLock] = useState('')
      var [collapsed, setCollapsed] = useState({ exact: true, video: true, renameExt: true, uuid: true, bySize: true, byDuration: true, unify: true, emptyDirs: true })
      var [browse, setBrowse] = useState(null)
      var [msg, setMsg] = useState({ kind: '', text: '' })
      var [newDir, setNewDir] = useState('')
      var [tolText, setTolText] = useState('100')
      var [simText, setSimText] = useState('0.9')
      var [fsText, setFsText] = useState('10')
      var [concText, setConcText] = useState('0')
      var [fromExt, setFromExt] = useState('dat')
      var [toExt, setToExt] = useState('mp4')
      var timer = useRef(null)
      var busyRef = useRef(false)
      var busyTimer = useRef(null)
      var [busy, setBusy] = useState(false)

      useEffect(function () {
        api('/config').then(function (c) {
          if (c.error) { setMsg({ kind: 'err', text: c.error }); return }
          var next = Object.assign({ sources: [] }, c)
          setCfg(next)
          if (c.clearedSources) {
            setMsg({ kind: '', text: '已剔除 ' + c.clearedSources + ' 个不存在的来源目录' })
          }
          if (c.clearedDirs && c.clearedDirs.length) {
            setMsg({ kind: '', text: '已清空不存在的目录：' + c.clearedDirs.map(function (x) { return x.path }).join('、') })
          }
          setTolText(String(next.durationToleranceMs))
          setSimText(String(next.frameSimilarity))
        setFsText(String(next.frameSeconds || 10))
          setConcText(String(next.concurrency || 0))
        })
        poll()
        return function () { if (timer.current) clearInterval(timer.current) }
      }, [])

      function clearBusy() {
        busyRef.current = false
        setBusy(false)
        if (busyTimer.current) { clearTimeout(busyTimer.current); busyTimer.current = null }
      }

      function poll() {
        if (timer.current) return
        timer.current = setInterval(function () {
          api('/status').then(function (s) {
            if (s.error) return
            setTasks(s.tasks || {})
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
        return Object.assign({}, cfg, {
          durationToleranceMs: clampNum(tolText, 0, 10000, cfg.durationToleranceMs),
          frameSimilarity: clampNum(simText, 0.1, 1, cfg.frameSimilarity),
          frameSeconds: clampNum(fsText, 1, 120, cfg.frameSeconds || 10),
          concurrency: clampNum(concText, 0, 32, cfg.concurrency || 0),
        })
      }

      function saveConfig(next) {
        setCfg(next)
        return api('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) })
          .then(function (r) {
            if (r.error) { setMsg({ kind: 'err', text: r.error }); return false }
            // 服务端会剔除不存在的来源目录，以它返回的配置为准，别让旧状态把它写回来
            if (r.config) {
              var srv = Object.assign({}, r.config)
              if (r.droppedSources || (next.sources && srv.sources && srv.sources.length !== next.sources.length)) {
                setMsg({ kind: '', text: '已剔除不存在的来源目录' })
              }
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
        setConcText(String(next.concurrency))
        saveConfig(next)
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
        var next = Object.assign({}, cfg)
        if (browse.mode === 'output') next.outputDir = browse.path
        else if (browse.mode === 'sizeTarget') next.sizeTargetDir = browse.path
        else if (browse.mode === 'durationTarget') next.durationTargetDir = browse.path
        else if (browse.mode === 'unifyTarget') next.unifyTargetDir = browse.path
        else if (browse.mode === 'unifyWork') next.unifyWorkDir = browse.path
        else if (cfg.sources.indexOf(browse.path) < 0) next.sources = cfg.sources.concat([browse.path])
        saveConfig(next)
        setBrowse(null)
      }

      function addSource() {
        var v = newDir.trim()
        if (!v) return
        if (cfg.sources.indexOf(v) >= 0) { setMsg({ kind: 'err', text: '这个目录已经在列表里了' }); return }
        saveConfig(Object.assign({}, cfg, { sources: cfg.sources.concat([v]) }))
        setNewDir('')
      }

      function removeSource(s) {
        saveConfig(Object.assign({}, cfg, { sources: cfg.sources.filter(function (x) { return x !== s }) }))
      }

      function stopAll() {
        if (busyRef.current) return
        api('/stop', { method: 'POST' }).then(function (r) { applyTaskResponse(r, r.note) })
      }

      function start(pathname, okText, body) {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
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

      var anyRunning = Object.keys(tasks).some(function (k) { return tasks[k] && tasks[k].running })
      var locked = anyRunning || !!lock || busy

      var t = function (k) { return tasks[k] || {} }
      var toggle = function (k) {
        return function (v) { setCollapsed(Object.assign({}, collapsed, (function () { var o = {}; o[k] = v; return o })())) }
      }
      var HINTS = {
        exact: '处理对象：来源目录（上方列表）里的全部文件',
        video: '处理对象：来源目录里的 MP4 视频；并发数在上方「来源目录」统一设置',
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
          { name: '时长容差(ms)', desc: '两个视频时长差在这个范围内才归为同一组，默认 100ms。容差越大分组越宽松，也越容易误判。' },
          { name: '抓帧相似度', desc: '每秒抽 1 帧、缩到 16×16 灰度后逐帧比较；相似度 ≥ 该值算同一段画面。默认 0.9。' },
          { name: '抓帧时长(秒)', desc: '只比对视频前 N 秒，每秒 1 帧，默认 10 秒。时长超过该值的视频不参与比对（配置太大反而会跳过很多长视频）。' },
        ],
        renameExt: [
          { name: '原后缀 / 新后缀', desc: '把来源目录里所有「原后缀」的文件改成「新后缀」，内容不动，同名目标自动跳过。' },
        ],
        uuid: [
          { name: '后缀', desc: '只处理这个后缀的文件，文件名改成 UUID，后缀保持不变。' },
        ],
        emptyDirs: [
          { name: '删除空文件夹', desc: '递归扫描来源目录下的所有子目录；某个目录里没有任何文件（也不含还有文件的子目录）就删掉它。深层先删，父目录变空后也会被删；来源目录本身、符号链接和联接点不动。' },
        ],
        bySize: [
          { name: '后缀', desc: '只处理这个后缀的文件。' },
          { name: '目标目录', desc: '按文件大小从小到大排序，重命名为 100000 起的序号并移动到这里；不能放在来源目录内部。' },
        ],
        byDuration: [
          { name: '后缀', desc: '只处理这个后缀的视频文件。' },
          { name: '目标目录', desc: '用 ffprobe 读真实时长，从短到长排序，重命名为 100000 起的序号并移动到这里；读不到时长的文件会跳过并报数量。' },
        ],
        unify: [
          { name: '对比目录', desc: '按文件头识别出的 MOV/AVI/WMV 会先移动到这里，再转成同名 MP4。' },
          { name: '临时目录', desc: 'ffmpeg 先写 .part 到这里，校验通过后再搬回对比目录；留空则自动选一个 ffmpeg 能写的目录。' },
          { name: '保留原文件', desc: '勾选=原件留在对比目录（同名 .mp4 原件进 original\\）；取消=转码成功且校验通过后才删原件。' },
          { name: '智能直通', desc: '源本来就是 H.264+AAC 且非 HDR 时只换容器不重编码，秒级完成、零画质损失。' },
          { name: '编码器', desc: 'x264 兼容最好；NVENC/QSV/AMF 用硬件加速，失败会自动退回 x264 重试一次。' },
          { name: 'HDR 处理', desc: '强制 8bit=直接压成 SDR 可能偏暗；色调映射=用 zscale 转 SDR（需 ffmpeg 支持）；保留 HDR=输出 HEVC 10bit。' },
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

        /* ② 完全一致文件校验 */
        h(Section, Object.assign({ title: '完全一致文件校验', label: '对来源目录里的文件先按大小分组，再抽样或逐字节确认内容完全相同，可一键删除多余副本。' }, secProps('exact')),
          h('div', { className: 'dfc-row' },
            h('label', { className: 'dfc-radio' },
              h('input', {
                type: 'radio', name: 'exactMode', checked: cfg.exactMode !== 'strict',
                onChange: function () { saveConfig(Object.assign({}, cfg, { exactMode: 'fast' })) },
                disabled: locked,
              }), '快速校验（长度 + 头/中/尾各 100KB）'),
            h('label', { className: 'dfc-radio' },
              h('input', {
                type: 'radio', name: 'exactMode', checked: cfg.exactMode === 'strict',
                onChange: function () { saveConfig(Object.assign({}, cfg, { exactMode: 'strict' })) },
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
        h(Section, Object.assign({ title: '抓帧疑似重复校验', label: '仅处理来源目录里的 MP4：排除完全一致的文件后，按时长分组并比对前 N 秒画面（默认 10 秒，可配置），找出转码过的同一段视频；命中的整组文件都会被移动。' }, secProps('video')),
          h('div', { className: 'dfc-row' },
            h('span', null, '疑似重复输出目录'),
            h('input', {
              className: 'dfc-in', placeholder: '移动目标目录，会自动创建', value: cfg.outputDir || '',
              onChange: function (e) { setCfg(Object.assign({}, cfg, { outputDir: e.target.value })) },
              onBlur: function () { saveConfig(currentConfig()) },
              disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.outputDir || '', 'output') }, disabled: locked }, '浏览…')),
          h('div', { className: 'dfc-row' },
            h('span', null, '时长容差(ms)'),
            h('input', { className: 'dfc-num', type: 'number', min: 0, max: 10000, value: tolText, onChange: function (e) { setTolText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
            h('span', null, '抓帧相似度'),
            h('input', { className: 'dfc-num', type: 'number', min: 0.1, max: 1, step: 0.01, value: simText, onChange: function (e) { setSimText(e.target.value) }, onBlur: commitNumbers, disabled: locked })),
            h('div', { className: 'dfc-row' },
              h('span', null, '抓帧时长(秒)'),
              h('input', { className: 'dfc-num', type: 'number', min: 1, max: 120, step: 1, value: fsText, title: '每秒抓 1 帧；默认 10 秒', onChange: function (e) { setFsText(e.target.value) }, onBlur: commitNumbers, disabled: locked }),
              h('span', { className: 'dfc-warn' }, '注意：视频时长超过抓帧时长的文件不做处理，请谨慎配置')),
          h('div', { className: 'dfc-row' },
            h('button', { className: 'dfc-btn primary', onClick: function () { start('/video/scan', '抓帧扫描已开始') }, disabled: locked }, '开始扫描'),
            h('button', {
              className: 'dfc-btn', onClick: moveSuspects,
              disabled: locked || !(t('video').resultCount || (t('video').result && t('video').result.length)),
            }, '移动疑似重复')),
          browse && browse.mode === 'output' ? h(Browse, {
            browse: browse, pickLabel: '设为输出目录',
            onOpen: function (p) { openBrowse(p, 'output') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          h(Status, { task: t('video') },
            (t('video').result && t('video').result.length) ? h('div', null,
              t('video').result.map(function (g, gi) {
                return h('div', { key: 'v' + gi },
                  h('div', { className: 'dfc-gh' }, '时长 ≈ ' + g.durationMs + ' ms'),
                  (g.clusters || []).map(function (c, ci) {
                    return h('div', { className: 'dfc-g', key: 'c' + ci },
                      h('div', { className: 'dfc-gh' }, '相似组 ' + (ci + 1) + ' · ' + c.length + ' 个'),
                      c.map(function (f) { return h('div', { className: 'dfc-f', key: f.path }, h('span', { className: 'dfc-path', title: f.path }, f.path)) }))
                  }))
              })) : null)),

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
          h(Status, { task: t('renameExt') })),

        /* ⑤ 随机文件名 */
        h(Section, Object.assign({ title: '随机文件名（UUID）', label: '把来源目录里指定后缀的文件改名为 UUID，后缀保持不变。' }, secProps('uuid')),
          h('div', { className: 'dfc-row' },
            h('span', null, '处理后缀'),
            h('input', { className: 'dfc-num', value: cfg.uuidExt || 'mp4', onChange: function (e) { setCfg(Object.assign({}, cfg, { uuidExt: e.target.value })) }, onBlur: function () { saveConfig(currentConfig()) }, disabled: locked }),
            h('button', { className: 'dfc-btn primary', disabled: locked, onClick: function () { if (window.confirm('把来源目录里所有 .' + (cfg.uuidExt || 'mp4') + ' 文件改名为 UUID？')) start('/uuid', 'UUID 改名已开始') } }, '开始执行')),
          h(Status, { task: t('uuid') })),

        /* ⑤.5 删除空文件夹 */
        h(Section, Object.assign({ title: '删除空文件夹', label: '检查来源目录下的每个子目录，里面没有任何文件就删掉；先删深层再删父目录，来源目录本身和符号链接/联接点不动。' }, secProps('emptyDirs')),
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
            h('input', { className: 'dfc-num', value: cfg.sizeExt || 'mp4', onChange: function (e) { setCfg(Object.assign({}, cfg, { sizeExt: e.target.value })) }, onBlur: function () { saveConfig(currentConfig()) }, disabled: locked }),
            h('span', null, '目标目录'),
            h('input', {
              className: 'dfc-in', value: cfg.sizeTargetDir || '', placeholder: '不能与来源目录相同',
              onChange: function (e) { setCfg(Object.assign({}, cfg, { sizeTargetDir: e.target.value })) },
              onBlur: function () { saveConfig(currentConfig()) }, disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.sizeTargetDir || '', 'sizeTarget') }, disabled: locked }, '浏览…'),
            h('button', { className: 'dfc-btn primary', disabled: locked, onClick: function () { if (window.confirm('按文件大小排序后重命名为 100000 起并移动到目标目录？')) start('/by-size', '按大小重命名已开始') } }, '开始执行')),
          browse && browse.mode === 'sizeTarget' ? h(Browse, {
            browse: browse, pickLabel: '设为目标目录',
            onOpen: function (p) { openBrowse(p, 'sizeTarget') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          h(Status, { task: t('bySize') })),

        /* ⑦ 按视频长度重命名并移动 */
        h(Section, Object.assign({ title: '按视频长度重命名并移动', label: '把来源目录里指定后缀的视频按时长从短到长排序，重命名为 100000 起的序号并移动到目标目录。' }, secProps('byDuration')),
          h('div', { className: 'dfc-row' },
            h('span', null, '处理后缀'),
            h('input', { className: 'dfc-num', value: cfg.durationExt || 'mp4', onChange: function (e) { setCfg(Object.assign({}, cfg, { durationExt: e.target.value })) }, onBlur: function () { saveConfig(currentConfig()) }, disabled: locked }),
            h('span', null, '目标目录'),
            h('input', {
              className: 'dfc-in', value: cfg.durationTargetDir || '', placeholder: '不能与来源目录相同',
              onChange: function (e) { setCfg(Object.assign({}, cfg, { durationTargetDir: e.target.value })) },
              onBlur: function () { saveConfig(currentConfig()) }, disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.durationTargetDir || '', 'durationTarget') }, disabled: locked }, '浏览…'),
            h('button', { className: 'dfc-btn primary', disabled: locked, onClick: function () { if (window.confirm('按视频长度排序后重命名为 100000 起并移动到目标目录？')) start('/by-duration', '按时长重命名已开始') } }, '开始执行')),
          browse && browse.mode === 'durationTarget' ? h(Browse, {
            browse: browse, pickLabel: '设为目标目录',
            onOpen: function (p) { openBrowse(p, 'durationTarget') },
            onPick: pickBrowse,
            onClose: function () { setBrowse(null) },
          }) : null,
          h(Status, { task: t('byDuration') })),

        /* 统一编码 */
        h(Section, Object.assign({ title: '统一编码', label: '在来源目录里按文件头找出 MOV/AVI/WMV，移到对比目录并转成同名 MP4，分辨率帧率码率与原片一致。' }, secProps('unify')),
          h('div', { className: 'dfc-row' },
            h('span', null, '对比目录'),
            h('input', {
              className: 'dfc-in', value: cfg.unifyTargetDir || '', placeholder: '转码后的 MP4 与原文件放这里',
              onChange: function (e) { setCfg(Object.assign({}, cfg, { unifyTargetDir: e.target.value })) },
              onBlur: function () { saveConfig(currentConfig()) }, disabled: locked,
            }),
            h('button', { className: 'dfc-btn primary', onClick: function () { openBrowse(cfg.unifyTargetDir || '', 'unifyTarget') }, disabled: locked }, '浏览…')),
          h('div', { className: 'dfc-row' },
            h('span', null, '临时目录'),
            h('input', {
              className: 'dfc-in', value: cfg.unifyWorkDir || '', placeholder: '可留空；自动 .bin/.work 均失败时，可指定一个确定可写的目录',
              onChange: function (e) { setCfg(Object.assign({}, cfg, { unifyWorkDir: e.target.value })) },
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
            }, '开始执行')),
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
