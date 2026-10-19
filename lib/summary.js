/**
 * 把日志文本渲染成摘要优先的正文。
 *
 * 输出形状是契约，因此实现为纯函数并由测试钉住：
 *   1. warn/error 全量列举，不受 `limit` 影响；
 *   2. 先给按 probe 的分组计数——计数为 0 的路径往往比日志内容更有信息量；
 *   3. 省略量必须显式写出，不静默截断；
 *   4. 空日志区分「不存在 / 存在但为空 / 有脏行但无合法记录」，并给出排查建议。
 */

import { parseLog } from './protocol.js'

/** 分组计数展示的上限；超出的组只报数量，不逐个列出。 */
const TOP_N = 8

/** 单条记录渲染成一行（时间序部分用）。 */
function renderRecord(record) {
  const parts = [`[${record.level}]`, record.probe]
  // [!] 两种"看不见完整值"必须长得**不一样**：
  //   · `[!]截断` = **宿主/桩真的把它省略了**（记录里带 `truncated:true`，不可恢复）；
  //   · `…（显示省略 N 字符）` = 只是**这一行显示**缩短了，日志里是完整的。
  // 老实现两边都只打一个 `…`，于是一次排查整轮都在猜"到底哪个是哪个"。
  if (record.truncated === true) parts.push('[!]截断')
  if (record.msg) parts.push(record.msg)
  if (record.data !== undefined) {
    let data
    try {
      data = JSON.stringify(record.data)
    } catch {
      data = '[unserializable]'
    }
    if (data && data.length > 240) data = `${data.slice(0, 240)}…（显示省略 ${data.length - 240} 字符，日志里是完整的）`
    parts.push(data)
  }
  return parts.join('  ')
}

/** 人类可读的字节数。 */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 从 ISO-8601（带偏移）求时间跨度；解析不出来就返回 null。 */
function spanSeconds(records) {
  if (records.length < 2) return null
  const first = Date.parse(records[0].ts)
  const last = Date.parse(records[records.length - 1].ts)
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null
  return Math.max(0, (last - first) / 1000)
}

/**
 * 渲染 `dsh_debug_read` 的返回正文。
 *
 * @param {object} input
 * @param {string} input.hash
 * @param {number} input.round
 * @param {boolean} input.exists 日志文件是否存在
 * @param {string} [input.text] 文件内容（不存在时省略）
 * @param {number} [input.bytes] 文件字节数
 * @param {number} [input.limit] 时间序最多给多少条
 * @param {'trace'|'debug'|'info'|'warn'|'error'} [input.level] 只看某一级别
 * @param {string} [input.probe] 只看某个探针（前缀匹配）
 * @param {boolean} [input.truncated] 读取时被宿主截断
 * @param {Array<{probe: string, why?: string}>} [input.declared] Agent 自报的探针清单，
 *   用于给「计数为 0」的探针点名
 * @returns {string}
 */
export function renderLogSummary(input) {
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : 200
  const header = `调试日志 · 任务 ${input.hash} · 第 ${input.round} 轮`

  if (!input.exists) {
    return [
      `${header} · 日志文件不存在`,
      '',
      '也就是说：探针一次都没有写成功。按顺序排查这三点——',
      '1. 探针桩路径对不对（业务代码 import 的是任务目录里的 runtime/probe.mjs 绝对路径）；',
      '2. 被调试的进程**真的走到**了那行代码，而且是以本次任务的桩启动的（不是旧的构建产物）；',
      '3. 进程对**任务产物目录**（指南里给出的那个绝对路径，默认在用户临时目录里）有写权限——沙箱只读、或系统刚清理过临时目录时，写入会安静失败（桩按设计不抛异常）。',
    ].join('\n')
  }

  const { records, dirtyLines } = parseLog(input.text ?? '')
  const dirtyDetail = dirtyLines > 0 ? firstDirtyLine(input.text ?? '') : null

  if (records.length === 0 && dirtyLines > 0) {
    return [
      `${header} · 有 ${dirtyLines} 行内容，但没有一行符合协议`,
      '',
      `第一条脏行原文：${dirtyDetail}`,
      '',
      '这几乎总是"桩写错了协议"：字段序必须与 lib/protocol.js 一致，且 `probe` 必填非空。',
      '要么改桩，要么让 Agent 说明它自写的桩长什么样。',
    ].join('\n')
  }

  if (records.length === 0) {
    return [
      `${header} · 日志存在但为空`,
      '',
      '说明探针桩建好了，但没有一条探针被执行到。最可能的原因——',
      '1. 走到的分支不是被埋点的分支（这时应该补埋点，而不是继续读）；',
      '2. 被调试的进程还没重启（旧进程里没有探针）；',
      '3. 探针被放进了不会执行的路径（例如被缓存短路的代码之后）。',
    ].join('\n')
  }

  /** 先按 probe 过滤，再按 level 过滤；warn/error 的全量列举基于这之后的结果。 */
  let selected = records
  if (input.probe) {
    const needle = String(input.probe)
    selected = selected.filter((record) => record.probe.startsWith(needle) || record.probe.includes(needle))
  }
  if (input.level) selected = selected.filter((record) => record.level === input.level)

  const counts = new Map()
  for (const record of selected) counts.set(record.probe, (counts.get(record.probe) ?? 0) + 1)
  const grouped = [...counts.entries()].sort((left, right) => right[1] - left[1])
  const span = spanSeconds(selected)

  const lines = []
  lines.push([
    header,
    `${records.length} 行 / ${humanBytes(input.bytes ?? (input.text ?? '').length)}`,
    span === null ? null : `时间跨度 ${span.toFixed(1)}s`,
    `脏行 ${dirtyLines}`,
    input.truncated ? '[!] 读取被截断（文件超出宿主上限）' : null,
  ].filter(Boolean).join(' · '))

  const filtered = selected.length !== records.length
  if (filtered) {
    lines.push(`已按 ${input.level ? `level=${input.level}` : ''}${input.level && input.probe ? ' + ' : ''}`
      + `${input.probe ? `probe≈${input.probe}` : ''} 收窄到 ${selected.length} 行`)
  }

  lines.push('', `按探针分组（Top ${TOP_N}）：`)
  if (grouped.length === 0) {
    lines.push('  （收窄后没有任何记录——放宽条件再读一次）')
  } else {
    for (const [probe, count] of grouped.slice(0, TOP_N)) lines.push(`  ${count}  ${probe}`)
    if (grouped.length > TOP_N) lines.push(`  …另有 ${grouped.length - TOP_N} 组未列出`)
  }

  // 计数为 0 的探针 = 该路径没走到。这是整份摘要里最贵的一条信号（准则）。
  const declared = Array.isArray(input.declared) ? input.declared : []
  const missed = declared.filter((entry) => entry?.probe && !counts.has(String(entry.probe)))
  if (missed.length > 0) {
    lines.push('', `声明过但没有命中的探针（计数 0，通常最有价值）：`)
    for (const entry of missed.slice(0, TOP_N)) {
      lines.push(`  0  ${entry.probe}${entry.why ? `  —— ${entry.why}` : ''}`)
    }
  }

  const alarms = selected.filter((record) => record.level === 'warn' || record.level === 'error')
  lines.push('', `异常与警告（全部 ${alarms.length} 条，不受 limit 影响）：`)
  if (alarms.length === 0) lines.push('  （无）')
  else for (const record of alarms) lines.push(`  ${record.ts}  ${renderRecord(record)}`)

  const tail = selected.slice(-limit)
  const omitted = selected.length - tail.length
  lines.push('', omitted > 0
    ? `时间序（最近 ${tail.length} 条，已省略 ${omitted} 条；用 level/probe 参数收窄）：`
    : `时间序（全部 ${tail.length} 条）：`)
  for (const record of tail) lines.push(`  ${record.ts}  ${renderRecord(record)}`)

  return lines.join('\n')
}

/** 取第一条脏行原文（便于一眼看出协议写错在哪）。 */
function firstDirtyLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object' && typeof parsed.probe === 'string' && parsed.probe) continue
      } catch {
        // 落到下面当脏行
      }
    }
    return line.length > 200 ? `${line.slice(0, 200)}…` : line
  }
  return '(无法定位)'
}
