#!/usr/bin/env node
/**
 * scripts/probe-selfcheck.mjs —— 探针**边界自检**：一条命令跑完，不再靠人工构造负载。
 *
 * 为什么要有它：实测里"边界值 → 逐条 POST → 读日志 → 对脏行/标记/字节"这套动作
 * 被手工做过好几轮，而且踩过一个自伤：把 8 条回执塞进一条记录再去读，
 * 结果 `dsh_debug_read` 的**显示缩写**（>240 字符就缩）正好把要读的数字截掉了。
 * 这个脚本自己打表、自己算数，不经任何显示层——那些数字必须完整可见。
 *
 * 两种模式：
 *   1. 本地（默认）：在临时工作区里直接驱动 `DebugService`，跑完整矩阵 +
 *      三处实现一致性 + 协议不变量。**不需要 DSH 在跑，也不需要端口。**
 *   2. `--endpoint <url>`：打**活的** DSH（验证路由 / CORS / 真实宿主）。
 *      日志绝对路径取自 `GET /probe` 那个 handshake 响应里的 `logPath`
 *      （产物现在住在用户临时目录里，从 `--repo` 拼出来的路径不再可信）；
 *      拿不到时才要求显式传 `--log <绝对路径>`。
 *
 * 退出码：任何一条不合格 ⇒ 1（可以直接接进 CI 或 pre-commit）。
 *
 * 用法：
 *   node scripts/probe-selfcheck.mjs
 *   node scripts/probe-selfcheck.mjs --keep            # 保留临时目录供人工查看
 *   node scripts/probe-selfcheck.mjs --json            # 机器可读
 *   node scripts/probe-selfcheck.mjs --endpoint 'http://127.0.0.1:19387/dsh-debug-mode/probe?h=<hash>'
 *   node scripts/probe-selfcheck.mjs --endpoint '<url>' --log '<日志绝对路径>'   # handshake 没给 logPath 时
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'

import { DebugService } from '../lib/debug-service.js'
import { byteLength, parseLog, parseRecord, RECORD_FIELDS } from '../lib/protocol.js'
import { renderBrowserStub, renderProbeStub } from '../lib/probe-template.js'
import { removeBlocks } from '../lib/scan.js'

/** 单行上限（与 lib/protocol.js 的 MAX_RECORD_BYTES 一致；这里独立写死，才能验它）。 */
const MAX_LINE_BYTES = 8 * 1024

/**
 * 边界矩阵。
 *
 * 每一行都对应一次实测踩过的坑，**别删**：
 *   · 7800/8000 在 8 KiB 之下 ⇒ 应当"完整落盘且无标记"（对照组）
 *   · 8200/10000 越线 ⇒ 应当"被省略 + 有标记 + 说明省略多少"
 *   · 顶层 msg 与 data 是**两条不同的路径**（v0.16 的静默预截断只砍前者）
 *   · 中文/代理对按**字节**算，不按字符数
 *   · 小键很多时绕过字符串档位（降级必须同时限键数）
 *   · 长 probe 是分组计数的键，被砍会让两组悄悄合并；超长时还会走**骨架兜底**分支
 *
 * [!] 每条用例的请求体必须 ≤ 64 KiB（HTTP 路由的上限）——
 * 否则活模式会 400、本地模式却通过，两种模式结论不一致（实测踩过：9000 个小键）。
 * 脚本启动时会自检这一点，矩阵写错了会直接指出来。
 */
const HTTP_BODY_LIMIT = 64 * 1024

const MATRIX = [
  { label: '嵌套值 7800（未越线）', payload: { probe: 'sc:nested-7800', data: { nested: { value: 'x'.repeat(7800) } } }, field: 'data', expectOmitted: false },
  { label: '嵌套值 8000（未越线）', payload: { probe: 'sc:nested-8000', data: { nested: { value: 'x'.repeat(8000) } } }, field: 'data', expectOmitted: false },
  { label: '嵌套值 8200（越线）', payload: { probe: 'sc:nested-8200', data: { nested: { value: 'x'.repeat(8200) } } }, field: 'data', expectOmitted: true },
  { label: '嵌套值 10000（越线）', payload: { probe: 'sc:nested-10000', data: { nested: { value: 'x'.repeat(10000) } } }, field: 'data', expectOmitted: true },
  { label: '单层对象 @10000', payload: { probe: 'sc:flat-10000', data: { value: 'x'.repeat(10000) } }, field: 'data', expectOmitted: true },
  { label: '三层嵌套 @10000', payload: { probe: 'sc:deep-10000', data: { a: { b: { c: 'x'.repeat(10000) } } } }, field: 'data', expectOmitted: true },
  { label: '数组元素 @10000', payload: { probe: 'sc:array-10000', data: { list: ['x'.repeat(10000)] } }, field: 'data', expectOmitted: true },
  { label: '顶层 msg @10000（v0.16 的坑）', payload: { probe: 'sc:msg-10000', msg: 'M'.repeat(10000) }, field: 'msg', expectOmitted: true },
  { label: '顶层 msg @30000', payload: { probe: 'sc:msg-30000', msg: 'M'.repeat(30000) }, field: 'msg', expectOmitted: true },
  { label: '顶层 msg @10000 中文', payload: { probe: 'sc:msg-zh', msg: '中'.repeat(10000) }, field: 'msg', expectOmitted: true },
  { label: '中文负载 4000×3 字节', payload: { probe: 'sc:data-zh', data: { zh: '中'.repeat(4000) } }, field: 'data', expectOmitted: true },
  { label: '小键很多（4000 个）', payload: { probe: 'sc:many-keys', data: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`k${i}`, i])) }, field: 'data', expectOmitted: true },
  { label: '长 probe @500（未越线，分组键）', payload: { probe: `sc:${'z'.repeat(500)}`, data: { n: 1 } }, field: 'probe', expectOmitted: false },
  { label: '长 probe @9000（越线，分组键）', payload: { probe: `sc:${'z'.repeat(9000)}`, data: { n: 1 } }, field: 'probe', expectOmitted: true },
  { label: '普通小记录（基线）', payload: { probe: 'sc:tiny', data: { n: 1 } }, field: 'data', expectOmitted: false },
]

/** 解析命令行。 */
function parseArgs(argv) {
  const options = { endpoint: '', repo: process.cwd(), log: '', keep: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--endpoint') options.endpoint = argv[++index] ?? ''
    else if (token === '--repo') options.repo = resolve(argv[++index] ?? '.')
    else if (token === '--log') options.log = resolve(argv[++index] ?? '.')
    else if (token === '--keep') options.keep = true
    else if (token === '--json') options.json = true
    else if (token === '--help' || token === '-h') options.help = true
  }
  return options
}

const HELP = `探针边界自检

  node scripts/probe-selfcheck.mjs [选项]

  --endpoint <url>  打活的 DSH（形如 http://127.0.0.1:<端口>/dsh-debug-mode/probe?h=<hash>）
                    省略时走本地模式：临时工作区 + 真实 DebugService，不需要 DSH 在跑
  --log <path>      活模式的日志绝对路径（**只在 GET /probe 没给出 logPath 时才需要**）
  --repo <path>     被调试仓库的根（默认当前目录）；仅作为定位提示保留
  --keep            保留临时工作区，便于人工查看落盘原文
  --json            以 JSON 输出（供 CI 消费）
  -h, --help        显示这段说明
`

/** 造一个只够 DebugService 用的最小宿主上下文。 */
function fakeContext() {
  return {
    logger: () => ({ warn() {}, info() {}, error() {} }),
    sessionController: { async prompt() { return { accepted: true } } },
    webServer: { register() { return () => undefined }, port: 19387 },
  }
}

/**
 * 自检矩阵本身：每条用例的请求体必须能过 HTTP 路由的 64 KiB 上限。
 *
 * 为什么要有这一步：两种模式走的是**不同的入口**（本地直接调 `ingestProbe`，
 * 活模式走 HTTP 路由），矩阵里一旦有条用例超过 64 KiB，活模式 400、本地通过
 * ——同一个矩阵给出两个结论，而失败信息是"请求体过大"，指向的是矩阵而不是被测代码。
 * 实测踩过一次（9000 个小键）。
 */
function validateMatrix() {
  const problems = []
  for (const entry of MATRIX) {
    const body = JSON.stringify(entry.payload)
    const bytes = byteLength(body)
    if (bytes > HTTP_BODY_LIMIT) {
      problems.push(`${entry.label}：请求体 ${bytes} 字节 > HTTP 上限 ${HTTP_BODY_LIMIT}（活模式会 400）`)
    }
  }
  return problems
}

/**
 * 断言一条已落盘记录。
 * @returns {{ failures: string[], omitted: boolean, marked: boolean, explained: boolean, lineBytes: number, parsed: boolean }}
 */
function judge(entry, rawLine) {
  const failures = []
  const record = parseRecord(rawLine)
  const parsed = record !== null
  if (!parsed) failures.push('落盘的行不是合法探针记录（脏行）')

  const lineBytes = byteLength(rawLine)
  if (lineBytes > MAX_LINE_BYTES) failures.push(`单行 ${lineBytes} 字节 > 上限 ${MAX_LINE_BYTES}`)
  if (rawLine.includes('\n')) failures.push('单行里出现了换行符')

  if (!parsed) return { failures, omitted: false, marked: false, explained: false, lineBytes, parsed }

  const sent = entry.payload[entry.field]
  const landed = record[entry.field]
  const omitted = JSON.stringify(sent) !== JSON.stringify(landed)
  // 省略说明有三种形状，都要认：省略超长**字符** / 数组**项** / 对象**个键**。
  // （只认"字符"会让"一万个小键"那条假红——实测踩过。）
  const asText = typeof landed === 'string' ? landed : JSON.stringify(landed)
  const explained = /省略 \d+ (字符|项|个键)/.test(String(asText))

  if (omitted && record.truncated !== true) failures.push('值被省略了却没有 truncated 标记（静默丢失）')
  if (omitted && !explained) failures.push('值被省略了但没说清省略了多少')
  if (!omitted && entry.field !== 'probe' && record.truncated === true) failures.push('标了 truncated 但值其实完整（标记可疑）')
  if (entry.field === 'probe' && omitted && record.truncated !== true) failures.push('probe 标识被砍却无标记')
  return { failures, omitted, marked: record.truncated === true, explained, lineBytes, parsed }
}

/* ────────────────────────── 空白演练（收尾摘除时的空行行为） ────────────────────────── */

/**
 * 摘除探针块时**空行**会怎样。
 *
 * 为什么单独做一节：这套行为被人工验证过好几轮，而且**行数会骗人**——
 * 实测出现过「一处少 1 行 + 一处多 1 行 ⇒ 总行数不变」，只看总数会判成"全对"，
 * 实际是一个空行从 A 处搬到了 B 处。所以这里把 before/after 都**按位置**列出来。
 *
 * 四种情形（前两种是纪律，后两种是纪律没做到时的代价）：
 *   ① 空行只在标记内 + 原地无空行 ⇒ 逐字还原
 *   ② 空行在标记外（原有）+ 块内也加了 ⇒ 原有那个活下来（宿主不碰标记外）
 *   ③ 把**原有的**空行包进标记内 ⇒ 它跟块一起消失（清理逻辑**兜不住**）
 *   ④ 在标记**外**加填充 ⇒ 留下 1 个空行（收敛把 2 个降到 1 个，降不到 0）
 *   ⑤ 总行数不变但空行搬家 ⇒ 只看行数会判错（专门留的用例）
 */
function runBlankDrill() {
  const hash = 'deadbeef'
  const pre = `# dsh-debug:probe ${hash} start`
  const post = `# dsh-debug:probe ${hash} end`
  const inner = [pre, '', "probe('x')", '', post]

  const scenarios = [
    {
      label: '① 空行只在标记内 · 原地无空行',
      before: ['a = 1', ...inner, 'b = 2'],
      expect: ['a = 1', 'b = 2'],
      note: '逐字还原',
    },
    {
      label: '② 原有空行在标记外 · 块内也加了',
      before: ['a = 1', '', ...inner, 'b = 2'],
      expect: ['a = 1', '', 'b = 2'],
      note: '原有那一个必须活下来',
    },
    {
      label: '③ 把原有的空行包进了标记内',
      before: ['a = 1', pre, '', "probe('x')", post, 'b = 2'],
      expect: ['a = 1', 'b = 2'],
      note: '代价：空行被吃掉 ⇒ 清理逻辑兜不住（它在删除区间里）。本条**符合预期**，是纪律没做到时的必然结果',
    },
    {
      label: '④ 在标记外加填充',
      before: ['a = 1', '', pre, "probe('x')", post, '', 'b = 2'],
      expect: ['a = 1', '', 'b = 2'],
      note: '代价：留下 1 个空行（收敛把 2 个降到 1 个）。本条**符合预期**',
    },
    {
      label: '⑤ 空行搬家 · 总行数与"全对"相同',
      // 上面一个块吃掉了原有的空行、下面一个块多留了一个空行 ⇒ 一少一多，
      // 总行数与"每个缝都恰好"的版本**一模一样**。
      before: ['a = 1', pre, '', "probe('x')", post, 'b = 2', '', pre, "probe('y')", post, 'c = 3'],
      expect: ['a = 1', 'b = 2', '', 'c = 3'],
      note: '[!] 行数相同、位置不同——只比行数会把这一条判成「全对」',
    },
  ]

  return scenarios.map((scenario) => {
    const result = removeBlocks(scenario.before.join('\n'), hash)
    const after = result.text.split('\n')
    return {
      label: scenario.label,
      ok: JSON.stringify(after) === JSON.stringify(scenario.expect),
      note: scenario.note,
      collapsedBlankLines: result.collapsedBlankLines,
      before: scenario.before,
      after,
      expect: scenario.expect,
      // 单独把"总行数是否与预期相同"也算出来 —— 用来演示"行数会骗人"。
      sameLineCount: after.length === scenario.expect.length,
    }
  })
}

/* ────────────────────────── 本地模式：驱动真实 DebugService ────────────────────────── */

async function runLocal(options) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-selfcheck-'))
  const ctx = fakeContext()
  // 产物根指到本次自检自己的临时工作区：默认的 `os.tmpdir()/dsh-debug-mode` 是**共享**的，
  // 别让一次自检在用户临时目录里留下任务（也免得扫到别人留下的任务）。
  const service = new DebugService(ctx, { tempDir: root })
  await service.issueTicket({ sessionId: 'selfcheck', workspace: root })
  const started = await service.start({ sessionId: 'selfcheck', workspace: root, goal: '探针边界自检' })
  if (!started.ok) throw new Error(`无法创建任务：${started.text}`)

  const hash = started.hash
  // 日志绝对路径**只能用 start 的返回值**：产物根是运行时解析出来的
  // （临时目录优先，不可写才回退工作区），手拼的那一份不再是真相。
  const logAbs = started.logPath
  const logDir = dirname(logAbs)
  const rows = []
  let dirtyBefore = 0

  for (const entry of MATRIX) {
    const receipt = await service.ingestProbe({ hash, payload: entry.payload })
    const text = await readFile(logAbs, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const rawLine = lines[lines.length - 1]
    const verdict = judge(entry, rawLine)
    const dirtyAfter = parseLog(text).dirtyLines

    if (receipt.accepted !== 1) verdict.failures.push(`宿主拒收（accepted=${receipt.accepted}）`)
    if (dirtyAfter !== dirtyBefore) verdict.failures.push(`这一步新增了 ${dirtyAfter - dirtyBefore} 条脏行`)
    if (entry.expectOmitted && !verdict.omitted) {
      verdict.failures.push('按预期应当被省略，实际完整落盘（上限没生效？）')
    }
    dirtyBefore = dirtyAfter

    rows.push({ label: entry.label, ...verdict, accepted: receipt.accepted, degraded: receipt.degraded ?? 0 })
  }

  const invariants = await checkInvariants(service, hash, logAbs)
  const parity = await checkParity(service, hash, logDir, logAbs)
  const blanks = runBlankDrill()

  const logInfo = await stat(logAbs)
  const summary = {
    mode: 'local',
    workspace: root,
    hash,
    logPath: logAbs,
    logBytes: logInfo.size,
    rows,
    invariants,
    parity,
    blanks,
  }
  if (!options.keep) await rm(root, { recursive: true, force: true })
  return summary
}

/**
 * 协议不变量。
 *
 * [!] 关于 `ts` 的**真实契约**（自检脚本第一版把它写错了，这里纠正）：
 *   · 省略 `ts` ⇒ 宿主补**到达时刻**；
 *   · 提供 `ts` ⇒ **原样采纳**。
 * 第二条是必需的，不是漏洞：浏览器桩**批量发送**（200 ms 一批、卸载时冲刷），
 * 一条 200 ms 前排队的记录必须保住**事件时刻**，用落盘时刻会让整个时间序错位。
 * 所以"投递方伪造 ts 无效"是**错**的期望——只有 `task` 是宿主写死的。
 */
async function checkInvariants(service, hash, logAbs) {
  const checks = []
  const readLast = async () => {
    const text = await readFile(logAbs, 'utf8')
    return text.trimEnd().split('\n').pop()
  }

  // ① task 由宿主写死：伪造无效。
  await service.ingestProbe({ hash, payload: { probe: 'sc:forge-task', task: 'deadbeef', data: { n: 1 } } })
  const forgedTask = parseRecord(await readLast())
  checks.push({
    name: 'task 由宿主写死（投递方伪造无效）',
    ok: forgedTask?.task === hash,
    detail: `落盘 task=${forgedTask?.task}`,
  })

  // ② 省略 ts ⇒ 宿主补到达时刻（带时区偏移）。
  await service.ingestProbe({ hash, payload: { probe: 'sc:no-ts', data: { n: 1 } } })
  const stamped = parseRecord(await readLast())
  checks.push({
    name: '省略 ts ⇒ 宿主补到达时刻（带时区偏移）',
    ok: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(stamped?.ts ?? ''),
    detail: `落盘 ts=${stamped?.ts}`,
  })

  // ③ 提供 ts ⇒ 原样采纳（批量投递靠它保住事件时刻）。
  const supplied = '2020-02-02T02:02:02.000+08:00'
  await service.ingestProbe({ hash, payload: { probe: 'sc:own-ts', ts: supplied, data: { n: 1 } } })
  const honored = parseRecord(await readLast())
  checks.push({
    name: '提供 ts ⇒ 原样采纳（批量投递要用事件时刻）',
    ok: honored?.ts === supplied,
    detail: `落盘 ts=${honored?.ts}`,
  })

  // ④ 字段顺序是冻结序的**子序列**（可缺字段，不可乱序）——`truncated` 只在降级时出现。
  const keys = Object.keys(JSON.parse(await readLast()))
  const frozen = RECORD_FIELDS.filter((field) => keys.includes(field))
  checks.push({
    name: '字段顺序与冻结协议一致（缺字段可以，乱序不行）',
    ok: JSON.stringify(keys) === JSON.stringify(frozen),
    detail: keys.join(','),
  })
  return checks
}

/** 三处实现一致性：宿主摄入 vs Node 桩 vs 浏览器桩，同一条负载必须产出同一行（除 ts）。 */
async function checkParity(service, hash, logDir, hostLog) {
  const results = []
  // 两个辅助文件落在**任务目录里**（由宿主日志的绝对路径反推），所以它们随任务一起消失。
  const stubPath = join(logDir, 'runtime', 'probe.parity.mjs')
  const stubLog = join(logDir, 'parity.log')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(stubPath, await renderProbeStub({ hash, logAbsolutePath: stubLog }), 'utf8')
  const { probe } = await import(pathToFileURL(stubPath).href)

  const source = await renderBrowserStub({ hash, endpoint: 'http://127.0.0.1:1/probe?h=' + hash })
  const beacons = []
  const sandbox = {
    console,
    Blob: class { constructor(parts) { this.parts = parts } },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    navigator: { sendBeacon: (_url, blob) => { beacons.push(blob.parts.join('')); return true } },
    fetch: () => Promise.resolve({}),
  }
  sandbox.globalThis = sandbox
  runInContext(source, createContext(sandbox), { filename: 'probe.browser.js' })

  // 挑几条有代表性的（越线与未越线各取，含顶层 msg 与嵌套 data）。
  for (const entry of MATRIX.filter((item) => ['sc:nested-8000', 'sc:nested-10000', 'sc:msg-10000', 'sc:many-keys'].includes(item.payload.probe))) {
    const before = (await readFile(stubLog, 'utf8').catch(() => '')).trimEnd().split('\n').filter(Boolean).length
    probe(entry.payload.probe, entry.payload.data, entry.payload.msg === undefined ? {} : { msg: entry.payload.msg })
    const stubLines = (await readFile(stubLog, 'utf8')).trimEnd().split('\n').filter(Boolean)
    const stubLine = stubLines[stubLines.length - 1] ?? ''
    if (stubLines.length === before) { results.push({ label: entry.label, ok: false, detail: 'Node 桩没有写出新行' }); continue }

    beacons.length = 0
    sandbox.dshProbe(entry.payload.probe, entry.payload.data, entry.payload.msg === undefined ? {} : { msg: entry.payload.msg })
    sandbox.dshProbe.flush()
    const browserLine = beacons[beacons.length - 1] ?? ''

    // 宿主：重新投一次同一条负载，取落盘最后一行。
    await service.ingestProbe({ hash, payload: entry.payload })
    const hostLines = (await readFile(hostLog, 'utf8')).trimEnd().split('\n').filter(Boolean)
    const hostLine = hostLines[hostLines.length - 1] ?? ''

    const strip = (line) => line.replace(/"ts":"[^"]*"/, '"ts":"T"').replace(/\n$/, '')
    const ok = strip(stubLine) === strip(browserLine) && strip(stubLine) === strip(hostLine)
    results.push({
      label: entry.label,
      ok,
      detail: ok ? '三处逐字一致' : '不一致',
      ...(ok ? {} : { stub: strip(stubLine).slice(0, 160), browser: strip(browserLine).slice(0, 160), host: strip(hostLine).slice(0, 160) }),
    })
  }
  return results
}

/* ────────────────────────── 活模式：打真实端点 ────────────────────────── */

async function runLive(options) {
  const url = new URL(options.endpoint)
  const hash = url.searchParams.get('h') ?? url.searchParams.get('task') ?? ''
  if (!/^[0-9a-f]{8}$/.test(hash)) throw new Error('端点 URL 里缺少合法的 h=<8 位十六进制> 参数')

  // 先自检：GET 同一个地址。**日志路径从它的响应里取** —— 产物现在默认落在用户
  // 临时目录里，从 `--repo` 拼 `.dsh/debug-mode/tasks/...` 只会指到一个不存在的文件，
  // 而那种失败会伪装成"脏行 / 没有记录"，把人带去查错的方向。
  const handshake = await fetch(url, { headers: { accept: 'application/json' } })
  const handshakeBody = await handshake.json().catch(() => ({}))
  const logAbs = handshakeBody.logPath || options.log
  if (!logAbs) {
    throw new Error('活模式：GET /probe 没给出 logPath，且未传 --log <绝对路径>')
  }

  const rows = []
  let dirtyBefore = parseLog(await readFile(logAbs, 'utf8').catch(() => '')).dirtyLines

  for (const entry of MATRIX) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(entry.payload),
    })
    const receipt = await response.json().catch(() => ({}))
    const text = await readFile(logAbs, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const rawLine = lines[lines.length - 1]
    // 每次 POST 只追加一条，所以**最后一行**就是刚写进去的那条。
    // （别去按前缀 `find`：矩阵里有两条 `sc:z…` 探针，第一版就是这么踩的。）
    const verdict = judge(entry, rawLine)
    const dirtyAfter = parseLog(text).dirtyLines
    if (!response.ok && response.status !== 200) verdict.failures.push(`HTTP ${response.status}：${receipt.reason ?? ''}`)
    if (receipt.accepted !== 1) verdict.failures.push(`accepted=${receipt.accepted}`)
    if (dirtyAfter !== dirtyBefore) verdict.failures.push(`新增 ${dirtyAfter - dirtyBefore} 条脏行`)
    dirtyBefore = dirtyAfter
    rows.push({ label: entry.label, ...verdict, accepted: receipt.accepted ?? 0, degraded: receipt.degraded ?? 0 })
  }

  return {
    mode: 'live',
    endpoint: options.endpoint,
    hash,
    logPath: logAbs,
    handshake: { status: handshake.status, ok: handshakeBody.ok === true, httpRecords: handshakeBody.httpRecords, hint: handshakeBody.hint },
    rows,
    invariants: [],
    parity: [],
    // 空白演练与本任务无关（它验的是摘除逻辑），活模式下也跑一遍——两边行为必须一致。
    blanks: runBlankDrill(),
  }
}

/* ────────────────────────────── 报告 ────────────────────────────── */

function renderReport(summary) {
  const lines = []
  // 终端 / CI 的编码与字形回退各不相同，所以报告里一律用 ASCII 标记（仓库禁 emoji）。
  const mark = (ok) => (ok ? '[ok]' : '[x]')
  lines.push('')
  lines.push(`探针边界自检 · ${summary.mode === 'local' ? '本地（临时工作区 + 真实 DebugService）' : `活模式 ${summary.endpoint}`}`)
  lines.push(`任务 #${summary.hash}${summary.logBytes !== undefined ? ` · 日志 ${summary.logBytes} 字节` : ''}`)
  lines.push('')
  lines.push('① 边界矩阵（每一项都独立判定：值是否完整 / 是否有标记 / 行是否越线 / 是否脏行）')
  lines.push('   ' + ['结果', '用例'.padEnd(30), '值', '标记', '省略说明', '行字节', '降级'].join('  '))
  for (const row of summary.rows) {
    lines.push('   ' + [
      mark(row.failures.length === 0),
      row.label.padEnd(30),
      row.omitted ? '已省略' : '完整  ',
      row.marked ? '有' : '无',
      row.explained ? '有' : '—',
      String(row.lineBytes).padStart(6),
      String(row.degraded).padStart(4),
    ].join('  '))
  }
  const failedRows = summary.rows.filter((row) => row.failures.length > 0)
  if (failedRows.length > 0) {
    lines.push('')
    lines.push('   失败明细：')
    for (const row of failedRows) for (const failure of row.failures) lines.push(`   [x] ${row.label}：${failure}`)
  }

  if (summary.invariants.length > 0) {
    lines.push('')
    lines.push('② 协议不变量')
    for (const item of summary.invariants) lines.push(`   ${mark(item.ok)} ${item.name}（${item.detail}）`)
  }

  if (summary.parity.length > 0) {
    lines.push('')
    lines.push('③ 三处实现一致性（宿主摄入 / Node 桩 / 浏览器桩）')
    for (const item of summary.parity) {
      lines.push(`   ${mark(item.ok)} ${item.label}  ${item.detail}`)
      if (!item.ok) {
        lines.push(`      宿主：${item.host}`)
        lines.push(`      桩：${item.stub}`)
        lines.push(`      浏览器：${item.browser}`)
      }
    }
  }

  if (summary.blanks.length > 0) {
    lines.push('')
    lines.push('④ 空白演练（摘除探针块时空行的去向 —— **按位置**看，不看行数；[ok] = 行为与文档写的预期一致）')
    const show = (line) => (line.trim() === '' ? '␣' : line)
    for (const item of summary.blanks) {
      lines.push(`   ${mark(item.ok)} ${item.label}`)
      lines.push(`      前：${item.before.map(show).join(' | ')}`)
      lines.push(`      后：${item.after.map(show).join(' | ')}`)
      if (!item.ok) lines.push(`      期望：${item.expect.map(show).join(' | ')}`)
      lines.push(`      ${item.note}${item.sameLineCount && !item.ok ? '　← 总行数与期望相同：行数看不出来，位置才看得出来' : ''}`)
    }
  }

  const failures = [
    ...summary.rows.flatMap((row) => row.failures.map((item) => `${row.label}：${item}`)),
    ...summary.invariants.filter((item) => !item.ok).map((item) => `不变量 ${item.name}`),
    ...summary.parity.filter((item) => !item.ok).map((item) => `一致性 ${item.label}`),
    ...summary.blanks.filter((item) => !item.ok).map((item) => `空白演练 ${item.label}`),
  ]
  lines.push('')
  lines.push(failures.length === 0
    ? `[ok] 全部通过（${summary.rows.length} 条用例${summary.parity.length ? ` + ${summary.parity.length} 条一致性` : ''}${summary.invariants.length ? ` + ${summary.invariants.length} 条不变量` : ''}${summary.blanks.length ? ` + ${summary.blanks.length} 条空白演练` : ''}）`
    : `[x] ${failures.length} 项不合格——见上面的明细`)
  return lines.join('\n')
}

/* ────────────────────────────── 入口 ────────────────────────────── */

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

// 先自检矩阵：写错了就先说清楚，别让"请求体过大"这种信息把人带偏。
const matrixProblems = validateMatrix()
if (matrixProblems.length > 0) {
  process.stderr.write(`自检矩阵有问题（修 MATRIX，不是修被测代码）：\n  - ${matrixProblems.join('\n  - ')}\n`)
  process.exit(2)
}

try {
  const summary = options.endpoint ? await runLive(options) : await runLocal(options)
  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else process.stdout.write(`${renderReport(summary)}\n`)

  if (summary.mode === 'local' && options.keep) {
    process.stdout.write(`\n临时工作区保留在：${summary.workspace}\n（日志原文：${summary.logPath}）\n`)
  }

  const failed = summary.rows.some((row) => row.failures.length > 0)
    || summary.invariants.some((item) => !item.ok)
    || summary.parity.some((item) => !item.ok)
    || summary.blanks.some((item) => !item.ok)
  process.exit(failed ? 1 : 0)
} catch (error) {
  process.stderr.write(`自检无法运行：${String(error?.message ?? error)}\n`)
  process.exit(2)
}
