/**
 * sidecar worker：把重扫描跑在独立 Node 进程里。
 *
 * 为什么要有它：抓帧、LSH 候选对、LCS 校验会占几百 MB 到 1 GB，
 * 和 DSH host 同进程时一旦失控会把整个界面拖死。worker 崩了/超限了，
 * 父进程只收到“任务失败”，DSH 本身不受影响。
 *
 * 协议（stdin/stdout 各一行 JSON）：
 *   父 -> 子：{ task: 'video' | 'videoIntro', cfg: {...} }
 *   子 -> 父：{ type: 'progress', phase, done, total, rss, log }
 *             { type: 'done', result, log, phase }
 *             { type: 'error', error }
 */
import { videoScan, videoIntroScan } from './index.js'

const taskName = process.argv[2]
const mode = process.env.DFC_WORKER_TEST_MODE || ''

function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch { /* 父进程已退出 */ }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { buf += d })
    process.stdin.on('end', () => resolve(buf))
    // 父进程通过 stdin 发一行就关闭；某些平台不会触发 end，给一个短兜底
    setTimeout(() => resolve(buf), 5000).unref?.()
  })
}

const payload = JSON.parse((await readStdin()) || '{}')
const cfg = payload.cfg || {}
const task = {
  running: true,
  phase: '准备中',
  done: 0,
  total: 0,
  startedAt: Date.now(),
  finishedAt: 0,
  error: '',
  log: [],
  result: null,
}

// 测试钩子：只用于回归插件验证“崩溃/超内存/可停止”，正常扫描不会设置。
if (mode === 'crash') {
  process.stderr.write('worker test crash\n')
  process.exit(42)
}
if (mode === 'oom') {
  // 故意把 RSS 顶上去；父进程按 DFC_WORKER_MEM_MB 监控并杀进程。
  const hog = []
  for (;;) {
    hog.push(Buffer.alloc(8 * 1024 * 1024, 1))
    send({ type: 'progress', phase: 'oom-test', done: 0, total: 0, rss: process.memoryUsage().rss, log: task.log.slice(-20) })
    await new Promise((ok) => setTimeout(ok, 20))
  }
}

let lastLog = null
const timer = setInterval(() => {
  const log = task.log.slice(-40)
  // 只比长度会在日志达到 300 行后永远相等；必须比内容，父进程才能持续拿到新行。
  const logText = log.join('\n')
  send({
    type: 'progress',
    phase: task.phase,
    done: task.done,
    total: task.total,
    rss: process.memoryUsage().rss,
    // 总行号用于父进程按绝对位置去重；只发最近 40 行，避免重复传输整段日志。
    logTotal: task.log.length,
    log: logText !== lastLog ? log : undefined,
  })
  lastLog = logText
}, 250)

try {
  if (mode === 'slow') await new Promise((ok) => setTimeout(ok, 10000))
  if (taskName === 'video') await videoScan(task, cfg)
  else if (taskName === 'videoIntro') await videoIntroScan(task, cfg)
  else throw new Error(`unknown worker task: ${taskName}`)
  clearInterval(timer)
  const payload = JSON.stringify({
    type: 'done',
    result: task.result,
    log: task.log.slice(-300),
    logTotal: task.log.length,
    phase: '完成',
    done: task.done,
    total: task.total,
    rss: process.memoryUsage().rss,
  }) + '\n'
  // 等 stdout 真正写完再退出；大结果直接用 process.exit 可能被截断。
  process.stdout.write(payload, () => process.exit(0))
} catch (e) {
  clearInterval(timer)
  const payload = JSON.stringify({ type: 'error', error: String(e?.stack || e?.message || e) }) + '\n'
  process.stdout.write(payload, () => process.exit(1))
}
