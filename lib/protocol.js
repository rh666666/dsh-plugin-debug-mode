/**
 * 探针日志行协议（JSONL）的**唯一实现**。
 *
 * 冻结的契约（改动必须同步 `assets/probe.template.mjs` 与 `test/protocol.test.mjs`）：
 *   · 一行一条 JSON 记录，UTF-8 编码，以 `\n` 结尾；只追加，绝不改写已有行。
 *   · 字段名与顺序见 `RECORD_FIELDS`；新增字段只能是可选字段。
 *   · 本模块与运行时桩（`probe.mjs`）不得相互 import —— 桩会被复制进用户项目并独立执行，
 *     因此协议在两处各有一份实现，由 `test/protocol.test.mjs` 逐字节对账。
 */

/**
 * 日志文件扩展名。目录形状由 `lib/task.js` 决定。
 */
export const LOG_FILE_EXT = '.log'

/** 一条记录在序列化时的字段顺序。 */
export const RECORD_FIELDS = Object.freeze(['ts', 'task', 'probe', 'level', 'msg', 'data', 'truncated'])

/**
 * 单行记录的字节上限（UTF-8，含全部字段开销）。三处实现必须一致。
 *
 * 超限时不是"切掉尾巴"，而是按以下顺序降级，最终保证每行都能被解析：
 *   1. 省略超长字符串值、裁剪过大的数组/对象，再重新序列化；
 *   2. 在可行档位与失败上界之间二分，取出能放下的**最大**保留长度；
 *   3. 仍然放不下时退化为骨架行（只保留 ts/task/probe/level）。
 * 任何降级都带 `truncated: true`，且被省略的值里写明省略量。
 */
export const MAX_RECORD_BYTES = 8 * 1024

/** 降级时依次尝试的"单个字符串值可保留字符数"。 */
export const DEGRADE_STEPS = Object.freeze([2048, 512, 128, 16, 0])
/** 降级时每个对象/数组最多保留的键或项数量。 */
export const DEGRADE_MAX_ITEMS = 50
/** 降级时最多下探的对象层级。 */
export const DEGRADE_MAX_DEPTH = 6

/**
 * UTF-8 字节长度。不依赖 `Buffer` / `TextEncoder`，以便三处实现逐字相同。
 * @param {string} text
 * @returns {number}
 */
export function byteLength(text) {
  const value = String(text)
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对整体算 4 字节：跳过低位代理，否则会多算 3 字节。
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * @typedef {object} ProbeRecord
 * @property {string} ts     ISO-8601，毫秒精度，带本地时区偏移；缺省时由写入方补齐。
 * @property {string} [task] 任务哈希；桩里已烘死，故可省略。
 * @property {string} probe  探针标识：`<文件相对路径>:<行号>:<短标签>`，或自由标签。
 * @property {'trace'|'debug'|'info'|'warn'|'error'} [level='info']
 * @property {string} [msg]  人类可读描述。
 * @property {unknown} [data] 任意可 JSON 序列化的负载。
 * @property {boolean} [truncated] 由写入方设置，表示值已被省略。
 */

/**
 * 本地时间 ISO-8601（毫秒精度、带时区偏移）。与桩里的 `stamp()` 必须逐字一致。
 * @param {Date} [now]
 * @returns {string}
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
 * 把记录序列化成一行 JSONL：无内嵌换行、字段序稳定、循环引用不抛。
 *
 * @param {Partial<ProbeRecord> & { probe?: string }} record
 * @param {number} [maxBytes] 单行上限，默认 `MAX_RECORD_BYTES`
 * @returns {string} 以 `\n` 结尾的一行
 * @throws {Error} `probe` 缺失或为空时抛出——没有 probe 的行无法被读端归类。
 */
export function formatRecord(record, maxBytes = MAX_RECORD_BYTES) {
  return encodeRecord(record, maxBytes).line
}

/**
 * 序列化并在超限时降级，返回 `{ line, truncated, degraded }`。
 *
 * 降级只能作用于**值**：先省略超长内容、再重新序列化、再量字节、再做 parse 往返校验。
 * 直接对已序列化的行做切片会在对象或数组中间留下未闭合的 `[` / `{`，产生读端无法解析的行。
 *
 * @param {Partial<ProbeRecord> & { probe?: string }} record
 * @param {number} [maxBytes]
 * @returns {{ line: string, truncated: boolean, degraded: boolean }}
 * @throws {Error} `probe` 缺失或为空时抛出。
 */
export function encodeRecord(record, maxBytes = MAX_RECORD_BYTES) {
  if (!record || typeof record.probe !== 'string' || !record.probe) {
    throw new Error('debug-mode: probe record requires a non-empty `probe`')
  }
  const out = {}
  for (const field of RECORD_FIELDS) {
    if (field === 'ts' && record.ts === undefined) {
      out.ts = stamp()
      continue
    }
    if (field === 'truncated') continue
    const value = record[field]
    if (value === undefined) continue
    out[field] = field === 'data' ? safe(value) : value
  }
  const full = `${JSON.stringify(out)}\n`
  if (byteLength(full) <= maxBytes) return { line: full, truncated: false, degraded: false }

  // 先用固定档位找一个可行解，同时记下第一个失败档位作为二分上界。
  let best = null
  let upper = MAX_RECORD_BYTES + 1
  for (const limit of DEGRADE_STEPS) {
    const line = renderClipped(out, limit)
    if (fitsLine(line, maxBytes)) {
      best = { limit, line }
      break
    }
    upper = limit
  }
  if (best === null) return { line: skeletonLine(out, full), truncated: true, degraded: true }

  // 档位之间还有空隙：二分找出能放下的最大保留长度，避免浪费行预算。
  // 二分是确定性的，三处实现因此仍可逐字一致。
  let low = best.limit
  let high = upper
  let line = best.line
  while (high - low > 1) {
    const mid = (low + high) >> 1
    const candidate = renderClipped(out, mid)
    if (fitsLine(candidate, maxBytes)) {
      low = mid
      line = candidate
    } else {
      high = mid
    }
  }
  return { line, truncated: true, degraded: true }
}

/**
 * 按给定保留长度省略超长值后重新序列化。这是超限降级的唯一渲染路径。
 * @param {object} out
 * @param {number} limit
 * @returns {string}
 */
function renderClipped(out, limit) {
  const candidate = { ...out, truncated: true }
  // probe 是分组计数的键，同样参与降级，且省略必须留痕。
  candidate.probe = clipValue(out.probe, limit, 0)
  if (out.msg !== undefined) candidate.msg = clipValue(out.msg, limit, 0)
  if (out.data !== undefined) candidate.data = clipValue(out.data, limit, 0)
  return `${JSON.stringify(candidate)}\n`
}

/**
 * 判断一行是否既在上限内、又能被读端解析。
 * @param {string} line
 * @param {number} maxBytes
 * @returns {boolean}
 */
function fitsLine(line, maxBytes) {
  return byteLength(line) <= maxBytes && parsesToRecord(line)
}

/**
 * 最后手段：返回一条必定合法、且仍可读到的骨架记录。
 * @param {object} out
 * @param {string} full
 * @returns {string}
 */
function skeletonLine(out, full) {
  return `${JSON.stringify({
    ts: out.ts,
    ...(out.task === undefined ? {} : { task: out.task }),
    probe: clipValue(String(out.probe), 200, 0),
    level: out.level ?? 'info',
    truncated: true,
    msg: `记录超过单行上限（${byteLength(full)} 字节），已降级为骨架`,
  })}\n`
}

/**
 * 递归省略超长值。字符串按字符数裁剪并注明省略量；数组与对象按键/项数与层级裁剪。
 * @param {unknown} value
 * @param {number} limit
 * @param {number} depth
 * @returns {unknown}
 */
function clipValue(value, limit, depth) {
  if (typeof value === 'string') {
    return value.length > limit
      ? `${value.slice(0, limit)}…<省略 ${value.length - limit} 字符>`
      : value
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

/**
 * 一行是否既是合法 JSON、又带非空 `probe`。
 * @param {string} line
 * @returns {boolean}
 */
function parsesToRecord(line) {
  try {
    const parsed = JSON.parse(line)
    return Boolean(parsed) && typeof parsed === 'object' && typeof parsed.probe === 'string' && parsed.probe !== ''
  } catch {
    return false
  }
}

/**
 * 解析一行记录；不是合法探针记录时返回 null。
 * @param {string} line
 * @returns {ProbeRecord|null}
 */
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
    // 只有确实发生过降级的记录才带这个字段；读端据此区分"值被省略了"与"显示被缩短了"。
    ...(parsed.truncated === true ? { truncated: true } : {}),
    ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
  }
}

/**
 * 解析整段日志文本。脏行只计数、不抛出，供上层如实报告。
 * @param {string} text
 * @returns {{ records: ProbeRecord[], dirtyLines: number }}
 */
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

/**
 * 把任意值转成可 JSON 序列化的形状：循环引用、BigInt、Error、函数都不许让写入抛异常。
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
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
