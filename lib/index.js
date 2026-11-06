/**
 * dsh-duplicate-file-check — host half.
 *
 * 6 个独立任务，共用一把操作锁：
 *   exact      完全一致校验（fast = 抽样头中尾各 100KB；strict = 逐字节全量比对）
 *   video      抓帧疑似重复（仅 MP4：先排除完全一致文件，再按时长容差分组 + 前 10 秒 1fps 帧相似度）
 *   renameExt  批量改后缀
 *   uuid       随机文件名（UUID，后缀不变）
 *   bySize     按文件大小重命名并移动到目标目录
 *   byDuration 按视频长度重命名并移动到目标目录（仅 MP4）
 *
 * 安全：只接受本机回环请求；写操作还要带启动时生成的 token。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

const NAME = 'dsh-duplicate-file-check'
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CFG_FILE = path.join(HOME, '.dsh', 'duplicate-file-check.json')
const API_TOKEN = crypto.randomBytes(16).toString('hex')

const SAMPLE_BYTES = 100 * 1024
const FRAME_COUNT = 10
const FRAME_SIDE = 16
const DEFAULT_SIMILARITY = 0.9

const ffmpegPath = fs.existsSync('D:\\botshare\\ffmpeg\\bin\\ffmpeg.exe') ? 'D:\\botshare\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg'
const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
const defaultConfig = () => ({
  sources: [],
  outputDir: '',
  durationToleranceMs: 100,
  frameSimilarity: DEFAULT_SIMILARITY,
  concurrency: 0,
  exactMode: 'fast',
  ext: 'mp4',
  uuidExt: 'mp4',
  sizeExt: 'mp4',
  durationExt: 'mp4',
  sizeTargetDir: '',
  durationTargetDir: '',
})

function normalizeExt(x) {
  const s = String(x || '').trim().replace(/^\.+/, '').toLowerCase()
  return /^[a-z0-9]{1,16}$/.test(s) ? s : ''
}

function readConfig() {
  const out = defaultConfig()
  let raw
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch { return out }
  if (Array.isArray(raw.sources)) out.sources = raw.sources.filter((s) => typeof s === 'string')
  for (const k of ['outputDir', 'sizeTargetDir', 'durationTargetDir']) if (typeof raw[k] === 'string') out[k] = raw[k]
  for (const k of ['ext', 'uuidExt', 'sizeExt', 'durationExt']) out[k] = normalizeExt(raw[k]) || out[k]
  if (raw.exactMode === 'strict' || raw.exactMode === 'fast') out.exactMode = raw.exactMode
  if (Number.isFinite(raw.durationToleranceMs)) out.durationToleranceMs = Math.max(0, Math.min(10000, Math.round(raw.durationToleranceMs)))
  if (Number.isFinite(raw.frameSimilarity)) out.frameSimilarity = Math.min(1, Math.max(0.1, raw.frameSimilarity))
  if (Number.isFinite(raw.concurrency)) out.concurrency = Math.max(0, Math.min(32, Math.round(raw.concurrency)))
  return out
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
  const tmp = `${CFG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, CFG_FILE)
}

/* ------------------------------------------------------------------ *
 * 并发与停止
 * ------------------------------------------------------------------ */
const activeChildren = new Set()
let stopRequested = false
let opLock = ''

function killChildren() {
  for (const child of activeChildren) { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
  activeChildren.clear()
}

const stopped = () => stopRequested

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length || stopped()) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

/* ------------------------------------------------------------------ *
 * 任务状态
 * ------------------------------------------------------------------ */
function blankTask() {
  return { running: false, phase: '空闲', done: 0, total: 0, startedAt: 0, finishedAt: 0, error: '', log: [], result: null }
}

const tasks = {
  exact: blankTask(),
  video: blankTask(),
  renameExt: blankTask(),
  uuid: blankTask(),
  bySize: blankTask(),
  byDuration: blankTask(),
}

function tlog(task, msg) {
  task.log.push(`${new Date().toTimeString().slice(0, 8)} ${msg}`)
  if (task.log.length > 300) task.log.splice(0, task.log.length - 300)
}

async function runTask(name, label, fn) {
  if (opLock) return { ok: false, error: `有操作正在执行（${opLock}），请等它结束` }
  const task = tasks[name]
  Object.assign(task, blankTask(), { running: true, phase: '准备中', startedAt: Date.now() })
  stopRequested = false
  opLock = label
  try {
    await fn(task)
    if (stopped()) { task.phase = '已停止'; tlog(task, '已停止') }
    else if (!task.error) task.phase = '完成'
  } catch (e) {
    if (stopped()) {
      task.phase = '已停止'
      tlog(task, '已停止（中途终止）')
    } else {
      task.error = String(e?.message || e)
      task.phase = '出错'
      tlog(task, `出错: ${task.error}`)
    }
  } finally {
    killChildren()
    task.running = false
    task.finishedAt = Date.now()
    opLock = ''
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * 遍历与抽样
 * ------------------------------------------------------------------ */
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git', '.svn'])

async function walk(dir, out, depth = 0) {
  if (depth > 24 || stopped()) return
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (stopped()) return
    const full = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full, out, depth + 1) }
    else if (e.isFile()) out.push(full)
  }
}

async function listFiles(task, cfg, extFilter) {
  const files = []
  for (const src of cfg.sources) {
    if (!src || !fs.existsSync(src)) { tlog(task, `跳过不存在的目录: ${src}`); continue }
    await walk(src, files)
  }
  const list = extFilter ? files.filter((f) => path.extname(f).toLowerCase() === `.${extFilter}`) : files
  task.total = list.length
  tlog(task, `发现 ${files.length} 个文件` + (extFilter ? `，其中 .${extFilter} 共 ${list.length} 个` : ''))
  return list
}

function readSample(fd, position, length) {
  const buf = Buffer.allocUnsafe(length)
  const read = fs.readSync(fd, buf, 0, length, position)
  return read === length ? buf : buf.subarray(0, read)
}

function sampleSignature(file, size) {
  const fd = fs.openSync(file, 'r')
  try {
    if (size <= 0) return ''
    const chunk = size >= SAMPLE_BYTES * 3 ? SAMPLE_BYTES : Math.max(1, Math.floor(size / 3))
    const head = readSample(fd, 0, Math.min(chunk, size))
    const midStart = Math.max(0, Math.floor(size / 2 - chunk / 2))
    const mid = readSample(fd, midStart, Math.min(chunk, size - midStart))
    const tailStart = Math.max(0, size - chunk)
    const tail = readSample(fd, tailStart, Math.min(chunk, size - tailStart))
    return [head.toString('hex'), mid.toString('hex'), tail.toString('hex')].join('|')
  } finally { fs.closeSync(fd) }
}

/** 逐字节比较两个文件（分块读，不整文件进内存）。 */
async function sameContent(a, b, chunkSize = 1024 * 1024) {
  const fa = await fsp.open(a, 'r')
  const fb = await fsp.open(b, 'r')
  const ba = Buffer.allocUnsafe(chunkSize)
  const bb = Buffer.allocUnsafe(chunkSize)
  try {
    for (let pos = 0; ; pos += chunkSize) {
      if (stopped()) throw new Error('已停止')
      const [ra, rb] = await Promise.all([fa.read(ba, 0, chunkSize, pos), fb.read(bb, 0, chunkSize, pos)])
      if (ra.bytesRead !== rb.bytesRead) return false
      if (ra.bytesRead === 0) return true
      if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false
      if (ra.bytesRead < chunkSize) return true
    }
  } finally {
    await fa.close().catch(() => {})
    await fb.close().catch(() => {})
  }
}

/* ------------------------------------------------------------------ *
 * ffmpeg
 * ------------------------------------------------------------------ */
function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout) => {
      activeChildren.delete(child)
      resolve({ ok: !err, stdout: String(stdout || ''), error: err ? String(err.message) : '' })
    })
    activeChildren.add(child)
    if (stopped()) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
  })
}

async function probeDurationMs(file) {
  const r = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 20000)
  const n = Number((r.stdout || '').trim())
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0
}

async function frameSignature(file) {
  return new Promise((resolve) => {
    const chunks = []
    const child = execFile(
      ffmpegPath,
      ['-v', 'error', '-ss', '0', '-t', String(FRAME_COUNT), '-i', file,
        '-vf', `fps=1,scale=${FRAME_SIDE}:${FRAME_SIDE}:flags=area,format=gray`,
        '-f', 'rawvideo', '-'],
      { maxBuffer: 4 * 1024 * 1024, timeout: 30000, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        activeChildren.delete(child)
        const buf = chunks.length ? Buffer.concat(chunks) : Buffer.from(stdout || [])
        resolve(err || buf.length < FRAME_SIDE * FRAME_SIDE ? null : buf)
      },
    )
    child.stdout?.on('data', (d) => chunks.push(d))
    activeChildren.add(child)
    if (stopped()) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
  })
}

function frameSimilarity(a, b) {
  const frameSize = FRAME_SIDE * FRAME_SIDE
  const n = Math.min(Math.floor(a.length / frameSize), Math.floor(b.length / frameSize))
  if (n <= 0) return 0
  let total = 0
  for (let i = 0; i < n; i += 1) {
    let sum = 0
    for (let j = 0; j < frameSize; j += 1) sum += Math.abs(a[i * frameSize + j] - b[i * frameSize + j])
    total += sum / frameSize / 255
  }
  return 1 - total / n
}

function clusterByDuration(items, toleranceMs) {
  const sorted = items.slice().sort((x, y) => x.durationMs - y.durationMs)
  const clusters = []
  let cur = []
  for (const it of sorted) {
    if (cur.length === 0) { cur.push(it); continue }
    if (it.durationMs - cur[cur.length - 1].durationMs <= Math.max(0, toleranceMs)) cur.push(it)
    else { clusters.push(cur); cur = [it] }
  }
  if (cur.length) clusters.push(cur)
  return clusters
}

/* ------------------------------------------------------------------ *
 * 任务一：完全一致
 * ------------------------------------------------------------------ */
async function exactScan(task, cfg) {
  const limit = Math.max(1, Math.min(32, Number(cfg.concurrency) || Math.min(8, Math.max(2, os.cpus().length))))
  const strict = cfg.exactMode === 'strict'
  tlog(task, `模式: ${strict ? '严格（逐字节）' : '快速（头/中/尾各 100KB）'} · 并发 ${limit}`)

  const files = await listFiles(task, cfg, null)
  if (stopped()) return

  task.phase = '按大小分组'
  const sized = (await mapLimit(files, limit, async (f) => {
    try {
      const st = await fsp.stat(f)
      if (!st.isFile() || st.size <= 0) return null
      task.done += 1
      return { path: f, size: st.size, mtime: st.mtimeMs }
    } catch { return null }
  })).filter(Boolean)

  const bySize = new Map()
  for (const it of sized) {
    const arr = bySize.get(it.size) || []
    arr.push(it)
    bySize.set(it.size, arr)
  }
  const candidates = [...bySize.values()].filter((a) => a.length > 1)
  tlog(task, `同大小分组: ${candidates.length} 组`)

  task.phase = strict ? '逐字节比对' : '抽样比对'
  task.done = 0
  task.total = candidates.reduce((n, g) => n + g.length, 0)

  const groupResults = await mapLimit(candidates, limit, async (group) => {
    const buckets = []
    for (const item of group) {
      if (stopped()) return []
      let sig = null
      if (!strict) { try { sig = sampleSignature(item.path, item.size) } catch { task.done += 1; continue } }
      let placed = false
      for (const b of buckets) {
        if (strict) {
          if (await sameContent(b.rep.path, item.path)) { b.items.push(item); placed = true; break }
        } else if (b.sig === sig) { b.items.push(item); placed = true; break }
      }
      if (!placed) buckets.push({ sig, rep: item, items: [item] })
      task.done += 1
    }
    return buckets.filter((b) => b.items.length > 1).map((b) => {
      const arr = b.items.slice().sort((x, y) => x.mtime - y.mtime || x.path.localeCompare(y.path))
      return {
        size: arr[0].size,
        keep: arr[0].path,
        sig: b.sig || '',
        files: arr.map((x) => ({ path: x.path, size: x.size, mtime: x.mtime })),
      }
    })
  })

  task.result = groupResults.flat()
  tlog(task, `完全一致组: ${task.result.length} 组，共 ${task.result.reduce((n, g) => n + g.files.length, 0)} 个文件`)
}

/* ------------------------------------------------------------------ *
 * 任务二：抓帧疑似重复（先排除完全一致）
 * ------------------------------------------------------------------ */
async function videoScan(task, cfg) {
  const limit = Math.max(1, Math.min(32, Number(cfg.concurrency) || Math.min(8, Math.max(2, os.cpus().length))))
  tlog(task, `并发 ${limit} · 时长容差 ${cfg.durationToleranceMs}ms · 相似度 ≥ ${cfg.frameSimilarity}`)

  const all = await listFiles(task, cfg, null)
  if (stopped()) return

  task.phase = '排除完全一致文件'
  const bySize = new Map()
  for (const f of all) {
    if (stopped()) return
    try {
      const st = await fsp.stat(f)
      if (!st.isFile() || st.size <= 0) continue
      const arr = bySize.get(st.size) || []
      arr.push({ path: f, size: st.size, mtime: st.mtimeMs })
      bySize.set(st.size, arr)
    } catch { /* 忽略 */ }
  }
  const dupSet = new Set()
  for (const group of [...bySize.values()].filter((g) => g.length > 1)) {
    if (stopped()) return
    const buckets = new Map()
    for (const it of group) {
      let sig
      try { sig = sampleSignature(it.path, it.size) } catch { continue }
      const arr = buckets.get(sig) || []
      arr.push(it)
      buckets.set(sig, arr)
    }
    for (const arr of buckets.values()) {
      if (arr.length < 2) continue
      arr.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path))
      for (let i = 1; i < arr.length; i += 1) dupSet.add(arr[i].path)
    }
  }
  const videos = all.filter((f) => /\.mp4$/i.test(f) && !dupSet.has(f))
  tlog(task, `排除完全一致文件 ${dupSet.size} 个；MP4 候选 ${videos.length} 个`)
  task.total = videos.length
  task.done = 0

  task.phase = '统计视频时长'
  const withDur = (await mapLimit(videos, Math.min(limit, 8), async (v) => {
    const d = await probeDurationMs(v)
    task.done += 1
    return d > 0 ? { path: v, durationMs: d } : null
  })).filter(Boolean)
  if (stopped()) return

  const durClusters = clusterByDuration(withDur, cfg.durationToleranceMs).filter((c) => c.length > 1)
  tlog(task, `时长相近且不止一个的分组: ${durClusters.length} 组`)

  task.phase = '抓帧比对'
  task.done = 0
  task.total = durClusters.reduce((n, c) => n + c.length, 0)
  const ffLimit = Math.max(2, Math.min(8, limit))

  const results = await mapLimit(durClusters, ffLimit, async (cluster) => {
    const sigs = new Map()
    for (const it of cluster) {
      if (stopped()) return null
      const sig = await frameSignature(it.path)
      if (sig) sigs.set(it.path, sig)
      task.done += 1
    }
    if (stopped() || sigs.size < 2) return null
    const list = [...sigs.keys()]
    const parent = new Map(list.map((p) => [p, p]))
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x }
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb) }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (frameSimilarity(sigs.get(list[i]), sigs.get(list[j])) >= cfg.frameSimilarity) union(list[i], list[j])
      }
    }
    const grouped = new Map()
    for (const p of list) {
      const r = find(p)
      const arr = grouped.get(r) || []
      arr.push(p)
      grouped.set(r, arr)
    }
    const clusters = [...grouped.values()].filter((g) => g.length > 1).map((g) => g.map((p) => ({
      path: p,
      durationMs: cluster.find((c) => c.path === p)?.durationMs || 0,
    })))
    return clusters.length ? { durationMs: Math.round(cluster[0].durationMs), clusters } : null
  })

  task.result = results.filter(Boolean)
  tlog(task, `疑似视频重复: ${task.result.reduce((n, g) => n + g.clusters.length, 0)} 组`)
}

/* ------------------------------------------------------------------ *
 * 删除完全一致
 * ------------------------------------------------------------------ */
async function deleteExact() {
  const task = tasks.exact
  const groups = task.result || []
  if (!groups.length) return { ok: false, error: '没有可删除的完全一致分组（先扫描）' }
  const deleted = []
  const failed = []
  for (const g of groups) {
    if (stopped()) break
    for (const f of g.files) {
      if (stopped()) break
      if (f.path === g.keep) continue
      try {
        const st = await fsp.stat(f.path)
        if (st.size !== f.size) { failed.push({ path: f.path, error: '大小在扫描后变了，跳过' }); continue }
        if (g.sig && sampleSignature(f.path, st.size) !== g.sig) {
          failed.push({ path: f.path, error: '内容在扫描后变了，跳过' }); continue
        }
        await fsp.unlink(f.path)
        deleted.push({ path: f.path, size: f.size })
      } catch (e) { failed.push({ path: f.path, error: String(e.message) }) }
    }
  }
  task.result = task.result
    .map((g) => ({ ...g, files: g.files.filter((f) => { try { return fs.existsSync(f.path) } catch { return false } }) }))
    .filter((g) => g.files.length > 1)
  tlog(task, `删除: 成功 ${deleted.length}，失败 ${failed.length}`)
  return { ok: true, deleted: deleted.length, failed, bytes: deleted.reduce((n, d) => n + d.size, 0) }
}

function nextSeq(dir) {
  let max = 99999
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = /^(\d{6})\./i.exec(name)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch { /* 目录不存在 */ }
  return max + 1
}

async function moveSuspects(cfg) {
  const task = tasks.video
  const out = cfg.outputDir
  if (!out) return { ok: false, error: '还没设置疑似重复文件输出目录' }
  const targets = []
  for (const g of task.result || []) for (const c of g.clusters) for (const f of c) targets.push(f.path)
  if (!targets.length) return { ok: false, error: '没有可移动的疑似重复文件（先扫描）' }
  await fsp.mkdir(out, { recursive: true })
  let seq = nextSeq(out)
  const moved = []
  const failed = []
  for (const src of [...new Set(targets)]) {
    if (stopped()) break
    if (path.dirname(src) === out) continue
    const dst = path.join(out, `${seq}.mp4`)
    try {
      try { await fsp.rename(src, dst) } catch { await fsp.copyFile(src, dst); await fsp.unlink(src) }
      moved.push({ from: src, to: dst })
      seq += 1
    } catch (e) { failed.push({ path: src, error: String(e.message) }) }
  }
  task.result = []
  tlog(task, `移动: 成功 ${moved.length}，失败 ${failed.length}`)
  return { ok: true, moved: moved.length, failed, first: moved[0]?.to || '', last: moved[moved.length - 1]?.to || '' }
}

/* ------------------------------------------------------------------ *
 * 批量改后缀
 * ------------------------------------------------------------------ */
async function renameExtensions(task, cfg, fromRaw, toRaw, dryRun) {
  const from = normalizeExt(fromRaw)
  const to = normalizeExt(toRaw)
  if (!from || !to) throw new Error('后缀只能是 1-16 位字母或数字')
  if (from === to) throw new Error('新旧后缀相同，不用改')

  const files = await listFiles(task, cfg, from)
  const plan = []
  let conflict = 0
  for (const f of files) {
    const dst = f.slice(0, f.length - path.extname(f).length) + `.${to}`
    if (fs.existsSync(dst)) { conflict += 1; continue }
    plan.push({ from: f, to: dst })
  }
  if (dryRun) {
    task.result = { dryRun: true, matched: files.length, willRename: plan.length, conflict, samples: plan.slice(0, 10) }
    tlog(task, `预览: 匹配 ${files.length}，可改 ${plan.length}，冲突 ${conflict}`)
    return
  }
  task.phase = '改名'
  task.done = 0
  task.total = plan.length
  let renamed = 0
  const failed = []
  for (const p of plan) {
    if (stopped()) break
    try { await fsp.rename(p.from, p.to); renamed += 1 } catch (e) { failed.push({ path: p.from, error: String(e.message) }) }
    task.done += 1
  }
  task.result = { renamed, conflict, failed }
  tlog(task, `改名: 成功 ${renamed}，冲突 ${conflict}，失败 ${failed.length}`)
}

/* ------------------------------------------------------------------ *
 * 随机文件名
 * ------------------------------------------------------------------ */
async function uuidRename(task, cfg) {
  const files = await listFiles(task, cfg, cfg.uuidExt)
  task.phase = '改名'
  task.done = 0
  task.total = files.length
  let ok = 0
  const failed = []
  for (const f of files) {
    if (stopped()) break
    const suffix = path.extname(f)
    let dst
    do { dst = path.join(path.dirname(f), crypto.randomUUID() + suffix) } while (fs.existsSync(dst))
    try { await fsp.rename(f, dst); ok += 1 } catch (e) { failed.push({ path: f, error: String(e.message) }) }
    task.done += 1
  }
  task.result = { renamed: ok, failed }
  tlog(task, `UUID 改名: 成功 ${ok}，失败 ${failed.length}`)
}

/* ------------------------------------------------------------------ *
 * 按大小 / 按时长 重命名并移动
 * ------------------------------------------------------------------ */
async function moveByOrder(task, cfg, { ext, targetDir, orderBy }) {
  if (!targetDir) throw new Error('还没设置目标目录')
  for (const s of cfg.sources) {
    if (!s) continue
    const rs = path.resolve(s).toLowerCase()
    const rt = path.resolve(targetDir).toLowerCase()
    if (rs === rt) throw new Error('目标目录不能与来源目录相同')
    if (rt.startsWith(rs + path.sep)) tlog(task, `注意：目标目录在来源目录内部（${s}），下次扫描会把它一起扫进来`)
  }
  const files = await listFiles(task, cfg, ext)
  const limit = Math.max(1, Math.min(32, Number(cfg.concurrency) || Math.min(8, Math.max(2, os.cpus().length))))

  task.phase = '统计排序依据'
  task.done = 0
  task.total = files.length
  const items = []
  await mapLimit(files, orderBy === 'size' ? limit : Math.min(limit, 8), async (f) => {
    if (stopped()) return
    if (orderBy === 'size') {
      try { items.push({ path: f, key: (await fsp.stat(f)).size }) } catch { /* skip */ }
    } else {
      const d = await probeDurationMs(f)
      if (d > 0) items.push({ path: f, key: d })
    }
    task.done += 1
  })
  if (stopped()) return

  if (!items.length) { tlog(task, '没有可处理的文件（后缀不匹配或读不到大小/时长）'); task.phase = '完成'; task.result = { moved: 0, failed: [] }; return }
  items.sort((a, b) => a.key - b.key || a.path.localeCompare(b.path))
  await fsp.mkdir(targetDir, { recursive: true })
  let seq = nextSeq(targetDir)
  task.phase = '重命名并移动'
  task.done = 0
  task.total = items.length
  let moved = 0
  const failed = []
  for (const it of items) {
    if (stopped()) break
    const dst = path.join(targetDir, `${seq}.${ext}`)
    try {
      try { await fsp.rename(it.path, dst) } catch { await fsp.copyFile(it.path, dst); await fsp.unlink(it.path) }
      moved += 1
      seq += 1
    } catch (e) { failed.push({ path: it.path, error: String(e.message) }) }
    task.done += 1
  }
  task.result = { moved, failed }
  tlog(task, `移动: 成功 ${moved}，失败 ${failed.length}`)
}

/* ------------------------------------------------------------------ *
 * 目录浏览
 * ------------------------------------------------------------------ */
function listRoots() {
  const roots = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    try { if (fs.statSync(root).isDirectory()) roots.push({ name: root, path: root }) } catch { /* 没有这个盘 */ }
  }
  return roots
}

async function browseDir(target) {
  const p = String(target || '').trim()
  if (!p) return { path: '', parent: '', dirs: [], roots: listRoots() }
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    const parent = path.dirname(p)
    return { path: p, parent: parent && parent !== p ? parent : '', dirs, roots: listRoots() }
  } catch (e) {
    return { path: p, parent: '', dirs: [], roots: listRoots(), error: String(e.message) }
  }
}

/* ------------------------------------------------------------------ *
 * 路由守卫
 * ------------------------------------------------------------------ */
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function isLocalRequest(req) {
  const addr = req.socket?.remoteAddress || req.connection?.remoteAddress || ''
  if (addr && !LOCAL_ADDRS.has(addr)) return false
  const host = String(req.headers?.host || '')
  if (host) {
    const name = host.split(':')[0]
    if (!LOCAL_HOSTS.has(name)) return false
  }
  return true
}

function denyCrossOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return false
  try {
    const u = new URL(origin)
    return !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  } catch { return true }
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function guard(req, res, needsToken) {
  if (!isLocalRequest(req)) { sendJson(res, 403, { error: 'only local requests are allowed' }); return false }
  if (denyCrossOrigin(req)) { sendJson(res, 403, { error: 'cross-origin request rejected' }); return false }
  if (needsToken && req.headers['x-dupfc-token'] !== API_TOKEN) {
    sendJson(res, 403, { error: 'missing or wrong X-Dupfc-Token' })
    return false
  }
  return true
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 1024 * 1024) throw new Error('请求体超过 1MB，拒绝处理')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const publicTasks = () => Object.fromEntries(Object.entries(tasks).map(([k, t]) => [k, {
  running: t.running, phase: t.phase, done: t.done, total: t.total,
  startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error,
  log: t.log.slice(-40),
  result: t.running ? null : (Array.isArray(t.result) ? t.result.slice(0, 200) : t.result),
  resultCount: Array.isArray(t.result) ? t.result.length : null,
}]))

export const name = NAME
export const inject = ['webServer']

export function apply(ctx) {
  const route = (p, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: p, handler }), `${NAME}: ${p}`)

  route('/dupfc/api/config', async (req, res) => {
    if (!guard(req, res, req.method !== 'GET')) return
    if (req.method === 'GET') return sendJson(res, 200, { ...readConfig(), token: API_TOKEN })
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    try {
      const body = JSON.parse(await readBody(req))
      const cfg = readConfig()
      if (Array.isArray(body.sources)) cfg.sources = body.sources.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
      for (const k of ['outputDir', 'sizeTargetDir', 'durationTargetDir']) if (typeof body[k] === 'string') cfg[k] = body[k].trim()
      for (const k of ['ext', 'uuidExt', 'sizeExt', 'durationExt']) if (body[k] !== undefined) cfg[k] = normalizeExt(body[k]) || cfg[k]
      if (body.exactMode === 'strict' || body.exactMode === 'fast') cfg.exactMode = body.exactMode
      if (Number.isFinite(body.durationToleranceMs)) cfg.durationToleranceMs = Math.max(0, Math.min(10000, Math.round(body.durationToleranceMs)))
      if (Number.isFinite(body.frameSimilarity)) cfg.frameSimilarity = Math.min(1, Math.max(0.1, body.frameSimilarity))
      if (Number.isFinite(body.concurrency)) cfg.concurrency = Math.max(0, Math.min(32, Math.round(body.concurrency)))
      writeConfig(cfg)
      return sendJson(res, 200, { ok: true, config: cfg })
    } catch (e) { return sendJson(res, 400, { error: String(e?.message || e) }) }
  })

  route('/dupfc/api/status', async (req, res) => {
    if (!guard(req, res, false)) return
    return sendJson(res, 200, { token: API_TOKEN, tasks: publicTasks(), lock: opLock, activeChildren: activeChildren.size })
  })

  route('/dupfc/api/browse', async (req, res) => {
    if (!guard(req, res, false)) return
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      return sendJson(res, 200, await browseDir(url.searchParams.get('path') || ''))
    } catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
  })

  const startRoute = (p, name, label, fn) => route(p, async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (tasks[name].running) return sendJson(res, 409, { error: '这个任务已经在跑' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    const cfg = readConfig()
    if (!cfg.sources.length) return sendJson(res, 400, { error: '还没设置来源目录' })
    runTask(name, label, (task) => fn(task, cfg))
    return sendJson(res, 202, { ok: true })
  })

  startRoute('/dupfc/api/exact/scan', 'exact', '完全一致校验', (t, c) => exactScan(t, c))
  startRoute('/dupfc/api/video/scan', 'video', '抓帧疑似重复', (t, c) => videoScan(t, c))
  startRoute('/dupfc/api/uuid', 'uuid', '随机文件名', (t, c) => uuidRename(t, c))
  startRoute('/dupfc/api/by-size', 'bySize', '按大小重命名并移动', (t, c) => moveByOrder(t, c, { ext: c.sizeExt, targetDir: c.sizeTargetDir, orderBy: 'size' }))
  startRoute('/dupfc/api/by-duration', 'byDuration', '按时长重命名并移动', (t, c) => moveByOrder(t, c, { ext: c.durationExt, targetDir: c.durationTargetDir, orderBy: 'duration' }))

  route('/dupfc/api/rename-ext', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (tasks.renameExt.running || opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock || '批量改后缀'}），请等它结束` })
    const cfg = readConfig()
    if (!cfg.sources.length) return sendJson(res, 400, { error: '还没设置来源目录' })
    try {
      const body = JSON.parse(await readBody(req))
      runTask('renameExt', body.dryRun === true ? '改后缀预览' : '批量改后缀', (t) => renameExtensions(t, cfg, body.from, body.to, body.dryRun === true))
      return sendJson(res, 202, { ok: true })
    } catch (e) { return sendJson(res, 400, { error: String(e?.message || e) }) }
  })

  route('/dupfc/api/exact/delete', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    stopRequested = false
    opLock = '删除完全一致'
    try { return sendJson(res, 200, await deleteExact()) }
    catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
    finally { opLock = '' }
  })

  route('/dupfc/api/video/move', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    stopRequested = false
    opLock = '移动疑似重复'
    try { return sendJson(res, 200, await moveSuspects(readConfig())) }
    catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
    finally { opLock = '' }
  })

  route('/dupfc/api/stop', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    const running = Object.entries(tasks).filter(([, t]) => t.running).map(([k]) => k)
    if (!running.length && !opLock) return sendJson(res, 200, { ok: true, note: '当前没有任务在跑' })
    stopRequested = true
    const killed = activeChildren.size
    killChildren()
    return sendJson(res, 200, { ok: true, note: `正在停止（已终止 ${killed} 个子进程）` })
  })
}
