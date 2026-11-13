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

export const FP_SCHEMA_VERSION = 5
/** 采样/指纹算法版本；改动帧格式、窗口规则或哈希算法时手动 +1。 */
export const FP_ALGO_VERSION = 2

const FRAME_BYTES = 16 * 16

/** 8bit 掩码的 popcount；band 只有 8 个，查表/位运算足够。 */
function popcount8(v) {
  let n = 0
  while (v) { v &= v - 1; n += 1 }
  return n
}

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

/**
 * 两类持久倒排索引，主键都是 fingerprints.rowid（fp_id）：
 *
 * band_luma：一帧一行，存 16×16 灰度帧的算术均值。
 *   查询用 `mean BETWEEN qmean-madMax AND qmean+madMax` 召回 MAD 候选；
 *   因为 |mean(a)-mean(b)| ≤ MAD(a,b)，这是 MAD≤madMax 的必要条件，不会漏。
 *   必须存 REAL；如果把 mean 取整成 INTEGER，边界差 1 会漏 MAD=15。
 *
 * band_dhash：一行 = 某视频在某个 8bit band 值上出现过；同视频去重。
 *   只在 MAD 不中、需要走 dHash/pHash 分支时用于召回，不能反过来给 MAD 设门。
 *
 * 两个表都按 fp_id 关联 fingerprints.rowid；文件改名/移动时 rowid 不变，索引无需搬。
 * 旧 scan_id 版索引直接删表重建，不迁移。
 */
const LUMA_COLUMNS = ['profile', 'fp_id', 'frame_no', 'mean']
const DHASH_COLUMNS = ['profile', 'fp_id', 'band_no', 'band_val']

const BAND_SCHEMA = `
CREATE TABLE IF NOT EXISTS band_luma (
  profile  TEXT NOT NULL,
  fp_id    INTEGER NOT NULL,
  frame_no INTEGER NOT NULL,
  mean     REAL NOT NULL,
  PRIMARY KEY (profile, fp_id, frame_no)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_band_luma_lookup
  ON band_luma(profile, mean, fp_id, frame_no);
CREATE TABLE IF NOT EXISTS band_dhash (
  profile  TEXT NOT NULL,
  fp_id    INTEGER NOT NULL,
  band_no  INTEGER NOT NULL CHECK (band_no BETWEEN 0 AND 7),
  band_val INTEGER NOT NULL CHECK (band_val BETWEEN 0 AND 255),
  PRIMARY KEY (profile, fp_id, band_no, band_val)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_band_dhash_lookup
  ON band_dhash(profile, band_no, band_val, fp_id);
`

const SCHEMA = TABLE_SCHEMA + INDEX_SCHEMA + BAND_SCHEMA

/**
 * 索引表不是指纹缓存主体；列、主键、WITHOUT ROWID 或 CHECK 任一不匹配
 * 都直接删表重建。只比列名会放过“同列名但无主键/无约束”的旧表。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureBandSchema(db) {
  const inspect = (name) => {
    const info = db.prepare(`PRAGMA table_info('${name}')`).all()
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql || '')
    return { info, sql, cols: info.map((c) => c.name), pk: info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name) }
  }
  const healthy = (t, cols, pk) => t.info.length === cols.length
    && cols.every((c) => t.cols.includes(c))
    && t.pk.join(',') === pk
    && /WITHOUT\s+ROWID/i.test(t.sql)
  const luma = inspect('band_luma')
  const dhash = inspect('band_dhash')
  const lumaOk = healthy(luma, LUMA_COLUMNS, 'profile,fp_id,frame_no')
  const dhashOk = healthy(dhash, DHASH_COLUMNS, 'profile,fp_id,band_no,band_val')
    && /CHECK\s*\(\s*band_no/i.test(dhash.sql)
    && /CHECK\s*\(\s*band_val/i.test(dhash.sql)
  if (luma.info.length && !lumaOk) db.exec('DROP TABLE band_luma')
  if (dhash.info.length && !dhashOk) db.exec('DROP TABLE band_dhash')
  db.exec(BAND_SCHEMA)
}

/**
 * 把旧表迁移到当前精简 schema。
 * 只保留仍被查询使用的字段：path/path_key/dir_key/size/profile、
 * duration_ms/intro_n/intro_blob/sig_blob；旧 body/mtime/algo/name 等丢弃。
 * 旧缓存仍可用，不需要重新抓帧。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrateSchema(db) {
  const cols = db.prepare("PRAGMA table_info('fingerprints')").all().map((c) => c.name)
  if (!cols.length) {
    db.exec(SCHEMA)
    // fingerprints 不存在也可能残留一张同列名但无主键/约束的 band_dhash；
    // SCHEMA 里的 CREATE IF NOT EXISTS 不会修它，必须再校验一次。
    ensureBandSchema(db)
    db.exec(`PRAGMA user_version = ${FP_SCHEMA_VERSION}`)
    return
  }

  const same = cols.length === FP_COLUMNS.length && FP_COLUMNS.every((c) => cols.includes(c))
  if (same) {
    db.exec(INDEX_SCHEMA)
    ensureBandSchema(db)
    const current = db.prepare('PRAGMA user_version').get().user_version
    if (current !== FP_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${FP_SCHEMA_VERSION}`)
    return
  }

  const has = (name) => cols.includes(name)
  const pick = (name, fallback) => (has(name) ? `COALESCE(${name}, ${fallback})` : fallback)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('ALTER TABLE fingerprints RENAME TO fingerprints_old')
    db.exec('DROP INDEX IF EXISTS idx_fp_dir')
    db.exec('DROP INDEX IF EXISTS idx_fp_profile')
    // 旧 band 数据按主人要求直接丢弃，不迁移；新表由 ensureBandSchema 重建。
    db.exec('DROP TABLE IF EXISTS band_dhash')
    db.exec('DROP TABLE IF EXISTS band_luma')
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
    ensureBandSchema(db)
    db.exec(`PRAGMA user_version = ${FP_SCHEMA_VERSION}`)
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
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new Error(`指纹缓存需要 Node.js 22.5+ 内置 node:sqlite；当前是 ${process.version}，请升级 DSH/Node`)
  }
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
  const stmtPathRows = db.prepare('SELECT rowid AS fp_id, profile FROM fingerprints WHERE path_key = ?')
  const stmtMovePath = db.prepare('UPDATE fingerprints SET path_key = ?, path = ?, dir_key = ? WHERE path_key = ?')
  const stmtRemoveDirExcept = db.prepare('DELETE FROM fingerprints WHERE dir_key = ? AND profile = ? AND path_key NOT IN (SELECT value FROM json_each(?))')
  const stmtStats = db.prepare(`
    SELECT COUNT(*) AS rows,
           COALESCE(SUM(COALESCE(length(intro_blob), 0) + COALESCE(length(sig_blob), 0)), 0) AS bytes
    FROM fingerprints
  `)
  const stmtFpId = db.prepare('SELECT rowid AS fp_id FROM fingerprints WHERE path_key = ? AND profile = ?')
  const stmtBandStats = db.prepare('SELECT COUNT(*) AS rows FROM band_dhash WHERE profile = ?')
  const stmtLumaStats = db.prepare('SELECT COUNT(*) AS rows FROM band_luma WHERE profile = ?')
  const stmtBandStatsAll = db.prepare('SELECT COUNT(*) AS rows FROM band_dhash')
  const stmtLumaStatsAll = db.prepare('SELECT COUNT(*) AS rows FROM band_luma')
  const stmtBandDeleteFp = db.prepare('DELETE FROM band_dhash WHERE profile = ? AND fp_id = ?')
  const stmtLumaDeleteFp = db.prepare('DELETE FROM band_luma WHERE profile = ? AND fp_id = ?')
  // 关联表孤儿：倒排里还在、主表已经没有对应 rowid 的记录。
  // 必须主动清掉——fingerprints 没有 AUTOINCREMENT，删行后 rowid 会被复用，
  // 残留的倒排会挂到新视频上，凭空多出假候选。
  const stmtPurgeLumaOrphans = db.prepare(
    'DELETE FROM band_luma WHERE NOT EXISTS (SELECT 1 FROM fingerprints f WHERE f.rowid = band_luma.fp_id)',
  )
  const stmtPurgeBandOrphans = db.prepare(
    'DELETE FROM band_dhash WHERE NOT EXISTS (SELECT 1 FROM fingerprints f WHERE f.rowid = band_dhash.fp_id)',
  )
  const stmtOrphanCounts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM band_luma WHERE NOT EXISTS (SELECT 1 FROM fingerprints f WHERE f.rowid = band_luma.fp_id)) AS luma,
      (SELECT COUNT(*) FROM band_dhash WHERE NOT EXISTS (SELECT 1 FROM fingerprints f WHERE f.rowid = band_dhash.fp_id)) AS bands
  `)
  // 多行 INSERT 减少百万级写入时的 JS↔SQLite 往返；每批 400 行，
  // 4 列 = 1600 个参数，远低于 SQLite 默认 32766 变量上限。
  const insertStmts = new Map()
  const insertStmt = (table, cols, n) => {
    const key = table + n
    let stmt = insertStmts.get(key)
    if (!stmt) {
      const marks = new Array(n).fill('(' + new Array(cols).fill('?').join(', ') + ')').join(', ')
      stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${table === 'band_luma' ? 'profile, fp_id, frame_no, mean' : 'profile, fp_id, band_no, band_val'}) VALUES ${marks}`)
      insertStmts.set(key, stmt)
    }
    return stmt
  }
  // 每个 band 一条精确查询，8 次调用后在本机合并掩码。
  // 用 idx_band_dhash_lookup(profile, band_no, band_val, fp_id)；
  // 不用 8 个 OR 拼一条 SQL，否则 SQLite 会放弃索引、扫全 profile。
  const stmtBandQuery = db.prepare(`
    SELECT fp_id FROM band_dhash
    WHERE profile = ? AND band_no = ?
      AND band_val IN (SELECT value FROM json_each(?))
  `)
  // band_luma 覆盖索引 (profile, mean, fp_id, frame_no)；mean±madMax 是 MAD 的必要下界。
  const stmtLumaQuery = db.prepare(`
    SELECT DISTINCT fp_id FROM band_luma
    WHERE profile = ? AND mean BETWEEN ? AND ?
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
    /**
     * 按稳定 fp_id 批量取指定文件的元数据与 intro BLOB。
     * 只用于指定文件查重：倒排索引先给 fp_id，再按 fp_id 反查路径/时长/帧。
     * @param {number[]} fpIds
     * @param {string} profile
     * @returns {Map<number, object>}
     */
    getRowsByFpIds(fpIds, profile) {
      const map = new Map()
      if (!fpIds || !fpIds.length) return map
      for (let i = 0; i < fpIds.length; i += 400) {
        const chunk = fpIds.slice(i, i + 400)
        const marks = new Array(chunk.length).fill('?').join(',')
        const stmt = db.prepare(
          `SELECT rowid AS fp_id, path, size, duration_ms, intro_blob, intro_n
           FROM fingerprints WHERE profile = ? AND rowid IN (${marks})`,
        )
        for (const row of stmt.all(profile, ...chunk)) map.set(Number(row.fp_id), row)
      }
      return map
    },
    /** 强制清空所有 profile 的指纹记录和两类倒排索引。只清数据库，不动任何文件。 */
    clearAll() {
      let deleted = 0
      runTx(() => {
        db.exec('DELETE FROM band_luma')
        db.exec('DELETE FROM band_dhash')
        const r = db.prepare('DELETE FROM fingerprints').run()
        deleted = Number(r.changes) || 0
      })
      return deleted
    },
    /** 查某个指纹行的稳定 fp_id（fingerprints.rowid）。 */
    findFpId(key, profile) {
      const r = stmtFpId.get(key, profile)
      return r ? Number(r.fp_id) : 0
    },
    /**
     * 批量重建若干视频的倒排索引。
     * rows: { profile, fpId, luma:number[], bands:{bandNo,bandVal}[] }
     * luma 按 frame_no 顺序存；bands 只存非纯色帧的 dHash 8bit band。
     */
    addIndex(rows) {
      if (!rows || !rows.length) return
      const insertLuma = (profile, fpId, luma) => {
        for (let off = 0; off < luma.length; off += 400) {
          const chunk = luma.slice(off, off + 400)
          const values = []
          for (let i = 0; i < chunk.length; i += 1) values.push(profile, fpId, off + i, chunk[i])
          insertStmt('band_luma', 4, chunk.length).run(...values)
        }
      }
      const insertBands = (profile, fpId, bands) => {
        for (let off = 0; off < bands.length; off += 400) {
          const chunk = bands.slice(off, off + 400)
          const values = []
          for (const b of chunk) values.push(profile, fpId, b.bandNo, b.bandVal)
          insertStmt('band_dhash', 4, chunk.length).run(...values)
        }
      }
      runTx(() => {
        for (const r of rows) {
          if (!r || !r.fpId) continue
          stmtBandDeleteFp.run(r.profile, r.fpId)
          stmtLumaDeleteFp.run(r.profile, r.fpId)
          if (Array.isArray(r.luma) && r.luma.length) insertLuma(r.profile, r.fpId, r.luma)
          if (Array.isArray(r.bands) && r.bands.length) insertBands(r.profile, r.fpId, r.bands)
        }
      })
    },
    /**
     * 按 8 个 band 查持久缓存候选 fp_id。
     * valuesByBand[b] 是当前视频在 band b 上出现过的所有 8bit 值（已去重）。
     * 返回共享至少 minBands 个 band 的 fp_id（不含 selfFpId）。
     */
    bandCandidates(profile, valuesByBand, minBands, selfFpId) {
      const mask = new Map()
      for (let b = 0; b < 8; b += 1) {
        const values = valuesByBand[b] || []
        if (!values.length) continue
        for (const row of stmtBandQuery.all(profile, b, JSON.stringify(values))) {
          const id = Number(row.fp_id)
          if (!Number.isInteger(id) || id === selfFpId) continue
          mask.set(id, (mask.get(id) || 0) | (1 << b))
        }
      }
      const floor = Math.max(1, Math.min(8, Math.round(Number(minBands) || 1)))
      const out = []
      for (const [id, bits] of mask) if (popcount8(bits) >= floor) out.push(id)
      return out
    },
    /**
     * 按单帧灰度均值召回 MAD 候选。
     * 返回 mean ∈ [mean-tolerance, mean+tolerance] 的 fp_id；这是 MAD≤tolerance 的必要下界。
     */
    lumaCandidates(profile, mean, tolerance, selfFpId) {
      const m = Number(mean)
      const t = Math.max(0, Number(tolerance) || 0)
      if (!Number.isFinite(m)) return []
      const out = []
      for (const row of stmtLumaQuery.all(profile, m - t, m + t)) {
        const id = Number(row.fp_id)
        if (Number.isInteger(id) && id !== selfFpId) out.push(id)
      }
      return out
    },
    bandStats(profile) {
      const r = stmtBandStats.get(profile)
      return { rows: Number(r && r.rows) || 0 }
    },
    lumaStats(profile) {
      const r = stmtLumaStats.get(profile)
      return { rows: Number(r && r.rows) || 0 }
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
          // 指纹 BLOB 变了，旧倒排立即失效；扫描结束会按新帧重建。
          const fpId = stmtFpId.get(r.pathKey, r.profile)
          if (fpId) {
            stmtBandDeleteFp.run(r.profile, Number(fpId.fp_id))
            stmtLumaDeleteFp.run(r.profile, Number(fpId.fp_id))
          }
        }
      })
    },
    remove(keys, profile) {
      if (!keys || !keys.length) return
      runTx(() => {
        for (const k of keys) {
          const fpId = stmtFpId.get(k, profile)
          if (fpId) {
            stmtBandDeleteFp.run(profile, Number(fpId.fp_id))
            stmtLumaDeleteFp.run(profile, Number(fpId.fp_id))
          }
          stmtRemove.run(k, profile)
        }
      })
    },
    removeByDirExcept(key, profile, keepKeys) {
      const rows = db.prepare(`
        SELECT rowid AS fp_id, path_key FROM fingerprints
        WHERE dir_key = ? AND profile = ? AND path_key NOT IN (SELECT value FROM json_each(?))
      `).all(key, profile, JSON.stringify([...keepKeys]))
      runTx(() => {
        for (const r of rows) {
          stmtBandDeleteFp.run(profile, Number(r.fp_id))
          stmtLumaDeleteFp.run(profile, Number(r.fp_id))
          stmtRemove.run(r.path_key, profile)
        }
      })
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
          // 不误删目标文件另一算法/参数的记录；旧记录对应的倒排也要一起删。
          for (const r of stmtPathRows.all(toKey)) {
            stmtBandDeleteFp.run(r.profile, Number(r.fp_id))
            stmtLumaDeleteFp.run(r.profile, Number(r.fp_id))
          }
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
              stmtBandDeleteFp.run(row.profile, Number(row.rowid))
              stmtLumaDeleteFp.run(row.profile, Number(row.rowid))
              stmtRemove.run(row.path_key, row.profile); deleted += 1
            }
          } catch (e) {
            if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
              stmtBandDeleteFp.run(row.profile, Number(row.rowid))
              stmtLumaDeleteFp.run(row.profile, Number(row.rowid))
              stmtRemove.run(row.path_key, row.profile); deleted += 1
            } else errors += 1
          }
        }
      }
      skippedDirs = skipped.size
      // 旧版本可能在删 fingerprints 时留下孤儿倒排（尤其是先删主表、后删索引的路径）。
      // 这些行的 fp_id 会被 SQLite rowid 复用，必须清掉，否则新视频会凭空继承旧候选。
      const orphanLuma = Number(stmtPurgeLumaOrphans.run().changes) || 0
      const orphanBands = Number(stmtPurgeBandOrphans.run().changes) || 0
      return { scanned, deleted, skippedDirs, errors, orphanLuma, orphanBands }
    },
    stats() {
      const r = stmtStats.get()
      const b = stmtBandStatsAll.get()
      const l = stmtLumaStatsAll.get()
      return {
        rows: Number(r.rows) || 0,
        bytes: Number(r.bytes) || 0,
        bandRows: Number(b && b.rows) || 0,
        lumaRows: Number(l && l.rows) || 0,
        dbPath,
      }
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
