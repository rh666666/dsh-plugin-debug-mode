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
const FIELDS = ['ts', 'task', 'probe', 'level', 'msg', 'data']
const MAX_LINE = 8 * 1024
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
    let line = serialize(record)
    if (line.length > MAX_LINE) {
      line = `${line.slice(0, MAX_LINE - 32)}…","truncated":true}\n`
    }
    appendFileSync(LOG, line)
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

export default probe
