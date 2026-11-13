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
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  openFingerprintStore,
  fingerprintDbPath,
  pathKey,
  dirKey,
  videoProfile,
  videoIntroProfile,
  frameCount,
  validFrameBuf,
  decodeIntroRow,
} from './fingerprint-db.mjs'

const NAME = 'dsh-duplicate-file-check'
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CFG_FILE = path.join(HOME, '.dsh', 'duplicate-file-check.json')
const API_TOKEN = crypto.randomBytes(16).toString('hex')
const SESSION_COOKIE = 'dupfc_session'

const SAMPLE_BYTES = 100 * 1024
const VIDEO_CLUSTER_CAP = 300
const FRAME_COUNT = 10
const FRAME_SIDE = 16
const DEFAULT_SIMILARITY = 0.9

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(SELF_DIR, 'worker.mjs')
// 每次启动 worker 时读取，回归用例可以临时压小上限验证“超内存只杀 worker”。
const workerHeapMb = () => Math.max(256, Math.min(4096, Number(process.env.DFC_WORKER_HEAP_MB) || 2048))
const workerMemMb = () => Math.max(64, Math.min(8192, Number(process.env.DFC_WORKER_MEM_MB) || 3072))
const SELF_BIN_DIR = path.join(path.dirname(SELF_DIR), '.bin')
const requireFromPlugin = createRequire(import.meta.url)

/** 可选依赖安装器提供的二进制路径；未安装时返回空串。 */
function installerBinary(pkg) {
  try {
    const mod = requireFromPlugin(pkg)
    const candidate = typeof mod === 'string' ? mod : mod && mod.path
    if (candidate && fs.existsSync(candidate)) return candidate
  } catch { /* optional dependency is allowed to be absent */ }
  return ''
}

const ffmpegPath = (() => {
  const fromEnv = process.env.DFC_FFMPEG_PATH || process.env.FFMPEG_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const installed = installerBinary('@ffmpeg-installer/ffmpeg')
  if (installed) return installed
  const bundled = path.join(SELF_BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (fs.existsSync(bundled)) return bundled
  return 'ffmpeg'
})()
let ffmpegActive = ffmpegPath
const ffprobePath = (() => {
  const fromEnv = process.env.DFC_FFPROBE_PATH || process.env.FFPROBE_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const installed = installerBinary('@ffprobe-installer/ffprobe')
  if (installed) return installed
  const sibling = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  if (sibling !== ffmpegPath && fs.existsSync(sibling)) return sibling
  return 'ffprobe'
})()
let ffprobeActive = ffprobePath

/**
 * 在 PATH 中查找可执行文件。Windows 会额外尝试 .exe。
 * @param {string} name
 * @returns {string}
 */
function commandOnPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* keep looking */ }
    }
  }
  return ''
}

/**
 * 把一个已解析的二进制路径转成可展示的依赖状态。
 * @param {string} resolved 解析结果，可能是 PATH 名（如 ffmpeg）
 * @param {string} fallback PATH 回退名
 * @param {string[]} envNames 可覆盖的环境变量
 */
function binaryDependency(resolved, fallback, envNames) {
  let source = 'PATH'
  if (resolved !== fallback) {
    if (envNames.some((k) => process.env[k] && process.env[k] === resolved)) source = 'env'
    else if (resolved.startsWith(SELF_BIN_DIR)) source = 'plugin .bin'
    else source = 'optional dependency'
  } else {
    const onPath = commandOnPath(fallback)
    if (onPath) return { ok: true, path: onPath, source: 'PATH' }
    return {
      ok: false,
      path: fallback,
      source: 'missing',
      error: `找不到 ${fallback}；请重新安装依赖，或设置 ${envNames[0]} 指向可执行文件`,
    }
  }
  return { ok: true, path: resolved, source }
}

let sqliteProbe = null
/** 检查当前 Node/Electron 是否带 node:sqlite；结果缓存。 */
function probeSqlite() {
  if (!sqliteProbe) {
    sqliteProbe = import('node:sqlite').then((m) => ({
      ok: typeof m.DatabaseSync === 'function',
      source: 'built-in',
      detail: typeof m.DatabaseSync === 'function' ? 'node:sqlite 可用' : 'node:sqlite 缺少 DatabaseSync',
    })).catch((e) => ({
      ok: false,
      source: 'missing',
      error: `当前 Node ${process.version} 没有 node:sqlite，需要 Node.js 22.5+`,
      detail: errText(e),
    }))
  }
  return sqliteProbe
}

/** 新用户首次打开面板时展示的依赖状态；不会阻塞安装，也不会因缺依赖让插件崩溃。 */
async function dependencyStatus() {
  return {
    node: process.version,
    ffmpeg: binaryDependency(ffmpegPath, 'ffmpeg', ['DFC_FFMPEG_PATH', 'FFMPEG_PATH']),
    ffprobe: binaryDependency(ffprobePath, 'ffprobe', ['DFC_FFPROBE_PATH', 'FFPROBE_PATH']),
    sqlite: await probeSqlite(),
  }
}

/* ------------------------------------------------------------------ *
 * 日志：每次 DSH 启动只保留 3 个槽位，清空并复用最旧的那个
 * ------------------------------------------------------------------ */
const LOG_DIR = process.env.DFC_LOG_DIR || path.join(os.homedir(), 'dupfc', 'logs')
const LOG_SLOTS = [1, 2, 3].map((n) => path.join(LOG_DIR, `dupfc-${n}.log`))
let LOG_FILE = ''

/** 把异常转成可读文本，错误对象带 stack，字符串原样返回。 */
function errText(e) {
  if (!e) return ''
  if (typeof e === 'string') return e
  return String(e.stack || e.message || e)
}

/**
 * 追加一行持久日志；日志是旁路，不允许因为磁盘/权限问题影响任务。
 * @param {'INFO'|'WARN'|'ERROR'|'TASK'|'WORKER'} level 级别
 * @param {string} msg 正文
 * @param {unknown} [e] 可选异常，写 stack
 */
function flog(level, msg, e) {
  if (!LOG_FILE) return
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${e ? `\n${errText(e)}` : ''}\n`
  try { fs.appendFileSync(LOG_FILE, line, 'utf8') } catch { /* 日志失败不能拖垮任务 */ }
}

/**
 * 初始化本次 DSH 启动的日志文件：
 * 三个槽位始终存在；选择 mtime 最旧（新建槽位按 1970 算）的一个清空并写入。
 * 这样连续启动 1→2→3→1 轮换，任何时刻最多只有 3 个日志文件。
 */
function initLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const slots = LOG_SLOTS.map((p) => {
      let mtime = 0
      try { mtime = fs.statSync(p).mtimeMs } catch { fs.writeFileSync(p, '', 'utf8'); try { fs.utimesSync(p, 0, 0) } catch {} }
      return { p, mtime }
    })
    slots.sort((a, b) => a.mtime - b.mtime || a.p.localeCompare(b.p))
    LOG_FILE = slots[0].p
    fs.writeFileSync(LOG_FILE, '', 'utf8')
    flog('INFO', `DSH 启动：pid=${process.pid} node=${process.version} platform=${process.platform} ` +
      `ffmpeg=${ffmpegPath} workerHeap=${workerHeapMb()}MB workerRssLimit=${workerMemMb()}MB log=${LOG_FILE}`)
  } catch (e) {
    LOG_FILE = ''
    console.error(`[${NAME}] 日志初始化失败: ${errText(e)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
const defaultConfig = () => ({
  sources: [],
  outputDir: '',
  durationToleranceMs: 100,
  frameSimilarity: DEFAULT_SIMILARITY,
  frameSeconds: 10,
  frameFps: 2,
  videoIntroSeconds: 40,
  videoIntroFps: 2,
  videoIntroOffset: 10,
  videoIntroFailMax: 8,
  videoIntroFailReset: 15,
  videoIntroOutDir: '',
  concurrency: 0,
  exactMode: 'fast',
  videoIntroMadMax: 15,
  videoIntroDHashMax: 4,
  videoIntroPHashMax: 8,
  videoIntroCoverage: 90,
  videoIntroRunRatio: 85,
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
  fingerprintDb: '',
  fingerprintCache: true,
  syncFingerprintsRenameExt: false,
  syncFingerprintsUuid: false,
  syncFingerprintsBySize: false,
  syncFingerprintsByDuration: false,
})

function normalizeExt(x) {
  const s = String(x || '').trim().replace(/^\.+/, '').toLowerCase()
  return /^[a-z0-9]{1,16}$/.test(s) ? s : ''
}

function readConfig() {
  const out = defaultConfig()
  let raw
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch { return out }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (Array.isArray(raw.sources)) out.sources = raw.sources.filter((s) => typeof s === 'string')
  for (const k of ['outputDir', 'sizeTargetDir', 'durationTargetDir', 'unifyTargetDir', 'unifyWorkDir', 'videoIntroOutDir', 'fingerprintDb']) if (typeof raw[k] === 'string') out[k] = raw[k]
  if (typeof raw.fingerprintCache === 'boolean') out.fingerprintCache = raw.fingerprintCache
  for (const k of ['syncFingerprintsRenameExt', 'syncFingerprintsUuid', 'syncFingerprintsBySize', 'syncFingerprintsByDuration']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k]
  }
  if (typeof raw.keepOriginal === 'boolean') out.keepOriginal = raw.keepOriginal
  if (['force8', 'tonemap', 'passthrough'].includes(raw.hdrMode)) out.hdrMode = raw.hdrMode
  if (typeof raw.smartCopy === 'boolean') out.smartCopy = raw.smartCopy
  if (['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(raw.encoder)) out.encoder = raw.encoder
  if (fingerprintDbError(out.fingerprintDb, out.sources)) out.fingerprintDb = ''
  for (const k of ['ext', 'uuidExt', 'sizeExt', 'durationExt']) out[k] = normalizeExt(raw[k]) || out[k]
  if (raw.exactMode === 'strict' || raw.exactMode === 'fast') out.exactMode = raw.exactMode
  if (Number.isFinite(raw.durationToleranceMs)) out.durationToleranceMs = Math.max(0, Math.min(10000, Math.round(raw.durationToleranceMs)))
  if (Number.isFinite(raw.frameSimilarity)) out.frameSimilarity = Math.min(1, Math.max(0.1, raw.frameSimilarity))
  if (Number.isFinite(raw.frameSeconds)) out.frameSeconds = Math.max(1, Math.min(120, Math.round(raw.frameSeconds)))
  if (Number.isFinite(raw.frameFps)) out.frameFps = Math.max(1, Math.min(5, Math.round(raw.frameFps)))
  if (Number.isFinite(raw.videoIntroSeconds)) out.videoIntroSeconds = Math.max(1, Math.min(60, Math.round(raw.videoIntroSeconds)))
  if (Number.isFinite(raw.videoIntroFps)) out.videoIntroFps = Math.max(1, Math.min(5, Math.round(raw.videoIntroFps)))
  if (Number.isFinite(raw.videoIntroFailMax)) out.videoIntroFailMax = Math.max(1, Math.min(100, Math.round(raw.videoIntroFailMax)))
  if (Number.isFinite(raw.videoIntroFailReset)) out.videoIntroFailReset = Math.max(1, Math.min(300, Math.round(raw.videoIntroFailReset)))
  if (Number.isFinite(raw.videoIntroMadMax)) out.videoIntroMadMax = Math.max(1, Math.min(64, Math.round(raw.videoIntroMadMax)))
  // 8bit×8 band 的鸽巢保证只覆盖 D≤7；D=8 时每个 band 都可能翻 1 bit，band 索引会漏检。
  if (Number.isFinite(raw.videoIntroDHashMax)) out.videoIntroDHashMax = Math.max(0, Math.min(7, Math.round(raw.videoIntroDHashMax)))
  if (Number.isFinite(raw.videoIntroPHashMax)) out.videoIntroPHashMax = Math.max(0, Math.min(24, Math.round(raw.videoIntroPHashMax)))
  if (Number.isFinite(raw.videoIntroCoverage)) out.videoIntroCoverage = Math.max(50, Math.min(100, Math.round(raw.videoIntroCoverage)))
  if (Number.isFinite(raw.videoIntroRunRatio)) out.videoIntroRunRatio = Math.max(50, Math.min(100, Math.round(raw.videoIntroRunRatio)))
  const offRaw = Number.isFinite(raw.videoIntroOffset) ? raw.videoIntroOffset : out.videoIntroOffset
  out.videoIntroOffset = Math.max(0, Math.min(20, Math.round(offRaw), Math.max(0, (out.videoIntroSeconds || 40) - 5)))
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

/** 杀掉子进程及其整棵树：worker 下面还有 ffmpeg，只杀 worker 会留下孤儿。 */
function killProcessTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch { /* 进程可能已退出 */ }
}

function killChildren() {
  for (const child of activeChildren) killProcessTree(child)
  activeChildren.clear()
}

const stopped = () => stopRequested

/** 同盘 rename；仅在跨盘（EXDEV）时复制再删；目标已存在等错误直接抛出，避免覆盖。 */
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    // 先复制到目标目录内的临时名，成功后再原子落位；copy 中途失败不会留下半截目标。
    const tmp = `${to}.dupfc-part-${process.pid}-${Date.now()}`
    try {
      await fsp.copyFile(from, tmp, fs.constants.COPYFILE_EXCL)
      try {
        await fsp.link(tmp, to)
      } catch (linkErr) {
        // 少数文件系统不支持硬链接：目标不存在时才允许 rename 落位。
        if (linkErr.code === 'EEXIST') throw linkErr
        try { await fsp.access(to) ; throw Object.assign(new Error('目标已存在'), { code: 'EEXIST' }) } catch (accessErr) {
          if (accessErr.code !== 'ENOENT') throw accessErr
        }
        await fsp.rename(tmp, to)
      }
      await fsp.unlink(tmp)
      await fsp.unlink(from)
    } catch (copyErr) {
      try { await fsp.unlink(tmp) } catch { /* 临时文件可能已移走/不存在 */ }
      throw copyErr
    }
  }
}

/** child 是否等于 parent 或位于 parent 内部（Windows 下忽略大小写）。 */
function pathInside(child, parent) {
  if (!child || !parent) return false
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase())
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** 校验显式指定的指纹库路径；返回空串表示可用，否则返回用户可读错误。
 *  空值合法（走默认 LOCALAPPDATA），但显式值不能是相对路径、目录、DSH 用户目录或来源目录。 */
function fingerprintDbError(raw, sources = []) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (!path.isAbsolute(s)) return '指纹数据库路径必须是绝对路径'
  if (/[\\/]$/.test(s)) return '指纹数据库路径必须包含文件名'
  try {
    if (fs.existsSync(s) && fs.statSync(s).isDirectory()) return '指纹数据库路径不能是目录'
  } catch { /* 路径暂时不可访问时仍允许，打开失败会退回全量抓帧 */ }
  const abs = path.resolve(s)
  if (pathInside(abs, path.join(os.homedir(), '.dsh'))) return '指纹数据库不能放在 DSH 用户目录'
  for (const src of sources) {
    if (src && pathInside(abs, src)) return '指纹数据库不能放在来源目录内'
  }
  return ''
}

/** 搬运成功后再写复位记录；记录失败则尽量搬回，避免文件与记录脱节。
 *  recName 用于文件不在记录目录根下时（例如 unify 的 fail\xxx）。 */
async function moveWithRecord(from, to, recMove, recName) {
  await moveFile(from, to)
  try {
    await recMove({ name: recName || path.basename(to), from })
  } catch (e) {
    try { await moveFile(to, from) } catch { /* 搬回失败，交给任务错误 */ }
    throw e
  }
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

/**
 * 并发映射：最多 limit 个 worker 同时消费 items，保持结果顺序。
 * 与 Promise.all(items.map(...)) 的区别是不会一次性开出 N 个任务；
 * 每个 worker 取下一个下标，遇到 stopped() 立即收手，用于支持“停止”按钮。
 * @template T,R
 * @param {T[]} items 待处理列表
 * @param {number} limit 并发上限
 * @param {(item:T,index:number)=>Promise<R>} worker 处理函数
 * @returns {Promise<R[]>} 与输入同序的结果数组（未执行的位置为 undefined）
 */
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
  return { running: false, phase: '空闲', done: 0, total: 0, startedAt: 0, finishedAt: 0, error: '', log: [], result: null, workerRss: 0 }
}

const tasks = {
  exact: blankTask(),
  video: blankTask(),
  videoIntro: blankTask(),
  renameExt: blankTask(),
  uuid: blankTask(),
  emptyDirs: blankTask(),
  bySize: blankTask(),
  byDuration: blankTask(),
  unify: blankTask(),
}

/**
 * 往任务日志里追加一行带时间戳的记录。
 * 任务运行期间自动加“（任务尚未结束）”后缀，让用户知道后面还有步骤；
 * 日志只保留最近 300 行，避免长任务把内存和接口响应撑大。
 * @param {object} task 任务状态对象
 * @param {string} msg 日志正文
 */
function tlog(task, msg) {
  const suffix = task && task.running && !String(msg).includes('任务尚未结束') ? '（任务尚未结束）' : ''
  task.log.push(`${new Date().toTimeString().slice(0, 8)} ${msg}${suffix}`)
  if (task.log.length > 300) task.log.splice(0, task.log.length - 300)
  // 任务关键日志同步落盘；worker 进程里的 LOG_FILE 为空，不会重复写。
  flog('TASK', String(msg) + suffix)
}

/**
 * 任务统一外壳：加锁 → 重置状态 → 执行 → 收尾。
 * 所有扫描/移动任务都从这里进，保证同一时间只跑一个重操作（opLock），
 * 并统一处理停止、异常、子进程清理、阶段与结束日志。
 * @param {string} name tasks 里的键（videoIntro/exact/...）
 * @param {string} label 展示用任务名，写进结束日志
 * @param {(task:object)=>Promise<void>} fn 实际任务体；结果写 task.result
 * @returns {Promise<{ok:boolean,error?:string}>} 开始失败时返回 error；正常结束返回 ok
 */
async function runTask(name, label, fn) {
  if (opLock) return { ok: false, error: `有操作正在执行（${opLock}），请等它结束` }
  const task = tasks[name]
  Object.assign(task, blankTask(), { running: true, phase: '准备中', startedAt: Date.now() })
  stopRequested = false
  opLock = label
  const t0 = Date.now()
  flog('INFO', `任务开始：${label} (${name})`)
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
      flog('ERROR', `任务异常：${label} (${name})`, e)
    }
  } finally {
    killChildren()
    task.running = false
    task.finishedAt = Date.now()
    if (task.phase === '完成') tlog(task, `任务已结束：${label}`)
    else tlog(task, `任务已结束：${label}（${task.phase}）`)
    flog('INFO', `任务结束：${label} (${name}) 状态=${task.phase} 耗时=${Date.now() - t0}ms` +
      (task.error ? ` 错误=${task.error}` : ''))
    opLock = ''
  }
  return { ok: true }
}

/**
 * 在独立 Node 进程里跑重扫描（video / videoIntro）。
 *
 * 父进程只负责：启动 worker、把 progress 合并进 task、按 RSS 上限杀进程、
 * 停止时杀整棵树。worker 崩溃/超限只让当前任务失败，DSH 主进程不受影响。
 * @param {'video'|'videoIntro'} taskName worker 任务名
 * @param {object} task 父进程任务状态
 * @param {object} cfg 当前配置快照
 * @returns {Promise<void>} worker 正常结束 resolve；崩溃/超限/协议错误 reject
 */
function mirrorWorkerLog(task, lines, total) {
  if (!Array.isArray(lines) || !lines.length) return
  // lines 只是日志尾部窗口；total 是窗口最后一行的绝对行号。
  // 用绝对行号去重，避免窗口长度固定后“seen 等于长度”导致后续日志永远写不进去。
  const totalN = Number.isFinite(total) ? Number(total) : (Number(task._workerLogSeen) || 0) + lines.length
  const start = Math.max(0, totalN - lines.length)
  let seen = Number(task._workerLogSeen) || 0
  if (seen < start) seen = start // 中间有未收到的行，只能从当前窗口开始
  for (let i = Math.max(0, seen - start); i < lines.length; i += 1) flog('WORKER', String(lines[i]))
  task._workerLogSeen = totalN
  task._workerLogTotal = totalN
}

function runScanInWorker(taskName, task, cfg) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${workerHeapMb()}`,
      WORKER_PATH,
      taskName,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // DSH 桌面端的 process.execPath 是 Electron 主程序；直接 spawn 会再起一个
      // Electron 窗口而不是 Node worker。ELECTRON_RUN_AS_NODE 让它以纯 Node 运行
      // worker.mjs；在普通 Node 宿主下该环境变量无副作用。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    activeChildren.add(child)
    task._workerLogSeen = 0
    const workerStarted = Date.now()

    let settled = false
    let outBuf = ''
    let errBuf = ''
    let peakRss = 0
    flog('INFO', `worker 启动：${taskName} pid=${child.pid} heap=${workerHeapMb()}MB rssLimit=${workerMemMb()}MB`)

    const finish = (err, result) => {
      if (settled) return
      settled = true
      clearInterval(watch)
      activeChildren.delete(child)
      if (err) {
        if (Array.isArray(task.log)) mirrorWorkerLog(task, task.log, task._workerLogTotal)
        flog('ERROR', `worker 失败：${taskName} pid=${child.pid}`, err)
        reject(err)
      } else {
        if (result && Array.isArray(result.result)) task.result = result.result
        if (result && Array.isArray(result.log)) {
          task.log = result.log
          mirrorWorkerLog(task, result.log, result.logTotal)
        }
        if (result && result.phase) task.phase = result.phase
        if (result && Number.isFinite(result.done)) task.done = result.done
        if (result && Number.isFinite(result.total)) task.total = result.total
        if (result && Number.isFinite(result.rss)) task.workerRss = result.rss
        if (stopped()) {
          flog('WARN', `worker 已停止：${taskName} pid=${child.pid} 耗时=${Date.now() - workerStarted}ms`)
        } else {
          flog('INFO', `worker 完成：${taskName} pid=${child.pid} 耗时=${Date.now() - workerStarted}ms ` +
            `peakRss=${(peakRss / 1024 / 1024).toFixed(0)}MB`)
        }
        resolve()
      }
    }

    const watch = setInterval(() => {
      if (settled) return
      const limitMb = workerMemMb()
      if (peakRss > limitMb * 1024 * 1024) {
        const msg = `worker 内存超限（${(peakRss / 1024 / 1024).toFixed(0)} MB > ${limitMb} MB），已终止`
        task.error = msg
        tlog(task, msg)
        flog('ERROR', `${msg} task=${taskName} pid=${child.pid}`)
        killProcessTree(child)
        finish(new Error(msg))
      }
    }, 500)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      outBuf += chunk
      for (;;) {
        const nl = outBuf.indexOf('\n')
        if (nl < 0) break
        const line = outBuf.slice(0, nl).trim()
        outBuf = outBuf.slice(nl + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch {
          flog('WARN', `worker 输出非 JSON（已忽略）：${line.slice(0, 500)}`)
          continue
        }
        if (msg.type === 'progress') {
          if (typeof msg.phase === 'string') task.phase = msg.phase
          if (Number.isFinite(msg.done)) task.done = msg.done
          if (Number.isFinite(msg.total)) task.total = msg.total
          if (Number.isFinite(msg.rss)) {
            peakRss = Math.max(peakRss, msg.rss)
            task.workerRss = msg.rss
          }
          if (Array.isArray(msg.log)) {
            task.log = msg.log
            mirrorWorkerLog(task, msg.log, msg.logTotal)
          }
        } else if (msg.type === 'done') {
          finish(null, msg)
        } else if (msg.type === 'error') {
          flog('ERROR', `worker 上报错误：${taskName} pid=${child.pid} ${String(msg.error || '')}`)
          finish(new Error(String(msg.error || 'worker 失败').split('\n')[0]))
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      errBuf = (errBuf + chunk).slice(-4000)
    })
    child.on('error', (e) => {
      flog('ERROR', `worker 进程错误：${taskName}`, e)
      finish(e)
    })
    child.on('exit', (code, signal) => {
      if (errBuf.trim()) flog('WARN', `worker stderr：${taskName} ${errBuf.trim().slice(-2000)}`)
      // 给 stdout 最后一个 chunk 一点时间；正常 done 已经 settle 了。
      setImmediate(() => {
        if (settled) return
        if (stopped()) return finish(null)
        const tail = errBuf.trim() ? `：${errBuf.trim().split('\n').slice(-3).join(' | ')}` : ''
        finish(new Error(`worker 异常退出（code=${code}${signal ? ' signal=' + signal : ''}）${tail}`))
      })
    })

    child.stdin.on('error', () => { /* worker 提前退出时 EPIPE 忽略，exit 会报错 */ })
    child.stdin.end(JSON.stringify({ cfg }))
  })
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

/**
 * 递归收集来源目录下的文件，并做去重与可选的扩展名过滤。
 * 来源目录可能互相嵌套或重复配置，所以按 resolve+小写路径去重；
 * 不存在的来源目录只记日志、不抛错，避免一个坏路径让整个任务失败。
 * @param {object} task 任务对象，用于 tlog/total
 * @param {object} cfg 配置，读取 cfg.sources
 * @param {string|null} extFilter 只要该扩展名（不带点），null 表示全部
 * @returns {Promise<string[]>} 去重后的文件绝对路径列表
 */
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

/** 读取样本签名：头/中/尾各最多 SAMPLE_BYTES，异步读，避免同步 IO 卡住事件循环。 */
async function sampleSignature(file, size) {
  if (size <= 0) return ''
  const fh = await fsp.open(file, 'r')
  try {
    const chunk = size >= SAMPLE_BYTES * 3 ? SAMPLE_BYTES : Math.max(1, Math.floor(size / 3))
    const readAt = async (position, len) => {
      const buf = Buffer.allocUnsafe(len)
      const { bytesRead } = await fh.read(buf, 0, len, position)
      return buf.subarray(0, bytesRead)
    }
    const head = await readAt(0, Math.min(chunk, size))
    const midStart = Math.max(0, Math.floor(size / 2 - chunk / 2))
    const mid = await readAt(midStart, Math.min(chunk, size - midStart))
    const tailStart = Math.max(0, size - chunk)
    const tail = await readAt(tailStart, Math.min(chunk, size - tailStart))
    return [head.toString('hex'), mid.toString('hex'), tail.toString('hex')].join('|')
  } finally {
    await fh.close().catch(() => {})
  }
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
    const child = execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      activeChildren.delete(child)
      const errText = err ? String(err.message) + (stderr ? `：${String(stderr).trim().slice(-2000)}` : '') : ''
      resolve({ ok: !err, stdout: String(stdout || ''), error: errText })
    })
    activeChildren.add(child)
    if (stopped()) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
  })
}

async function probeDurationMs(file) {
  const r = await run(ffprobeActive, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 60000)
  const n = Number((r.stdout || '').trim())
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0
}

async function frameSignature(file, seconds, fps) {
  return new Promise((resolve) => {
    const chunks = []
    const child = execFile(
      ffmpegPath,
      ['-nostdin', '-v', 'error', '-ss', '0', '-t', String(seconds || FRAME_COUNT), '-i', file,
        '-vf', `fps=${Math.max(1, Math.min(5, Number(fps) || 1))},scale=${FRAME_SIDE}:${FRAME_SIDE}:flags=area,format=gray`,
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
    // 与簇首比较而不是与上一个比较，避免 100.0/100.1/100.2 链式并成一簇
    if (it.durationMs - cur[0].durationMs <= Math.max(0, toleranceMs)) cur.push(it)
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
    let compareErrors = 0
    for (const item of group) {
      if (stopped()) return []
      let sig = null
      if (!strict) { try { sig = await sampleSignature(item.path, item.size) } catch { task.done += 1; continue } }
      let placed = false
      let compareFailed = false
      for (const b of buckets) {
        if (strict) {
          try {
            if (await sameContent(b.rep.path, item.path)) { b.items.push(item); placed = true; break }
          } catch {
            compareFailed = true
            compareErrors += 1
            break
          }
        } else if (b.sig === sig) { b.items.push(item); placed = true; break }
      }
      if (compareFailed) { task.done += 1; continue }
      if (!placed) buckets.push({ sig, rep: item, items: [item] })
      task.done += 1
    }
    if (compareErrors) tlog(task, `严格比对时有 ${compareErrors} 个文件读取失败，已跳过（不影响其他文件）`)
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
 * 指纹缓存：目录内按 path+size 复用，目录枚举成功后清理已删除/大小变化的文件
 * ------------------------------------------------------------------ */
const fpCacheEnabled = (cfg) => cfg.fingerprintCache !== false && process.env.DFC_FP_CACHE !== '0'

/**
 * 指纹写入队列：抓帧主循环只 push，不在这里同步写 SQLite。
 * 每次 setImmediate 批量写一小批，避免所有新记录堆到扫描结束才一次性写。
 * 注意 node:sqlite 是同步 API，因此这里是“异步让出 + 小批量”，
 * 不是独立线程；真正的独立写线程需要 worker_threads。
 * @param {object} cache
 * @param {number} batch
 */
function createRowWriter(cache, profile, batch = 32) {
  let queue = []
  let scheduled = false
  let active = 0
  let written = 0
  let firstError = null
  const schedule = () => {
    if (scheduled || firstError) return
    scheduled = true
    setImmediate(pump)
  }
  const pump = async () => {
    scheduled = false
    if (firstError || !queue.length) return
    active += 1
    const rows = queue.splice(0, batch)
    try {
      cache.upsert(rows)
      written += rows.length
    } catch (e) {
      firstError = e
      queue = []
    }
    active -= 1
    if (queue.length) schedule()
  }
  return {
    push(row) {
      if (firstError) return
      queue.push(row)
      schedule()
    },
    async drain() {
      while (queue.length || scheduled || active) await new Promise((r) => setImmediate(r))
      if (firstError) throw firstError
    },
    get pending() { return queue.length + active },
    get written() { return written },
  }
}

async function openFingerprintCache(task, cfg) {
  if (!fpCacheEnabled(cfg)) return null
  try {
    const cache = await openFingerprintStore(fingerprintDbPath(cfg))
    tlog(task, `指纹缓存: ${cache.dbPath}`)
    return cache
  } catch (e) {
    tlog(task, `指纹缓存不可用，本次全量抓帧: ${String((e && e.message) || e)}`)
    return null
  }
}

/**
 * 读取候选文件的 stat 与目录内缓存记录。
 * 只有 size 一致才复用；mtime 只记录不参与命中判断。
 * 等目录完整处理完再由 finishFingerprintCache 统一清理。
 */
async function prepareFingerprintCache(task, cfg, profile, files, limit) {
  const cache = await openFingerprintCache(task, cfg)
  if (!cache) return { cache: null, rows: new Map(), stats: new Map(), presentByDir: new Map(), unsafeDirs: new Set() }
  const stats = new Map()
  const presentByDir = new Map()
  const unsafeDirs = new Set()
  // stat 是缓存准备阶段的主要 I/O；扫描并发只有 3 时不能再把 stat 压到 3。
  // 默认 16 路，可用 DFC_FP_STAT_CONCURRENCY 调整，最大 32。
  const statConc = Math.max(1, Math.min(32, Number(process.env.DFC_FP_STAT_CONCURRENCY) || 16))
  await mapLimit(files, statConc, async (f) => {
    try {
      const st = await fsp.stat(f)
      if (!st.isFile()) return
      stats.set(f, { size: st.size, mtimeMs: st.mtimeMs })
      const dk = dirKey(path.dirname(f))
      const set = presentByDir.get(dk) || new Set()
      set.add(pathKey(f))
      presentByDir.set(dk, set)
    } catch (e) {
      // ENOENT 是真删除，交给 finish 清理；其他错误是临时锁/权限抖动，
      // 不能因此把该目录剩余文件的缓存当成“文件已删除”。
      if (e && e.code !== 'ENOENT') unsafeDirs.add(dirKey(path.dirname(f)))
    }
  })
  const rows = new Map()
  const filesByDir = new Map()
  for (const f of files) {
    const dk = dirKey(path.dirname(f))
    const arr = filesByDir.get(dk) || []
    arr.push(f)
    filesByDir.set(dk, arr)
  }
  for (const [dk, arr] of filesByDir) {
    const byKey = cache.getDir(dk, profile)
    const hitKeys = []
    for (const f of arr) {
      const st = stats.get(f)
      const key = pathKey(f)
      const row = byKey.get(key)
      if (row && st && row.size === st.size) {
        rows.set(key, row)
        hitKeys.push(key)
      }
    }
    if (hitKeys.length) {
      // 只读取真正命中的行；未命中的目录行不再携带 BLOB 进出内存。
      const blobs = cache.getBlobs(hitKeys, profile)
      for (const key of hitKeys) {
        const blob = blobs.get(key)
        if (blob) rows.set(key, { ...rows.get(key), ...blob })
      }
    }
  }
  return { cache, rows, stats, presentByDir, unsafeDirs }
}

/**
 * 写回新抓的指纹，并删除本目录里已经不存在的文件记录。
 * 只在扫描未被停止、目录已完整枚举时调用；记录写失败只记日志，不影响扫描结果。
 */
async function finishFingerprintCache(task, cache, profile, presentByDir, newRows, unsafeDirs, extraWritten = 0) {
  if (!cache) return
  try {
    if (newRows && newRows.length) cache.upsert(newRows)
    // stat 失败的目录本轮不能清：否则临时锁/权限抖动会把有效缓存删掉。
    const skip = unsafeDirs instanceof Set ? unsafeDirs : new Set()
    for (const [dk, keys] of presentByDir) {
      if (skip.has(dk)) continue
      cache.removeByDirExcept(dk, profile, keys)
    }
    const st = cache.stats()
    tlog(task, `指纹缓存写入 ${(newRows ? newRows.length : 0) + extraWritten} 条；库内 ${st.rows} 条 / ${(st.bytes / 1024 / 1024).toFixed(1)} MB`)
  } catch (e) {
    tlog(task, `指纹缓存写回失败（不影响扫描结果）: ${String((e && e.message) || e)}`)
  } finally {
    try { cache.close() } catch { /* ignore */ }
  }
}

/**
 * 四个改名/移动任务成功后同步指纹记录；失败只写日志，不影响文件操作。
 * @param {object} task 当前任务
 * @param {object} cfg 配置
 * @param {boolean} enabled 对应任务的“同步指纹记录”勾选
 * @param {{from:string,to:string}[]} pairs 成功移动/改名的文件对
 * @param {string} label 日志标签
 */
/** 清掉“文件已删/大小变了”的指纹；父目录离线时整目录跳过。 */
async function cleanupFingerprintRecords(cfg) {
  const cache = await openFingerprintStore(fingerprintDbPath(cfg))
  try {
    const before = cache.stats()
    const result = cache.cleanup()
    const after = cache.stats()
    return { ok: true, ...result, beforeRows: before.rows, afterRows: after.rows, dbPath: after.dbPath }
  } finally {
    cache.close()
  }
}

async function syncFingerprintMoves(task, cfg, enabled, pairs, label) {
  if (!enabled || !pairs || !pairs.length) return
  let cache
  try {
    cache = await openFingerprintStore(fingerprintDbPath(cfg))
    cache.move(pairs)
    tlog(task, `${label}：同步指纹记录 ${pairs.length} 条`)
  } catch (e) {
    tlog(task, `${label}：同步指纹记录失败（不影响文件操作）: ${String((e && e.message) || e)}`)
  } finally {
    if (cache) { try { cache.close() } catch { /* ignore */ } }
  }
}

/* ------------------------------------------------------------------ *
 * 任务二：抓帧疑似重复（先排除完全一致）
 * ------------------------------------------------------------------ */
async function videoScan(task, cfg) {
  const limit = Math.max(1, Math.min(32, Number(cfg.concurrency) || Math.min(8, Math.max(2, os.cpus().length))))
  const frameSeconds = Math.max(1, Math.min(120, Math.round(Number(cfg.frameSeconds) || 10)))
  const frameFps = Math.max(1, Math.min(5, Math.round(Number(cfg.frameFps) || 2)))
  const durationTolerance = Math.max(0, Math.min(10000, Number(cfg.durationToleranceMs) || 0))
  const frameSimilarityMin = Math.max(0.1, Math.min(1, Number(cfg.frameSimilarity) || 0.9))
  tlog(task, `并发 ${limit} · 抓帧时长 ${frameSeconds}s（每秒 ${frameFps} 帧） · 时长容差 ${durationTolerance}ms · 相似度 ≥ ${frameSimilarityMin}`)
  tlog(task, `每个视频只比对前 ${frameSeconds} 秒画面（长视频同样只取前 ${frameSeconds} 秒）`)

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
      try { sig = await sampleSignature(it.path, it.size) } catch { continue }
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
  const cacheFiles = all.filter((f) => /\.mp4$/i.test(f))
  const videos = cacheFiles.filter((f) => !dupSet.has(f))
  tlog(task, `排除完全一致文件 ${dupSet.size} 个；MP4 候选 ${videos.length} 个`)
  task.total = videos.length
  task.done = 0

  task.phase = '统计视频时长'
  const profile = videoProfile(frameSeconds, frameFps)
  // 缓存按目录维护，必须把被排除的完全一致副本也算作“目录内仍存在”，
  // 否则 removeByDirExcept 会把它们的指纹记录删掉，下次扫描又得重新抓帧。
  const fp = await prepareFingerprintCache(task, cfg, profile, cacheFiles, Math.min(limit, 8))
  let cacheHit = 0
  const withDur = (await mapLimit(videos, Math.min(limit, 8), async (v) => {
    const row = fp.rows.get(pathKey(v))
    if (row && row.duration_ms > 0 && validFrameBuf(row.sig_blob, row.intro_n)) {
      cacheHit += 1
      task.done += 1
      return { path: v, durationMs: row.duration_ms, _sig: Buffer.from(row.sig_blob), _cached: true }
    }
    const d = await probeDurationMs(v)
    task.done += 1
    return d > 0 ? { path: v, durationMs: d } : null
  })).filter(Boolean)
  if (cacheHit) tlog(task, `指纹缓存命中 ${cacheHit} 个视频（跳过时长读取与抓帧）`)
  if (stopped()) { if (fp.cache) fp.cache.close(); return }
  const noDur = videos.length - withDur.length
  if (noDur > 0) tlog(task, `${noDur} 个视频读不到时长，已跳过`)

  // 长视频也只比对开头 N 秒，不再整段跳过
  const longOnes = withDur.filter((x) => x.durationMs > frameSeconds * 1000)
  if (longOnes.length) {
    tlog(task, `其中 ${longOnes.length} 个视频超过 ${frameSeconds} 秒，按开头 ${frameSeconds} 秒参与比对`)
    const longSample = longOnes.slice(0, 3).map((x) => path.basename(x.path) + '（' + (x.durationMs / 1000).toFixed(0) + 's）')
    tlog(task, '  例如：' + longSample.join('、') + (longOnes.length > 3 ? ' 等 ' + longOnes.length + ' 个' : ''))
  }
  const eligible = withDur
  const durClusters = clusterByDuration(eligible, durationTolerance).filter((c) => c.length > 1)
  tlog(task, `时长相近且不止一个的分组: ${durClusters.length} 组`)

  task.phase = '抓帧比对'
  task.done = 0
  task.total = durClusters.reduce((n, c) => n + c.length, 0)
  const ffLimit = Math.max(2, Math.min(8, limit))

  const newRows = []
  const rowWriter = fp.cache ? createRowWriter(fp.cache, profile) : null
  const results = await mapLimit(durClusters, ffLimit, async (cluster) => {
    if (cluster.length > VIDEO_CLUSTER_CAP) {
      tlog(task, `时长簇有 ${cluster.length} 个视频，超过上限 ${VIDEO_CLUSTER_CAP}，已跳过（避免内存/CPU 爆；可缩小来源或放宽时长容差）`)
      task.done += cluster.length
      return null
    }
    const sigs = new Map()
    for (const it of cluster) {
      if (stopped()) return null
      let sig = it._sig
      if (!sig) {
        sig = await frameSignature(it.path, frameSeconds, frameFps)
        const st = fp.stats.get(it.path)
        if (sig && st && rowWriter) {
          rowWriter.push({
            pathKey: pathKey(it.path), path: it.path, dirKey: dirKey(path.dirname(it.path)), name: path.basename(it.path),
            size: st.size, mtimeMs: st.mtimeMs, profile, durationMs: it.durationMs,
            introN: frameCount(sig), bodyN: 0, infoN: 0, sigBlob: sig,
          })
        }
      }
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
        if (frameSimilarity(sigs.get(list[i]), sigs.get(list[j])) >= frameSimilarityMin) union(list[i], list[j])
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
  if (fp.cache) {
    if (rowWriter) { try { await rowWriter.drain() } catch (e) { flog('WARN', '指纹写队列收尾失败', e) } }
    if (stopped()) fp.cache.close()
    else await finishFingerprintCache(task, fp.cache, profile, fp.presentByDir, [], fp.unsafeDirs)
  }
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
    const keep = g.files.find((f) => f.path === g.keep)
    if (!keep) { failed.push({ path: g.keep, error: '保留文件不在分组里，整组跳过' }); continue }
    let keepStat
    try { keepStat = await fsp.stat(g.keep) } catch { failed.push({ path: g.keep, error: '保留文件不存在，整组跳过' }); continue }
    if (keepStat.size !== keep.size) { failed.push({ path: g.keep, error: '保留文件大小在扫描后变了，整组跳过' }); continue }
    if (g.sig) {
      try {
        if (await sampleSignature(g.keep, keepStat.size) !== g.sig) {
          failed.push({ path: g.keep, error: '保留文件内容在扫描后变了，整组跳过' })
          continue
        }
      } catch { failed.push({ path: g.keep, error: '保留文件读不了，整组跳过' }); continue }
    }
    for (const f of g.files) {
      if (stopped()) break
      if (f.path === g.keep) continue
      try {
        const st = await fsp.stat(f.path)
        if (st.size !== f.size) { failed.push({ path: f.path, error: '大小在扫描后变了，跳过' }); continue }
        if (g.sig) {
          if (await sampleSignature(f.path, st.size) !== g.sig) {
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

async function nextSeq(dir) {
  let max = 99999
  try {
    for (const name of await fsp.readdir(dir)) {
      const m = /^(\d{6,})\./i.exec(name)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch { /* 目录不存在 */ }
  return max + 1
}

const MOVE_MANIFEST = '.dupfc-move-manifest.json'
const RESTORE_FILE = '_dupfc_restore.json'

async function readMoveManifest(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, MOVE_MANIFEST), 'utf8')) || [] } catch { return [] }
}

async function writeMoveManifest(dir, list) {
  const file = path.join(dir, MOVE_MANIFEST)
  if (!list || !list.length) { try { await fsp.unlink(file) } catch { /* 忽略 */ } ; return }
  await fsp.writeFile(file, JSON.stringify(list, null, 2), 'utf8')
}

async function appendMoveManifest(dir, entries) {
  if (!entries || !entries.length) return
  const list = await readMoveManifest(dir)
  list.push(...entries)
  await writeMoveManifest(dir, list)
}

function normalizeRecordEntry(e) {
  const name = String((e && e.name) || '').trim()
  const from = String((e && e.from) || '').trim()
  if (!name || !from) return null
  if (/^[a-zA-Z]:[\\/]/.test(name) || name.startsWith('\\\\') || name.startsWith('/')) return null
  if (name.split(/[\\/]+/).some((x) => x === '..')) return null
  if (!path.isAbsolute(from)) return null
  return { name, from }
}

async function readRestoreRecord(dir) {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dir, RESTORE_FILE), 'utf8'))
    const files = Array.isArray(raw && raw.files) ? raw.files : (Array.isArray(raw) ? raw : [])
    return files.map(normalizeRecordEntry).filter(Boolean)
  } catch { return [] }
}

async function writeRestoreRecord(dir, files) {
  const file = path.join(dir, RESTORE_FILE)
  const list = (files || []).filter((e) => e && e.name && e.from)
  if (!list.length) { try { await fsp.unlink(file) } catch { /* 忽略 */ } ; return }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), files: list }, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  } catch (e) {
    try { await fsp.unlink(tmp) } catch { /* 忽略 */ }
    throw e
  }
}

async function appendRestoreRecord(dir, files) {
  if (!files || !files.length) return
  const list = await readRestoreRecord(dir)
  const index = new Map(list.map((e) => [e.name.toLowerCase(), e]))
  let changed = false
  for (const raw of files) {
    const f = normalizeRecordEntry(raw)
    if (!f) continue
    const key = f.name.toLowerCase()
    const old = index.get(key)
    if (old) {
      if (old.from === f.from) continue
      let alive = true
      try { await fsp.access(path.join(dir, old.name)) } catch { alive = false }
      if (alive) continue
      old.from = f.from
      changed = true
      continue
    }
    list.push(f)
    index.set(key, f)
    changed = true
  }
  if (changed) await writeRestoreRecord(dir, list)
}

const JOURNAL_FILE = '_dupfc_restore.jsonl'

/** 每移动一个文件追加一行（O(1)，避免整份记录反复重写）；写失败必须抛出。 */
async function appendJournal(dir, entry) {
  const e = normalizeRecordEntry(entry)
  if (!e) return
  await fsp.appendFile(path.join(dir, JOURNAL_FILE), JSON.stringify(e) + '\n', 'utf8')
}

/** 把 JSONL 合并进 _dupfc_restore.json 并删除日志；先落记录再删日志。 */
async function compactJournal(dir) {
  const file = path.join(dir, JOURNAL_FILE)
  let txt = ''
  try { txt = await fsp.readFile(file, 'utf8') } catch { return }
  const entries = []
  for (const line of txt.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { const e = normalizeRecordEntry(JSON.parse(t)); if (e) entries.push(e) } catch { /* 坏行跳过 */ }
  }
  if (entries.length) await appendRestoreRecord(dir, entries)
  try { await fsp.unlink(file) } catch { /* 忽略 */ }
}

/** 串行化追加：并发搬运时不丢条目；返回的 Promise 会如实抛出写失败。 */
function recordAppender(dir) {
  let chain = Promise.resolve()
  const fn = (entry) => {
    const p = chain.then(() => appendJournal(dir, entry))
    chain = p.catch(() => {})
    return p
  }
  fn.flush = () => chain
  return fn
}

async function migrateLegacyManifest(dir) {
  const legacy = await readMoveManifest(dir)
  if (!legacy.length) return
  await appendRestoreRecord(dir, legacy.map((e) => ({ name: path.basename(e.to), from: e.from })))
  await writeMoveManifest(dir, [])
}

async function uniqueRestoreTarget(p) {
  try { await fsp.access(p) } catch { return p }
  const ext = path.extname(p)
  const stem = p.slice(0, p.length - ext.length)
  let k = 1
  while (true) {
    const cand = stem + '_恢复' + k + ext
    try { await fsp.access(cand) } catch { return cand }
    k += 1
  }
}

async function resetDirWithRecord(dir, out, resetFailDir, stats, opts = {}) {
  const rec = await readRestoreRecord(dir)
  if (!rec.length) return false
  const listed = new Set(rec.map((e) => e.name.toLowerCase()))
  const keep = []
  for (const e of rec) {
    const file = path.join(dir, e.name)
    let exists = true
    try { await fsp.access(file) } catch { exists = false }
    if (!exists) { stats.deleted += 1; continue }
    const fromDir = path.dirname(e.from)
    let dirOk = false
    try { dirOk = (await fsp.stat(fromDir)).isDirectory() } catch { /* 原目录不存在 */ }
    if (!dirOk) {
      if (!stats.missingDirs.includes(fromDir)) stats.missingDirs.push(fromDir)
      stats.left += 1
      keep.push(e)
      continue
    }
    try { await moveFileTo(file, await uniqueRestoreTarget(e.from)); stats.restored += 1 }
    catch { keep.push(e) }
  }
  if (dir !== out || opts.rootExtras) {
    let ents = []
    try { ents = await fsp.readdir(dir, { withFileTypes: true }) } catch { /* 忽略 */ }
    for (const ent of ents) {
      if (!ent.isFile()) continue
      if (ent.name.toLowerCase() === RESTORE_FILE.toLowerCase()) continue
      if (listed.has(ent.name.toLowerCase())) continue
      try {
        const ext = path.extname(ent.name)
        const uuid = crypto.randomUUID() + ext
        await fsp.mkdir(resetFailDir, { recursive: true })
        await moveFileTo(path.join(dir, ent.name), path.join(resetFailDir, uuid))
        stats.resetFail += 1
      } catch { stats.left += 1 }
    }
  }
  await writeRestoreRecord(dir, keep)
  if (dir !== out && !keep.length) { try { await fsp.rmdir(dir) } catch { /* 非空忽略 */ } }
  return true
}

async function moveFileTo(src, dst) {
  return moveFile(src, dst)
}

/** 复位：按每个分组目录内的记录文件把文件搬回原目录；记录外的文件统一 UUID 改名移入 resetFail */
async function resetMoved(dir, opts = {}) {
  if (!dir) return { ok: false, error: '还没设置输出目录' }
  const out = dir
  const resetFailDir = path.join(out, 'resetFail')
  await migrateLegacyManifest(out)
  await compactJournal(out)
  const stats = { restored: 0, deleted: 0, resetFail: 0, left: 0, missingDirs: [] }
  const handled = []
  if ((await readRestoreRecord(out)).length) { await resetDirWithRecord(out, out, resetFailDir, stats, opts); handled.push(out) }
  let subs = []
  try { subs = await fsp.readdir(out, { withFileTypes: true }) } catch { /* 忽略 */ }
  for (const ent of subs) {
    if (!ent.isDirectory()) continue
    const d = path.join(out, ent.name)
    await compactJournal(d)
    if (!(await readRestoreRecord(d)).length) continue
    await resetDirWithRecord(d, out, resetFailDir, stats)
    handled.push(d)
  }
  if (!handled.length) return { ok: false, error: '没有可复位的移动记录（先执行一次移动操作）' }
  if (stats.missingDirs.length) {
    const names = stats.missingDirs.slice(0, 3).join('、')
    return { ok: false, error: '源目录不存在：' + names + (stats.missingDirs.length > 3 ? ' 等 ' + stats.missingDirs.length + ' 个' : '') + '；这些文件留在输出目录', ...stats, left: stats.left }
  }
  return { ok: true, ...stats }
}

async function moveSuspects(cfg) {
  const task = tasks.video
  const out = cfg.outputDir
  if (!out) return { ok: false, error: '还没设置疑似重复文件输出目录' }
  if (path.parse(out).root.toLowerCase() === path.resolve(out).toLowerCase()) return { ok: false, error: '输出目录不能是盘符根目录，请选一个子目录' }
  for (const s of cfg.sources || []) {
    if (s && pathInside(out, s)) return { ok: false, error: `输出目录不能放在来源目录内部：${out}` }
  }
  const targets = []
  for (const g of task.result || []) for (const c of g.clusters) for (const f of c) targets.push(f.path)
  if (!targets.length) return { ok: false, error: '没有可移动的疑似重复文件（先扫描）' }
  await fsp.mkdir(out, { recursive: true })
  // 跨盘搬移需要空间：同盘 rename 不占额外空间
  const uniq = [...new Set(targets)]
  const outRoot = path.parse(out).root.toLowerCase()
  const roots = new Set(uniq.map((f) => path.parse(f).root.toLowerCase()))
  if ([...roots].some((r) => r !== outRoot)) {
    let bytes = 0
    for (const f of uniq) { try { bytes += (await fsp.stat(f)).size } catch { /* 忽略 */ } }
    await ensureSpace(out, bytes, task, '疑似重复输出')
  }
  const recMove = recordAppender(out)
  let seq = await nextSeq(out)
  const moved = []
  const failed = []
  for (const src of [...new Set(targets)]) {
    if (stopped()) break
    if (path.dirname(src).toLowerCase() === path.resolve(out).toLowerCase()) continue
    const dst = path.join(out, `${seq}.mp4`)
    try {
      await moveWithRecord(src, dst, recMove)
      moved.push({ from: src, to: dst })
      seq += 1
    } catch (e) { failed.push({ path: src, error: String(e.message) }) }
  }
  await recMove.flush()
  await compactJournal(out)
  task.result = []
  tlog(task, `移动: 成功 ${moved.length}，失败 ${failed.length}`)
  return { ok: true, moved: moved.length, failed, first: moved[0]?.to || '', last: moved[moved.length - 1]?.to || '' }
}

/* ------------------------------------------------------------------ *
 * 抓帧疑似重复校验_忽略片头（独立模块：私有常量/方法/配置，不与旧模块共用）
 * ------------------------------------------------------------------ */
const VI_SIDE = 16
const VI_FB = VI_SIDE * VI_SIDE
const VI_BANDS = 8
const VI_FLAT_VARIANCE = 3
const VI_MIN_INFORMATIVE = 5
// 单个指纹桶最多容纳的视频数。超过这个数的桶称为“热桶”：
// 通常是黑帧、纯色、固定 UI、固定片头/字幕等区分度很低的内容，
// 大量视频会共享同一个指纹值。热桶不参与桶内两两组合：
// 既避免 O(n²) 候选对爆炸，也避免把“只是都黑屏/都带同一段 UI”当成相似。
// 注意：跳过热桶不等于跳过视频，视频仍会通过其他 23 个桶参与配对。
const VI_BUCKET_CAP = Number(process.env.DFC_VI_BUCKET_CAP) || 256
// 候选对硬上限：桶内两两组合在视频多时会爆炸（1697 个视频可到百万级），
// 先按桶大小升序（稀有桶更可信）生成，达到上限就截断，避免拖垮宿主内存。
const VI_PAIR_CAP = 50000
// 对齐时允许相邻匹配对之间少/多几帧（剪辑点、插帧），超过就视为断开。
// 这是下限；实际按抓帧频率放大到最多 10 帧（低帧率下两帧间隔更大）。
const VI_GAP_TOL = 2
// 中段 pHash 锚点：MAD 看的是 16×16 亮度分布，容易把“构图/亮度接近但内容不同”
// 的画面放过去（例如同机位、同光照的不同人）。中段再用 pHash 数一遍低频轮廓，
// 至少要有这么多帧轮廓一致，才允许成组；只用少量锚点，避免帧偏移把覆盖率打穿。
const VI_BODY_PHASH_MIN = 3

const VI_POP = new Uint8Array(256)
for (let i = 0; i < 256; i += 1) VI_POP[i] = (i & 1) + VI_POP[(i >> 1) & 0xff]
const VI_DCT_COS = (() => {
  const out = []
  for (let u = 0; u < 8; u += 1) {
    const row = []
    for (let x = 0; x < 16; x += 1) row.push(Math.cos(((2 * x + 1) * u * Math.PI) / 32))
    out.push(row)
  }
  return out
})()

/**
 * 把配置值收口成 [lo, hi] 区间内的整数。
 * 前端输入框可能是空串/字符串/NaN，配置文件也可能被手改成越界值，
 * 所有数值参数统一从这里过一遍，避免把 NaN 带进 ffmpeg 参数或阈值比较。
 * @param {*} value 原始值
 * @param {number} lo 下限（含）
 * @param {number} hi 上限（含）
 * @param {number} fallback 非法值时的默认值
 * @returns {number} 规整后的整数
 */
function viClampInt(value, lo, hi, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

/**
 * 计算一帧 16×16 灰度图的方差，用来识别“几乎纯色/黑屏”的无效帧。
 * 片头黑场或纯色画面的哈希值高度雷同，若参与倒排索引，会把任意两个视频连成候选对，
 * 所以方差低于 VI_FLAT_VARIANCE 的帧会被标记 flat，在建索引和比对时跳过。
 * @param {Buffer} buf 长度必须为 VI_FB（256）的灰度帧
 * @returns {number} 方差（0 表示完全纯色）
 */
function viVariance(buf) {
  let sum = 0
  for (let i = 0; i < VI_FB; i += 1) sum += buf[i]
  const mean = sum / VI_FB
  let acc = 0
  for (let i = 0; i < VI_FB; i += 1) { const d = buf[i] - mean; acc += d * d }
  return acc / VI_FB
}

/**
 * 8×8 差值哈希（dHash），输出 64 bit。
 * 先把 16×16 帧按 15/7、15/8 的比例采样成 8×8，再逐行比较左右相邻像素：
 * 左边比右边亮记 1，否则记 0。它描述的是“亮度变化方向”，
 * 对整体亮度偏移、轻微压缩噪声不敏感，适合快速筛画面结构相近的帧。
 * @param {Buffer} buf 16×16 灰度帧
 * @returns {bigint} 64 位哈希
 */
function viDHash(buf) {
  const px = (x, y) => buf[Math.round(y * 15 / 7) * 16 + Math.round(x * 15 / 8)]
  let bits = 0n
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bits = (bits << 1n) | (px(x, y) > px(x + 1, y) ? 1n : 0n)
  }
  return bits
}

/**
 * 感知哈希（pHash），输出 63 bit（跳过直流分量）。
 * 对 16×16 帧做 8×8 二维 DCT，取左上角低频系数（去掉 (0,0) 的亮度均值），
 * 以中位数为阈值逐位比较。低频系数代表画面的大体结构，
 * 因此 pHash 对缩放、轻微裁剪、码率差异比 dHash 更稳。
 * 注意：这里为了省依赖手写了 DCT，VI_DCT_COS 在模块初始化时预计算。
 * @param {Buffer} buf 16×16 灰度帧
 * @returns {bigint} 63 位哈希（最高位起有效）
 */
function viPHash(buf) {
  const tmp = new Float64Array(8 * 16)
  for (let u = 0; u < 8; u += 1) {
    for (let y = 0; y < 16; y += 1) {
      let s = 0
      for (let x = 0; x < 16; x += 1) s += buf[y * 16 + x] * VI_DCT_COS[u][x]
      tmp[u * 16 + y] = s
    }
  }
  const use = []
  for (let u = 0; u < 8; u += 1) {
    for (let v = 0; v < 8; v += 1) {
      if (u === 0 && v === 0) continue
      let s = 0
      for (let y = 0; y < 16; y += 1) s += tmp[u * 16 + y] * VI_DCT_COS[v][y]
      use.push(s)
    }
  }
  const sorted = use.slice().sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]
  let bits = 0n
  for (const s of use) bits = (bits << 1n) | (s > med ? 1n : 0n)
  return bits
}

/**
 * 粗粒度灰度哈希，输出 64 bit。
 * 把 16×16 帧切成 4×4 个 4×4 小块，每块求平均亮度后量化成 4 bit（0-15），
 * 16 个块拼成 64 位。它比 dHash/pHash 更“粗”，但对明显不同的画面区分度足够，
 * 作为第三路倒排索引，专门兜住 dHash/pHash 因压缩噪声漏掉的候选对。
 * @param {Buffer} buf 16×16 灰度帧
 * @returns {bigint} 64 位哈希
 */
function viCoarseHash(buf) {
  let bits = 0n
  for (let by = 0; by < 4; by += 1) {
    for (let bx = 0; bx < 4; bx += 1) {
      let sum = 0
      for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) sum += buf[(by * 4 + y) * 16 + bx * 4 + x]
      bits = (bits << 4n) | BigInt(Math.min(15, Math.round(sum / 16 / 16)))
    }
  }
  return bits
}

/**
 * 两个 bigint 哈希的汉明距离（不同 bit 的个数）。
 * VI_POP 是预先算好的 0-255 查表，每次取低 8 位累加后右移，
 * 比逐位循环快一个数量级；dHash/pHash 都是 64 bit 以内，固定循环 8 次即可。
 * @param {bigint} a 哈希 A
 * @param {bigint} b 哈希 B
 * @returns {number} 0-64 的差异位数
 */
function viHamming(a, b) {
  let x = a ^ b
  let d = 0
  for (let i = 0; i < 8; i += 1) { d += VI_POP[Number(x & 0xffn)]; x >>= 8n }
  return d
}

/**
 * 两帧灰度图的平均绝对差（MAD）。
 * 逐像素求 |a-b| 后取平均，范围 0-255；越小越像。
 * 它直接反映亮度分布，和哈希的“结构相似”互补：
 * 有些画面结构相同但整体亮度差很多（曝光/滤镜），哈希会过，MAD 会拦。
 * @param {Buffer} a 16×16 灰度帧
 * @param {Buffer} b 16×16 灰度帧
 * @returns {number} 平均绝对差
 */
function viMad(a, b) {
  let s = 0
  for (let i = 0; i < VI_FB; i += 1) s += Math.abs(a[i] - b[i])
  return s / VI_FB
}

/**
 * 判断两帧是否算“同一画面”。
 * 恢复 0.4.2 的 MAD-first 语义：
 *   1) flat 帧只比 MAD；纯色帧的 dHash/pHash 全 0，不能走哈希分支；
 *   2) 非 flat 帧先算 MAD，≤ madMax 直接命中；
 *   3) MAD 不中才走哈希：dHash ≤ dhMax 且 pHash ≤ phMax。
 * 注意：band_luma 只负责把 MAD 候选召回；band_dhash 只服务第 3 步的哈希分支，
 * 不能反过来要求所有帧先过 dHash，否则会漏掉 0.4.2 能识别的 MAD-only 对。
 */
function viFrameMatch(a, b, madMax, dhMax, phMax) {
  if (a.flat || b.flat) {
    // 纯色帧的 dHash/pHash 全为 0，不能走哈希分支，否则红/蓝纯色也会被判同帧。
    return Boolean(a.g && b.g && viMad(a.g, b.g) <= madMax)
  }
  if (a.g && b.g && viMad(a.g, b.g) <= madMax) return true
  return viHamming(a.d, b.d) <= dhMax && viHamming(a.p, b.p) <= phMax
}

/**
 * 把 64bit dHash 切成 8 个 8bit band（band_no 0 为最低 8 位）。
 * 这是 band_dhash 表的唯一写入格式；与 viDHash 的 bit 顺序保持一致。
 * @param {bigint} d
 * @returns {number[]} 长度 8，每项 0-255
 */
function viDHashBands(d) {
  const out = new Array(8)
  for (let b = 0; b < 8; b += 1) out[b] = Number((d >> BigInt(b * 8)) & 0xffn)
  return out
}

/**
 * 数两段中段里 pHash 轮廓一致的帧数（同位置采样）。
 * 中段的 MAD 已经能放过“亮度/构图接近但内容不同”的画面，这里只补一道
 * 低频轮廓锚点：不要求每一帧都过 pHash（帧偏移会让覆盖率大跌），
 * 只要求至少 VI_BODY_PHASH_MIN 帧轮廓对得上，既能挡住误报，又保留召回。
 * @param {Array} framesA 视频 A 的中段帧
 * @param {Array} framesB 视频 B 的中段帧
 * @param {number} maxDist pHash 汉明距离上限
 * @returns {number} 轮廓一致的帧数
 */
/**
 * 给从 SQLite 还原出来的帧补齐内存态字段。
 * 数据库只存 16×16 灰度像素，dHash/pHash/coarse 与灰度 Buffer 都是派生值；
 * 倒排索引和逐帧匹配都依赖这些字段，缺失会让 BigInt 位移直接抛错。
 * @param {{px:Buffer,min:number,max:number,mean:number,variance:number,flat:boolean}[]} frames
 * @returns {{px:Buffer,min:number,max:number,mean:number,variance:number,flat:boolean,d:bigint,p:bigint,c:number,g:Buffer}[]}
 */
function viHydrateCachedFrames(frames) {
  return frames.map((fr) => ({
    px: fr.px,
    min: fr.min,
    max: fr.max,
    mean: fr.mean,
    variance: fr.variance,
    flat: fr.flat,
    g: Buffer.from(fr.px),
    d: viDHash(fr.px),
    p: viPHash(fr.px),
    c: viCoarseHash(fr.px),
  }))
}

function viPHashAgree(framesA, framesB, maxDist) {
  const n = Math.min(framesA.length, framesB.length)
  let hits = 0
  for (let i = 0; i < n; i += 1) {
    const a = framesA[i]
    if (!a || a.flat) continue
    // 中段窗口的起点按各自时长取半，原片和剪辑版可能差 1 帧；
    // 和 LCS 一样允许 ±1 邻帧，否则真重复会因采样相位被误杀。
    let ok = false
    for (let dj = -1; dj <= 1 && !ok; dj += 1) {
      const b = framesB[i + dj]
      if (b && !b.flat && viHamming(a.p, b.p) <= maxDist) ok = true
    }
    if (ok) hits += 1
  }
  return hits
}

/**
 * 用 ffmpeg 从指定起点抽 N 秒灰度帧，输出原始 rawvideo 字节流。
 * 命令含义：
 *   -ss startSec -t seconds   从 startSec 秒开始取 N 秒（默认 0，即开头）
 *   -vf fps=F,scale=16:16:flags=area,format=gray
 *                      按 F 帧/秒抽帧，缩放到 16×16，转灰度，输出每帧 256 字节
 *   -f rawvideo -      不封装，直接写 stdout
 * 这里同时监听 stdout 的 data 事件并收集 chunks，是因为大视频的 raw 数据可能
 * 走 execFile 的 maxBuffer 之外的流式路径；两条路取其一，避免拿到空 Buffer。
 * 任务被停止时 activeChildren 会被统一 SIGKILL，这里也兜底 kill 一次。
 * @param {string} file 视频绝对路径
 * @param {number} seconds 抓帧时长（秒）
 * @param {number} fps 每秒帧数（1-5）
 * @returns {Promise<Buffer|null>} 长度至少 VI_FB 的灰度帧缓冲；失败/太短返回 null
 */
function viFrameSignature(file, seconds, fps, startSec = 0) {
  return new Promise((resolve) => {
    const chunks = []
    const child = execFile(
      ffmpegPath,
      ['-nostdin', '-v', 'error', '-ss', String(Math.max(0, Number(startSec) || 0)), '-t', String(seconds), '-i', file,
        '-vf', `fps=${Math.max(1, Math.min(5, Number(fps) || 1))},scale=${VI_SIDE}:${VI_SIDE}:flags=area,format=gray`,
        '-f', 'rawvideo', '-'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 30000 + seconds * 1000, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        activeChildren.delete(child)
        const buf = chunks.length ? Buffer.concat(chunks) : Buffer.from(stdout || [])
        resolve(err || buf.length < VI_FB ? null : buf)
      },
    )
    child.stdout?.on('data', (d) => chunks.push(d))
    activeChildren.add(child)
    if (stopped()) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
  })
}

/**
 * 用 ffprobe 读容器时长（毫秒）。
 * 只取 format.duration，不解析流信息，速度最快；
 * 读不到或时长非正数时返回 0，调用方据此把文件计入“不可读”并跳过。
 * @param {string} file 视频绝对路径
 * @returns {Promise<number>} 时长毫秒；失败为 0
 */
async function viDurationMs(file) {
  const r = await run(ffprobeActive, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 60000)
  const n = Number((r.stdout || '').trim())
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0
}

/**
 * 把 ffmpeg 输出的 rawvideo 灰度帧解码成指纹数组。
 * @param {Buffer} buf 连续 16×16 灰度帧
 * @returns {{frames:Array, info:number}} frames 供比对；info 为有效（非纯色）帧数
 */
function viDecodeFrames(buf) {
  const count = Math.floor(buf.length / VI_FB)
  const frames = []
  let info = 0
  for (let i = 0; i < count; i += 1) {
    const slice = buf.subarray(i * VI_FB, (i + 1) * VI_FB)
    let sum = 0
    for (let k = 0; k < VI_FB; k += 1) sum += slice[k]
    const mean = sum / VI_FB
    const flat = viVariance(slice) < VI_FLAT_VARIANCE
    frames.push({ d: viDHash(slice), p: viPHash(slice), c: viCoarseHash(slice), g: Buffer.from(slice), mean, flat })
    if (!flat) info += 1
  }
  return { frames, info }
}

/**
 * 对两段帧序列做 ±1 邻帧容差 + 允许少量缺口的 LCS，返回最佳对齐评分。
 * 这个函数只负责“像不像”，是否成组由调用方结合片头容差、覆盖率和连续度判断。
 * @param {Array} framesA 视频 A 的帧
 * @param {Array} framesB 视频 B 的帧
 * @param {(a:object,b:object)=>boolean} match 单帧同帧判定
 * @param {number} gapTol 允许的剪辑缺口（帧）
 * @returns {null|{off:number,span:number,hits:number,coreSpan:number,maxRun:number,cov:number,tail:number}}
 */
function viLcsBest(framesA, framesB, match, gapTol, phMax) {
  const lenA = framesA.length
  const lenB = framesB.length
  const W = lenB + 1
  const same = new Uint8Array((lenA + 1) * W)
  for (let i = 0; i < lenA; i += 1) {
    const fa = framesA[i]
    if (fa.flat) continue
    const row = (i + 1) * W
    for (let j = 0; j < lenB; j += 1) {
      const fb = framesB[j]
      if (fb.flat) continue
      if (match(fa, fb)) same[row + j + 1] = 1
    }
  }
  if (process.env.DFC_DEBUG) {
    let sameCount = 0
    for (let i = 0; i < same.length; i += 1) sameCount += same[i]
    console.error(`[LCS] same=${sameCount} A=${lenA} B=${lenB}`)
  }
  // ±1 帧邻帧容差：查询以 (i,j) 为中心的 3×3 区域。
  const near = (i, j) => {
    for (let di = -1; di <= 1; di += 1) {
      const ii = i + di
      if (ii < 0 || ii >= lenA) continue
      const row = (ii + 1) * W
      for (let dj = -1; dj <= 1; dj += 1) {
        const jj = j + dj
        if (jj >= 0 && jj < lenB && same[row + jj + 1]) return true
      }
    }
    return false
  }
  const dp = new Int16Array((lenA + 1) * W)
  for (let i = 1; i <= lenA; i += 1) {
    const row = i * W
    const prev = row - W
    for (let j = 1; j <= lenB; j += 1) {
      dp[row + j] = near(i - 1, j - 1)
        ? dp[prev + j - 1] + 1
        : Math.max(dp[prev + j], dp[row + j - 1])
    }
  }
  const pairs = []
  let pi = lenA
  let pj = lenB
  while (pi > 0 && pj > 0) {
    if (near(pi - 1, pj - 1) && dp[pi * W + pj] === dp[(pi - 1) * W + pj - 1] + 1) {
      pairs.push([pi - 1, pj - 1])
      pi -= 1
      pj -= 1
    } else if (dp[(pi - 1) * W + pj] >= dp[pi * W + pj - 1]) pi -= 1
    else pj -= 1
  }
  pairs.reverse()
  if (!pairs.length) {
    if (process.env.DFC_DEBUG) console.error(`[LCS] no pairs A=${lenA} B=${lenB}`)
    return null
  }
  let phits = 0
  if (Number.isFinite(Number(phMax))) {
    for (const [a, b] of pairs) {
      if (viHamming(framesA[a].p, framesB[b].p) <= phMax) phits += 1
    }
  }
  const [a0, b0] = pairs[0]
  const [a1, b1] = pairs[pairs.length - 1]
  const coreSpan = Math.max(a1 - a0 + 1, b1 - b0 + 1)
  let run = 1
  let maxRun = 1
  for (let k = 1; k < pairs.length; k += 1) {
    const [pa, pb] = pairs[k - 1]
    const [a, b] = pairs[k]
    if (a - pa - 1 <= gapTol && b - pb - 1 <= gapTol) {
      run += 1
      if (run > maxRun) maxRun = run
    } else run = 1
  }
  return {
    off: b0 - a0,
    span: coreSpan,
    hits: pairs.length,
    coreSpan,
    maxRun,
    phits,
    cov: pairs.length / Math.max(1, coreSpan - Math.min(coreSpan - pairs.length, gapTol, Math.ceil(coreSpan * 0.15))),
    tail: Math.max(a1 / Math.max(1, lenA - 1), b1 / Math.max(1, lenB - 1)),
  }
}

/**
 * 「抓帧疑似重复校验_忽略片头」主流程。
 *
 * 与旧「抓帧疑似重复」的区别：
 *   - 不要求两个视频时长接近；每条视频各抓开头 N 秒和中段 N 秒两段，开头负责对齐/连续度，中段负责确认正片；
 *   - 允许片头错开：先用 ±1 邻帧容差建同帧矩阵，再用允许少量缺帧的 LCS 对齐，
 *     兼容剪辑版在中间插入/删掉若干帧（缺口按抓帧频率换算，最多约 2 秒）；
 *   - 裁掉首尾片头，只在内容段上算吻合率与最长连续吻合；
 *   - 中段除 MAD 吻合率外，还要求至少 3 帧 pHash 低频轮廓一致，
 *     挡住“同机位/同亮度但内容不同”的画面；
 *   - 判定单位是“内容段吻合率 + 最长连续吻合 + 尾部覆盖”，而不是单帧相似度阈值。
 *
 * @param {object} task 任务状态对象（tasks.videoIntro）的引用。
 *   本函数会写：phase、done、total、result、log；异常由 runTask 统一捕获。
 * @param {object} cfg 本次任务开始时的配置快照，使用以下字段：
 *   - videoIntroSeconds  单段抓帧时长（1-20 秒）：开头取这么多秒，中段也取这么多秒；
 *     短视频不足时中段退化为开头同一段
 *   - videoIntroFps      抓帧频率（1-5 帧/秒）
 *   - videoIntroOffset   片头容差（秒），内部换算成帧数 offset；0 表示必须对齐
 *   - concurrency        并发数（0/未设时按 CPU 核数取 2-8）
 *   - videoIntroMadMax   单帧灰度平均绝对差上限（越小越严格）
 *   - videoIntroDHashMax dHash 汉明距离上限
 *   - videoIntroPHashMax pHash 汉明距离上限
 *   - videoIntroCoverage 内容段吻合率下限（%，命中帧/内容段可比帧）
 *   - videoIntroRunRatio 内容段连续吻合率下限（%，最长连续命中/内容段可比帧）
 * @returns {Promise<void>} 不返回数据；结果写在 task.result，供 /status 与移动接口使用
 */
async function videoIntroScanLegacy(task, cfg) {
  // ---- 参数收口：所有阈值都夹到合法区间，避免前端脏值把算法带偏 ----
  const seconds = viClampInt(cfg.videoIntroSeconds, 1, 20, 10)
  // 片头容差不能超过“抓帧时长 - 5”，否则对齐后没有足够的内容段可比较
  const offsetMax = Math.max(0, Math.min(10, seconds - 5))
  const fps = viClampInt(cfg.videoIntroFps, 1, 5, 2)
  // 低帧率时两帧之间的时间间隔更大：3fps 下 6 帧约 2 秒，
  // 对“原片 vs 剪辑版”的插入/删除要按时间放宽缺口，不能永远只给 2 帧。
  // 上限 10 帧（5fps 约 2 秒），避免把大段不同内容当成剪辑点。
  const gapTol = Math.max(VI_GAP_TOL, Math.min(10, Math.round(fps * 2)))
  const offsetSec = viClampInt(cfg.videoIntroOffset, 0, offsetMax, offsetMax)
  // 容差换算成帧偏移：LCS 第一对匹配的帧差不能超过它
  const offset = offsetSec * fps
  const conc = Math.max(1, Math.min(32, Number(cfg.concurrency) || Math.min(8, Math.max(2, os.cpus().length))))
  const madMax = Math.max(1, Math.min(64, Number(cfg.videoIntroMadMax) || 15))
  const dhMax = Number.isFinite(Number(cfg.videoIntroDHashMax)) ? Math.max(0, Math.min(7, Math.round(Number(cfg.videoIntroDHashMax)))) : 4
  const phMax = Number.isFinite(Number(cfg.videoIntroPHashMax)) ? Math.max(0, Math.min(24, Math.round(Number(cfg.videoIntroPHashMax)))) : 8
  const coveragePct = Math.max(50, Math.min(100, Number(cfg.videoIntroCoverage) || 90))
  const runPct = Math.max(50, Math.min(100, Number(cfg.videoIntroRunRatio) || 85))
  // 把三个阈值绑成一个谓词，后面 LCS 建同帧矩阵时只管调用，不用反复传参
  const match = (a, b) => viFrameMatch(a, b, madMax, dhMax, phMax)
  tlog(task, `抓帧时长 ${seconds}s · 抓帧频率 ${fps} 帧/秒 · 片头容差 ${offsetSec} 秒 · 并发 ${conc} · 同帧=dHash≤${dhMax}bit 且（pHash≤${phMax}bit 或灰度MAD≤${madMax}）`)
  tlog(task, `成组阈值：内容段吻合率 ≥${coveragePct}% · 内容段连续吻合率 ≥${runPct}%`)
  tlog(task, `对齐方式：±1 帧邻帧容差 · 剪辑点允许 ≤${gapTol} 帧缺口 · 内容段需覆盖较短片的 60% 且到尾部 75%`)
  tlog(task, `双窗口：开头 ${seconds} 秒负责对齐与连续度；中段 ${seconds} 秒负责确认正片内容（短视频不足则取整段）`)
  tlog(task, `中段轮廓锚点：至少 ${VI_BODY_PHASH_MIN} 帧 pHash≤${phMax}bit，挡住同亮度/同构图但内容不同的画面`)

  // 递归遍历所有来源目录，去重后返回全部文件（扩展名过滤传 null，后面自己筛 MP4）
  const all = await listFiles(task, cfg, null)
  if (stopped()) return

  // ① 只保留 MP4。
  // 完全一致的文件也纳入本模块：用户明确要求“完全一致同样算疑似相似”，
  // 它们抓帧后会 100% 命中，和普通相似文件一起成组，不再交给其它模块独占。
  const candidates = all.filter((f) => /\.mp4$/i.test(f))
  tlog(task, `MP4 候选 ${candidates.length} 个（完全一致文件也参与比对）`)
  task.total = candidates.length
  task.done = 0

  // ② 抓帧 + 指纹
  // 每个视频：ffprobe 读时长 → ffmpeg 抽开头 N 秒和中段 N 秒两段灰度帧 → 逐帧算 dHash/pHash/粗哈希；
  // 有效帧（非纯色）少于 VI_MIN_INFORMATIVE 的视频直接跳过，因为它提供不了足够证据。
  task.phase = '抓帧与指纹'
  const t0 = Date.now()
  const viProfile = videoIntroProfile(seconds, fps)
  const fp = await prepareFingerprintCache(task, cfg, viProfile, candidates, Math.min(8, conc))
  const videos = []
  const toExtract = []
  let cacheHit = 0
  for (const file of candidates) {
    const row = fp.rows.get(file)
    // 旧缓存可能把“长视频中段抓取失败”写成 body_n=0；不能把它当成短视频复用，
    // 否则 stage2 会拿开头窗口比开头窗口，直接绕过共享片头守卫。
    const bodyMissing = !!row && row.body_n === 0 &&
      (row.duration_ms <= 0 || row.duration_ms > (seconds * 1000 + 250))
    if (bodyMissing) {
      try { fp.cache.remove([pathKey(file)], viProfile) } catch { /* 下一次会重新抓帧 */ }
    }
    const decoded = row && !bodyMissing ? decodeIntroRow(row, VI_FLAT_VARIANCE) : null
    if (decoded && decoded.info >= VI_MIN_INFORMATIVE) {
      // 缓存只存灰度像素；倒排索引/逐帧匹配需要的 dHash/pHash/coarse 必须在还原时补齐。
      const frames = viHydrateCachedFrames(decoded.frames)
      const bodyFrames = decoded.bodyFrames === decoded.frames ? frames : viHydrateCachedFrames(decoded.bodyFrames)
      videos.push({ path: file, durationMs: row.duration_ms, frames, bodyFrames, info: decoded.info })
      cacheHit += 1
    } else toExtract.push(file)
  }
  task.done = cacheHit
  if (cacheHit) tlog(task, `指纹缓存命中 ${cacheHit} 个视频（跳过时长读取与抓帧）`)
  let unreadable = 0
  let noInfo = 0
  const newRows = []
  // 抓帧阶段单独把并发压到最多 8：同时开太多 ffmpeg 会抢磁盘 IO，反而更慢
  await mapLimit(toExtract, Math.max(2, Math.min(8, conc)), async (file) => {
    if (stopped()) return
    try {
      const dur = await viDurationMs(file)
      if (!(dur > 0)) { unreadable += 1; task.done += 1; return }
      const durSec = dur / 1000
      const winSec = Math.min(seconds, Math.max(1, durSec))
      // 第一段：开头，用来识别片头/找对齐；第二段：中段，用来确认真实内容。
      // 只比开头会被“同一节目/同一游戏的固定片头”骗过（片头全一样、正片完全不同）；
      // 只比中段又可能丢掉“片头不同但正片相同”的连续性，所以两段都取。
      const introBuf = await viFrameSignature(file, winSec, fps, 0)
      if (!introBuf) { unreadable += 1; task.done += 1; return }
      const bodyStart = Math.max(0, (durSec - winSec) / 2)
      // 短视频（没有真正的“中段”）允许 body=intro；长视频中段必须单独抓到。
      // 长视频中段抓取失败时不能回退开头，否则 stage2 会重复校验片头，误放行。
      const bodyBuf = bodyStart > 0.25 ? await viFrameSignature(file, winSec, fps, bodyStart) : introBuf
      if (bodyStart > 0.25 && !bodyBuf) { unreadable += 1; task.done += 1; return }
      const intro = viDecodeFrames(introBuf)
      const body = bodyBuf && bodyBuf !== introBuf ? viDecodeFrames(bodyBuf) : intro
      if (intro.info < VI_MIN_INFORMATIVE) { noInfo += 1; task.done += 1; return }
      videos.push({ path: file, durationMs: dur, frames: intro.frames, bodyFrames: body.frames, info: intro.info })
      const st = fp.stats.get(file)
      if (fp.cache && st) {
        newRows.push({
          pathKey: pathKey(file), path: file, dirKey: dirKey(path.dirname(file)), name: path.basename(file),
          size: st.size, mtimeMs: st.mtimeMs, profile: viProfile, durationMs: dur,
          introN: intro.frames.length, bodyN: bodyBuf !== introBuf ? body.frames.length : 0, infoN: intro.info,
          introBlob: introBuf, bodyBlob: bodyBuf !== introBuf ? bodyBuf : null,
        })
      }
    } catch { unreadable += 1 }
    task.done += 1
  })
  if (stopped()) {
    if (fp.cache) fp.cache.close()
    return
  }
  if (unreadable) tlog(task, `${unreadable} 个视频读不到时长或无法抓帧，已跳过`)
  if (noInfo) tlog(task, `${noInfo} 个视频有效帧不足 ${VI_MIN_INFORMATIVE} 个（视频太短或几乎黑屏/纯色），已跳过；可调高抓帧频率或抓帧时长`)
  tlog(task, `抓帧完成: ${videos.length} 个视频 · ${videos.reduce((n, v) => n + v.frames.length, 0)} 帧 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (!videos.length) {
    task.result = []; task.phase = '完成'
    if (fp.cache) {
      // 全部是“有效帧不足”时目录其实已完整处理，可以清掉过期记录；
      // 但有读不到的文件时保留整库，避免瞬态失败清掉有效缓存。
      if (!unreadable) await finishFingerprintCache(task, fp.cache, viProfile, fp.presentByDir, [], fp.unsafeDirs)
      else fp.cache.close()
    }
    return
  }

  // ③ 倒排索引（pHash / dHash / 粗粒度灰度 三路）
  // 64 位哈希按 8 bit 一段切成 8 个 band；同一 band 值相同的视频进入同一个桶。
  // 只要两个视频在任意一路、任意一个 band 上同桶，就认为“可能相似”，进入候选对。
  // 这是 LSH 的思路：用少量索引换大幅减少 O(n²) 全量比对。
  task.phase = '建立指纹索引'
  const buildBands = (pick, frameKey = 'frames') => {
    const bands = new Array(VI_BANDS).fill(0).map(() => new Map())
    for (let vi = 0; vi < videos.length; vi += 1) {
      for (const fr of videos[vi][frameKey]) {
        if (fr.flat) continue
        const hash = pick(fr)
        for (let b = 0; b < VI_BANDS; b += 1) {
          const val = Number((hash >> BigInt(b * 8)) & 0xffn)
          const set = bands[b].get(val)
          if (set) set.add(vi)
          else bands[b].set(val, new Set([vi]))
        }
      }
    }
    return bands
  }
  // 开头段负责“可能相似”的召回；中段负责把共享片头但正片不同的视频排除。
  // 两段都建索引：只共享片头的视频会在中段索引里分开，而真重复即使开头
  // 是热桶（固定片头），也能从中段这个稀有桶进入候选，不会被热桶规则漏掉。
  const allBands = [
    ...buildBands((fr) => fr.p),
    ...buildBands((fr) => fr.d),
    ...buildBands((fr) => fr.c),
    ...buildBands((fr) => fr.p, 'bodyFrames'),
    ...buildBands((fr) => fr.d, 'bodyFrames'),
    ...buildBands((fr) => fr.c, 'bodyFrames'),
  ]
  // 热桶统计：一个桶里超过 VI_BUCKET_CAP 个视频，说明这个指纹值太常见
  // （黑帧、纯色、固定 UI、固定片头/字幕…），区分度低。
  // 这类桶整桶跳过，不生成桶内两两组合；视频本身不会因此被排除，
  // 只要在别的 band 或别的哈希上还有稀有指纹，仍会进入候选。
  // 代价是：两个视频的共享指纹若恰好全落在热桶，可能漏掉；这是召回率换稳定性。
  let hot = 0
  for (const map of allBands) for (const set of map.values()) if (set.size > VI_BUCKET_CAP) hot += 1
  if (hot) tlog(task, `${hot} 个指纹桶超过 ${VI_BUCKET_CAP} 个视频，已跳过（热桶通常是黑帧/纯色/固定 UI，视频仍会通过其他桶参与）`)

  // ④ 候选对
  // 桶内两两组合；pairCount 记录每对共享了多少个桶。
  // 视频多时要求至少共享 2 个桶，过滤掉“偶然一帧撞上”的噪声对。
  // 但桶内全组合是 O(n²)：1697 个视频时可能产生百万级候选对，
  // 因此先收集有效桶并按大小升序（小桶区分度高、误报少），
  // 再生成候选对；达到 VI_PAIR_CAP 立即截断，保证内存有硬上限。
  const buckets = []
  const indexed = new Uint8Array(videos.length)
  for (const map of allBands) {
    for (const set of map.values()) {
      if (set.size >= 2 && set.size <= VI_BUCKET_CAP) {
        buckets.push(set)
        for (const vi of set) indexed[vi] = 1
      }
    }
  }
  buckets.sort((a, b) => a.size - b.size)
  const pairCount = new Map()
  const pairN = Math.max(1, videos.length)
  let pairCapped = false
  outer:
  for (const set of buckets) {
    const arr = [...set]
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        // 用 videos.length 做进制，避免固定 100000 的碰撞上限
        const key = arr[i] * pairN + arr[j]
        const prev = pairCount.get(key)
        if (prev === undefined && pairCount.size >= VI_PAIR_CAP) {
          pairCapped = true
          break outer
        }
        pairCount.set(key, (prev || 0) + 1)
      }
    }
  }
  if (pairCapped) tlog(task, `候选对达到上限 ${VI_PAIR_CAP}，已截断；可缩小来源或调低指纹桶上限`)
  // 视频较多时，只保留至少共享 2 个指纹桶的候选对，减少无效比对
  const pairFloor = videos.length > 30 ? 2 : 1
  for (const [key, cnt] of [...pairCount]) if (cnt < pairFloor) pairCount.delete(key)

  // 兜底召回：固定片头/常见画面会把所有 band 都顶成热桶，导致真重复一条候选都没有。
  // 对没有任何 LSH 候选的视频，按总时长找邻近视频，并先用中段 pHash 轮廓预筛，
  // 只把“中段确实有轮廓一致帧”的补进来；是否重复仍由完整校验决定。
  const degree = new Int32Array(videos.length)
  for (const key of pairCount.keys()) {
    degree[Math.floor(key / pairN)] += 1
    degree[key % pairN] += 1
  }
  let durationFallback = 0
  for (let i = 0; i < videos.length && durationFallback < 20000; i += 1) {
    if (indexed[i] && degree[i]) continue
    const di = videos[i].durationMs || 0
    for (let j = i + 1; j < videos.length; j += 1) {
      const dj = videos[j].durationMs || 0
      const durTol = Math.max(15000, Math.round(Math.min(di || dj, dj || di) * 0.02))
      if (Math.abs(di - dj) > durTol) continue
      const aFrames = videos[i].bodyFrames || []
      const bFrames = videos[j].bodyFrames || []
      if (aFrames.length < VI_BODY_PHASH_MIN || bFrames.length < VI_BODY_PHASH_MIN) continue
      if (viPHashAgree(aFrames, bFrames, phMax) < VI_BODY_PHASH_MIN) continue
      const key = i * pairN + j
      if (!pairCount.has(key)) {
        pairCount.set(key, 1)
        durationFallback += 1
      }
    }
  }
  if (durationFallback) tlog(task, `指纹桶未召回或全部落在热桶的视频按时长+中段轮廓补 ${durationFallback} 对（仍走完整校验）`)
  tlog(task, `候选视频对: ${pairCount.size} 对`)

  // ⑤ 校验
  // 片头长度不同，剪辑版还可能少/多几帧，单一全局偏移对不齐；
  // 用允许 ±1 邻帧和少量缺口的 LCS 对齐，裁掉首尾后算吻合率与最长连续段。
  task.phase = '相似度校验'
  task.done = 0
  task.total = pairCount.size
  const matched = []
  let durGuardSkipped = 0
  let bodyRejected = 0
  await mapLimit([...pairCount.keys()], conc, async (key) => {
    if (stopped()) return
    const ai = Math.floor(key / pairN)
    const bi = key % pairN
    const va = videos[ai]
    const vb = videos[bi]
    const framesA = va.frames.length
    const framesB = vb.frames.length
    // 时长守卫：如果只看开头窗口，两个完全不同的视频只要共享同一段开场
    // 也会拿到 100% 吻合率（例如同一游戏/同一节目的固定片头）。
    // 片头长度差最多是用户设置的片头容差，短视频不可能差出几分钟；
    // 时长差超过 15 秒或较短片的 15%，直接跳过，避免“同片头不同正片”误报。
    const durA = va.durationMs
    const durB = vb.durationMs
    if (durA > 0 && durB > 0) {
      const durTol = Math.max(15000, Math.floor(Math.min(durA, durB) * 0.15))
      if (Math.abs(durA - durB) > durTol) { durGuardSkipped += 1; task.done += 1; return }
    }
    // 内容段至少要有较短视频 60% 的帧，避免“相同片头 + 不同正片”被当成一组
    const minCore = Math.max(6, Math.ceil(Math.min(framesA, framesB) * 0.6))
    // Stage 1: opening window provides alignment and continuity.
    const best = viLcsBest(va.frames, vb.frames, match, gapTol)
    let bodyCov = null
    let bodyPHashHits = 0
    let qualified = false
    if (best && Math.abs(best.off) <= offset &&
      best.coreSpan >= minCore &&
      best.tail >= 0.75 &&
      best.cov >= coveragePct / 100 &&
      best.maxRun >= Math.ceil(best.coreSpan * (runPct / 100))) {
      // Stage 2: middle window confirms the real content. A shared intro
      // matches perfectly in stage 1 but its middle differs and must be rejected.
      let bodyOk = true
      if (va.bodyFrames.length && vb.bodyFrames.length) {
        const bodyBest = viLcsBest(va.bodyFrames, vb.bodyFrames, match, gapTol)
        const bodyMinCore = Math.max(6, Math.ceil(Math.min(va.bodyFrames.length, vb.bodyFrames.length) * 0.6))
        bodyCov = bodyBest ? bodyBest.cov : 0
        bodyPHashHits = viPHashAgree(va.bodyFrames, vb.bodyFrames, phMax)
        bodyOk = !!bodyBest && bodyBest.coreSpan >= bodyMinCore &&
          bodyBest.cov >= coveragePct / 100 &&
          bodyBest.maxRun >= Math.ceil(bodyBest.coreSpan * 0.5) &&
          bodyPHashHits >= VI_BODY_PHASH_MIN
      }
      if (bodyOk) qualified = true
      else bodyRejected += 1
    }

    if (process.env.DFC_DEBUG) tlog(task, `pair ${path.basename(va.path)} vs ${path.basename(vb.path)} span=${best ? best.span : 0} core=${best ? best.coreSpan : 0} cov=${best ? (best.cov * 100).toFixed(0) : 0}% off=${best ? best.off : 0} run=${best ? best.maxRun : 0} bodyCov=${bodyCov === null ? '-' : (bodyCov * 100).toFixed(0) + '%'} bodyP=${bodyPHashHits} qualified=${qualified}`)
if (qualified) matched.push({ a: ai, b: bi, hits: best.hits, need: best.coreSpan, run: best.maxRun, off: best.off })
    task.done += 1
  })
  if (stopped()) {
    if (fp.cache) fp.cache.close()
    return
  }
  tlog(task, `校验通过: ${matched.length} 对`)
  if (durGuardSkipped) tlog(task, `时长守卫跳过 ${durGuardSkipped} 对（时长差超过 15 秒或较短片的 15%）`)
  if (bodyRejected) tlog(task, `中段确认跳过 ${bodyRejected} 对（片头/片尾相同但中段内容或轮廓不同）`)

  // ⑥ 合并成组（展示与其它模块一致）
  // 并查集：A-B 相似、B-C 相似，则 A/B/C 同组；避免同一组被拆成多条结果。
  const parent = new Array(videos.length).fill(0).map((_, i) => i)
  const find = (x) => { while (parent[x] !== x) x = parent[x]; return x }
  const union = (x, y) => { const rx = find(x); const ry = find(y); if (rx !== ry) parent[rx] = ry }
  for (const m of matched) union(m.a, m.b)
  const groups = new Map()
  for (let i = 0; i < videos.length; i += 1) {
    const root = find(i)
    const arr = groups.get(root) || []
    arr.push({ path: videos[i].path, durationMs: videos[i].durationMs })
    groups.set(root, arr)
  }
  // 只保留多于 1 个视频的组；durationMs 取组内平均，仅用于界面显示
  task.result = [...groups.values()].filter((g) => g.length > 1).map((g) => ({
    durationMs: Math.round(g.reduce((n, x) => n + x.durationMs, 0) / g.length),
    clusters: [g],
  }))
  tlog(task, `疑似视频重复（忽略片头）: ${task.result.length} 组，涉及 ${task.result.reduce((n, g) => n + g.clusters[0].length, 0)} 个视频`)
  if (fp.cache) await finishFingerprintCache(task, fp.cache, viProfile, fp.presentByDir, newRows, fp.unsafeDirs)
}

/**
 * 「抓帧疑似重复校验_忽略片头」的帧级多候选算法。
 *
 * 设计前提（主人 2026-11-10 明确）：
 *   - 只看前 N 秒，N ≤ 60；片头肯定不超过 20 秒，超过 20 秒查不出来就算；
 *   - 不做全时间轴、不抓中段、不用热桶跳过、不用视频级 SimHash。
 *
 * 做法：
 *   1. 每条视频只抓 0..N 秒，去掉纯色帧，帧保留在数组中的先后位置。
 *   2. 所有非纯色帧的 dHash 8 个 8bit band 写入 band_dhash，做视频级 4-band 召回；
 *      帧级反查也用同样的 8 个 8bit band，value 打包为“视频号*1024+帧号”。
 *   3. 对每个 A 视频逐帧循环：
 *      - 先推进已经发现的 B/C/D 候选游标（允许 cursor±1 和 1 帧缺口）；
 *        失败累加 fails，超过 failMax 淘汰；命中则 matches++、run++、maxRun 更新。
 *      - 再拿 A 当前帧反查索引，用新出现的 B 帧建立候选（startA、startB、matches=1）；
 *        起点差不得大于 videoIntroOffset 秒换算出的帧数。
 *   4. A 走完后，存活候选按 matches / (A 剩余帧数) 与 maxRun / 分母判断；
 *      分母从该候选的 startA 算，只对“从发现帧到 A 末帧”负责。
 *
 * @param {object} task 任务状态对象（tasks.videoIntro）的引用
 * @param {object} cfg 配置快照；使用 videoIntroSeconds/Fps/Offset/FailMax、
 *   videoIntroMadMax/DHashMax/PHashMax/Coverage/RunRatio、concurrency
 * @returns {Promise<void>}
 */
async function videoIntroScan(task, cfg) {
  const seconds = viClampInt(cfg.videoIntroSeconds, 1, 60, 40)
  const fps = viClampInt(cfg.videoIntroFps, 1, 5, 2)
  const offsetMax = Math.max(0, Math.min(20, seconds - 5))
  const offsetSec = viClampInt(cfg.videoIntroOffset, 0, offsetMax, Math.min(10, offsetMax))
  const offsetFrames = offsetSec * fps
  const failMax = viClampInt(cfg.videoIntroFailMax, 1, 100, 8)
  const failReset = viClampInt(cfg.videoIntroFailReset, 1, 300, 15)
  const conc = Math.max(1, Math.min(32, Number(cfg.concurrency) || Math.min(8, Math.max(2, os.cpus().length))))
  const madMax = Math.max(1, Math.min(64, Number(cfg.videoIntroMadMax) || 15))
  const dhMax = Number.isFinite(Number(cfg.videoIntroDHashMax)) ? Math.max(0, Math.min(16, Math.round(Number(cfg.videoIntroDHashMax)))) : 4
  const phMax = Number.isFinite(Number(cfg.videoIntroPHashMax)) ? Math.max(0, Math.min(24, Math.round(Number(cfg.videoIntroPHashMax)))) : 8
  const coveragePct = Math.max(50, Math.min(100, Number(cfg.videoIntroCoverage) || 90))
  const runPct = Math.max(50, Math.min(100, Number(cfg.videoIntroRunRatio) || 85))
  const match = (a, b) => viFrameMatch(a, b, madMax, dhMax, phMax)

  tlog(task, `抓帧时长 ${seconds}s · 抓帧频率 ${fps} 帧/秒 · 片头容差 ${offsetSec} 秒 · 失败上限 ${failMax} · 连续成功 ${failReset} 帧后失败计数清零 · 并发 ${conc}`)
  tlog(task, `成组阈值：匹配帧/两段较短剩余帧 ≥${coveragePct}% · 最长连续匹配/两段较短剩余帧 ≥${runPct}%`)
  tlog(task, `算法：逐帧反查 + 每候选游标推进；只抓前 ${seconds} 秒，不抓中段/全片，不用热桶`)
  tlog(task, `片头按最多 20 秒设计；20 秒之后还要求至少 3 帧 pHash 轮廓一致，避免整段共享片头被误判`)

  const all = await listFiles(task, cfg, null)
  if (stopped()) return
  const candidates = all.filter((f) => /\.mp4$/i.test(f))
  tlog(task, `MP4 候选 ${candidates.length} 个（完全一致文件也参与比对）`)
  task.total = candidates.length
  task.done = 0

  task.phase = '抓帧与指纹'
  const t0 = Date.now()
  const viProfile = videoIntroProfile(seconds, fps)
  const fp = await prepareFingerprintCache(task, cfg, viProfile, candidates, Math.min(8, conc))
  const videos = []
  const newRows = []
  const rowWriter = fp.cache ? createRowWriter(fp.cache, viProfile) : null
  if (fp.cache) {
    tlog(task, `缓存候选 ${candidates.length} 个 · 命中 ${fp.rows.size} 个 · 未命中 ${Math.max(0, candidates.length - fp.rows.size)} 个`)
  }
  let cacheHits = 0
  let unreadable = 0
  let noInfo = 0
  let flatSkipped = 0

  const extractConc = Math.max(2, Math.min(8, conc));
  await mapLimit(candidates, extractConc, async (file) => {
    if (stopped()) return
    try {
      const st = await fsp.stat(file)
      const row = fp.cache ? fp.rows.get(pathKey(file)) : null
      if (row) {
        const decoded = decodeIntroRow(row, VI_FLAT_VARIANCE)
        if (decoded && decoded.info >= VI_MIN_INFORMATIVE && decoded.frames.length >= VI_MIN_INFORMATIVE) {
          const hydrated = viHydrateCachedFrames(decoded.frames)
          let cut = 0
          while (cut < hydrated.length && hydrated[cut].flat) cut += 1
          const frames = hydrated.slice(cut)
          flatSkipped += cut
          if (frames.length >= VI_MIN_INFORMATIVE) {
            videos.push({ path: file, durationMs: row.duration_ms, frames, leadFlat: cut })
            cacheHits += 1
            task.done += 1
            return
          }
        }
      }

      const durMs = await viDurationMs(file)
      if (!durMs || durMs <= 0) { unreadable += 1; task.done += 1; return }
      const durSec = durMs / 1000
      const winSec = Math.min(seconds, durSec)
      if (winSec < 1) { unreadable += 1; task.done += 1; return }
      const buf = await viFrameSignature(file, winSec, fps, 0)
      if (!buf) { unreadable += 1; task.done += 1; return }
      const intro = viDecodeFrames(buf)
      if (intro.info < VI_MIN_INFORMATIVE) { noInfo += 1; task.done += 1; return }
      const rawN = intro.frames.length
      let cut = 0
      while (cut < intro.frames.length && intro.frames[cut].flat) cut += 1
      const frames = intro.frames.slice(cut)
      flatSkipped += cut
      if (frames.length < VI_MIN_INFORMATIVE) { noInfo += 1; task.done += 1; return }
      videos.push({ path: file, durationMs: durMs, frames, leadFlat: cut })
      const cacheRow = {
        pathKey: pathKey(file), path: file, dirKey: dirKey(path.dirname(file)), name: path.basename(file),
        size: Number(st.size), mtimeMs: Math.round(Number(st.mtimeMs)), profile: viProfile,
        durationMs: durMs, introN: rawN, bodyN: 0, infoN: intro.info,
        introBlob: buf, bodyBlob: null, sigBlob: null,
      }
      if (rowWriter) rowWriter.push(cacheRow)
      // 正常情况下 rowWriter 会立即排队写入；这里保留一份直到收尾，
      // 用于发现/补救高频扫描下写入条数少于抓帧视频数的情况。
      newRows.push(cacheRow)
      task.done += 1
    } catch (e) {
      unreadable += 1
      task.done += 1
      flog('WARN', `忽略片头抓帧失败：${file}`, e)
    }
  })
  tlog(task, `抓帧完成: ${videos.length} 个视频 · ${videos.reduce((n, v) => n + v.frames.length, 0)} 个非纯色帧 · 缓存命中 ${cacheHits} 个 · 纯色帧跳过 ${flatSkipped} 个 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (noInfo) tlog(task, `${noInfo} 个视频有效帧不足 ${VI_MIN_INFORMATIVE} 个（视频太短或几乎黑屏/纯色），已跳过`)
  if (unreadable) tlog(task, `${unreadable} 个视频读不到时长或抓帧失败，已跳过`)
  if (stopped()) {
    if (rowWriter) { try { await rowWriter.drain() } catch (e) { flog('WARN', '指纹写队列停止时收尾失败', e) } }
    if (fp.cache) fp.cache.close()
    return
  }

  if (videos.length === 0) {
    if (fp.cache) {
      if (!unreadable) await finishFingerprintCache(task, fp.cache, viProfile, fp.presentByDir, [], fp.unsafeDirs)
      else fp.cache.close()
    }
    task.result = []
    tlog(task, '疑似视频重复（忽略片头）: 0 组')
    return
  }

  // ---- 持久倒排索引：只写缓存，不参与下面的对比逻辑 ----
  // 指定文件快速查重依赖 band_luma / band_dhash 按稳定 fp_id 召回。
  // 这里只做“缓存插入”，不改变 viFrameMatch、候选游标或成组规则。
  if (fp.cache) {
    if (rowWriter) {
      try { await rowWriter.drain() } catch (e) { flog('WARN', '倒排索引写入前收尾失败', e) }
    }
    if (stopped()) { fp.cache.close(); return }
    // 每次都重建索引：旧版只检查 band_luma 是否有行，luma 写成功、band 写失败
    // 的视频会被永久跳过，导致指定文件快速查重一直缺 band。分批重建，避免
    // 一次性持有几千个视频的全部行，也能在停止时保留已完成批次。
    const INDEX_BATCH_VIDEOS = 128
    let indexRows = []
    let indexVideos = 0
    let lumaRows = 0
    let bandRows = 0
    let missingFp = 0
    let indexError = null
    const flushIndex = () => {
      if (!indexRows.length) return
      fp.cache.addIndex(indexRows)
      indexRows = []
    }
    for (const v of videos) {
      if (stopped()) break
      const fpId = fp.cache.findFpId(pathKey(v.path), viProfile)
      if (!fpId) { missingFp += 1; continue }
      const luma = v.frames.map((fr) => Number(fr.mean))
      if (!luma.length) continue
      const seen = Array.from({ length: 8 }, () => new Set())
      const bands = []
      for (const fr of v.frames) {
        if (fr.flat || typeof fr.d !== 'bigint') continue
        const vals = viDHashBands(fr.d)
        for (let b = 0; b < 8; b += 1) {
          if (seen[b].has(vals[b])) continue
          seen[b].add(vals[b])
          bands.push({ bandNo: b, bandVal: vals[b] })
        }
      }
      indexRows.push({ profile: viProfile, fpId, luma, bands })
      indexVideos += 1
      lumaRows += luma.length
      bandRows += bands.length
      if (indexRows.length >= INDEX_BATCH_VIDEOS) {
        try { flushIndex() } catch (e) {
          indexError = e
          tlog(task, `倒排索引写入失败（不影响扫描结果）: ${String((e && e.message) || e)}`)
          break
        }
      }
    }
    if (!indexError && indexRows.length) {
      try { flushIndex() } catch (e) {
        indexError = e
        tlog(task, `倒排索引写入失败（不影响扫描结果）: ${String((e && e.message) || e)}`)
      }
    }
    if (!indexError) {
      tlog(task, `倒排索引: 重建 ${indexVideos} 个视频 · luma ${lumaRows} 行 · dHash ${bandRows} 行${missingFp ? ` · 缺缓存记录 ${missingFp} 个` : ''}`)
    }
    if (stopped()) { fp.cache.close(); return }
  }

  // ---- 帧级倒排索引：pHash/dHash 各 4 个 16bit band，不设热桶、不整桶跳过 ----
  // 先让“前导纯色片头更长”的视频当 A：它先跳过黑场，B 可以从更早的正片帧对齐。
  videos.sort((a, b) => (b.leadFlat || 0) - (a.leadFlat || 0) || b.frames.length - a.frames.length)
  task.phase = '建帧级索引'
  const FRAME_BASE = 1024
  const frameIndex = new Map()
  const addBand = (prefix, b, band, vi, fi) => {
    const key = prefix + b + ':' + band
    let arr = frameIndex.get(key)
    if (!arr) { arr = []; frameIndex.set(key, arr) }
    arr.push(vi * FRAME_BASE + fi)
  }
  for (let vi = 0; vi < videos.length; vi += 1) {
    const frames = videos[vi].frames
    for (let fi = 0; fi < frames.length; fi += 1) {
      const fr = frames[fi]
      if (fr.flat) continue
      // 4 × 16 bit band：桶内条目约为 8×8 bit 的 1/256，逐帧反查成本大幅下降；
      // 真重复通常只差少量 bit，仍会有 band 完整命中。
      for (let b = 0; b < 4; b += 1) {
        addBand('p', b, Number((fr.p >> BigInt(b * 16)) & 0xffffn), vi, fi)
        addBand('d', b, Number((fr.d >> BigInt(b * 16)) & 0xffffn), vi, fi)
      }
    }
  }
  const indexFrames = [...frameIndex.values()].reduce((n, a) => n + a.length, 0)
  tlog(task, `帧级索引: ${frameIndex.size} 个 band（4×16bit），${indexFrames} 条帧记录（纯色帧不建索引，不跳过任何 band）`)

  // ---- 逐帧多候选 ----
  task.phase = '逐帧相似匹配'
  task.done = 0
  task.total = videos.length
  tlog(task, `进入逐帧相似匹配: ${videos.length} 个视频，索引 ${frameIndex.size} 个 band`)
  let lookups = 0
  let started = 0
  let dropped = 0
  const matched = []
  // 事件循环让出：对比阶段是纯 CPU 长循环，必须定期 await，
  // worker 的 progress 定时器才有机会把 phase/进度写回父进程。
  const yieldLoop = () => new Promise((resolve) => setImmediate(resolve))
  // 单个 A 同时跟踪的候选上限；索引中的公共 band 可能命中极多视频，
  // 不设上限时 active 会膨胀到数万，扫描看起来像卡死。
  const MAX_ACTIVE = 4000
  let activeCapped = 0

  const lookupFrame = (af, ai, i, active, activeByB, doneB) => {
    const found = new Map()
    const nearStart = (bi, fi) => {
      const set = activeByB.get(bi)
      if (!set) return false
      for (const key of set) {
        const t = active.get(key)
        if (t && Math.abs(t.startB - fi) <= 2) return true
      }
      return false
    }
    const visit = (prefix, b, v) => {
      const arr = frameIndex.get(prefix + b + ':' + v)
      if (!arr) return
      for (let k = 0; k < arr.length; k += 1) {
        const code = arr[k]
        const bi = Math.floor(code / FRAME_BASE)
        const fi = code % FRAME_BASE
        if (bi <= ai || doneB.has(bi)) continue
        if (nearStart(bi, fi)) continue
        if ((activeByB.get(bi)?.size || 0) >= 8) continue
        const bf = videos[bi].frames[fi]
        if (!bf || bf.flat) continue
        if (!match(af, bf)) continue
        const key = bi + ':' + fi
        const prev = found.get(key)
        if (prev === undefined || Math.abs(fi - i) < Math.abs(prev.fi - i)) found.set(key, { bi, fi })
      }
    }
    for (let b = 0; b < 4; b += 1) {
      visit('p', b, Number((af.p >> BigInt(b * 16)) & 0xffffn))
      visit('d', b, Number((af.d >> BigInt(b * 16)) & 0xffffn))
    }
    return found
  }

  for (let ai = 0; ai < videos.length; ai += 1) {
    if (stopped()) break
    const A = videos[ai]
    const introGuard = Math.min(A.frames.length, Math.max(0, Math.round(20 * fps)))
    const active = new Map()
    const activeByB = new Map()
    const doneB = new Set()
    for (let i = 0; i < A.frames.length; i += 1) {
      if (stopped()) break
      // 每 32 帧让出一次事件循环，并把当前 A 的帧进度写进 task。
      if (i > 0 && (i & 31) === 0) await yieldLoop()
      const af = A.frames[i]
      lookups += 1

      // 先推进已有候选：A 当前帧应与 B 游标帧（或 ±1）匹配
      for (const [key, t] of active) {
        const B = videos[t.bi]
        // B 的抓帧窗口先结束：A 剩余帧只是 B 没有的尾部，不能再算失败，
        // 否则 failMax 会在结算前把本可通过的候选淘汰。
        if (t.cursor >= B.frames.length) continue
        while (t.cursor < B.frames.length && B.frames[t.cursor].flat) t.cursor += 1
        let hit = false
        for (let gap = 0; gap <= 1 && !hit; gap += 1) {
          // 先试游标当前帧，再试前后邻帧；否则相邻帧 MAD 也可能过线，
          // 游标会一直停在上一帧，导致完全一致的副本反而 pHash 命中极少。
          for (const dj of [0, -1, 1]) {
            const j = t.cursor + gap + dj
            if (j < 0 || j >= B.frames.length) continue
            const bf = B.frames[j]
            if (!bf) continue
            if (!match(af, bf)) continue
            t.cursor = j + 1
            // 失败后被成功“接住”的失败帧，才允许从分母扣除；
            // 末尾尚未被成功接住的失败段仍算在分母里。
            if (t.gapRun > 0) {
              t.gapRecovered += t.gapRun
              t.gapRun = 0
            }
            t.matches += 1
            t.run += 1
            t.streak += 1
            if (viHamming(af.p, bf.p) <= phMax) {
              t.phits += 1
              if (i >= introGuard) t.tailPhits += 1
            }
            if (t.run > t.maxRun) t.maxRun = t.run
            if (t.fails > 0 && t.streak >= failReset) {
              t.fails = 0
              t.streak = 0
            }
            hit = true
            break
          }
        }
        if (!hit) {
          // 设计语义：失败也推进 B 游标，失败只作为可恢复缺口计入预算；
          // 连续成功 failReset 帧后才清空失败计数。
          t.fails += 1
          t.streak = 0
          t.gapFrames += 1
          t.gapRun += 1
          t.cursor += 1
          if (t.fails > failMax) {
            active.delete(key); dropped += 1
            const set = activeByB.get(t.bi)
            if (set) {
              set.delete(key)
              if (!set.size) { activeByB.delete(t.bi); doneB.add(t.bi) }
            }
            if (process.env.DFC_DEBUG) console.error(`[VI] drop A${ai}@${i} B${t.bi} startA=${t.startA} startB=${t.startB} matches=${t.matches} fails=${t.fails}`)
          }
        }
      }

      // 再反查新候选：当前 A 帧出现在哪些 B 的索引里
      const found = lookupFrame(af, ai, i, active, activeByB, doneB)
      for (const [, c] of found) {
        const { bi, fi } = c
        if (Math.abs(fi - i) > offsetFrames) continue
        const key = bi + ':' + fi
        if (active.has(key)) continue
        if (active.size >= MAX_ACTIVE) { activeCapped += 1; continue }
        let set = activeByB.get(bi)
        if (!set) { set = new Set(); activeByB.set(bi, set) }
        const phit = viHamming(af.p, videos[bi].frames[fi].p) <= phMax
        active.set(key, { bi, startA: i, startB: fi, cursor: fi + 1, matches: 1, phits: phit ? 1 : 0, tailPhits: phit && i >= introGuard ? 1 : 0, fails: 0, gapFrames: 0, gapRun: 0, gapRecovered: 0, streak: 0, run: 1, maxRun: 1 })
        set.add(key)
        started += 1
        if (process.env.DFC_DEBUG) console.error(`[VI] create A${ai}@${i} B${bi}@${fi}`)
      }
    }

    // A 走完，结算存活候选
    const aRemainBase = A.frames.length
    for (const [, t] of active) {
      // 只比较“两段前缀都还在”的帧；B 的片头更长时，它的抓帧窗口会比 A 早结束。
      const denom = Math.min(aRemainBase - t.startA, videos[t.bi].frames.length - t.startB)
      // 方案 3：只有失败段被后续成功接住时，才把这段失败帧从分母扣除；
      // 末尾尚未被接住的失败段仍算在分母里。只有连续成功 failReset 帧后
      // 才清空 fails，避免反复小额失败无限续命。
      const effectiveDenom = Math.max(1, denom - t.gapRecovered)
      if (process.env.DFC_DEBUG) console.error(`[VI] final A${ai} B${t.bi} startA=${t.startA} startB=${t.startB} matches=${t.matches} denom=${denom} gaps=${t.gapFrames} recovered=${t.gapRecovered} tailGap=${t.gapRun} eff=${effectiveDenom} maxRun=${t.maxRun} fails=${t.fails} ph=${t.phits} tailPh=${t.tailPhits}`)
      if (effectiveDenom < 6 || t.matches < 6 || t.matches > effectiveDenom) continue
      // 灰度 MAD 对“亮度接近但内容不同”不敏感；片头最多 20 秒，
      // 因此 20 秒之后的窗口必须有少量 pHash 低频轮廓锚点，避免整段共享片头被误判。
      const guardFrames = Math.min(A.frames.length, Math.max(0, Math.round(20 * fps)))
      const tailFrames = A.frames.length - guardFrames
      if (tailFrames >= 6 && t.tailPhits < 3) continue
      if (t.phits < 3) continue
      const cov = t.matches / effectiveDenom
      const run = t.run / effectiveDenom
      if (cov * 100 < coveragePct) continue
      if (run * 100 < runPct) continue
      if (A.durationMs > 0 && videos[t.bi].durationMs > 0) {
        const durTol = Math.max(15000, Math.floor(Math.min(A.durationMs, videos[t.bi].durationMs) * 0.15))
        if (Math.abs(A.durationMs - videos[t.bi].durationMs) > durTol) continue
      }
      matched.push({ a: ai, b: t.bi, hits: t.matches, denom, cov, run, startA: t.startA, startB: t.startB, fails: t.fails })
      if (process.env.DFC_DEBUG) console.error(`[VI] match ${path.basename(A.path)} <-> ${path.basename(videos[t.bi].path)} hits=${t.matches}/${denom} cov=${(cov*100).toFixed(1)}% run=${(run*100).toFixed(1)}% off=${t.startA - t.startB}`)
    }

    task.done = ai + 1
    if (ai % 25 === 0 || ai + 1 === videos.length) {
      tlog(task, `逐帧匹配 ${ai + 1}/${videos.length}，活跃候选 ${active.size}，已确认 ${matched.length} 对，反查 ${lookups} 帧`)
    }
    await yieldLoop()
  }
  if (activeCapped) tlog(task, `对比阶段候选达到上限 ${MAX_ACTIVE} 后跳过新建 ${activeCapped} 次（避免候选爆炸）`)

  if (stopped()) { if (fp.cache) fp.cache.close(); return }
  tlog(task, `逐帧匹配完成: 反查 ${lookups} 帧 · 新建候选 ${started} 个 · 失败淘汰 ${dropped} 个 · 通过 ${matched.length} 对`)

  // ---- 并查集成组 ----
  const parent = videos.map((_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  for (const m of matched) union(m.a, m.b)
  const groups = new Map()
  for (let i = 0; i < videos.length; i += 1) {
    const r = find(i)
    let arr = groups.get(r)
    if (!arr) { arr = []; groups.set(r, arr) }
    arr.push({ path: videos[i].path, durationMs: videos[i].durationMs })
  }
  task.result = [...groups.values()].filter((g) => g.length > 1).map((g) => ({
    durationMs: Math.round(g.reduce((n, x) => n + x.durationMs, 0) / g.length),
    clusters: [g],
  }))
  tlog(task, `疑似视频重复（忽略片头）: ${task.result.length} 组，涉及 ${task.result.reduce((n, g) => n + g.clusters[0].length, 0)} 个视频`)
  let cacheWritten = rowWriter ? rowWriter.written : 0
  if (rowWriter) { try { await rowWriter.drain() } catch (e) { flog('WARN', '指纹写队列收尾失败', e) } }
  if (fp.cache && newRows.length && cacheWritten < newRows.length) {
    tlog(task, `指纹写队列只完成 ${cacheWritten}/${newRows.length} 条，正在全量补写`)
    try {
      fp.cache.upsert(newRows)
      cacheWritten = newRows.length
      tlog(task, `指纹写队列补写完成: ${cacheWritten} 条`)
    } catch (e) {
      flog('WARN', '指纹写队列补写失败', e)
      tlog(task, `指纹写队列补写失败（不影响扫描结果）: ${String((e && e.message) || e)}`)
    }
  }
  if (fp.cache) await finishFingerprintCache(task, fp.cache, viProfile, fp.presentByDir, [], fp.unsafeDirs, cacheWritten)
}

/** 本模块私有的目标盘空间预检 */
async function viEnsureSpace(dir, bytes, label) {
  try {
    const st = await fsp.statfs(dir)
    const free = Number(st.bavail) * Number(st.bsize)
    if (free > 0 && bytes > free) {
      throw new Error(`${label}空间不足：需要 ~${(bytes / 1024 ** 3).toFixed(2)} GB，可用 ${(free / 1024 ** 3).toFixed(1)} GB`)
    }
  } catch (e) {
    if (String((e && e.message) || e).includes('空间不足')) throw e
  }
}

/** 同组移动：每个相似组一个子文件夹，组内保留原文件名 */
/**
 * 指定文件快速查重：只读指纹缓存，不重新抓全目录。
 *
 * 先用持久倒排索引召回候选：
 *   - band_luma：查询文件的每一帧 mean±(madMax+1)，覆盖 MAD≤madMax 的必要条件；
 *   - band_dhash：查询文件所有非纯色帧的 8×8bit band，召回哈希分支候选。
 * 然后只加载候选的 intro BLOB，用 viLcsBest 对齐验证；MAD 是第一层判定，
 * 不再用 dHash 给 MAD 设门。
 *
 * @param {object} cfg 配置快照
 * @param {string} file 已缓存的视频绝对路径
 * @param {object} [task] 可选任务状态，用于日志/停止
 * @returns {Promise<object>}
 */
async function videoIntroFind(cfg, file, task = null) {
  const abs = path.resolve(String(file || ''))
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, error: '文件不存在：' + abs }
  }
  const seconds = viClampInt(cfg.videoIntroSeconds, 1, 60, 40)
  const fps = viClampInt(cfg.videoIntroFps, 1, 5, 2)
  const madMax = Math.max(1, Math.min(64, Number(cfg.videoIntroMadMax) || 15))
  const dhMax = Math.max(0, Math.min(7, Number(cfg.videoIntroDHashMax) || 4))
  const phMax = Math.max(0, Math.min(24, Number(cfg.videoIntroPHashMax) || 8))
  const coveragePct = Math.max(50, Math.min(100, Number(cfg.videoIntroCoverage) || 90))
  const runPct = Math.max(50, Math.min(100, Number(cfg.videoIntroRunRatio) || 85))
  const profile = videoIntroProfile(seconds, fps)
  const gapTol = Math.max(2, Math.min(10, Math.round(fps * 2)))
  const match = (a, b) => viFrameMatch(a, b, madMax, dhMax, phMax)

  const cache = await openFingerprintStore(fingerprintDbPath(cfg))
  try {
    const key = pathKey(abs)
    // getDir 的参数是 dir_key（目录），返回的 Map 才按 path_key 索引。
    const meta = cache.getDir(dirKey(path.dirname(abs)), profile).get(key)
    if (!meta) {
      return { ok: false, error: '该文件还没有指纹缓存；请先运行一次「抓帧疑似重复校验_忽略片头」扫描。' }
    }
    const blobRow = cache.getBlobs([key], profile).get(key)
    if (!blobRow || !blobRow.intro_blob) {
      return { ok: false, error: '该文件的指纹缓存不完整；请重新扫描后再试。' }
    }
    const decodedQuery = decodeIntroRow({ ...meta, intro_blob: blobRow.intro_blob }, 3)
    const query = decodedQuery ? { ...decodedQuery, frames: viHydrateCachedFrames(decodedQuery.frames) } : null
    if (!query || query.info < VI_MIN_INFORMATIVE) {
      return { ok: false, error: '该文件有效帧不足（< ' + VI_MIN_INFORMATIVE + '），无法比对。' }
    }
    const selfFpId = cache.findFpId(key, profile)
    if (!selfFpId) {
      return { ok: false, error: '找不到该文件的稳定 fp_id；请重新扫描刷新缓存。' }
    }

    // dHash 哈希候选（仅服务 MAD 不中的非 flat 帧）。
    const valuesByBand = Array.from({ length: 8 }, () => new Set())
    for (const f of query.frames) {
      if (f.flat || typeof f.d !== 'bigint') continue
      const bands = viDHashBands(f.d)
      for (let b = 0; b < 8; b += 1) valuesByBand[b].add(bands[b])
    }
    const bandIds = cache.bandCandidates(
      profile,
      valuesByBand.map((s) => Array.from(s)),
      Math.max(1, 8 - Math.min(8, dhMax)),
      selfFpId,
    )

    // luma 候选：每个查询帧单独按 mean±(madMax+1) 召回，再取并集。
    const lumaIds = new Set()
    for (const f of query.frames) {
      for (const id of cache.lumaCandidates(profile, f.mean, madMax + 1, selfFpId)) lumaIds.add(id)
    }
    const candidateIds = new Set([...bandIds, ...lumaIds])
    candidateIds.delete(selfFpId)
    if (!candidateIds.size) {
      return { ok: true, file: abs, seconds, fps, candidates: [], candidateCount: 0, message: '缓存里没有可召回的其他视频。' }
    }

    const rows = cache.getRowsByFpIds(Array.from(candidateIds), profile)
    if (process.env.DFC_DEBUG) console.error(`[FIND] candidates=${candidateIds.size} rows=${rows.size} queryFrames=${query.frames.length}`)
    const out = []
    for (const [fpId, row] of rows) {
      if (stopped()) break
      const decoded = decodeIntroRow(row, 3)
      if (!decoded || decoded.info < VI_MIN_INFORMATIVE) continue
      const candidateFrames = viHydrateCachedFrames(decoded.frames)
      const best = viLcsBest(query.frames, candidateFrames, match, gapTol, phMax)
      if (!best) continue
      const cov = best.cov
      const run = best.maxRun / Math.max(1, best.coreSpan)
      if (process.env.DFC_DEBUG) console.error(`[FIND] ${path.basename(abs)} vs ${path.basename(row.path)} hits=${best.hits} span=${best.coreSpan} cov=${(cov * 100).toFixed(1)} run=${(run * 100).toFixed(1)} ph=${best.phits} off=${best.off} dur=${meta.duration_ms}/${row.duration_ms}`)
      if (cov * 100 < coveragePct || run * 100 < runPct) continue
      if (best.phits < 3) continue
      if (meta.duration_ms > 0 && row.duration_ms > 0) {
        const durTol = Math.max(15000, Math.floor(Math.min(meta.duration_ms, row.duration_ms) * 0.15))
        if (Math.abs(meta.duration_ms - row.duration_ms) > durTol) continue
      }
      out.push({
        path: row.path,
        fpId,
        durationMs: row.duration_ms,
        hits: best.hits,
        coreSpan: best.coreSpan,
        coveragePct: Math.round(cov * 1000) / 10,
        runPct: Math.round(run * 1000) / 10,
        phits: best.phits,
        offsetSec: Math.round((best.off / fps) * 10) / 10,
      })
    }
    out.sort((a, b) => b.coveragePct - a.coveragePct || b.runPct - a.runPct || b.hits - a.hits)
    if (task) tlog(task, `指定文件查重 ${path.basename(abs)}：候选 ${candidateIds.size} 个，通过 ${out.length} 个`)
    return {
      ok: true,
      file: abs,
      seconds,
      fps,
      candidateCount: candidateIds.size,
      candidates: out,
    }
  } finally {
    cache.close()
  }
}

async function videoIntroMove(cfg) {
  const task = tasks.videoIntro
  const out = cfg.videoIntroOutDir
  if (!out) return { ok: false, error: '还没设置本模块的疑似重复输出目录' }
  if (path.parse(out).root.toLowerCase() === path.resolve(out).toLowerCase()) return { ok: false, error: '输出目录不能是盘符根目录，请选一个子目录' }
  for (const s of cfg.sources || []) {
    if (s && pathInside(out, s)) return { ok: false, error: `输出目录不能放在来源目录内部：${out}` }
  }
  const groups = (task.result || []).filter((g) => (g.clusters || []).some((c) => c && c.length))
  if (!groups.length) return { ok: false, error: '没有可移动的疑似重复文件（先扫描）' }
  await fsp.mkdir(out, { recursive: true })

  // 目标盘空间预检（跨盘复制才需要）
  const allFiles = []
  for (const g of groups) for (const c of g.clusters || []) for (const f of c || []) allFiles.push(f.path)
  const uniqueFiles = [...new Set(allFiles)]
  const outRoot = path.parse(out).root.toLowerCase()
  let needBytes = 0
  const foreign = []
  for (const f of uniqueFiles) {
    if (pathInside(f, out)) continue
    foreign.push(f)
    try { needBytes += (await fsp.stat(f)).size } catch { /* 忽略 */ }
  }
  if (foreign.length) {
    const roots = new Set(foreign.map((f) => path.parse(f).root.toLowerCase()))
    if ([...roots].some((r) => r !== outRoot)) await viEnsureSpace(out, needBytes, '疑似重复输出')
  }

  const uniqueDir = (base) => {
    let p = path.join(out, base)
    let i = 2
    while (fs.existsSync(p)) { p = path.join(out, `${base}_${i}`); i += 1 }
    return p
  }
  const uniqueFile = (dir, name) => {
    let p = path.join(dir, name)
    if (!fs.existsSync(p)) return p
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    let i = 2
    while (fs.existsSync(path.join(dir, `${stem}_${i}${ext}`))) i += 1
    return path.join(dir, `${stem}_${i}${ext}`)
  }

  const moved = []
  const failed = []
  let gi = 0
  for (const g of groups) {
    if (stopped()) break
    const files = []
    for (const c of g.clusters || []) for (const f of c || []) if (f && f.path) files.push(f.path)
    const uniq = [...new Set(files)].filter((f) => !pathInside(f, out))
    if (uniq.length < 2) continue
    gi += 1
    const folder = uniqueDir(`重复组_${String(gi).padStart(3, '0')}`)
    try { await fsp.mkdir(folder, { recursive: true }) } catch (e) { failed.push({ path: folder, error: String(e.message) }); continue }
    const recMove = recordAppender(folder)
    for (const src of uniq) {
      if (stopped()) break
      if (pathInside(src, out)) continue
      const dst = uniqueFile(folder, path.basename(src))
      try {
        await moveWithRecord(src, dst, recMove)
        moved.push({ from: src, to: dst })
      } catch (e) { failed.push({ path: src, error: String(e.message) }) }
    }
    await recMove.flush()
    await compactJournal(folder)
  }
  task.result = []
  const folders = gi
  tlog(task, `按组移动: ${folders} 个子文件夹，成功 ${moved.length} 个文件，失败 ${failed.length}`)
  if (failed.length) tlog(task, '  例如：' + failed.slice(0, 3).map((f) => path.basename(f.path) + ' → ' + f.error).join(', '))
  return { ok: true, groups: folders, moved: moved.length, failed, first: moved[0]?.to || '' }
}

/* ------------------------------------------------------------------ *
 * 删除空文件夹：来源目录下的子目录若里面没有任何文件就删除（先深后浅）
 * ------------------------------------------------------------------ */
async function emptyDirsCleanup(task, cfg) {
  const roots = (cfg.sources || []).filter(Boolean)
  const rootKeys = new Set(roots.map((r) => path.resolve(r).toLowerCase()))
  // 输出/目标/工作目录即使为空也不能当“空文件夹”删掉
  const protectedRoots = [cfg.outputDir, cfg.sizeTargetDir, cfg.durationTargetDir, cfg.unifyTargetDir, cfg.unifyWorkDir, cfg.videoIntroOutDir]
    .filter(Boolean).map((p) => path.resolve(p))
  const isProtected = (p) => protectedRoots.some((pd) => pathInside(p, pd))
  task.phase = '扫描目录'
  const dirs = []
  const seen = new Set()
  let unreadable = 0
  const scan = async (dir, depth = 0) => {
    if (stopped() || depth > 64) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { unreadable += 1; return }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      if (!ent.isDirectory()) continue
      if (SKIP_DIRS.has(ent.name)) continue
      const p = path.join(dir, ent.name)
      const key = path.resolve(p).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (isProtected(p)) continue
      // 配置的来源目录本身永不删除，只删它们下面的空目录
      if (!rootKeys.has(key)) dirs.push(p)
      await scan(p, depth + 1)
    }
  }
  for (const r of roots) {
    if (!fs.existsSync(r)) { tlog(task, `跳过不存在的目录: ${r}`); continue }
    await scan(r)
  }
  if (unreadable) tlog(task, `${unreadable} 个目录读不到（权限或已删除），已跳过`)
  task.total = dirs.length
  task.done = 0
  if (!dirs.length) { task.result = { deleted: 0, failed: [], scanned: 0 }; tlog(task, '没有可删除的空目录'); return }
  task.phase = '删除空文件夹'
  // 按目录深度从深到浅，先删深层，父目录才可能变空
  const depthOf = (p) => path.resolve(p).split(path.sep).filter(Boolean).length
  const ordered = dirs.slice().sort((a, b) => depthOf(b) - depthOf(a) || b.length - a.length)
  const deleted = []
  const failed = []
  for (const d of ordered) {
    if (stopped()) break
    let entries
    try {
      entries = await fsp.readdir(d)
    } catch (e) {
      // 扫描后被别处删掉：不算失败
      if (e && e.code !== 'ENOENT') failed.push({ path: d, error: String(e.message) })
      task.done += 1
      continue
    }
    if (!entries.length) {
      // 确认不是重解析点（junction / 挂载点），避免误删
      let st = null
      try { st = await fsp.lstat(d) } catch { /* 忽略 */ }
      if (st && st.isSymbolicLink()) { task.done += 1; continue }
      try { await fsp.rmdir(d); deleted.push(d) } catch (e) {
        if (!e || e.code !== 'ENOENT') failed.push({ path: d, error: String(e.message) })
      }
    }
    task.done += 1
  }
  task.result = { deleted: deleted.length, failed, scanned: dirs.length, sample: deleted.slice(0, 20) }
  if (deleted.length) tlog(task, `已删除空文件夹 ${deleted.length} 个`)
  if (failed.length) {
    tlog(task, `${failed.length} 个目录删不掉`)
    tlog(task, '  例如：' + failed.slice(0, 3).map((f) => path.basename(f.path) + ' → ' + f.error).join(', '))
  }
  tlog(task, `扫描 ${dirs.length} 个子目录，删除 ${deleted.length} 个`)
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
  const movedPairs = []
  for (const p of plan) {
    if (stopped()) break
    try {
      await fsp.rename(p.from, p.to)
      renamed += 1
      movedPairs.push({ from: p.from, to: p.to })
    } catch (e) { failed.push({ path: p.from, error: String(e.message) }) }
    task.done += 1
  }
  task.result = { renamed, conflict, failed }
  tlog(task, `改名: 成功 ${renamed}，冲突 ${conflict}，失败 ${failed.length}`)
  await syncFingerprintMoves(task, cfg, cfg.syncFingerprintsRenameExt, movedPairs, '改后缀')
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
  const movedPairs = []
  for (const f of files) {
    if (stopped()) break
    const suffix = path.extname(f)
    let dst
    do { dst = path.join(path.dirname(f), crypto.randomUUID() + suffix) } while (fs.existsSync(dst))
    try {
      await fsp.rename(f, dst)
      ok += 1
      movedPairs.push({ from: f, to: dst })
    } catch (e) { failed.push({ path: f, error: String(e.message) }) }
    task.done += 1
  }
  task.result = { renamed: ok, failed }
  tlog(task, `UUID 改名: 成功 ${ok}，失败 ${failed.length}`)
  await syncFingerprintMoves(task, cfg, cfg.syncFingerprintsUuid, movedPairs, 'UUID 改名')
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
  let seq = await nextSeq(targetDir)
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
  const movedPairs = []
  const recMove = recordAppender(targetDir)
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
      await moveWithRecord(it.path, dst, recMove)
      moved += 1
      movedPairs.push({ from: it.path, to: dst })
    } catch (e) { failed.push({ path: it.path, error: String(e.message) }) }
    task.done += 1
  })
  await recMove.flush()
  await compactJournal(targetDir)
  task.result = { moved, failed }
  tlog(task, `移动: 成功 ${moved}，失败 ${failed.length}`)
  await syncFingerprintMoves(
    task, cfg,
    orderBy === 'size' ? cfg.syncFingerprintsBySize : cfg.syncFingerprintsByDuration,
    movedPairs, orderBy === 'size' ? '按大小移动' : '按时长移动',
  )
}


/* ------------------------------------------------------------------ *
 * 统一编码：按文件头识别 MOV / AVI / WMV，移动到对比目录并转成 MP4
 * ------------------------------------------------------------------ */
const HEAD_BYTES = 64

async function readHead(file) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close().catch(() => {})
  }
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

/** 只认真 HDR 传输函数；10/12bit 的 SDR（如 bt709 10bit）不再误判。 */
function isHdr(v) {
  const pf = String(v.pix_fmt || '')
  const trc = String(v.color_transfer || '')
  if (['smpte2084', 'arib-std-b67'].includes(trc)) return true
  const wide = ['bt2020', 'bt2020nc'].includes(String(v.color_primaries || ''))
  return wide && /10le|12le|10be|12be/.test(pf) && trc !== 'bt709'
}

async function probeVideoParams(file) {
  const r = await run(ffprobeActive, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], 120000)
  if (!r.ok) return null
  try {
    const j = JSON.parse(r.stdout)
    const v = (j.streams || []).find((s) => s.codec_type === 'video')
    const a = (j.streams || []).find((s) => s.codec_type === 'audio')
    if (!v) return null
    const subs = (j.streams || []).filter((s) => s.codec_type === 'subtitle')
    return { v, a, subs, format: j.format || {} }
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
      if (binTest.ok) {
        ffmpegActive = cand
        const probeCand = path.join(SELF_BIN_DIR, 'ffprobe.exe')
        if (fs.existsSync(probeCand)) {
          const probeTest = await run(probeCand, ['-version'], 15000)
          if (probeTest.ok) ffprobeActive = probeCand
        }
        return true
      }
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
    try { head = await readHead(f) } catch { task.done += 1; return }
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
  const recMove = recordAppender(target)
  await mapLimit(found, encLimit, async (item) => {
  let encoderUsed = ''
    if (stopped()) return
      const base = path.basename(item.path)
      const ext = path.extname(base)
      const stem = base.slice(0, base.length - ext.length)
      let current = item.path          // 原件当前位置（移动后变成对比目录里的路径）
      let partial = ''
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

        // 2) 把原件搬到对比目录（记录失败会尝试搬回）
        // sameExt 时原件在 target\original\ 下，复位记录必须写相对路径，
        // 否则 reset 会去 target\<name> 找到转码成品，把成品当原件搬回。
        await moveWithRecord(current, dst, recMove, path.relative(target, dst))
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
        const args = ['-nostdin', '-y', '-v', 'error', '-i', current, '-map', '0:v:0', '-map_metadata', '0', '-map_chapters', '0']
        if (a) args.push('-map', '0:a?')
        // MP4 只能装 mov_text/tx3g 字幕；图片字幕等不硬塞，避免整条转码失败
        const textSubs = (params.subs || []).filter((s) => ['mov_text', 'tx3g'].includes(String(s.codec_name || '')))
        for (const s of textSubs) args.push('-map', `0:${s.index}`)
        if (textSubs.length) args.push('-c:s', 'copy')

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
          if (fs.existsSync(current)) {
            await moveWithRecord(current, dst, recMove, path.relative(target, dst))
            where = dst
          }
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
  /* 记录压缩：先把 journal 合并，再只保留文件仍存在的条目（keep=false 删掉的原件、已挪去 fail 的旧条目都会被清掉） */
  try {
    await recMove.flush()
    await compactJournal(target)
    const rec = await readRestoreRecord(target)
    const alive = rec.filter((e) => fs.existsSync(path.join(target, e.name)))
    await writeRestoreRecord(target, alive)
  } catch (e) { tlog(task, `复位记录整理失败：${String((e && e.message) || e)}`) }
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
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function isLocalRequest(req) {
  const addr = req.socket?.remoteAddress || req.connection?.remoteAddress || ''
  if (addr && !LOCAL_ADDRS.has(addr)) return false
  const host = String(req.headers?.host || '')
  if (host) {
    let name
    if (host.startsWith('[')) {
      const end = host.indexOf(']')
      name = end >= 0 ? host.slice(0, end + 1) : host
    } else if (host === '::1') {
      name = '::1'
    } else {
      name = host.split(':')[0]
    }
    if (!LOCAL_HOSTS.has(name.toLowerCase())) return false
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

function sendJson(res, code, body, extraHeaders) {
  // 所有 4xx/5xx 都落盘：既包括业务 catch 后返回的错误，也包括路由兜底异常。
  if (code >= 500) flog('ERROR', `HTTP ${code}：${String(body && (body.error || body.message) || '')}`)
  else if (code >= 400) flog('WARN', `HTTP ${code}：${String(body && (body.error || body.message) || '')}`)
  const text = JSON.stringify(body)
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) }
  if (extraHeaders) Object.assign(headers, extraHeaders)
  res.writeHead(code, headers)
  res.end(text)
}

/** 会话 cookie：GET /config 下发，写接口用 cookie 或 X-Dupfc-Token 鉴权。 */
function sessionCookie() {
  return `${SESSION_COOKIE}=${API_TOKEN}; Path=/dupfc; HttpOnly; SameSite=Strict; Max-Age=86400`
}

function cookieToken(req) {
  const raw = String(req.headers?.cookie || '')
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim()
  }
  return ''
}

function guard(req, res, needsToken) {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: 'only local requests are allowed' })
    return false
  }
  if (denyCrossOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin request rejected' })
    return false
  }
  if (needsToken) {
    const header = String(req.headers['x-dupfc-token'] || '')
    // 显式带 header 时以 header 为准（便于负向用例验证错误 token）；
    // 否则接受 GET /config 下发的 HttpOnly 会话 cookie。
    const supplied = header || cookieToken(req)
    if (supplied !== API_TOKEN) {
      sendJson(res, 403, { error: 'missing or wrong X-Dupfc-Token' })
      return false
    }
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
  workerRss: Number.isFinite(t.workerRss) ? t.workerRss : 0,
}]))

export const name = NAME
export const inject = ['webServer']
// worker 复用同一套扫描实现，避免 core 与 host 两份逻辑漂移
export { videoScan, videoIntroScan, videoIntroFind }

function sweepOrphanFfmpeg() {
  const script = [
    "$frame = 'scale=16:16:flags=area'",
    "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" -ErrorAction SilentlyContinue | Where-Object { $cmd = $_.CommandLine; if (-not $cmd) { $false } elseif ($cmd.Contains($frame) -and $cmd.Contains('rawvideo')) { $true } elseif ($cmd.Contains('.mp4.part') -and $cmd.Contains('faststart')) { $true } else { $false } } | ForEach-Object {",
    "  $parentAlive = $false",
    "  try { $null = Get-Process -Id $_.ParentProcessId -ErrorAction Stop; $parentAlive = $true } catch { }",
    "  if (-not $parentAlive) { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output ('swept ' + $_.ProcessId) } catch { } }",
    "}",
  ].join('\n')
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
    if (stdout && String(stdout).trim()) flog('INFO', `启动清理孤儿 ffmpeg：${String(stdout).trim()}`)
    if (err) flog('WARN', '启动清理孤儿 ffmpeg 失败', err)
  })
}

export function apply(ctx) {
  initLog()
  try {
    const cfg = readConfig()
    flog('INFO', `配置：sources=${(cfg.sources || []).join(' | ') || '(空)'} outputDir=${cfg.outputDir || '(空)'} ` +
      `videoIntroOutDir=${cfg.videoIntroOutDir || '(空)'}`)
  } catch (e) {
    flog('ERROR', '启动读取配置失败', e)
  }
  dependencyStatus().then((d) => {
    const line = ['ffmpeg', 'ffprobe', 'sqlite'].map((k) => `${k}=${d[k].ok ? 'ok' : 'missing'}(${d[k].path || d[k].source || ''})`).join(' ')
    flog(d.ffmpeg.ok && d.ffprobe.ok && d.sqlite.ok ? 'INFO' : 'WARN', `依赖检查：${line}`)
  }).catch((e) => flog('WARN', '依赖检查失败', e))
  setTimeout(sweepOrphanFfmpeg, 1500)
  // 插件被禁用/HMR 卸载时，路由 disposer 只会注销接口；worker 必须一起杀，
  // 否则旧版本 worker 会在后台继续抓帧，和新版本抢磁盘。
  ctx.effect(() => () => {
    flog('INFO', '插件卸载/HMR：清理 worker')
    killChildren()
  }, `${NAME}: cleanup worker`)

  // 所有路由统一兜底记录未捕获异常；业务代码自己的 400/500 仍照常返回。
  const route = (p, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: p,
    handler: async (req, res) => {
      try {
        return await handler(req, res)
      } catch (e) {
        flog('ERROR', `路由异常：${req.method} ${p}`, e)
        throw e
      }
    },
  }), `${NAME}: ${p}`)

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
      for (const k of ['outputDir', 'sizeTargetDir', 'durationTargetDir', 'unifyTargetDir', 'unifyWorkDir', 'videoIntroOutDir']) {
        const v = cfg[k]
        if (v && !usable(v)) cleared.push({ field: k, path: v })
      }
      // 只报告、不改写：临时离线的盘/目录不能被这次 GET（或后续自动保存）永久删掉
      const missingSources = cfg.sources.filter((s) => !s || !fs.existsSync(s))
      const clearedSources = missingSources.length
      const dependencies = await dependencyStatus()
      const extra = { 'Set-Cookie': sessionCookie() }
      // DSH 桌面端可能以自定义 scheme 加载页面，浏览器不保存 HTTP cookie；
      // 仅在插件 UI 明确请求时用响应头下发一次引导 token，JSON 仍不含 token。
      if (req.headers['x-dupfc-ui'] === '1') extra['X-Dupfc-Bootstrap'] = API_TOKEN
      return sendJson(res, 200, { ...cfg, dependencies, clearedDirs: cleared, clearedSources, missingSources }, extra)
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    try {
      const body = JSON.parse(await readBody(req))
      const cfg = readConfig()
      let missingSources = []
      if (Array.isArray(body.sources)) {
        const wanted = body.sources.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
        // 不因为目录暂时离线就删除配置：保留来源，扫描时自然会跳过并写日志
        cfg.sources = wanted
        missingSources = wanted.filter((s) => !fs.existsSync(s))
      }
      for (const k of ['outputDir', 'sizeTargetDir', 'durationTargetDir', 'unifyTargetDir', 'unifyWorkDir', 'videoIntroOutDir', 'fingerprintDb']) if (typeof body[k] === 'string') cfg[k] = body[k].trim()
      if (typeof body.fingerprintCache === 'boolean') cfg.fingerprintCache = body.fingerprintCache
      for (const k of ['syncFingerprintsRenameExt', 'syncFingerprintsUuid', 'syncFingerprintsBySize', 'syncFingerprintsByDuration']) {
        if (typeof body[k] === 'boolean') cfg[k] = body[k]
      }
      if (typeof body.keepOriginal === 'boolean') cfg.keepOriginal = body.keepOriginal
      if (['force8', 'tonemap', 'passthrough'].includes(body.hdrMode)) cfg.hdrMode = body.hdrMode
      if (typeof body.smartCopy === 'boolean') cfg.smartCopy = body.smartCopy
      if (['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(body.encoder)) cfg.encoder = body.encoder
      const fpErr = fingerprintDbError(cfg.fingerprintDb, cfg.sources)
      if (fpErr) return sendJson(res, 400, { error: fpErr })
      for (const k of ['ext', 'uuidExt', 'sizeExt', 'durationExt']) if (body[k] !== undefined) cfg[k] = normalizeExt(body[k]) || cfg[k]
      if (body.exactMode === 'strict' || body.exactMode === 'fast') cfg.exactMode = body.exactMode
      if (Number.isFinite(body.durationToleranceMs)) cfg.durationToleranceMs = Math.max(0, Math.min(10000, Math.round(body.durationToleranceMs)))
      if (Number.isFinite(body.frameSimilarity)) cfg.frameSimilarity = Math.min(1, Math.max(0.1, body.frameSimilarity))
      if (Number.isFinite(body.frameSeconds)) cfg.frameSeconds = Math.max(1, Math.min(120, Math.round(body.frameSeconds)))
      if (Number.isFinite(body.frameFps)) cfg.frameFps = Math.max(1, Math.min(5, Math.round(body.frameFps)))
      if (Number.isFinite(body.videoIntroSeconds)) cfg.videoIntroSeconds = Math.max(1, Math.min(60, Math.round(body.videoIntroSeconds)))
      if (Number.isFinite(body.videoIntroFps)) cfg.videoIntroFps = Math.max(1, Math.min(5, Math.round(body.videoIntroFps)))
      if (Number.isFinite(body.videoIntroOffset)) cfg.videoIntroOffset = Math.max(0, Math.min(20, Math.round(body.videoIntroOffset)))
      if (Number.isFinite(body.videoIntroFailMax)) cfg.videoIntroFailMax = Math.max(1, Math.min(100, Math.round(body.videoIntroFailMax)))
  if (Number.isFinite(body.videoIntroFailReset)) cfg.videoIntroFailReset = Math.max(1, Math.min(300, Math.round(body.videoIntroFailReset)))
      if (Number.isFinite(body.videoIntroMadMax)) cfg.videoIntroMadMax = Math.max(1, Math.min(64, Math.round(body.videoIntroMadMax)))
      if (Number.isFinite(body.videoIntroDHashMax)) cfg.videoIntroDHashMax = Math.max(0, Math.min(7, Math.round(body.videoIntroDHashMax)))
      if (Number.isFinite(body.videoIntroPHashMax)) cfg.videoIntroPHashMax = Math.max(0, Math.min(24, Math.round(body.videoIntroPHashMax)))
      if (Number.isFinite(body.videoIntroCoverage)) cfg.videoIntroCoverage = Math.max(50, Math.min(100, Math.round(body.videoIntroCoverage)))
      if (Number.isFinite(body.videoIntroRunRatio)) cfg.videoIntroRunRatio = Math.max(50, Math.min(100, Math.round(body.videoIntroRunRatio)))
      cfg.videoIntroOffset = Math.max(0, Math.min(20, Math.max(0, (cfg.videoIntroSeconds || 40) - 5), Number(cfg.videoIntroOffset) || 0))
      if (Number.isFinite(body.concurrency)) cfg.concurrency = Math.max(0, Math.min(32, Math.round(body.concurrency)))
      writeConfig(cfg)
      return sendJson(res, 200, { ok: true, config: cfg, missingSources })
    } catch (e) { return sendJson(res, 400, { error: String(e?.message || e) }) }
  })

  route('/dupfc/api/status', async (req, res) => {
    if (!guard(req, res, false)) return
    return sendJson(res, 200, { tasks: publicTasks(), lock: opLock, activeChildren: activeChildren.size })
  })

  route('/dupfc/api/fingerprints/stats', async (req, res) => {
    if (!guard(req, res, false)) return
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    try {
      const cfg = readConfig()
      const cache = await openFingerprintStore(fingerprintDbPath(cfg))
      try {
        const st = cache.stats()
        return sendJson(res, 200, { ok: true, ...st, path: fingerprintDbPath(cfg) })
      } finally { cache.close() }
    } catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
  })

  route('/dupfc/api/fingerprints/clear', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock || Object.values(tasks).some((t) => t.running)) return sendJson(res, 409, { error: '有任务正在执行，请等它结束再清空指纹' })
    try {
      const cfg = readConfig()
      const dbPath = fingerprintDbPath(cfg)
      const cache = await openFingerprintStore(dbPath)
      try {
        const before = cache.stats()
        const deleted = cache.clearAll()
        const after = cache.stats()
        flog('WARN', `指纹强制清空：删除 ${deleted} 条（${before.rows} -> ${after.rows}），库 ${dbPath}`)
        return sendJson(res, 200, { ok: true, deleted, beforeRows: before.rows, afterRows: after.rows, dbPath })
      } finally { cache.close() }
    } catch (e) {
      flog('ERROR', '指纹强制清空失败', e)
      return sendJson(res, 500, { error: String(e?.message || e) })
    }
  })

  route('/dupfc/api/fingerprints/cleanup', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock || Object.values(tasks).some((t) => t.running)) return sendJson(res, 409, { error: '有任务正在执行，请等它结束再清理指纹' })
    try {
      const r = await cleanupFingerprintRecords(readConfig())
      flog('INFO', `指纹清理：扫描 ${r.scanned}，删除 ${r.deleted}，跳过离线目录 ${r.skippedDirs}，错误 ${r.errors}`)
      return sendJson(res, 200, r)
    } catch (e) {
      flog('ERROR', '指纹清理失败', e)
      return sendJson(res, 500, { error: String(e?.message || e) })
    }
  })

  route('/dupfc/api/browse', async (req, res) => {
    if (!guard(req, res, false)) return
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      return sendJson(res, 200, await browseDir(url.searchParams.get('path') || ''))
    } catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
  })

  /**
   * 注册一个“开始扫描”型 POST 路由。
   * 统一做：本地来源 + token 校验、方法检查、同任务/全局锁检查、来源目录非空检查，
   * 然后立刻返回 202，把真正的重活丢给 runTask 异步跑；前端靠 /status 轮询进度。
   * @param {string} p 路由路径
   * @param {string} name tasks 里的任务键
   * @param {string} label 任务展示名
   * @param {(task:object,cfg:object)=>Promise<void>} fn 任务体
   */
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
  startRoute('/dupfc/api/video/scan', 'video', '抓帧疑似重复', (t, c) => runScanInWorker('video', t, c))
  startRoute('/dupfc/api/video-intro/scan', 'videoIntro', '抓帧疑似重复_忽略片头', (t, c) => runScanInWorker('videoIntro', t, c))

  // 指定文件快速查重：只读已有指纹缓存，不再抓全目录。
  route('/dupfc/api/video-intro/find', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (tasks.videoIntro.running || opLock) return sendJson(res, 409, { error: '抓帧扫描正在运行，等它结束再查指定文件' })
    let body
    try { body = JSON.parse(await readBody(req)) } catch { return sendJson(res, 400, { error: '请求体不是 JSON' }) }
    const file = String(body.path || '').trim()
    if (!file) return sendJson(res, 400, { error: '缺少文件路径' })
    try {
      return sendJson(res, 200, await videoIntroFind(readConfig(), file))
    } catch (e) {
      return sendJson(res, 500, { error: String(e?.message || e) })
    }
  })
  startRoute('/dupfc/api/uuid', 'uuid', '随机文件名', (t, c) => uuidRename(t, c))
  startRoute('/dupfc/api/empty-dirs', 'emptyDirs', '删除空文件夹', (t, c) => emptyDirsCleanup(t, c))
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
  route('/dupfc/api/video-intro/move', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    stopRequested = false
    opLock = '移动疑似重复_忽略片头'
    try { return sendJson(res, 200, await videoIntroMove(readConfig())) }
    catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
    finally { opLock = '' }
  })
  route('/dupfc/api/video/reset', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    stopRequested = false
    opLock = '复位文件'
    try { return sendJson(res, 200, await resetMoved(readConfig().outputDir)) }
    catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
    finally { opLock = '' }
  })
  route('/dupfc/api/video-intro/reset', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    stopRequested = false
    opLock = '复位文件'
    try { return sendJson(res, 200, await resetMoved(readConfig().videoIntroOutDir)) }
    catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
    finally { opLock = '' }
  })
  route('/dupfc/api/by-size/reset', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    stopRequested = false
    opLock = '复位文件'
    try { return sendJson(res, 200, await resetMoved(readConfig().sizeTargetDir)) }
    catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
    finally { opLock = '' }
  })
  route('/dupfc/api/by-duration/reset', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    stopRequested = false
    opLock = '复位文件'
    try { return sendJson(res, 200, await resetMoved(readConfig().durationTargetDir)) }
    catch (e) { return sendJson(res, 500, { error: String(e?.message || e) }) }
    finally { opLock = '' }
  })
  route('/dupfc/api/unify/reset', async (req, res) => {
    if (!guard(req, res, true)) return
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (opLock) return sendJson(res, 409, { error: `有操作正在执行（${opLock}），请等它结束` })
    stopRequested = false
    opLock = '复位文件'
    try { return sendJson(res, 200, await resetMoved(readConfig().unifyTargetDir, { rootExtras: true })) }
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
    flog('WARN', `收到停止请求：running=${running.join(',') || '(无)'} 子进程=${killed}`)
    killChildren()
    return sendJson(res, 200, { ok: true, note: `正在停止（已终止 ${killed} 个子进程）` })
  })
}
