/**
 * 指纹缓存：把「视频 → 抓帧指纹」存进 SQLite，重复扫描同一目录时不再重跑 ffmpeg。
 *
 * 设计约束（来自需求与源码审查）：
 * - 身份 = 规范化绝对路径 + size；mtime 只记录，不参与命中/清理判断。
 * - 缓存 key 只包含算法/采样参数，不包含判定阈值；调 coverage/run/madMax 不应让缓存失效。
 * - 目录离线时绝不能删记录；目录枚举成功后才删该目录里已不存在的文件。
 * - 数据库操作永远不能影响文件任务；调用方负责 try/catch，本模块只抛错。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const FP_SCHEMA_VERSION = 2
/** 采样/指纹算法版本；改动帧格式、窗口规则或哈希算法时手动 +1。 */
export const FP_ALGO_VERSION = 2

const FRAME_BYTES = 16 * 16

/** Windows 路径不区分大小写；其它平台保持原样。 */
export function pathKey(p) {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function dirKey(dir) {
  return pathKey(dir)
}

/** 抓帧疑似重复（旧 video 模块）的 profile；只依赖采样参数与算法版本。 */
export function videoProfile(frameSeconds, frameFps) {
  return `video:${frameSeconds}:${frameFps}:v${FP_ALGO_VERSION}`
}

/** 忽略片头模块的 profile；双窗口规则包含在算法版本里。 */
export function videoIntroProfile(seconds, fps) {
  return `vi:${seconds}:${fps}:v${FP_ALGO_VERSION}`
}

/** 默认数据库放在用户目录下的 dupfc，不放进 DSH 配置目录。 */
export function defaultDbPath() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'dupfc', 'fingerprints.db')
}

export function fingerprintDbPath(cfg) {
  const explicit = cfg && typeof cfg.fingerprintDb === 'string' ? cfg.fingerprintDb.trim() : ''
  return explicit || defaultDbPath()
}

export function frameCount(buf) {
  if (!buf || !buf.length) return 0
  return Math.floor(buf.length / FRAME_BYTES)
}

export function validFrameBuf(buf, expectedFrames) {
  if (!buf || !buf.length) return false
  if (buf.length % FRAME_BYTES !== 0) return false
  if (expectedFrames !== undefined && expectedFrames !== null && frameCount(buf) !== expectedFrames) return false
  return true
}

export const FP_COLUMNS = [
  'path_key', 'path', 'dir_key', 'size', 'profile',
  'duration_ms', 'intro_n', 'intro_blob', 'sig_blob',
]

const TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fingerprints (
  path_key    TEXT NOT NULL,
  path        TEXT NOT NULL,
  dir_key     TEXT NOT NULL,
  size        INTEGER NOT NULL,
  profile     TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  intro_n     INTEGER NOT NULL DEFAULT 0,
  intro_blob  BLOB,
  sig_blob    BLOB,
  PRIMARY KEY (path_key, profile)
);
`

// 覆盖 getDir 的目录元数据查询（不再读 BLOB）；profile+path_key 服务
// getBlobs 的 IN 查询；主键服务单文件查/删/搬。
const INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_fp_dir
  ON fingerprints(dir_key, profile, path_key, size, duration_ms, intro_n);
CREATE INDEX IF NOT EXISTS idx_fp_profile
  ON fingerprints(profile, path_key);
`

const SCHEMA = TABLE_SCHEMA + INDEX_SCHEMA

/**
 * 把旧表迁移到当前精简 schema。
 * 只保留仍被查询使用的字段：path/path_key/dir_key/size/profile、
 * duration_ms/intro_n/intro_blob/sig_blob；旧 body/mtime/algo/name 等丢弃。
 * 旧缓存仍可用，不需要重新抓帧。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrateSchema(db) {
  const cols = db.prepare("PRAGMA table_info('fingerprints')").all().map((c) => c.name)
  if (!cols.length) { db.exec(SCHEMA); return }

  const same = cols.length === FP_COLUMNS.length && FP_COLUMNS.every((c) => cols.includes(c))
  if (same) { db.exec(INDEX_SCHEMA); return }

  const has = (name) => cols.includes(name)
  const pick = (name, fallback) => (has(name) ? `COALESCE(${name}, ${fallback})` : fallback)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('ALTER TABLE fingerprints RENAME TO fingerprints_old')
    db.exec('DROP INDEX IF EXISTS idx_fp_dir')
    db.exec('DROP INDEX IF EXISTS idx_fp_profile')
    db.exec(TABLE_SCHEMA)
    db.exec(`
      INSERT INTO fingerprints
        (path_key, path, dir_key, size, profile, duration_ms, intro_n, intro_blob, sig_blob)
      SELECT path_key, path, dir_key, size, profile,
             ${pick('duration_ms', '0')}, ${pick('intro_n', '0')},
             ${has('intro_blob') ? 'intro_blob' : 'NULL'},
             ${has('sig_blob') ? 'sig_blob' : 'NULL'}
      FROM fingerprints_old
    `)
    db.exec('DROP TABLE fingerprints_old')
    db.exec(INDEX_SCHEMA)
    db.exec('PRAGMA user_version = 2')
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw e
  }
  // 真正重建文件，清掉旧 body/mtime 页；失败不影响迁移后的可用性。
  try { db.exec('VACUUM') } catch { /* ignore */ }
}

/**
 * 打开（必要时创建/迁移）指纹库。
 * @param {string} dbPath
 * @returns {Promise<{getDir:Function,upsert:Function,remove:Function,removeByDirExcept:Function,cleanup:Function,stats:Function,close:Function,dbPath:string}>}
 */
export async function openFingerprintStore(dbPath) {
  const { DatabaseSync } = await import('node:sqlite')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  migrateSchema(db)
  // 目录级只取索引覆盖的元数据；BLOB 在确认 size 命中后再按命中集合批量取。
  const stmtGetDir = db.prepare(`
    SELECT path_key, size, duration_ms, intro_n
    FROM fingerprints WHERE dir_key = ? AND profile = ?
  `)
  const stmtUpsert = db.prepare(`
    INSERT INTO fingerprints
      (path_key, path, dir_key, size, profile,
       duration_ms, intro_n, intro_blob, sig_blob)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path_key, profile) DO UPDATE SET
      path=excluded.path, dir_key=excluded.dir_key, size=excluded.size,
      duration_ms=excluded.duration_ms, intro_n=excluded.intro_n,
      intro_blob=excluded.intro_blob, sig_blob=excluded.sig_blob
  `)
  const stmtRemove = db.prepare('DELETE FROM fingerprints WHERE path_key = ? AND profile = ?')
  const stmtDeletePathProfiles = db.prepare(
    'DELETE FROM fingerprints WHERE path_key = ? AND profile IN (SELECT profile FROM fingerprints WHERE path_key = ?)'
  )
  const stmtMovePath = db.prepare('UPDATE fingerprints SET path_key = ?, path = ?, dir_key = ? WHERE path_key = ?')
  const stmtRemoveDirExcept = db.prepare('DELETE FROM fingerprints WHERE dir_key = ? AND profile = ? AND path_key NOT IN (SELECT value FROM json_each(?))')
  const stmtStats = db.prepare(`
    SELECT COUNT(*) AS rows,
           COALESCE(SUM(COALESCE(length(intro_blob), 0) + COALESCE(length(sig_blob), 0)), 0) AS bytes
    FROM fingerprints
  `)
  // 清理按 rowid 分页，避免一次性把整个库（含 BLOB）读进内存。
  const stmtPage = db.prepare(`
    SELECT rowid, path_key, path, profile, size
    FROM fingerprints WHERE rowid > ? ORDER BY rowid LIMIT 500
  `)

  const runTx = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try { fn(); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch { /* ignore */ } ; throw e }
  }

  return {
    dbPath,
    getDir(key, profile) {
      const map = new Map()
      for (const row of stmtGetDir.all(key, profile)) map.set(row.path_key, row)
      return map
    },
    /**
     * 按命中集合批量取 BLOB，避免把目录里未命中记录的 BLOB 也读出来。
     * video profile 只需要 sig_blob；videoIntro 只需要 intro_blob。
     * @param {string[]} keys
     * @param {string} profile
     * @returns {Map<string, object>}
     */
    getBlobs(keys, profile) {
      const map = new Map()
      if (!keys || !keys.length) return map
      const cols = profile.startsWith('vi:')
        ? 'path_key, intro_blob'
        : 'path_key, sig_blob'
      for (let i = 0; i < keys.length; i += 400) {
        const chunk = keys.slice(i, i + 400)
        const marks = new Array(chunk.length).fill('?').join(',')
        const stmt = db.prepare(
          `SELECT ${cols} FROM fingerprints WHERE profile = ? AND path_key IN (${marks})`,
        )
        for (const row of stmt.all(profile, ...chunk)) map.set(row.path_key, row)
      }
      return map
    },
    /** 强制清空所有 profile 的指纹记录。只清数据库，不动任何文件。 */
    clearAll() {
      const r = db.prepare('DELETE FROM fingerprints').run()
      return Number(r.changes) || 0
    },
    upsert(rows) {
      if (!rows || !rows.length) return
      runTx(() => {
        for (const r of rows) {
          stmtUpsert.run(
            r.pathKey, r.path, r.dirKey, r.size, r.profile,
            r.durationMs || 0, r.introN || 0,
            r.introBlob || null, r.sigBlob || null,
          )
        }
      })
    },
    remove(keys, profile) {
      if (!keys || !keys.length) return
      runTx(() => { for (const k of keys) stmtRemove.run(k, profile) })
    },
    removeByDirExcept(key, profile, keepKeys) {
      runTx(() => stmtRemoveDirExcept.run(key, profile, JSON.stringify([...keepKeys])))
    },
    /**
     * 文件被任务改名/移动后同步记录。内容未变，指纹仍有效。
     * @param {{from:string,to:string}[]} pairs
     */
    move(pairs) {
      if (!pairs || !pairs.length) return
      runTx(() => {
        for (const p of pairs) {
          const fromKey = pathKey(p.from)
          const toKey = pathKey(p.to)
          if (fromKey === toKey) continue
          // 目标路径可能有旧记录（例如目标文件先被删），只清来源实际拥有的 profile，
          // 不误删目标文件另一算法/参数的记录。
          stmtDeletePathProfiles.run(toKey, fromKey)
          stmtMovePath.run(toKey, path.resolve(p.to), dirKey(path.dirname(p.to)), fromKey)
        }
      })
    },
    /**
     * 清理失效记录：
     * - 父目录不存在/不可访问 → 整目录跳过（离线盘不能清空缓存）
     * - 文件不存在 → 删除
     * - size 不一致 → 删除；mtime 变化不删
     * @returns {{scanned:number,deleted:number,skippedDirs:number,errors:number}}
     */
    cleanup() {
      let scanned = 0, deleted = 0, skippedDirs = 0, errors = 0
      const dirState = new Map()
      const skipped = new Set()
      let lastRowid = 0
      for (;;) {
        const batch = stmtPage.all(lastRowid)
        if (!batch.length) break
        lastRowid = batch[batch.length - 1].rowid
        for (const row of batch) {
          scanned += 1
          const dir = row.path ? path.dirname(row.path) : ''
          let dirOk = dirState.get(dir)
          if (dirOk === undefined) {
            dirOk = !!dir && fs.existsSync(dir)
            dirState.set(dir, dirOk)
          }
          if (!dirOk) { skipped.add(dir); continue }
          try {
            const st = fs.statSync(row.path)
            if (st.size !== row.size) {
              stmtRemove.run(row.path_key, row.profile); deleted += 1
            }
          } catch (e) {
            if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) { stmtRemove.run(row.path_key, row.profile); deleted += 1 }
            else errors += 1
          }
        }
      }
      skippedDirs = skipped.size
      return { scanned, deleted, skippedDirs, errors }
    },
    stats() {
      const r = stmtStats.get()
      return { rows: Number(r.rows) || 0, bytes: Number(r.bytes) || 0, dbPath }
    },
    close() { try { db.close() } catch { /* ignore */ } },
  }
}

/** 把一行数据库记录还原成 videoIntroScan 需要的前缀帧对象。 */
export function decodeIntroRow(row, flatVariance = 3) {
  if (!validFrameBuf(row.intro_blob, row.intro_n)) return null
  const intro = decodeBlobFrames(row.intro_blob, flatVariance)
  // 新算法只使用前缀帧；bodyFrames 保留为同一份帧，兼容旧调用方。
  return { frames: intro.frames, bodyFrames: intro.frames, info: intro.info }
}

/** 把 Buffer 灰度帧解成 {frames,info}；与 index.js 的 viDecodeFrames 保持同一格式。
 *  flatVariance 必须由调用方传入实时抓帧使用的同一阈值，否则缓存命中会改变 flat 判定。 */
export function decodeBlobFrames(buf, flatVariance = 3) {
  const frames = []
  let info = 0
  for (let off = 0; off + FRAME_BYTES <= buf.length; off += FRAME_BYTES) {
    const px = buf.subarray(off, off + FRAME_BYTES)
    let min = 255, max = 0, sum = 0
    for (const v of px) { if (v < min) min = v; if (v > max) max = v; sum += v }
    const mean = sum / FRAME_BYTES
    let varSum = 0
    for (const v of px) varSum += (v - mean) * (v - mean)
    const variance = varSum / FRAME_BYTES
    const flat = variance < flatVariance
    if (!flat) info += 1
    frames.push({ px, min, max, mean, variance, flat })
  }
  return { frames, info }
}
