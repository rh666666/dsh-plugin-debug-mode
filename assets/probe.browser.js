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
  var FIELDS = ['ts', 'task', 'probe', 'level', 'msg', 'data', 'truncated']
  var MAX_LINE = 8 * 1024
  // 超限降级档位：与 lib/protocol.js 的 DEGRADE_STEPS 必须逐字一致。
  // 绝不能切已经序列化好的整行——那是半个 JSON，读端只能算脏行。
  var DEGRADE_STEPS = [2048, 512, 128, 16, 0]
  var DEGRADE_MAX_ITEMS = 50
  var DEGRADE_MAX_DEPTH = 6
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

  /** UTF-8 字节数（与 lib/protocol.js 的 byteLength 逐字一致；中文不能按字符数算）。 */
  function byteLength(text) {
    var value = String(text)
    var bytes = 0
    for (var index = 0; index < value.length; index += 1) {
      var code = value.charCodeAt(index)
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
      return value.length > limit ? value.slice(0, limit) + '\u2026<\u7701\u7565 ' + (value.length - limit) + ' \u5b57\u7b26>' : value
    }
    if (value === null || typeof value !== 'object') return value
    if (depth >= DEGRADE_MAX_DEPTH) return '\u2026<\u5c42\u7ea7\u8fc7\u6df1>'
    var kept
    var index
    if (Object.prototype.toString.call(value) === '[object Array]') {
      kept = []
      for (index = 0; index < value.length && index < DEGRADE_MAX_ITEMS; index += 1) {
        kept.push(clipValue(value[index], limit, depth + 1))
      }
      if (value.length > DEGRADE_MAX_ITEMS) kept.push('\u2026<\u7701\u7565 ' + (value.length - DEGRADE_MAX_ITEMS) + ' \u9879>')
      return kept
    }
    var out = {}
    var keys = Object.keys(value)
    for (index = 0; index < keys.length && index < DEGRADE_MAX_ITEMS; index += 1) {
      out[keys[index]] = clipValue(value[keys[index]], limit, depth + 1)
    }
    if (keys.length > DEGRADE_MAX_ITEMS) out['\u2026'] = '\u7701\u7565 ' + (keys.length - DEGRADE_MAX_ITEMS) + ' \u4e2a\u952e'
    return out
  }

  /** 一行是否既是合法 JSON、又满足 probe 必填（入队前的最后一道闸）。 */
  function parses(line) {
    try {
      var parsed = JSON.parse(line)
      return Boolean(parsed) && typeof parsed === 'object' && typeof parsed.probe === 'string' && parsed.probe !== ''
    } catch (error) {
      return false
    }
  }

  /** 按给定 limit 省略超长值后重新序列化 —— 超限降级的**唯一**渲染路径。 */
  function renderClipped(record, limit) {
    var candidate = {}
    for (var key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) candidate[key] = record[key]
    }
    candidate.truncated = true
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
   * 序列化 + 超限降级：省略超长值 → 重新序列化 → 实测字节 → parse 往返校验。
   * 绝不切已经序列化好的整行。
   *
   * 与 `lib/protocol.js` 的 `encodeRecord()` 必须**逐字同构**（含二分规则），
   * 否则 `test/protocol.test.mjs` 的三处逐字比对会红。
   */
  function encode(record) {
    var full = serialize(record)
    if (byteLength(full) <= MAX_LINE) return full

    // ① 固定档位快速找可行解，并记住失败的那一档作为二分上界。
    var best = -1
    var bestLine = ''
    var upper = MAX_LINE + 1
    for (var step = 0; step < DEGRADE_STEPS.length; step += 1) {
      var limit = DEGRADE_STEPS[step]
      var line = renderClipped(record, limit)
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
        msg: '\u8bb0\u5f55\u8d85\u8fc7\u5355\u884c\u4e0a\u9650\uff08' + byteLength(full) + ' \u5b57\u8282\uff09\uff0c\u5df2\u964d\u7ea7\u4e3a\u9aa8\u67b6',
      })
    }

    // ② 把预算用足：二分找**最大的**能放下的 limit（固定档位只用掉约四分之一预算）。
    var low = best
    var high = upper
    var result = bestLine
    while (high - low > 1) {
      var mid = (low + high) >> 1
      var candidate = renderClipped(record, mid)
      if (fitsLine(candidate)) {
        low = mid
        result = candidate
      } else {
        high = mid
      }
    }
    return result
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
      queue.push(encode(record))
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
    // ── 加载即报到 ──────────────────────────────────────────────────────────────
    // 这一条同时证明两件事：**桩被加载了** + **HTTP 通道是通的**。缺了它，
    // "通道是死的"和"埋点没执行到"的现象一模一样（日志一片空白）。
    probe('debug-mode:ready', {
      runtime: 'browser',
      ua: global.navigator ? global.navigator.userAgent : null,
    }, { msg: '浏览器探针桩已加载（这条能到宿主，就说明通道通了）' })
    flush()
  } catch (error) {
    // 安静降级
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
