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
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-duplicate-file-check'
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CFG_FILE = path.join(HOME, '.dsh', 'duplicate-file-check.json')
const API_TOKEN = crypto.randomBytes(16).toString('hex')

const SAMPLE_BYTES = 100 * 1024
const FRAME_COUNT = 10
const FRAME_SIDE = 16
const DEFAULT_SIMILARITY = 0.9

const ffmpegPath = fs.existsSync('<redacted>\\ffmpeg\\bin\\ffmpeg.exe') ? '<redacted>\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg'
const SELF_BIN_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.bin')
let ffmpegActive = ffmpegPath
const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
const defaultConfig = () => ({
  sources: [],
  outputDir: '',
  durationToleranceMs: 100,
  frameSimilarity: DEFAULT_SIMILARITY,
  frameSeconds: 10,
  concurrency: 0,
  exactMode: 'fast',
  ext: 'mp4',
  uuidExt: 'mp4',
  sizeExt: 'mp4',
  durationExt: 'mp4',
  sizeTargetDir: '',
  durationTargetDir: '',
  unifyTargetDir: '',
  unifyWorkDir: '',
  keepOriginal: true,
  hdrMode: 'force8',
  smartCopy: true,
  encoder: 'libx264',
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
  for (const k of ['outputDir', 'sizeTargetDir', 'durationTargetDir', 'unifyTargetDir', 'unifyWorkDir']) if (typeof raw[k] === 'string') out[k] = raw[k]
  if (typeof raw.keepOriginal === 'boolean') out.keepOriginal = raw.keepOriginal
  if (['force8', 'tonemap', 'passthrough'].includes(raw.hdrMode)) out.hdrMode = raw.hdrMode
  if (typeof raw.smartCopy === 'boolean') out.smartCopy = raw.smartCopy
  if (['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(raw.encoder)) out.encoder = raw.encoder
  for (const k of ['ext', 'uuidExt', 'sizeExt', 'durationExt']) out[k] = normalizeExt(raw[k]) || out[k]
  if (raw.exactMode === 'strict' || raw.exactMode === 'fast') out.exactMode = raw.exactMode
  if (Number.isFinite(raw.durationToleranceMs)) out.durationToleranceMs = Math.max(0, Math.min(10000, Math.round(raw.durationToleranceMs)))
  if (Number.isFinite(raw.frameSimilarity)) out.frameSimilarity = Math.min(1, Math.max(0.1, raw.frameSimilarity))
  if (Number.isFinite(raw.frameSeconds)) out.frameSeconds = Math.max(1, Math.min(120, Math.round(raw.frameSeconds)))
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

/** 同盘 rename；跨盘先复制再删，失败会抛出。 */
async function moveFile(from, to) {
  try { await fsp.rename(from, to) } catch { await fsp.copyFile(from, to); await fsp.unlink(from) }
}

/** 目标盘空间预检：bytes 为预计占用，不足时抛错；目录不可用时只记日志。 */
const fmtBytes = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(1) + ' MB')

async function ensureSpace(dir, bytes, task, label) {
  try {
    const st = await fsp.statfs(dir)
    const free = Number(st.bavail) * Number(st.bsize)
    if (free > 0 && bytes > free) {
      throw new Error(`${label}空间不足：需要 ~${fmtBytes(bytes)}，可用 ${fmtBytes(free)}`)
    }
    tlog(task, `${label}空间预检: 需 ~${fmtBytes(bytes)}，可用 ${fmtBytes(free)}`)
  } catch (e) {
    if (String((e && e.message) || e).includes('空间不足')) throw e
    tlog(task, `${label}空间预检没做成（` + String((e && e.message) || e) + `），继续`)
  }
}

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
  unify: blankTask(),
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
  const raw = []
  for (const src of cfg.sources) {
    if (!src || !fs.existsSync(src)) { tlog(task, `跳过不存在的目录: ${src}`); continue }
    await walk(src, raw)
  }
  // 来源目录可能互相嵌套或重复配置，同一个文件只处理一次
  const seen = new Set()
  const files = []
  for (const f of raw) {
    const k = path.resolve(f).toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    files.push(f)
  }
  const dup = raw.length - files.length
  if (dup > 0) tlog(task, `来源目录有重叠，已去重 ${dup} 个重复扫描到的文件`)
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
  const r = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 60000)
  const n = Number((r.stdout || '').trim())
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0
}

async function frameSignature(file, seconds) {
  return new Promise((resolve) => {
    const chunks = []
    const child = execFile(
      ffmpegPath,
      ['-nostdin', '-v', 'error', '-ss', '0', '-t', String(seconds || FRAME_COUNT), '-i', file,
        '-vf', `fps=1,scale=${FRAME_SIDE}:${FRAME_SIDE}:flags=area,format=gray`,
        '-f', 'rawvideo', '-'],
      { maxBuffer: 4 * 1024 * 1024, timeout: 30000 + (Number(seconds || FRAME_COUNT) * 1000), windowsHide: true, encoding: 'buffer' },
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
  const frameSeconds = Math.max(1, Math.min(120, Math.round(Number(cfg.frameSeconds) || 10)))
  tlog(task, `并发 ${limit} · 抓帧时长 ${frameSeconds}s（每秒 1 帧） · 时长容差 ${cfg.durationToleranceMs}ms · 相似度 ≥ ${cfg.frameSimilarity}`)
  tlog(task, `注意：时长超过 ${frameSeconds} 秒的视频按配置不参与抓帧比对`)

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
  const noDur = videos.length - withDur.length
  if (noDur > 0) tlog(task, `${noDur} 个视频读不到时长，已跳过`)

  // 超过抓帧时长的视频不处理（只比前 N 秒，长视频的相似度没有意义）
  const tooLong = withDur.filter((x) => x.durationMs > frameSeconds * 1000)
  const eligible = withDur.filter((x) => x.durationMs <= frameSeconds * 1000)
  if (tooLong.length) {
    tlog(task, `时长超过 ${frameSeconds}s 的文件 ${tooLong.length} 个，已跳过（可调大抓帧时长）`)
    tlog(task, '  例: ' + tooLong.slice(0, 5).map((x) => `${path.basename(x.path)}(${(x.durationMs / 1000).toFixed(0)}s)`).join(', '))
  }
  if (!eligible.length) {
    task.result = []
    tlog(task, '没有符合抓帧时长的视频可比对')
    return
  }
  const durClusters = clusterByDuration(eligible, cfg.durationToleranceMs).filter((c) => c.length > 1)
  tlog(task, `时长相近且不止一个的分组: ${durClusters.length} 组`)

  task.phase = '抓帧比对'
  task.done = 0
  task.total = durClusters.reduce((n, c) => n + c.length, 0)
  const ffLimit = Math.max(2, Math.min(8, limit))

  const results = await mapLimit(durClusters, ffLimit, async (cluster) => {
    const sigs = new Map()
    for (const it of cluster) {
      if (stopped()) return null
      const sig = await frameSignature(it.path, frameSeconds)
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
        if (g.sig) {
          if (sampleSignature(f.path, st.size) !== g.sig) {
            failed.push({ path: f.path, error: '内容在扫描后变了，跳过' }); continue
          }
        } else {
          // 严格模式下没有抽样签名，删除前重新逐字节确认一次，别按旧结论删
          const same = await sameContent(g.keep, f.path).catch(() => false)
          if (!same) { failed.push({ path: f.path, error: '内容在扫描后变了，跳过' }); continue }
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
      const m = /^(\d{6,})\./i.exec(name)
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
  // 跨盘搬移需要空间：同盘 rename 不占额外空间
  const uniq = [...new Set(targets)]
  const srcRoot = uniq.length ? path.parse(uniq[0]).root.toLowerCase() : ''
  const outRoot = path.parse(out).root.toLowerCase()
  if (srcRoot && srcRoot !== outRoot) {
    let bytes = 0
    for (const f of uniq) { try { bytes += (await fsp.stat(f)).size } catch { /* 忽略 */ } }
    await ensureSpace(out, bytes, task, '疑似重复输出')
  }
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
  if (fs.existsSync(targetDir) && !fs.statSync(targetDir).isDirectory()) {
    throw new Error(`目标路径已存在但不是目录：${targetDir}`)
  }
  for (const s of cfg.sources) {
    if (!s) continue
    const rs = path.resolve(s).toLowerCase()
    const rsSep = rs.endsWith(path.sep) ? rs : rs + path.sep
    const rt = path.resolve(targetDir).toLowerCase()
    if (rs === rt) throw new Error('目标目录不能与来源目录相同')
    if (rt.startsWith(rsSep)) throw new Error('目标目录不能放在来源目录内部，否则下次运行会把结果再搬一遍')
  }
  const files = await listFiles(task, cfg, ext)
  const limit = Math.max(1, Math.min(32, Number(cfg.concurrency) || Math.min(8, Math.max(2, os.cpus().length))))

  task.phase = '统计排序依据'
  task.done = 0
  task.total = files.length
  const items = []
  const probeLimit = Math.min(limit, 16)
  if (orderBy !== 'size') tlog(task, `并发读取时长: ${probeLimit}（每个文件的搬运在同一个任务里并行）`)
  await mapLimit(files, probeLimit, async (f) => {
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

  const unreadable = files.length - items.length
  if (unreadable > 0 && !stopped()) tlog(task, `${unreadable} 个文件读不到${orderBy === 'size' ? '大小' : '时长'}，已跳过`)
  if (!items.length) { tlog(task, '没有可处理的文件（后缀不匹配或读不到大小/时长）'); task.phase = '完成'; task.result = { moved: 0, failed: [] }; return }
  items.sort((a, b) => a.key - b.key || a.path.localeCompare(b.path))
  await fsp.mkdir(targetDir, { recursive: true })
  // 搬运也并发：同盘只是 rename，跨盘就是复制+删除，属于重 I/O，应该和其他文件的任务并行
  // 序号先按排序结果一次性分配，再并发执行，100000、100001… 与「短→长」严格对应
  let seq = nextSeq(targetDir)
  const plan = items.map((it) => ({ ...it, seq: seq++ }))
  const dstRoot = path.parse(targetDir).root.toLowerCase()
  const roots = new Set(plan.map((it) => path.parse(it.path).root.toLowerCase()))
  const crossVolume = [...roots].some((r) => r !== dstRoot)
  const mixedVolume = roots.size > 1
  task.phase = '重命名并移动'
  task.done = 0
  task.total = plan.length
  let moved = 0
  const failed = []
  const moveLimit = Math.min(limit, 8)
  if (crossVolume) {
    const bytesArr = await mapLimit(plan, 16, async (it) => {
      try { return (await fsp.stat(it.path)).size } catch { return 0 }
    })
    const bytes = bytesArr.reduce((a, b) => a + b, 0)
    await ensureSpace(targetDir, bytes, task, '搬移目标')
  }
  tlog(task, `并发搬运: ${moveLimit}${crossVolume ? `（跨盘：复制+删除${mixedVolume ? '，来源跨多盘' : ''}）` : `（同盘：改名）`}`)
  await mapLimit(plan, moveLimit, async (it) => {
    if (stopped()) return
    const dst = path.join(targetDir, `${it.seq}.${ext}`)
    try {
      await moveFile(it.path, dst)
      moved += 1
    } catch (e) { failed.push({ path: it.path, error: String(e.message) }) }
    task.done += 1
  })
  task.result = { moved, failed }
  tlog(task, `移动: 成功 ${moved}，失败 ${failed.length}`)
}


/* ------------------------------------------------------------------ *
 * 统一编码：按文件头识别 MOV / AVI / WMV，移动到对比目录并转成 MP4
 * ------------------------------------------------------------------ */
const HEAD_BYTES = 64

function readHead(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n)
  } finally { fs.closeSync(fd) }
}

/** 按文件头判真实类型，不看扩展名。返回 'mov' | 'avi' | 'wmv' | 'mp4' | '' */
function sniffVideoType(head) {
  if (head.length >= 12) {
    // ISO BMFF: [size:4]['ftyp'][brand:4]
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
      const brand = head.subarray(8, 12).toString('latin1')
      if (brand === 'qt  ') return 'mov'
      return 'mp4'
    }
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'AVI ') return 'avi'
  if (head.length >= 16) {
    const asf = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])
    if (head.subarray(0, 16).equals(asf)) return 'wmv'
  }
  return ''
}

const UNIFY_TYPES = new Set(['mov', 'avi', 'wmv'])

let encoderCache = null
async function availableEncoders() {
  if (encoderCache) return encoderCache
  const r = await run(ffmpegPath, ['-hide_banner', '-encoders'], 20000)
  const set = new Set()
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /\s(h264_nvenc|h264_qsv|h264_amf|libx265|hevc_nvenc|hevc_qsv|hevc_amf)\s/.exec(line)
    if (m) set.add(m[1])
  }
  encoderCache = set
  return set
}

let tonemapProbe = null
let tonemapWarned = false
let encoderFallbackWarned = false
/** 实测 zscale 是否能做色彩转换；本机若不可用则色调映射降级 */
async function canTonemap() {
  if (tonemapProbe !== null) return tonemapProbe
  const r = await run(ffmpegPath, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:duration=0.1', '-vf', 'zscale=t=bt709', '-frames:v', '1', '-f', 'null', '-'], 20000)
  tonemapProbe = r.ok
  return tonemapProbe
}

/** 是否 HDR / 高色深 */
function isHdr(v) {
  const pf = String(v.pix_fmt || '')
  const trc = String(v.color_transfer || '')
  return /10le|12le|10be|12be/.test(pf) || ['smpte2084', 'arib-std-b67'].includes(trc)
}

async function probeVideoParams(file) {
  const r = await run(ffprobePath, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], 120000)
  if (!r.ok) return null
  try {
    const j = JSON.parse(r.stdout)
    const v = (j.streams || []).find((s) => s.codec_type === 'video')
    const a = (j.streams || []).find((s) => s.codec_type === 'audio')
    if (!v) return null
    return { v, a, format: j.format || {} }
  } catch { return null }
}

function parseRate(str) {
  if (!str || typeof str !== 'string') return 0
  const [a, b] = str.split('/').map(Number)
  if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b
  const n = Number(str)
  return Number.isFinite(n) ? n : 0
}

/** 把 ffmpeg/ffprobe 复制到插件自己的 .bin，并把完整性标签改成 Medium。
 *  低完整性（Low IL）目录里的 exe 只能写低完整性目录，改标签后就能写普通目录。 */
async function ensureMediumBinaries(task) {
  try {
    await fsp.mkdir(SELF_BIN_DIR, { recursive: true })
    const pairs = [[ffmpegPath, path.join(SELF_BIN_DIR, 'ffmpeg.exe')], [ffprobePath, path.join(SELF_BIN_DIR, 'ffprobe.exe')]]
    for (const [src, dst] of pairs) {
      if (!src || src === 'ffmpeg' || !fs.existsSync(src)) continue
      if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) {
        await fsp.copyFile(src, dst)
      }
      // 不论新旧，都把副本的完整性标签设为 Medium（低完整性目录里的 exe 写不了普通目录）
      await run('icacls', [dst, '/setintegritylevel', 'Medium'], 20000).catch(() => {})
    }
    const cand = path.join(SELF_BIN_DIR, 'ffmpeg.exe')
    if (fs.existsSync(cand)) {
      // 副本坏了（被截断/被杀软隔离）就不要用，退回原始 ffmpeg
      const binTest = await run(cand, ['-version'], 15000)
      if (binTest.ok) { ffmpegActive = cand; return true }
      tlog(task, '本地 ffmpeg 副本不可用，改用原始路径')
    }

  } catch (e) { tlog(task, `准备本地 ffmpeg 副本失败：${String(e.message || e)}`) }
  return false
}

const SELF_WORK_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.work')

/** 用一次极小的编码测试目标目录是否允许 ffmpeg 写入。 */
async function ffmpegCanWrite(dir) {
  const probe = path.join(dir, '.write-probe.mp4')
  const r = await run(ffmpegActive, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:duration=0.2', '-c:v', 'libx264', '-f', 'mp4', probe], 30000)
  let ok = false
  try { ok = r.ok && fs.existsSync(probe) } catch { ok = false }
  try { if (fs.existsSync(probe)) fs.unlinkSync(probe) } catch { /* ignore */ }
  return ok
}

async function unifyTask(task, cfg) {
  const target = cfg.unifyTargetDir
  if (!target) throw new Error('还没设置对比目录')
  const keep = cfg.keepOriginal !== false
  const rt = path.resolve(target).toLowerCase()
  for (const s0 of cfg.sources) {
    if (!s0) continue
    const rs = path.resolve(s0).toLowerCase()
    const rsSep = rs.endsWith(path.sep) ? rs : rs + path.sep
    if (rs === rt) throw new Error('对比目录不能与来源目录相同')
    if (rt.startsWith(rsSep)) throw new Error('对比目录不能放在来源目录内部，否则下次扫描会把产出的 mp4 原件再转一遍')
  }

  task.phase = '按文件头识别'
  const all = await listFiles(task, cfg, null)
  task.total = all.length
  task.done = 0
  const found = []
  let insideTarget = 0
  const scanLimit = Math.max(2, Math.min(16, Number(cfg.concurrency) || 8))
  await mapLimit(all, scanLimit, async (f) => {
    if (stopped()) return
    const dir = path.resolve(path.dirname(f)).toLowerCase()
    if (dir === rt || dir.startsWith(rt + path.sep)) { insideTarget += 1; task.done += 1; return }
    let head
    try { head = readHead(f) } catch { task.done += 1; return }
    if (UNIFY_TYPES.has(sniffVideoType(head))) found.push({ path: f })
    task.done += 1
  })
  if (stopped()) return
  found.sort((a, b) => a.path.localeCompare(b.path))
  tlog(task, `按文件头命中 MOV/AVI/WMV: ${found.length} 个`)
  if (insideTarget) tlog(task, `跳过已在对比目录里的文件 ${insideTarget} 个`)
  if (!found.length) { task.result = { converted: 0, failed: [], skipped: insideTarget, keep }; return }

  // ⓪ 目标路径与子目录预检：original / fail 必须是目录
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    throw new Error(`对比目录已存在但不是目录：${target}`)
  }
  for (const sub of ['original', 'fail']) {
    const p = path.join(target, sub)
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
      throw new Error(`对比目录下的 ${sub} 已存在但不是目录：${p}，请先改名或挪走`)
    }
  }

  // ⓪ 空间预检：估算目标盘剩余空间是否够用（先建目录，否则 statfs 拿不到盘）
  await fsp.mkdir(target, { recursive: true })

  // ⓪-2 工作目录：先确保有一份可写普通目录的 ffmpeg，再实测目标目录
  await ensureMediumBinaries(task)
  let effectiveWorkDir = ''
  if (cfg.unifyWorkDir) {
    try { await fsp.mkdir(cfg.unifyWorkDir, { recursive: true }); effectiveWorkDir = cfg.unifyWorkDir }
    catch { tlog(task, '临时目录建不出来，改用自动目录') }
  }
  if (!effectiveWorkDir) {
    const targetOk = await ffmpegCanWrite(target)
    if (targetOk) effectiveWorkDir = target
    else {
      try {
        await fsp.mkdir(SELF_WORK_DIR, { recursive: true })
        if (await ffmpegCanWrite(SELF_WORK_DIR)) {
          effectiveWorkDir = SELF_WORK_DIR
          tlog(task, `注意：目标目录不接受 ffmpeg 写入，已自动改用 ${SELF_WORK_DIR} 做临时目录，转完会搬回目标目录`)
        } else {
          effectiveWorkDir = target
          tlog(task, '警告：目标目录和自动临时目录都不接受 ffmpeg 写入，请检查目录完整性（icacls）或安全软件的文件保护')
        }
      } catch { effectiveWorkDir = target }
    }
  }
    // 先并发取大小再求和：srcBytes += (await stat) 会在 await 之间丢更新
    const sizes = await mapLimit(found, 16, async (it) => {
      try { return (await fsp.stat(it.path)).size } catch { return 0 }
    })
    const srcBytes = sizes.reduce((a, b) => a + b, 0)
    const outBytes = Math.ceil(srcBytes * 1.02)
    const targetRoot = path.parse(target).root.toLowerCase()
    let sameVol = true
    for (const it of found) { if (path.parse(it.path).root.toLowerCase() !== targetRoot) { sameVol = false; break } }
    const peak = sameVol ? outBytes : srcBytes + outBytes
    tlog(task, `空间估算: 源 ${fmtBytes(srcBytes)} + 成品 ~${fmtBytes(outBytes)} → 需 ~${fmtBytes(peak)}（${sameVol ? '同盘：原件 rename 不占新空间' : '跨盘：原件要复制进对比目录'}）`)
    await ensureSpace(target, peak, task, '转码目标')

  task.phase = '移动并转码'
  task.done = 0
  task.total = found.length
  let converted = 0
  const failed = []
  const done = []
  const claimed = new Set()
  const claimedOrig = new Set()

  const encLimit = Math.max(1, Math.min(4, Number(cfg.concurrency) || 2))
  tlog(task, `并发转码: ${encLimit}`)
  await mapLimit(found, encLimit, async (item) => {
  let encoderUsed = ''
    if (stopped()) return
      const base = path.basename(item.path)
      const ext = path.extname(base)
      const stem = base.slice(0, base.length - ext.length)
      let current = item.path          // 原件当前位置（移动后变成对比目录里的路径）
      let partial = ''
      let movedDst = ""
      try {
        // 1) 取名：源文件本来就叫 .mp4 时，原件放 target\original\，避免转码结果把原件覆盖掉
        const sameExt = ext.toLowerCase() === '.mp4'
        let finalStem = stem
        let n = 0
        while (
          claimed.has(finalStem.toLowerCase())
          || fs.existsSync(path.join(target, `${finalStem}.mp4`))
          || (!sameExt && fs.existsSync(path.join(target, `${finalStem}${ext}`)))
        ) {
          n += 1
          finalStem = `${stem}(${n})`
        }
        claimed.add(finalStem.toLowerCase())
        let dst
        if (sameExt) {
          const origDir = path.join(target, 'original')
          await fsp.mkdir(origDir, { recursive: true })
          dst = path.join(origDir, base)
          let k = 0
          while (claimedOrig.has(dst.toLowerCase()) || fs.existsSync(dst)) {
            k += 1
            dst = path.join(origDir, `${stem}(${k})${ext}`)
          }
          claimedOrig.add(dst.toLowerCase())
        } else {
          dst = path.join(target, `${finalStem}${ext}`)
        }
        const finalMp4 = path.join(target, `${finalStem}.mp4`)

        // 2) 把原件搬到对比目录
        await moveFile(current, dst)
        movedDst = dst
        current = dst

        // 3) 读原片参数
        const params = await probeVideoParams(current)
        if (!params) throw new Error('ffprobe 读不出视频流')
        const { v, a } = params

        // 4) 组转码参数（分辨率按显示方向换算，避免手机竖拍被压扁）
        const rotation = videoRotation(v)
        let w = Number(v.width) || 0
        let h = Number(v.height) || 0
        if ((rotation === 90 || rotation === 270) && w && h) { const t = w; w = h; h = t }
        const hdr = isHdr(v)
        const args = ['-nostdin', '-y', '-v', 'error', '-i', current, '-map', '0:v:0', '-map_metadata', '0']
        if (a) args.push('-map', '0:a?')

        // 智能直通：本来就是 h264+aac 且非 HDR，只换容器不重编码
        const canCopy = cfg.smartCopy !== false && !hdr && String(v.codec_name) === 'h264' && (!a || String(a.codec_name) === 'aac')

        const vf = []
        if (w && h) vf.push(`scale=${w}:${h}`)
        if (!canCopy) {
          if (hdr && cfg.hdrMode === 'tonemap' && (await canTonemap())) {
            vf.length = 0
            const srcPrim = v.color_primaries && v.color_primaries !== 'unknown' ? v.color_primaries : 'bt2020'
            const srcTrc = v.color_transfer && v.color_transfer !== 'unknown' ? v.color_transfer : 'smpte2084'
            const srcMtx = v.color_space && v.color_space !== 'unknown' ? v.color_space : 'bt2020nc'
            vf.push(`zscale=t=linear:npl=100:p=${srcPrim}:m=${srcMtx}:r=tv`, 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv')
            if (w && h) vf.push(`scale=${w}:${h}`)
            vf.push('format=yuv420p')
            if (!tonemapWarned) { tonemapWarned = true; tlog(task, 'HDR 源：已用 zscale 做色调映射到 SDR') }
          } else if (hdr && cfg.hdrMode === 'tonemap') {
            vf.push('format=yuv420p')
            if (!tonemapWarned) {
              tonemapWarned = true
              tlog(task, '本机 ffmpeg 的 zscale 不可用，色调映射降级为强制 8bit（画面可能偏暗）；要保留 HDR 请选「保留 HDR」')
            }
          } else if (hdr && cfg.hdrMode === 'passthrough') {
            vf.push('format=yuv420p10le')
          } else {
            vf.push('format=yuv420p')
          }
        }

        if (canCopy) {
          args.push('-c', 'copy')
        } else if (hdr && cfg.hdrMode === 'passthrough') {
          const encs = await availableEncoders()
          const hevc = cfg.encoder === 'h264_nvenc' && encs.has('hevc_nvenc') ? 'hevc_nvenc'
            : cfg.encoder === 'h264_qsv' && encs.has('hevc_qsv') ? 'hevc_qsv'
              : cfg.encoder === 'h264_amf' && encs.has('hevc_amf') ? 'hevc_amf' : 'libx265'
          args.push('-vf', vf.join(','), '-c:v', hevc, '-tag:v', 'hvc1')
          if (hevc === 'libx265') args.push('-preset', 'medium', '-x265-params', 'log-level=error')
        } else {
          const encs = await availableEncoders()
          if (!encs.has(cfg.encoder) && cfg.encoder !== 'libx264') {
            tlog(task, `编码器 ${cfg.encoder} 不可用，退回 libx264`)
          }
          const encoder = encs.has(cfg.encoder) ? cfg.encoder : 'libx264'
          encoderUsed = encoder
          args.push('-vf', vf.join(','), '-c:v', encoder)
          if (encoder === 'libx264') args.push('-preset', 'medium')
          else if (encoder === 'h264_nvenc') args.push('-preset', 'p5', '-rc', 'vbr')
          else args.push('-preset', 'medium')
        }

        // 帧率：CFR 才强制 -r；VFR 源用 passthrough 保留原始时间戳
        const avg = parseRate(v.avg_frame_rate)
        const raw = parseRate(v.r_frame_rate)
        if (avg && raw) {
          const diff = Math.abs(avg - raw) / Math.max(avg, raw)
          if (diff < 0.01) args.push('-r', avg.toFixed(3))
          else args.push('-fps_mode', 'passthrough')
        } else if (avg) {
          args.push('-r', avg.toFixed(3))
        }

        // 码率：优先视频流自报；缺失则用「体积×8/时长 − 音频码率」估算；再缺就退回 CRF
        let vBitrate = Number(v.bit_rate || 0)
        if (!vBitrate) {
          const dur = Number(params.format.duration || 0)
          const totalBits = Number(params.format.size || 0) * 8
          const audioBps = Number(a && a.bit_rate ? a.bit_rate : 0)
          if (dur > 0 && totalBits > 0) vBitrate = Math.max(0, Math.round(totalBits / dur - audioBps))
        }
        if (vBitrate > 0) args.push('-b:v', String(vBitrate), '-maxrate', String(vBitrate), '-bufsize', String(vBitrate * 2))
        else args.push('-crf', '18')
        if (!canCopy) {
          if (a) {
            args.push('-c:a', 'aac')
            if (a.sample_rate) args.push('-ar', String(a.sample_rate))
            if (a.channels) args.push('-ac', String(a.channels))
            if (Number(a.bit_rate) > 0) args.push('-b:a', String(a.bit_rate))
          } else {
            args.push('-an')
          }
        }

        // 5) 先写临时文件（可配置临时目录，绕开安全软件对 ffmpeg 写目标目录的拦截）
        const workDir = effectiveWorkDir || target
        partial = path.join(workDir, `${finalStem}.mp4.part`)
        args.push('-movflags', '+faststart', '-f', 'mp4', partial)
        let r = await run(ffmpegActive, args, 6 * 60 * 60 * 1000)
        if (!r.ok && encoderUsed && encoderUsed !== 'libx264') {
          // 硬件编码器可能因并发会话上限/驱动问题失败，退回 x264 再试一次
          if (!encoderFallbackWarned) {
            encoderFallbackWarned = true
            tlog(task, `${encoderUsed} 编码失败，个别文件改回 x264 重试`)
          }
          const retry = []
          for (let k = 0; k < args.length; k += 1) {
            if (args[k] === encoderUsed) { retry.push('libx264'); continue }
            if (args[k] === '-rc') { k += 1; continue }
            if (args[k] === '-preset' && ['p1','p2','p3','p4','p5','p6','p7'].includes(args[k + 1])) { k += 1; continue }
            retry.push(args[k])
          }
          r = await run(ffmpegActive, retry, 6 * 60 * 60 * 1000)
        }
        if (!r.ok) throw new Error(r.error || 'ffmpeg 失败')
        const st = await fsp.stat(partial).catch(() => null)
        if (!st || !st.size) throw new Error('输出文件为 0 字节')
        const verified = await probeVideoParams(partial)
        if (!verified) throw new Error('输出文件无法解析')
        const srcDur = Number(params.format.duration || 0)
        const outDur = Number(verified.format.duration || 0)
        if (srcDur > 0 && outDur > 0) {
          const tol = Math.max(2, srcDur * 0.02)
          if (Math.abs(outDur - srcDur) > tol) {
            throw new Error(`输出时长 ${outDur.toFixed(1)}s 与原片 ${srcDur.toFixed(1)}s 不符`)
          }
        }
        try {
          if (path.dirname(partial) !== target) await moveFile(partial, finalMp4)
          else await fsp.rename(partial, finalMp4)
        } catch (moveErr) {
          // 改名失败：清掉可能的半成品，别在对比目录里留一个打不开的 mp4
          try { if (fs.existsSync(finalMp4)) await fsp.unlink(finalMp4) } catch { /* 忽略 */ }
          throw moveErr
        }
        partial = ''

        converted += 1
        done.push({ from: item.path, mp4: finalMp4, original: dst })

        // 6) 不保留原文件：确认成品有效后才删原件
        if (!keep) {
          try { await fsp.unlink(dst) }
          catch (e) { tlog(task, `原件删不掉（${path.basename(dst)}）：${String(e.message || e)}`) }
        }
      } catch (e) {
        if (partial) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try { await fsp.unlink(partial); break } catch { await new Promise((r) => setTimeout(r, 150)) }
          }
        }
        if (movedDst && movedDst !== item.path && current === item.path) { try { await fsp.unlink(movedDst) } catch { /* 忽略 */ } }
        // 用户按了停止：文件放回来源，别混进 fail/ 里冒充坏文件
        if (stopped()) {
          let back = current
          try {
            if (current !== item.path) {
              await moveFile(current, item.path)
              back = item.path
            }
          } catch { back = fs.existsSync(current) ? current : item.path }
          failed.push({ path: back, original: item.path, error: back === item.path ? '已停止，未转换（文件已放回来源目录）' : '已停止，未转换（文件留在对比目录）' })
          task.done += 1
          return
        }
        // 失败的原件统一丢进 对比目录\fail\，文件名尽量保持不变
        let where = current
        let reason = String((e && e.message) || e)
        if (/Permission denied|EACCES|EPERM/i.test(reason)) {
          reason = '写入被拒绝 / Permission denied：多半是 ffmpeg / ffprobe 所在目录权限过低，交给 AI 调整即可'
        }
        try {
          const failDir = path.join(target, 'fail')
          await fsp.mkdir(failDir, { recursive: true })
          const base = path.basename(current)
          const ext = path.extname(base)
          const stem = base.slice(0, base.length - ext.length)
          let dst = path.join(failDir, base)
          let n = 0
          while (fs.existsSync(dst)) { n += 1; dst = path.join(failDir, `${stem}(${n})${ext}`) }
          if (fs.existsSync(current)) { await moveFile(current, dst); where = dst }
        } catch { /* 连移动都失败就留在原处 */ }
        failed.push({ path: where, original: item.path, error: reason })
        tlog(task, `失败: ${path.basename(item.path)} → ${reason}`)
      }
      task.done += 1
    }
  )



  const stoppedCount = failed.filter((f) => String(f.error).startsWith('已停止')).length
  const failedCount = failed.length - stoppedCount
  task.result = { converted, failed, failedCount, stoppedCount, skipped: insideTarget, keep, sample: done.slice(0, 20), failDir: path.join(target, 'fail') }
  if (failed.length) tlog(task, `${failedCount} 个失败，原件已放入对比目录下的 fail\\`)
  tlog(task, `转码完成 ${converted} 个，失败 ${failedCount} 个${stoppedCount ? `，停止 ${stoppedCount} 个` : ''}，原文件${keep ? '保留' : '删除'}`)
}

/** 读旋转角度：优先 side_data，其次 tags.rotate。 */
function videoRotation(v) {
  const list = v.side_data_list || []
  for (const sd of list) {
    if (sd.rotation !== undefined && Number.isFinite(Number(sd.rotation))) {
      return ((Math.round(Number(sd.rotation)) % 360) + 360) % 360
    }
  }
  const tag = Number(v.tags && (v.tags.rotate || v.tags.ROTATE))
  if (Number.isFinite(tag)) return ((Math.round(tag) % 360) + 360) % 360
  return 0
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
  let p = String(target || '').trim()
  let fallback = false
  const requested = p
  // 路径不存在就逐级往上找，找到第一个存在的目录作为起点（避免"目录不存在"卡住）
  while (p) {
    try { if (fs.statSync(p).isDirectory()) break } catch { /* 继续往上找 */ }
    const up = path.dirname(p)
    if (!up || up === p) { p = ''; break }
    p = up
    fallback = true
  }
  if (!p) return { path: '', parent: '', dirs: [], roots: listRoots(), requested, fallback: !!requested }
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    const parent = path.dirname(p)
    return { path: p, parent: parent && parent !== p ? parent : '', dirs, roots: listRoots(), requested, fallback }
  } catch (e) {
    return { path: p, parent: '', dirs: [], roots: listRoots(), error: String(e.message), requested, fallback }
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

function trimResult(result) {
  if (!result) return result
  if (Array.isArray(result)) return result.slice(0, 200)
  const out = { ...result }
  if (Array.isArray(out.failed) && out.failed.length > 50) {
    if (!Number.isFinite(out.failedCount)) out.failedCount = out.failed.length
    out.failed = out.failed.slice(0, 50)
  }
  return out
}

const publicTasks = () => Object.fromEntries(Object.entries(tasks).map(([k, t]) => [k, {
  running: t.running, phase: t.phase, done: t.done, total: t.total,
  startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error,
  log: t.log.slice(-40),
  result: t.running ? null : trimResult(t.result),
  resultCount: Array.isArray(t.result) ? t.result.length : null,
}]))

export const name = NAME
export const inject = ['webServer']

export function apply(ctx) {
  const route = (p, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: p, handler }), `${NAME}: ${p}`)

  route('/dupfc/api/config', async (req, res) => {
    if (!guard(req, res, req.method !== 'GET')) return
    if (req.method === 'GET') {
      const cfg = readConfig()
      const cleared = []
      // 目录还没创建、但上级存在 → 运行时能自动建，不算脏数据
      const usable = (p) => {
        if (!p) return true
        if (fs.existsSync(p)) return true
        const parent = path.dirname(p)
        return !!parent && parent !== p && fs.existsSync(parent)
      }
      for (const k of ['outputDir', 'sizeTargetDir', 'durationTargetDir', 'unifyTargetDir', 'unifyWorkDir']) {
        const v = cfg[k]
        if (v && !usable(v)) { cleared.push({ field: k, path: v }); cfg[k] = '' }
      }
      const beforeSources = cfg.sources.length
      cfg.sources = cfg.sources.filter((s) => s && fs.existsSync(s))
      const missingSources = []
      if (cfg.sources.length !== beforeSources) { const disk = readConfig(); disk.sources = cfg.sources; writeConfig(disk) }
      const clearedSources = beforeSources - cfg.sources.length
      // 被清掉的目录同步落盘，避免每次打开面板都再报一次
      if (cleared.length) { const disk = readConfig(); for (const c of cleared) disk[c.field] = ''; writeConfig(disk) }
      return sendJson(res, 200, { ...cfg, token: API_TOKEN, clearedDirs: cleared, clearedSources, missingSources })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    try {
      const body = JSON.parse(await readBody(req))
      const cfg = readConfig()
      let droppedSources = 0
      if (Array.isArray(body.sources)) {
        const wanted = body.sources.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
        cfg.sources = wanted.filter((s) => { const ok = fs.existsSync(s); if (!ok) droppedSources += 1; return ok })
      }
      for (const k of ['outputDir', 'sizeTargetDir', 'durationTargetDir', 'unifyTargetDir', 'unifyWorkDir']) if (typeof body[k] === 'string') cfg[k] = body[k].trim()
      if (typeof body.keepOriginal === 'boolean') cfg.keepOriginal = body.keepOriginal
      if (['force8', 'tonemap', 'passthrough'].includes(body.hdrMode)) cfg.hdrMode = body.hdrMode
      if (typeof body.smartCopy === 'boolean') cfg.smartCopy = body.smartCopy
      if (['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(body.encoder)) cfg.encoder = body.encoder
      for (const k of ['ext', 'uuidExt', 'sizeExt', 'durationExt']) if (body[k] !== undefined) cfg[k] = normalizeExt(body[k]) || cfg[k]
      if (body.exactMode === 'strict' || body.exactMode === 'fast') cfg.exactMode = body.exactMode
      if (Number.isFinite(body.durationToleranceMs)) cfg.durationToleranceMs = Math.max(0, Math.min(10000, Math.round(body.durationToleranceMs)))
      if (Number.isFinite(body.frameSimilarity)) cfg.frameSimilarity = Math.min(1, Math.max(0.1, body.frameSimilarity))
      if (Number.isFinite(body.frameSeconds)) cfg.frameSeconds = Math.max(1, Math.min(120, Math.round(body.frameSeconds)))
      if (Number.isFinite(body.concurrency)) cfg.concurrency = Math.max(0, Math.min(32, Math.round(body.concurrency)))
      writeConfig(cfg)
      return sendJson(res, 200, { ok: true, config: cfg, droppedSources })
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
  startRoute('/dupfc/api/unify', 'unify', '统一编码', (t, c) => unifyTask(t, c))

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
