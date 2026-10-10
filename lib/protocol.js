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
export const RECORD_FIELDS = Object.freeze(['ts', 'task', 'probe', 'level', 'msg', 'data', 'truncated'])

/**
 * 单行记录的字节上限（§11.2）。**冻结**：三处实现（本模块 / Node 桩 / 浏览器桩）必须一致。
 *
 * ── 触发线**与结果**（两件事，都要知道）────────────────────────────────────
 *   · **触发线**：序列化后的**整行**超过本值（含 `ts`/`task`/`probe` 等字段的开销，
 *     所以一个"看起来 8000 字符"的值可能刚好没事，8200 就会触发）。
 *   · **结果**：超长值被裁到**刚好放得下**为止（二分找最大的能放下的 clip 长度），
 *     记录通常**贴近但绝不越过**本上限——**不是**固定裁到某个长度。
 *     v0.17 及以前用固定档位（先试 2048），一个 10 KB 的值只留下 2061 字符、
 *     整行只有 2153 字节，**白白扔掉四分之三的额度**；v0.18 改成把预算用足
 *     （实测：10000 字符的 msg → 整行 8192 字节、值保留 8100 字符）。
 *   · 被裁过的记录一定带 `truncated: true`，且**值里写明省略了多少**
 *     （`…<省略 N 字符>` / `…<省略 N 项>` / `…<省略 N 个键>`）。
 *   · **字符串长度**受字节预算约束（裁到刚好放得下）；**键/项数量**另有一个固定上限
 *     （`DEGRADE_MAX_ITEMS`）——两者独立。所以一条"4000 个小键"的记录只有几百字节：
 *     它是被**数量**截断的，与字节预算无关（值里会写 `…<省略 3950 个键>`）。
 */
export const MAX_RECORD_BYTES = 8 * 1024

/**
 * 单行超限时的降级档位：逐步收紧"单个字符串值允许保留多少字符"。
 *
 * 设计意图见 `encodeRecord()`——**绝不切已经序列化好的整行**。
 */
export const DEGRADE_STEPS = Object.freeze([2048, 512, 128, 16, 0])
/** 降级时每个对象/数组最多保留多少个键/项（防止"一万个小键"绕过字符串档位）。 */
export const DEGRADE_MAX_ITEMS = 50
/** 降级时最多下探多少层。 */
export const DEGRADE_MAX_DEPTH = 6

/**
 * UTF-8 字节数（不依赖 Buffer / TextEncoder，三处实现可以逐字相同）。
 * @param {string} text
 */
export function byteLength(text) {
  const value = String(text)
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对 = 一个 4 字节字符；下一半必须一起吃掉，否则会多算 3 字节。
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

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
 * @param {number} [maxBytes] 单行上限；默认 `MAX_RECORD_BYTES`
 * @returns {string} 以 `\n` 结尾的一行
 */
export function formatRecord(record, maxBytes = MAX_RECORD_BYTES) {
  return encodeRecord(record, maxBytes).line
}

/**
 * 序列化 + **超限降级**，返回 `{ line, truncated, degraded }`。
 *
 * ⚠️ 这里是本插件最贵的一条教训（v0.15）：**绝不能对序列化好的整行做切片**。
 * 老实现是 `line.slice(0, 8192 - 32) + '…","truncated":true}\n'`，它只在一种巧合下
 * 成立——切点刚好落在**顶层字符串字段**（如 `msg`）的值里面时，补上的 `"` 与 `}`
 * 正好把字符串和对象收尾，于是那行**能解析**。切点落在 `data` 里（嵌套对象/数组/
 * 数组元素）时，那些没被闭合的 `[`/`{` 就永远合不上了，读端只能把它算成**脏行**。
 *
 * 实测到的现象因此长这样（与嵌套深度、容器类型都无关，只与"值在不在顶层"有关）：
 *
 * ```
 * 嵌套值 7800 字符 → 可解析（没超限，压根没截断）   8200 → 脏行
 * 顶层 msg 10000 字符 → 仍然可解析（对照组：切片恰好闭合成功）
 * ```
 *
 * 正确做法（本函数）：**省略超长值 → 重新序列化 → 实测字节数 → parse 往返校验**。
 * 每一档都重新量一遍 8 KiB 预算，而不是"先切了再说"。
 *
 * @param {Partial<ProbeRecord> & { probe?: string }} record
 * @param {number} [maxBytes]
 * @returns {{ line: string, truncated: boolean, degraded: boolean }}
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

  // ① 先用固定档位快速找一个可行解，顺便记住"更大的那一档"作为二分上界。
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

  // ② **把预算用足**：在 (可行档位, 失败上界) 之间二分，找**最大的**能放下的 limit。
  //
  // 为什么值得这一步（v0.18，实测反馈）：固定档位 `2048` 只用了约**四分之一**预算——
  // 10000 字符的 msg 截断后整行只有 2153 字节，而额度是 8192；一个 10 KB 的值白白
  // 扔掉四分之三的证据。二分是**确定性**的，所以三处实现仍然逐字一致
  // （`test/protocol.test.mjs` 的逐字比对会把任何漂移打红）。
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

/** 按给定 limit 省略超长值后重新序列化 —— 超限降级的**唯一**渲染路径。 */
function renderClipped(out, limit) {
  const candidate = { ...out, truncated: true }
  // `probe` 也要参与降级：它是**分组计数的键**，砍它会把两组悄悄合并；
  // 而且砍哪都要留痕（v0.17：骨架里曾有一处裸切，砍了不说，与 v0.16 同类）。
  candidate.probe = clipValue(out.probe, limit, 0)
  if (out.msg !== undefined) candidate.msg = clipValue(out.msg, limit, 0)
  if (out.data !== undefined) candidate.data = clipValue(out.data, limit, 0)
  return `${JSON.stringify(candidate)}\n`
}

/** 一行是否既放得下、又能被读端解析（parse 往返校验，通过才允许写盘）。 */
function fitsLine(line, maxBytes) {
  return byteLength(line) <= maxBytes && parsesToRecord(line)
}

/** 最后手段：骨架。它一定合法，而且仍然是一条能读到的记录（而不是一条脏行）。 */
function skeletonLine(out, full) {
  return `${JSON.stringify({
    ts: out.ts,
    ...(out.task === undefined ? {} : { task: out.task }),
    // 不能裸切：砍了却不说，读端就看不出这条被省略过什么（v0.17 实测踩过）。
    probe: clipValue(String(out.probe), 200, 0),
    level: out.level ?? 'info',
    truncated: true,
    msg: `记录超过单行上限（${byteLength(full)} 字节），已降级为骨架`,
  })}\n`
}

/** 递归省略超长值：**改的是值，不是已经序列化好的行**。 */
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

/** 一行是否既是合法 JSON、又满足 `probe` 必填。 */
function parsesToRecord(line) {
  try {
    const parsed = JSON.parse(line)
    return Boolean(parsed) && typeof parsed === 'object' && typeof parsed.probe === 'string' && parsed.probe !== ''
  } catch {
    return false
  }
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
    // 只在这条记录**真的被降级过**时才出现（可选字段的语义：没发生就不写）。
    // 读端要能一眼区分"**这条被截断了**"与"只是**显示**层缩短了"——
    // 这两件事长得一模一样，实测浪费过一整轮排查。
    ...(parsed.truncated === true ? { truncated: true } : {}),
    ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
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
