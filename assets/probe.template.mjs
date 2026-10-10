/**
 * assets/probe.template.mjs —— 「探针运行时」模板（零依赖、可独立运行）。
 *
 * 职责：把 Agent 埋进业务代码里的探针调用，按固定行协议（一行一条 JSON）
 * 追加写到本次调试任务的日志文件。
 *
 * 生命周期：
 *   1. `dsh_debug_start` 时，宿主把本文件复制到
 *      `<repo>/.dsh/debug-mode/tasks/<hash>/runtime/probe.mjs`，
 *      并把下方 `TASK` / `LOG` 两个常量替换成本次任务的真实值。
 *   2. Agent 在业务代码里 `import { probe } from '<repo>/.dsh/debug-mode/tasks/<hash>/runtime/probe.mjs'`
 *      然后调用它。
 *   3. `dsh_debug_end` / 用户选择「问题已解决」后，宿主连任务目录一起删除。
 *
 * 硬约束（改本文件前先读 DESIGN.md §7.4）：
 *   · 零依赖：只用 node: 内置模块，不 import 本插件的任何文件。
 *   · 永不抛异常：可观测性代码不许把被调试程序搞挂，任何失败都安静降级。
 *   · 同步追加写：崩溃前最后几条日志必须已经落盘（异步队列会吞掉现场）。
 *   · 不持有 fd：每次调用 open→write→close，保证宿主删文件后不复活它。
 *   · 单行长度上限 8 KiB，超长截断并标注 `truncated`。
 *   · 单任务日志总量上限 16 MiB（DESIGN.md §11.2）：到顶后**停止追加**并只写一条
 *     `probe: "debug-mode:overflow"`。为什么要停：一个跑飞的循环能在几分钟内把
 *     磁盘写满，而那种日志读起来也没有任何信息量——停写比写满更有用。
 */

// ── 由宿主在生成时替换（保持本行格式，替换脚本按前缀匹配）────────────────────
export const TASK = '__DSH_TASK__'
export const LOG = '__DSH_LOG__'
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** 单条记录的字段顺序，必须与 lib/protocol.js 的 RECORD_FIELDS 一致。 */
const FIELDS = ['ts', 'task', 'probe', 'level', 'msg', 'data', 'truncated']
const MAX_LINE = 8 * 1024
/**
 * 超限降级档位：逐步收紧"单个字符串值允许保留多少字符"。
 *
 * ⚠️ 与 `lib/protocol.js` 的 `DEGRADE_STEPS` / `DEGRADE_MAX_ITEMS` / `DEGRADE_MAX_DEPTH`
 * 必须**逐字一致**（`test/protocol.test.mjs` 会喂同一批负载给三处实现并比对字节）。
 * 为什么不能切序列化好的整行：那会切出半个 JSON，读端只能算脏行（见 protocol.js 的长注释）。
 */
const DEGRADE_STEPS = [2048, 512, 128, 16, 0]
const DEGRADE_MAX_ITEMS = 50
const DEGRADE_MAX_DEPTH = 6
/** 单任务日志总字节上限，与 DESIGN.md §11.2 的表格一致。 */
const MAX_BYTES = 16 * 1024 * 1024

let ready = false
let writes = 0
/** 最近一次观测到的日志字节数（只用于 stats()，写端判据一律现算）。 */
let bytes = 0
let overflowed = false

function ensureDir() {
  if (ready) return true
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    ready = true
    return true
  } catch {
    return false
  }
}

function safe(value, seen) {
  try {
    if (value === null || value === undefined) return value
    const type = typeof value
    if (type === 'bigint') return `${value.toString()}n`
    if (type === 'function' || type === 'symbol') return `[${type}]`
    if (type !== 'object') return value
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
    const bag = seen || new WeakSet()
    if (bag.has(value)) return '[circular]'
    bag.add(value)
    if (Array.isArray(value)) return value.map((item) => safe(item, bag))
    const out = {}
    for (const key of Object.keys(value)) out[key] = safe(value[key], bag)
    return out
  } catch {
    return '[unserializable]'
  }
}

function stamp() {
  const now = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `.${pad(now.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * 当前日志字节数。
 *
 * **每次都 stat，不用缓存**：宿主在 `dsh_debug_continue` 里会把日志 truncate 成 0，
 * 而探针进程可能一直活着——缓存了尺寸的话，清空之后它会以为日志还是满的，
 * 于是再也不写。一次 stat 换"清空一定生效"，这笔账很划算。
 */
function currentBytes() {
  try {
    bytes = statSync(LOG).size
  } catch {
    bytes = 0
  }
  return bytes
}

/** 按 FIELDS 顺序拼一行 —— 与 `probe()` 用同一段代码，保证字段序不会在两处漂移。 */
function serialize(record) {
  let line = ''
  for (const field of FIELDS) {
    if (record[field] === undefined) continue
    line += `${line ? ',' : '{'}${JSON.stringify(field)}:${JSON.stringify(record[field])}`
  }
  return `${line}}\n`
}

/** UTF-8 字节数（与 lib/protocol.js 的 byteLength 逐字一致；中文不能按字符数算）。 */
function byteLength(text) {
  const value = String(text)
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** 递归省略超长值（改的是值，不是已经序列化好的行）。 */
function clipValue(value, limit, depth) {
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}…<省略 ${value.length - limit} 字符>` : value
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= DEGRADE_MAX_DEPTH) return '…<层级过深>'
  if (Array.isArray(value)) {
    const kept = value.slice(0, DEGRADE_MAX_ITEMS).map((item) => clipValue(item, limit, depth + 1))
    if (value.length > DEGRADE_MAX_ITEMS) kept.push(`…<省略 ${value.length - DEGRADE_MAX_ITEMS} 项>`)
    return kept
  }
  const out = {}
  const keys = Object.keys(value)
  for (const key of keys.slice(0, DEGRADE_MAX_ITEMS)) out[key] = clipValue(value[key], limit, depth + 1)
  if (keys.length > DEGRADE_MAX_ITEMS) out['…'] = `省略 ${keys.length - DEGRADE_MAX_ITEMS} 个键`
  return out
}

/** 按给定 limit 省略超长值后重新序列化 —— 超限降级的**唯一**渲染路径。 */
function renderClipped(record, limit) {
  const candidate = { ...record, truncated: true }
  // probe 也要参与降级（它是分组计数的键，砍它会把两组悄悄合并）；且砍哪都要留痕。
  candidate.probe = clipValue(String(record.probe), limit, 0)
  if (record.msg !== undefined) candidate.msg = clipValue(record.msg, limit, 0)
  if (record.data !== undefined) candidate.data = clipValue(record.data, limit, 0)
  return serialize(candidate)
}

/** 一行是否既放得下、又能被读端解析。 */
function fitsLine(line) {
  return byteLength(line) <= MAX_LINE && parses(line)
}

/**
 * 序列化 + 超限降级：**省略超长值 → 重新序列化 → 实测字节 → parse 往返校验**。
 * 绝不切已经序列化好的整行（那会切出半个 JSON，读端只能算脏行）。
 *
 * 与 `lib/protocol.js` 的 `encodeRecord()` 必须**逐字同构**（含这里的二分上取整规则），
 * 否则 `test/protocol.test.mjs` 的三处逐字比对会红。
 */
function encode(record) {
  const full = serialize(record)
  if (byteLength(full) <= MAX_LINE) return full

  // ① 固定档位快速找可行解，并记住失败的那一档作为二分上界。
  let best = -1
  let bestLine = ''
  let upper = MAX_LINE + 1
  for (const limit of DEGRADE_STEPS) {
    const line = renderClipped(record, limit)
    if (fitsLine(line)) {
      best = limit
      bestLine = line
      break
    }
    upper = limit
  }
  if (best < 0) {
    return serialize({
      ts: record.ts,
      task: record.task,
      // 不能裸切：砍了却不说，读端就看不出这条被省略过什么（v0.17 实测踩过）。
      probe: clipValue(String(record.probe), 200, 0),
      level: record.level || 'info',
      truncated: true,
      msg: `记录超过单行上限（${byteLength(full)} 字节），已降级为骨架`,
    })
  }

  // ② 把预算用足：二分找**最大的**能放下的 limit（固定档位只用掉约四分之一预算）。
  let low = best
  let high = upper
  let line = bestLine
  while (high - low > 1) {
    const mid = (low + high) >> 1
    const candidate = renderClipped(record, mid)
    if (fitsLine(candidate)) {
      low = mid
      line = candidate
    } else {
      high = mid
    }
  }
  return line
}

/** 一行是否既是合法 JSON、又满足 probe 必填（写盘前的最后一道闸）。 */
function parses(line) {
  try {
    const parsed = JSON.parse(line)
    return Boolean(parsed) && typeof parsed === 'object' && typeof parsed.probe === 'string' && parsed.probe !== ''
  } catch {
    return false
  }
}

/**
 * 写一条探针记录。
 * @param {string} probe  探针标识，推荐 `<相对文件路径>:<行号>:<短标签>`
 * @param {unknown} [data] 负载；建议传对象而不是裸字符串
 * @param {{ level?: string, msg?: string }} [options]
 */
export function probe(probe, data, options = {}) {
  try {
    if (!ensureDir()) return
    // 到顶就停手：先写一条 overflow 说明，之后一律不写（连 overflow 也只写一次）。
    if (currentBytes() >= MAX_BYTES) {
      if (!overflowed) {
        overflowed = true
        const notice = serialize({
          ts: stamp(),
          task: TASK,
          probe: 'debug-mode:overflow',
          level: 'warn',
          msg: `日志已达 ${MAX_BYTES} 字节上限，探针停止写入；请收窄埋点或开新一轮`,
        })
        appendFileSync(LOG, notice)
        currentBytes()
      }
      return
    }
    const record = {
      ts: stamp(),
      task: TASK,
      probe: String(probe),
      level: options.level || 'info',
    }
    if (options.msg) record.msg = String(options.msg)
    if (data !== undefined) record.data = safe(data)
    appendFileSync(LOG, encode(record))
    currentBytes()
    writes += 1
  } catch {
    // 安静降级：探针不许影响被调试程序。
  }
}

/** 便捷级别糖；语义只是 level 字段，不做过滤。 */
probe.trace = (id, data, options) => probe(id, data, { ...options, level: 'trace' })
probe.debug = (id, data, options) => probe(id, data, { ...options, level: 'debug' })
probe.warn = (id, data, options) => probe(id, data, { ...options, level: 'warn' })
probe.error = (id, data, options) => probe(id, data, { ...options, level: 'error' })

/** 用 try/catch 包住一段同步逻辑，异常也留一条日志后原样抛出。 */
export function probeScope(id, fn) {
  probe(`${id}:enter`, undefined, { level: 'debug' })
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => { probe(`${id}:ok`, undefined, { level: 'debug' }); return value },
        (error) => { probe(`${id}:throw`, error, { level: 'error' }); throw error },
      )
    }
    probe(`${id}:ok`, undefined, { level: 'debug' })
    return result
  } catch (error) {
    probe(`${id}:throw`, error, { level: 'error' })
    throw error
  }
}

/** 诊断用：当前日志文件大小与本进程写入计数（Agent 可读，便于自查探针是否生效）。 */
probe.stats = () => {
  let bytes = 0
  try { bytes = statSync(LOG).size } catch { bytes = 0 }
  return { task: TASK, log: LOG, bytes, writes }
}

// ── 加载即报到 ────────────────────────────────────────────────────────────────
// 为什么要有这一条：日志为空时，"桩根本没被加载 / import 路径不对"与"桩加载了、但那段
// 代码没走到"的现象**完全一样**（都是一片空白），而这两种情况下 Agent 该做的事截然相反。
// 一条 ready 记录把它变成事实：看得到它 ⇒ 桩是通的，去查调用点；看不到它 ⇒ 去查 import。
// 写在模块加载期是有意的——那正是要被证明的那个时刻（"这段代码跑起来了吗"）。
probe('debug-mode:ready', {
  runtime: 'node',
  pid: typeof process === 'object' && process ? process.pid : null,
}, { msg: '探针桩已加载（这条由桩自己写入，用来区分"桩没加载"与"埋点没执行"）' })

export default probe
