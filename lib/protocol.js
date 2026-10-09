/**
 * lib/protocol.js —— 探针日志的行协议（**唯一真相**）。
 *
 * 设计约束（改动前先读 DESIGN.md §7.2）：
 *   · 一行一条 JSON 记录（JSONL，UTF-8，`\n` 结束）。追加写，永不改写历史行。
 *   · 字段名与语义冻结；新增字段只能是**可选**字段，且必须同步
 *     assets/probe.template.mjs 与 assets/AGENT-PROBE-GUIDE.md。
 *   · 运行时桩（probe.mjs）与本模块**不得相互 import**：桩会被复制到被调试的
 *     项目里并原样执行，必须能独立运行、零依赖。协议因此在这里重复实现一次，
 *     两处由 test/protocol.test.mjs 对账。
 */

/** 日志目录（相对被调试仓库根）/ 文件名的固定形状。 */
export const LOG_ROOT = '.dsh/debug-mode'
export const LOG_FILE_EXT = '.log'

/** 单条记录的字段顺序（序列化时按此顺序，方便人眼 grep）。 */
export const RECORD_FIELDS = Object.freeze(['ts', 'task', 'probe', 'level', 'msg', 'data'])

/**
 * @typedef {object} ProbeRecord
 * @property {string} ts     ISO-8601（毫秒精度，本地时区偏移），由写入端生成。
 * @property {string} [task] 任务哈希（8 位十六进制）；桩里已烘死，故可省略。
 * @property {string} probe  探针标识：`<文件相对路径>:<行号>:<短标签>` 或自由标签。
 * @property {'trace'|'debug'|'info'|'warn'|'error'} [level='info']
 * @property {string} [msg]  人类可读描述。
 * @property {unknown} [data] 任意可 JSON 序列化的负载（对象优先）。
 *//**
 * 本地时间 ISO-8601（毫秒精度、带时区偏移）。
 * 与探针桩里的 `stamp()` 必须逐字一致——两处实现由 test/protocol.test.mjs 对账。
 * @param {Date} [now]
 */
export function stamp(now = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `.${pad(now.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * 把一条记录序列化成一行 JSONL。保证：无换行、字段序稳定、循环引用不抛。
 *
 * 与探针桩的行为一致：`ts` 缺失时**由本函数补**（写入端负责时间）；
 * `probe` 仍然必填——没有 probe 的行在协议里不可解析，宁可在这里抛错，
 * 也不要写出一条读端永远看不见的日志。
 * @param {Partial<ProbeRecord> & { probe?: string }} record
 * @returns {string} 以 `\n` 结尾的一行
 */
export function formatRecord(record) {
  if (!record || typeof record.probe !== 'string' || !record.probe) {
    throw new Error('debug-mode: probe record requires a non-empty `probe`')
  }
  const out = {}
  for (const field of RECORD_FIELDS) {
    if (field === 'ts' && record.ts === undefined) {
      out.ts = stamp()
      continue
    }
    const value = record[field]
    if (value === undefined) continue
    out[field] = field === 'data' ? safe(value) : value
  }
  return `${JSON.stringify(out)}\n`
}

/** 解析一行；不是合法探针记录时返回 null（读端必须容忍脏行）。 */
export function parseRecord(line) {
  const trimmed = String(line).trim()
  if (!trimmed.startsWith('{')) return null
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const probe = typeof parsed.probe === 'string' ? parsed.probe : null
  if (!probe) return null
  return {
    ts: typeof parsed.ts === 'string' ? parsed.ts : '',
    task: typeof parsed.task === 'string' ? parsed.task : '',
    probe,
    level: typeof parsed.level === 'string' ? parsed.level : 'info',
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: 'data' in parsed ? parsed.data : undefined,
  }
}

/** 解析整段日志文本；返回 { records, dirtyLines }（脏行计数用于向 Agent 报告）。 */
export function parseLog(text) {
  const records = []
  let dirtyLines = 0
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    const record = parseRecord(line)
    if (record) records.push(record)
    else dirtyLines += 1
  }
  return { records, dirtyLines }
}

/** JSON 安全化：循环引用、BigInt、Error、函数都不许让写入抛异常。 */
function safe(value, seen = new WeakSet()) {
  try {
    if (value === null || value === undefined) return value
    const type = typeof value
    if (type === 'bigint') return `${value.toString()}n`
    if (type === 'function' || type === 'symbol') return `[${type}]`
    if (type !== 'object') return value
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack }
    }
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map((item) => safe(item, seen))
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = safe(item, seen)
    return out
  } catch {
    return '[unserializable]'
  }
}
