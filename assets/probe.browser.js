/**
 * assets/probe.browser.js —— 「浏览器 / 无法写文件的运行时」探针模板（零依赖、经典脚本）。
 *
 * 为什么需要第二个桩：Node 桩靠 `node:fs` 直接追加写日志，而浏览器里的页面
 * （尤其是 `file://` 打开的静态页）**既不能 import 那个模块，也没有文件系统**。
 * 过去唯一的出路是"起个本地服务器把页面伺服出来"——那要跑命令，而调试模式
 * 本来就不该需要任何命令（DESIGN.md §3.10）。所以宿主自己开一条**只追加写**的
 * 摄入端点（`POST <端点>`），页面把记录按同一行协议 POST 过去。
 *
 * 协议完全相同（DESIGN.md §7.2）：一行一个 JSON 对象，字段序
 * `ts, task, probe, level, msg, data`。宿主端用 `lib/protocol.js` 的 `formatRecord`
 * 重新序列化落盘，所以**这里只是传输，不是协议的第二个真相**。
 *
 * 用法（生成到 `<任务目录>/runtime/probe.browser.js` 后）：
 *   ```html
 *   <script src=".dsh/debug-mode/tasks/<hash>/runtime/probe.browser.js"></script>
 *   <script> dshProbe('app.js:12:click', { itm }) </script>
 *   ```
 * 经典脚本（不是 module）——`file://` 源下浏览器会按 CORS 拦掉 module 与 fetch 本地文件，
 * 但同源的经典 `<script src>` 不受影响。若页面有 CSP 挡了它，就把本文件内容整段
 * 粘进一个探针块里。
 *
 * 硬约束（与 Node 桩同源）：
 *   · **永不抛异常**：可观测性代码不许把被调试的页面搞挂。
 *   · 单行 ≤ 8 KiB，超长截断并标 `truncated`。
 *   · 批量发送（默认 200ms 或攒够 32 条），并在页面卸载时冲刷一次——
 *     否则"用户复现完就关页面"会把现场一起带走。
 *   · 请求是 CORS 简单请求（`text/plain`），不需要预检；响应内容一律不看。
 */

;(function (global) {
  'use strict'

  // ── 由宿主在生成时替换（保持本行格式，替换脚本按前缀匹配）────────────────────
  var TASK = '__DSH_TASK__'
  var ENDPOINT = '__DSH_ENDPOINT__'
  // ─────────────────────────────────────────────────────────────────────────────

  /** 单条记录的字段顺序，必须与 lib/protocol.js 的 RECORD_FIELDS 一致。 */
  var FIELDS = ['ts', 'task', 'probe', 'level', 'msg', 'data']
  var MAX_LINE = 8 * 1024
  var FLUSH_MS = 200
  var MAX_BATCH = 32
  var LEVELS = { trace: 1, debug: 1, info: 1, warn: 1, error: 1 }

  var queue = []
  var timer = null
  var writes = 0

  function stamp() {
    var now = new Date()
    var pad = function (n, w) {
      var text = String(n)
      while (text.length < (w || 2)) text = '0' + text
      return text
    }
    var offsetMin = -now.getTimezoneOffset()
    var sign = offsetMin >= 0 ? '+' : '-'
    var abs = Math.abs(offsetMin)
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds())
      + '.' + pad(now.getMilliseconds(), 3) + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
  }

  function safe(value, seen) {
    try {
      if (value === null || value === undefined) return value
      var type = typeof value
      if (type === 'number') return isFinite(value) ? value : String(value)
      if (type === 'bigint') return value.toString() + 'n'
      if (type === 'function' || type === 'symbol') return '[' + type + ']'
      if (type !== 'object') return value
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
      var bag = seen || []
      for (var i = 0; i < bag.length; i += 1) if (bag[i] === value) return '[circular]'
      bag.push(value)
      if (Object.prototype.toString.call(value) === '[object Array]') {
        var list = []
        for (var j = 0; j < value.length; j += 1) list.push(safe(value[j], bag))
        return list
      }
      // DOM 节点之类的东西没有可序列化的自有属性，降级成一小段描述而不是空对象。
      if (typeof Node !== 'undefined' && value instanceof Node) {
        return { node: value.nodeName, id: value.id || undefined, cls: value.className || undefined }
      }
      var out = {}
      var keys = Object.keys(value)
      for (var k = 0; k < keys.length; k += 1) out[keys[k]] = safe(value[keys[k]], bag)
      return out
    } catch (error) {
      return '[unserializable]'
    }
  }

  /** 按 FIELDS 顺序拼一行 —— 与 Node 桩、以及 lib/protocol.js 的字段序一致。 */
  function serialize(record) {
    var line = ''
    for (var i = 0; i < FIELDS.length; i += 1) {
      var field = FIELDS[i]
      if (record[field] === undefined) continue
      var encoded
      try {
        encoded = JSON.stringify(record[field])
      } catch (error) {
        encoded = JSON.stringify('[unserializable]')
      }
      if (encoded === undefined) continue
      line += (line ? ',' : '{') + JSON.stringify(field) + ':' + encoded
    }
    return line + '}\n'
  }

  /** 把队列发出去。失败就丢弃这一批——探针不许拖慢页面，也不许无限堆积。 */
  function flush() {
    if (timer !== null) {
      try { clearTimeout(timer) } catch (error) { /* ignore */ }
      timer = null
    }
    if (queue.length === 0) return
    var payload = queue.join('')
    queue = []
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        && typeof Blob !== 'undefined') {
        var blob = new Blob([payload], { type: 'text/plain;charset=utf-8' })
        if (navigator.sendBeacon(ENDPOINT, blob)) return
      }
    } catch (error) {
      // 落到 fetch
    }
    try {
      if (typeof fetch === 'function') {
        // `text/plain` 是 CORS 安全列表里的值 ⇒ 不触发预检；`no-cors` 让响应不可读
        // （我们也不需要读，记录以到达为准）。
        fetch(ENDPOINT, {
          method: 'POST',
          body: payload,
          keepalive: true,
          mode: 'no-cors',
          headers: { 'content-type': 'text/plain;charset=utf-8' },
        })
      }
    } catch (error) {
      // 安静降级
    }
  }

  function schedule() {
    if (queue.length >= MAX_BATCH) {
      flush()
      return
    }
    if (timer !== null) return
    try {
      timer = setTimeout(flush, FLUSH_MS)
    } catch (error) {
      timer = null
      flush()
    }
  }

  /**
   * 记一条探针。
   * @param {string} probe 探针标识，推荐 `<页面相对路径>:<行号>:<短标签>`
   * @param {*} [data] 负载；别 dump 整个 DOM，挑字段
   * @param {{ level?: string, msg?: string }} [options]
   */
  function probe(probe, data, options) {
    try {
      var opts = options || {}
      var level = LEVELS[opts.level] ? opts.level : 'info'
      var record = { ts: stamp(), task: TASK, probe: String(probe), level: level }
      if (opts.msg) record.msg = String(opts.msg)
      if (data !== undefined) record.data = safe(data)
      var line = serialize(record)
      if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE - 32) + '\u2026","truncated":true}\n'
      queue.push(line)
      writes += 1
      schedule()
    } catch (error) {
      // 安静降级：探针不许影响被调试的页面。
    }
  }

  probe.trace = function (id, data, options) { probe(id, data, mergeLevel(options, 'trace')) }
  probe.debug = function (id, data, options) { probe(id, data, mergeLevel(options, 'debug')) }
  probe.warn = function (id, data, options) { probe(id, data, mergeLevel(options, 'warn')) }
  probe.error = function (id, data, options) { probe(id, data, mergeLevel(options, 'error')) }
  /** 立刻冲刷队列（在会跳转/关闭页面的关键路径上手调一次）。 */
  probe.flush = flush
  /** 诊断用：本页面已生成的记录数（不是"已送达"数——投递是尽力而为）。 */
  probe.stats = function () { return { task: TASK, endpoint: ENDPOINT, writes: writes, pending: queue.length } }

  function mergeLevel(options, level) {
    var merged = {}
    if (options) for (var key in options) if (Object.prototype.hasOwnProperty.call(options, key)) merged[key] = options[key]
    merged.level = level
    return merged
  }

  try {
    global.dshProbe = probe
    if (typeof global.addEventListener === 'function') {
      // 用户"复现完就关页面"是最常见的一刻：不在这里冲刷，最后几百毫秒的现场就没了。
      global.addEventListener('pagehide', flush, false)
      global.addEventListener('beforeunload', flush, false)
      if (typeof global.document !== 'undefined' && global.document.addEventListener) {
        global.document.addEventListener('visibilitychange', function () {
          if (global.document.visibilityState === 'hidden') flush()
        }, false)
      }
    }
  } catch (error) {
    // 安静降级
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
