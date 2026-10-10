/**
 * test/protocol.test.mjs —— 协议与任务状态机的守卫测试。
 * 运行：node --test test/  （不需要任何依赖）
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { byteLength, encodeRecord, formatRecord, parseLog, parseRecord, RECORD_FIELDS } from '../lib/protocol.js'
import { createHash, createTask, logPath, probeStubPath, STATUS, taskDir, transition } from '../lib/task.js'
import { renderBrowserStub, renderProbeStub } from '../lib/probe-template.js'
import { runInContext, createContext } from 'node:vm'

/**
 * 超限负载矩阵 —— 逐条对应一次实测（用户报的那组数）。
 *
 * 老实现（切序列化好的整行）在这些用例上会写出**半个 JSON**，读端只能算脏行。
 * 关键对照：`msg`（顶层字符串字段）当年**恰好**能解析，因为切点落在字符串值里，
 * 补上的 `"` 与 `}` 正好把字符串和对象收尾——这就是为什么这个 bug 藏了这么久。
 */
const OVERFLOW_CASES = [
  { name: '嵌套值 7800（未超限）', probe: 'p:1', data: { nested: { value: 'x'.repeat(7800) } } },
  { name: '嵌套值 8000（未超限）', probe: 'p:2', data: { nested: { value: 'x'.repeat(8000) } } },
  { name: '嵌套值 8200（超限）', probe: 'p:3', data: { nested: { value: 'x'.repeat(8200) } } },
  { name: '嵌套值 10000（超限）', probe: 'p:4', data: { nested: { value: 'x'.repeat(10000) } } },
  { name: '单层对象 @10000', probe: 'p:5', data: { value: 'x'.repeat(10000) } },
  { name: '三层嵌套 @10000', probe: 'p:6', data: { a: { b: { c: 'x'.repeat(10000) } } } },
  { name: '数组元素 @10000', probe: 'p:7', data: { list: ['x'.repeat(10000)] } },
  { name: '顶层 msg @10000（当年的对照组）', probe: 'p:8', msg: 'x'.repeat(10000) },
  { name: '顶层 msg @10000 中文', probe: 'p:8zh', msg: '中'.repeat(10000) },
  { name: '顶层 msg @30000', probe: 'p:8b', msg: 'x'.repeat(30000) },
  { name: '中文负载 4000×3 字节（按字节而非字符算）', probe: 'p:9', data: { zh: '中'.repeat(4000) } },
  { name: '一万个小键（绕过字符串档位）', probe: 'p:10', data: Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [`k${i}`, i])) },
]

test('超限降级：绝不切整行——省略值后重新序列化，且每一档都 parse 往返校验', () => {
  for (const item of OVERFLOW_CASES) {
    const { line, truncated } = encodeRecord({ ts: '2026-10-10T10:00:00.000+08:00', task: 'deadbeef', level: 'info', ...item })
    // ① 绝不超限（按**字节**算，中文不能按字符数算）
    assert.ok(byteLength(line) <= 8 * 1024, `${item.name}: 超限了（${byteLength(line)} 字节）`)
    // ② **必须能被读端解析**——这正是老实现丢掉的东西
    const parsed = parseRecord(line)
    assert.ok(parsed, `${item.name}: 变成了脏行（老 bug 的复现）`)
    assert.equal(parsed.probe, item.probe, `${item.name}: probe 必须原样保留`)
    assert.ok(line.endsWith('\n'), `${item.name}: 必须恰好一行`)
    // ③ 超限的必须被标出来，读端才知道"这条被省略过"
    if (byteLength(JSON.stringify({ ...item })) > 8 * 1024 || truncated) {
      assert.equal(parsed.truncated, true, `${item.name}: 降级必须留痕`)
    }
  }

  // 反例守卫：老实现那种"切整行再补尾巴"的做法，在嵌套负载上必然产出脏行。
  // 把这条断言留在测试里，是为了让"改回切片"这件事当场变红。
  const nested = JSON.stringify({ probe: 'p', data: { nested: { value: 'x'.repeat(10000) } } })
  const sliced = `${nested.slice(0, 8 * 1024 - 32)}…","truncated":true}\n`
  assert.equal(parseRecord(sliced), null, '切整行 = 脏行（这就是要防的退化）')
})

test('三处实现（协议模块 / Node 桩 / 浏览器桩）对同一批超限负载产出**逐字相同**的行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-degrade-parity-'))
  try {
    // ── 载体 1：协议模块 ──
    // ⚠️ `ts` 必须与两个桩生成的**等长**（ISO-8601 带毫秒与偏移 = 29 字符）。
    // 因为 `ts` 参与 8 KiB 预算的计算：给它 7 个字符（`'FIXED'`）会让降级二分出与桩
    // 不同的 clip limit，两者"逐字比对"必然不一致——而事后归一化 `ts` 补不回来
    // （预算已经按不同的输入算过了）。第一版就是这么红的。
    const FIXED_TS = '2026-10-11T01:26:57.045+08:00'
    assert.equal(FIXED_TS.length, 29, '必须与桩 stamp() 的输出等长')
    const viaModule = (item) => formatRecord({ ts: FIXED_TS, task: 'deadbeef', level: 'info', ...item })

    // ── 载体 2：Node 桩（真写文件，再读回来）──
    const logAbs = join(dir, 'parity.log')
    const stubAbs = join(dir, 'probe.mjs')
    await writeFile(stubAbs, await renderProbeStub({ hash: 'deadbeef', logAbsolutePath: logAbs }), 'utf8')
    const { probe } = await import(pathToFileURL(stubAbs).href)

    // ── 载体 3：浏览器桩（vm 沙箱，拦下它排的队）──
    const source = await renderBrowserStub({ hash: 'deadbeef', endpoint: 'http://127.0.0.1:1/x' })
    const beacons = []
    const sandbox = {
      console,
      Blob: class { constructor(parts) { this.parts = parts } },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      navigator: { sendBeacon: (url, blob) => { beacons.push(blob.parts.join('')); return true } },
      fetch: () => Promise.resolve({}),
      TextEncoder,
    }
    sandbox.globalThis = sandbox
    runInContext(source, createContext(sandbox), { filename: 'probe.browser.js' })

    for (const item of OVERFLOW_CASES) {
      // 模块
      const moduleLine = viaModule(item)

      // Node 桩：一条一条写、一条一条读（`ts` 是桩自己生成的，比对时抠掉）
      probe(item.probe, item.data, item.msg === undefined ? {} : { msg: item.msg })
      const stubLines = (await readFile(logAbs, 'utf8')).trimEnd().split('\n')
      const stubLine = stubLines[stubLines.length - 1]

      // 浏览器桩
      beacons.length = 0
      sandbox.dshProbe(item.probe, item.data, item.msg === undefined ? {} : { msg: item.msg })
      sandbox.dshProbe.flush()
      const browserLine = beacons[beacons.length - 1] ?? ''

      // 三者的**结构**必须一致：去掉 ts（各自生成）与行尾换行后逐字相同。
      const strip = (line) => line.replace(/"ts":"[^"]*"/, '"ts":"T"').replace(/\n$/, '')
      assert.equal(strip(stubLine), strip(browserLine), `${item.name}: Node 桩与浏览器桩不一致`)
      assert.equal(strip(stubLine), strip(moduleLine), `${item.name}: 桩与协议模块不一致`)
      // 而且三者都不能产出脏行。
      assert.ok(parseRecord(stubLine), `${item.name}: Node 桩写出了脏行`)
      assert.ok(parseRecord(browserLine), `${item.name}: 浏览器桩写出了脏行`)
    }

    // 整份日志一条脏行都不许有（用户报的现象就是"脏行数 = 越线记录数"）。
    const { records, dirtyLines } = parseLog(await readFile(logAbs, 'utf8'))
    assert.equal(dirtyLines, 0, `日志里有 ${dirtyLines} 条脏行`)
    assert.ok(records.length >= OVERFLOW_CASES.length, '所有记录都必须可读')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('byteLength 按 UTF-8 算字节（中文 3 字节、代理对 4 字节）', () => {
  assert.equal(byteLength('abc'), 3)
  assert.equal(byteLength('中'), 3)
  assert.equal(byteLength('😀'), 4, '代理对必须算 4 字节而不是 2+3')
  assert.equal(byteLength('中a😀'), 3 + 1 + 4)
})

test('formatRecord 字段序稳定、可被 parseRecord 还原', () => {
  const line = formatRecord({
    ts: '2026-10-10T10:00:00.000+08:00',
    task: 'deadbeef',
    probe: 'src/a.ts:1:enter',
    level: 'debug',
    msg: 'hello',
    data: { a: 1 },
  })
  assert.ok(line.endsWith('\n'))
  const record = parseRecord(line)
  assert.deepEqual(record, {
    ts: '2026-10-10T10:00:00.000+08:00',
    task: 'deadbeef',
    probe: 'src/a.ts:1:enter',
    level: 'debug',
    msg: 'hello',
    data: { a: 1 },
  })
  // 字段序必须与冻结的顺序一致。`truncated` 是**可选**字段：这条没被降级，就不该出现
  // （它只标记"这条真的被宿主/桩省略过"，与"显示层缩写"是两件事）。
  assert.deepEqual(
    Object.keys(JSON.parse(line)),
    [...RECORD_FIELDS.filter((f) => f !== 'data' && f !== 'truncated'), 'data'],
  )
})

test('formatRecord 在 ts 缺失时补时间戳，在 probe 缺失时抛错', () => {
  const parsed = parseRecord(formatRecord({ probe: 'p' }))
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
  assert.throws(() => formatRecord({ level: 'info' }), /requires a non-empty `probe`/)
  assert.throws(() => formatRecord({ probe: '' }), /requires a non-empty `probe`/)
})

test('formatRecord 对循环引用 / Error / BigInt 不抛异常', () => {
  const cyclic = { name: 'c' }
  cyclic.self = cyclic
  const line = formatRecord({ probe: 'p', data: { cyclic, err: new Error('boom'), big: 10n } })
  const record = parseRecord(line)
  assert.equal(record.data.cyclic.self, '[circular]')
  assert.equal(record.data.err.message, 'boom')
  assert.equal(record.data.big, '10n')
})

test('parseLog 容忍脏行并计数', () => {
  const text = [
    formatRecord({ probe: 'a', level: 'info' }).trimEnd(),
    'not json at all',
    '',
    '{ broken json',
    formatRecord({ probe: 'b', level: 'warn' }).trimEnd(),
  ].join('\n')
  const { records, dirtyLines } = parseLog(text)
  assert.equal(records.length, 2)
  assert.equal(dirtyLines, 2)
  assert.equal(records[1].level, 'warn')
})

test('parseRecord 拒绝没有 probe 的 JSON 行', () => {
  assert.equal(parseRecord('{"ts":"x"}'), null)
  assert.equal(parseRecord('[]'), null)
})

test('createHash 是 8 位小写十六进制且不重复', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) {
    const hash = createHash()
    assert.match(hash, /^[0-9a-f]{8}$/)
    assert.ok(!seen.has(hash))
    seen.add(hash)
  }
})

test('路径约定冻结：日志落在任务目录内', () => {
  const hash = 'deadbeef'
  assert.equal(taskDir(hash), '.dsh/debug-mode/tasks/deadbeef')
  assert.equal(logPath(hash), '.dsh/debug-mode/tasks/deadbeef/deadbeef.log')
  assert.equal(probeStubPath(hash), '.dsh/debug-mode/tasks/deadbeef/runtime/probe.mjs')
})

test('状态机：合法迁移放行，非法迁移抛错', () => {
  const task = createTask({ hash: 'deadbeef', sessionId: 's1', workspace: '/w', goal: 'g' })
  assert.equal(task.status, STATUS.ACTIVE)
  transition(task, STATUS.AWAITING_USER)
  transition(task, STATUS.AWAITING_AGENT)
  transition(task, STATUS.ACTIVE)
  assert.throws(() => transition(task, 'nonsense'), /illegal transition/)
  const closed = createTask({ hash: 'x', sessionId: 's', workspace: '/w', goal: 'g' })
  transition(closed, STATUS.CLOSED)
  assert.throws(() => transition(closed, STATUS.ACTIVE), /illegal transition/)
})

test('探针账与修复账分开记：probeFiles 与 changedFiles 是两个数组', () => {
  // DESIGN.md §3.8：收尾只撤探针，绝不回滚用户的修复。两条账混在一起就会误删修复，
  // 所以这里把「它们必须是两个独立字段」钉住。
  const task = createTask({ hash: 'deadbeef', sessionId: 's1', workspace: '/w', goal: 'g' })
  assert.deepEqual(task.probeFiles, [])
  assert.deepEqual(task.changedFiles, [])
  assert.notEqual(task.probeFiles, task.changedFiles, '不能是同一个数组引用')

  task.probeFiles.push('src/a.ts')
  assert.deepEqual(task.changedFiles, [], '往探针账里加文件不得影响修复账')
})

test('renderProbeStub 烘死 hash 与日志绝对路径，且桩能真的写出协议行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-debug-mode-'))
  try {
    const hash = 'deadbeef'
    const logAbs = join(dir, 'deadbeef.log')
    const stubAbs = join(dir, 'probe.mjs')
    const source = await renderProbeStub({ hash, logAbsolutePath: logAbs })
    assert.ok(source.includes(`export const TASK = "deadbeef"`))
    assert.ok(!source.includes('__DSH_TASK__'))
    await (await import('node:fs/promises')).writeFile(stubAbs, source, 'utf8')

    const probeModule = await import(pathToFileURL(stubAbs).href)
    probeModule.probe('src/a.ts:1:enter', { value: 1 }, { msg: '进入' })
    probeModule.probe.warn('src/a.ts:2:branch', { taken: 'left' })
    assert.deepEqual(probeModule.probe.stats().task, hash)
    assert.ok(probeModule.probe.stats().bytes > 0)

    const { records, dirtyLines } = parseLog(await readFile(logAbs, 'utf8'))
    assert.equal(dirtyLines, 0)
    // 第 1 条是桩在**加载时**自己写的 ready —— 它是"桩没加载"与"埋点没执行"的唯一区分手段。
    assert.equal(records.length, 3)
    assert.equal(records[0].probe, 'debug-mode:ready')
    assert.equal(records[0].level, 'info')
    assert.equal(records[0].data.runtime, 'node')
    assert.equal(records[1].task, hash)
    assert.equal(records[1].probe, 'src/a.ts:1:enter')
    assert.equal(records[1].msg, '进入')
    assert.deepEqual(records[1].data, { value: 1 })
    assert.equal(records[2].level, 'warn')
    // 探针不许因为坏负载而抛异常
    assert.doesNotThrow(() => probeModule.probe('p', (() => { const c = {}; c.c = c; return c })()))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('探针桩在日志达到 16 MiB 上限后停止追加，并只写一条 overflow 说明（§11.2）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-debug-mode-cap-'))
  try {
    const logAbs = join(dir, 'cap.log')
    const stubAbs = join(dir, 'probe.mjs')
    await writeFile(stubAbs, await renderProbeStub({ hash: 'cafebabe', logAbsolutePath: logAbs }), 'utf8')
    // 直接把日志"垫"到上限：这是宿主的冻结阈值，测试必须钉住它，
    // 否则某天有人把上限调大/调小，没有任何东西会红。
    const limit = 16 * 1024 * 1024
    await writeFile(logAbs, Buffer.alloc(limit, 0x0a))
    const before = (await stat(logAbs)).size

    const { probe } = await import(pathToFileURL(stubAbs).href)
    probe('src/a.ts:1:enter', { value: 1 })
    const afterFirst = (await stat(logAbs)).size
    assert.ok(afterFirst > before, '到顶时必须写一条 overflow 说明')

    probe('src/a.ts:2:enter', { value: 2 })
    const afterSecond = (await stat(logAbs)).size
    assert.equal(afterSecond, afterFirst, 'overflow 只写一次，之后一律停手（不许把磁盘写满）')

    const text = await readFile(logAbs, 'utf8')
    assert.ok(text.includes('debug-mode:overflow'))
    assert.ok(text.trimEnd().endsWith('}'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renderProbeStub 在模板锚点缺失时抛错', async () => {
  await assert.rejects(
    () => renderProbeStub({ template: '// nothing here', hash: 'x', logAbsolutePath: '/tmp/x.log' }),
    /anchor missing/,
  )
})

test('桩写出的原始行与协议模块的字段序逐字一致（防止两处实现漂移）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-debug-mode-order-'))
  try {
    const logAbs = join(dir, 'x.log')
    const stubAbs = join(dir, 'probe.mjs')
    await writeFile(stubAbs, await renderProbeStub({ hash: 'cafebabe', logAbsolutePath: logAbs }), 'utf8')
    const { probe } = await import(pathToFileURL(stubAbs).href)
    probe('src/b.ts:9:after', { n: 1 }, { msg: 'ok' })

    const raw = (await readFile(logAbs, 'utf8')).trimEnd()
    // 最后一行才是我们主动写的那条（第一行是桩的 ready）。
    const parsed = JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1))
    // RECORD_FIELDS 是冻结顺序；桩必须完全相同（只写出现过的字段）
    assert.deepEqual(Object.keys(parsed), RECORD_FIELDS.filter((field) => parsed[field] !== undefined))
    assert.deepEqual(Object.keys(parsed), ['ts', 'task', 'probe', 'level', 'msg', 'data'])
    assert.equal(parsed.probe, 'src/b.ts:9:after')
    // ready 那条走的是同一个序列化器，所以字段序也必须一致。
    const ready = JSON.parse(raw.slice(0, raw.indexOf('\n')))
    assert.deepEqual(Object.keys(ready), ['ts', 'task', 'probe', 'level', 'msg', 'data'])
    // 协议模块对同一条记录序列化后，共享字段的字段序也必须相同
    // （`task` 是桩独有的：它来自桩里烘死的常量，协议模块没有任务上下文；
    //   `truncated` 只在这条被降级时出现，这里没有降级）
    const viaProtocol = Object.keys(JSON.parse(formatRecord({ probe: 'p', level: 'info', msg: 'ok', data: {} })))
    assert.deepEqual(viaProtocol, RECORD_FIELDS.filter((field) => field !== 'task' && field !== 'truncated'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
