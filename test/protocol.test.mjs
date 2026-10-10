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

import { formatRecord, parseLog, parseRecord, RECORD_FIELDS } from '../lib/protocol.js'
import { createHash, createTask, logPath, probeStubPath, STATUS, taskDir, transition } from '../lib/task.js'
import { renderProbeStub } from '../lib/probe-template.js'

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
  // 字段序必须与冻结的顺序一致
  assert.deepEqual(Object.keys(JSON.parse(line)), [...RECORD_FIELDS.filter((f) => f !== 'data'), 'data'])
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
    assert.equal(records.length, 2)
    assert.equal(records[0].task, hash)
    assert.equal(records[0].probe, 'src/a.ts:1:enter')
    assert.equal(records[0].msg, '进入')
    assert.deepEqual(records[0].data, { value: 1 })
    assert.equal(records[1].level, 'warn')
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
    const parsed = JSON.parse(raw)
    // RECORD_FIELDS 是冻结顺序；桩必须完全相同（只写出现过的字段）
    assert.deepEqual(Object.keys(parsed), RECORD_FIELDS.filter((field) => parsed[field] !== undefined))
    assert.deepEqual(Object.keys(parsed), ['ts', 'task', 'probe', 'level', 'msg', 'data'])
    // 协议模块对同一条记录序列化后，共享字段的字段序也必须相同
    // （`task` 是桩独有的：它来自桩里烘死的常量，协议模块没有任务上下文）
    const viaProtocol = Object.keys(JSON.parse(formatRecord({ probe: 'p', level: 'info', msg: 'ok', data: {} })))
    assert.deepEqual(viaProtocol, RECORD_FIELDS.filter((field) => field !== 'task'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
