/**
 * test/service.test.mjs —— 走完 S1→S7 的端到端守卫。
 *
 * 这里钉的不是"函数返回值"，而是**核心不变量**（AGENTS.md §1.1）：
 *   · 入口唯一：无票调用 `dsh_debug_start` 一律被拒；
 *   · 一个任务一个哈希；`continue` 清空日志但哈希不变；
 *   · 探针账与修复账分开记，收尾**只撤探针、绝不回滚修复**；
 *   · 用户信号幂等，不会产生第二次 prompt；
 *   · 闸门连续拒绝 3 次后降级为 warn-only 并记账（防死锁）。
 *
 * 全部走真实文件系统（临时目录），因为"收尾到底删了什么"只有真跑一遍才可信。
 */

import assert from 'node:assert/strict'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { DebugService } from '../lib/debug-service.js'
import { createFakeContext, createWorkspace, probeBlock, changeMark, readIfExists } from './helpers.mjs'

const SESSION = 'session-aaaa'
const OTHER_SESSION = 'session-bbbb'

/** 起一个服务 + 临时工作区。 */
async function setup(files = {}) {
  const workspace = await createWorkspace({
    'src/app.js': 'const items = []\nexport function total() { return items.length }\n',
    'package.json': JSON.stringify({ name: 'demo', type: 'module' }),
    ...files,
  })
  const fake = createFakeContext({ cwd: workspace.root })
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger })
  return { service, fake, workspace }
}

/** 走完"签票 → start"，返回 hash 与路径。 */
async function startTask(service, workspace, sessionId = SESSION, goal = '点了保存列表不刷新') {
  await service.issueTicket({ sessionId, text: goal, workspace: workspace.root })
  const started = await service.start({ sessionId, goal, workspace: workspace.root })
  assert.equal(started.ok, true, started.text)
  return started
}

test('无票调用 dsh_debug_start 一律被拒（入口唯一的硬校验）', async () => {
  const { service, workspace } = await setup()
  try {
    const refused = await service.start({ sessionId: SESSION, goal: '偷偷调试', workspace: workspace.root })
    assert.equal(refused.ok, false)
    assert.match(refused.text, /未进入调试模式：本插件不允许 Agent 自行发起调试任务/)
    assert.match(refused.text, /\/debug/)
    // 被拒时不能留下任何痕迹：不建目录、不分配哈希。
    assert.equal(refused.hash, '')
    assert.equal(await readIfExists(join(workspace.root, '.dsh', 'debug-mode', 'tasks')), null)
  } finally {
    await workspace.cleanup()
  }
})

test('S1：签票后 start 建出哈希、目录、桩与指南，并消费票据', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    assert.match(started.hash, /^[0-9a-f]{8}$/)
    assert.equal(started.round, 1)
    assert.equal(started.status, 'active')

    const dir = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash)
    assert.ok(await readIfExists(join(dir, `${started.hash}.log`)) !== null, '日志文件必须建出来')
    const stub = await readFile(join(dir, 'runtime', 'probe.mjs'), 'utf8')
    assert.ok(stub.includes(`export const TASK = "${started.hash}"`), '桩里必须烘死 hash')
    assert.ok(!stub.includes('__DSH_TASK__'), '占位符必须被替换')
    assert.ok(await readIfExists(join(dir, 'AGENT-PROBE-GUIDE.md')) !== null)
    assert.ok(await readIfExists(join(dir, 'state.json')) !== null)
    assert.ok(await readIfExists(join(dir, 'index.json')) !== null, 'R1 基线索引必须落盘')

    // 指南里的哈希与路径必须是真值（否则 Agent 会照着占位符埋点）。
    const guide = await readFile(join(dir, 'AGENT-PROBE-GUIDE.md'), 'utf8')
    assert.ok(!guide.includes('{{'), '指南里不得残留占位符')
    assert.ok(guide.includes(started.hash))
    assert.match(started.probeImport, /^file:\/\//, 'import 说明符必须是跨平台可用的 file:// 形式')

    // 票据一次性：消费掉之后内存与磁盘都不该再留着它。
    assert.equal(service.tickets.has(SESSION), false)
    assert.equal(await readIfExists(service.ticketFile(workspace.root, SESSION)), null)

    // 幂等：再来一次不新建第二个哈希。
    const again = await service.start({ sessionId: SESSION, goal: '又一次', workspace: workspace.root })
    assert.equal(again.reused, true)
    assert.equal(again.hash, started.hash)
  } finally {
    await workspace.cleanup()
  }
})

test('已有活跃任务时 /debug 拒绝再签票（明确告知既有哈希）', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    const refused = await service.issueTicket({ sessionId: SESSION, text: '再来一个', workspace: workspace.root })
    assert.equal(refused.ok, false)
    assert.ok(refused.text.includes(started.hash))
    assert.match(refused.text, /不要新开第二个任务/)
  } finally {
    await workspace.cleanup()
  }
})

test('S2：报告只加探针 → awaiting-user；探针账与修复账分开记', async () => {
  const { service, fake, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    await workspace.write('src/app.js', [
      'const items = []',
      probeBlock(started.hash, "probe('src/app.js:1:items', { count: items.length, msg: '进入' })"),
      `// dsh-debug:fix ${started.hash} 修复：空数组的 total 应该是 0`,
      'export function total() { return items.length }',
    ].join('\n'))

    const reported = await service.report({
      sessionId: SESSION,
      workspace: workspace.root,
      analysis: '怀疑 total 在空数组时返回 NaN',
      probes: [{ probe: 'src/app.js:1:items', why: '确认 items 真的是空数组' }],
    })
    assert.equal(reported.ok, true, reported.text)
    assert.equal(reported.status, 'awaiting-user')

    const task = service.tasks.get(SESSION)
    assert.deepEqual(task.probeFiles, ['src/app.js'], '探针文件必须进探针账')
    assert.deepEqual(task.changedFiles, [], '只加探针的改动**不得**进修复账（否则收尾会误判）')
    assert.match(reported.text, /等用户复现/)
    assert.ok(!/语法自检发现/.test(reported.text), '这段代码不该有语法失败')
  } finally {
    await workspace.cleanup()
  }
})

test('R4 L1 闸门：第 1 轮出现 dsh-debug:change 被拒；连续 3 次后降级为 warn-only', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    await workspace.write('src/app.js', [
      changeMark(started.hash, 'export function total() { return items.length || 0 }'),
    ].join('\n'))

    const first = await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '顺手改一下' })
    assert.equal(first.ok, false, '第 1 轮改代码必须被拒')
    assert.match(first.text, /第 1 轮是只读取证轮/)
    assert.equal(service.tasks.get(SESSION).status, 'active', '被拒时状态不得前进')

    const second = await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '还是想改' })
    assert.equal(second.ok, false)

    // 连续第 3 次同一原因 ⇒ 按 §16.3.0 降级，绝不把会话卡死。
    const third = await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第三次' })
    assert.equal(third.ok, true, '连续拒绝 3 次后必须降级为 warn-only')
    assert.match(third.text, /降级/)
    assert.equal(service.debts.some((entry) => entry.key.startsWith('gate:round1-change')), true,
      '降级必须写进欠账（面板要能看见）')
  } finally {
    await workspace.cleanup()
  }
})

test('S6 不清空日志：用户点「复现」之后，现场必须原样留着等 Agent 来读', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    const stubPath = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, 'runtime', 'probe.mjs')
    const { probe } = await import(pathToFileURL(stubPath).href)
    const logAbs = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, `${started.hash}.log`)

    // 第 1 轮：Agent 埋点 → 交卷 → 用户复现，复现过程写出了现场。
    probe('src/app.js:1:items', { count: 0 }, { msg: '第一轮现场' })
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第一轮' })
    const beforeSignal = (await stat(logAbs)).size
    assert.ok(beforeSignal > 0)

    const reproduced = await service.reproduce({ hash: started.hash, sessionId: SESSION })
    assert.equal(reproduced.ok, true)

    // ★ 这里是本次修复的核心断言：日志**一个字节都没少**。
    assert.equal((await stat(logAbs)).size, beforeSignal, 'S6 绝不许碰日志——Agent 还没读它')
    assert.match(await readFile(logAbs, 'utf8'), /第一轮现场/)

    // 而且宿主的唤醒指令必须让 Agent「先读」，不能说日志已经清了。
    const instruction = (await service.panelState(SESSION)).task
    assert.ok(instruction)
    const read = await service.read({ sessionId: SESSION, workspace: workspace.root })
    assert.match(read.text, /第一轮现场/, 'Agent 现在读得到用户刚刚复现出来的东西')
    assert.equal(read.lines, 1)
  } finally {
    await workspace.cleanup()
  }
})

test('闸门 C：日志里还有没读过的字节时拒绝清空；先读再 continue 才放行；三振后降级', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    const stubPath = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, 'runtime', 'probe.mjs')
    const { probe } = await import(pathToFileURL(stubPath).href)

    probe('src/app.js:1:items', { count: 0 }, { msg: '未读的现场' })
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第一轮' })
    await service.reproduce({ hash: started.hash, sessionId: SESSION })

    // 没读就想清空 ⇒ 拒绝，且日志必须完好无损。
    const refused = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root })
    assert.equal(refused.ok, false, '没读过的现场不许被清掉')
    assert.match(refused.text, /还有\*\*你没读过\*\*的内容|没读过/)
    assert.match(refused.text, /dsh_debug_read/)
    assert.equal(service.tasks.get(SESSION).round, 1, '被拒时轮次不得推进')

    const read = await service.read({ sessionId: SESSION, workspace: workspace.root })
    assert.equal(read.ok, true)
    const moved = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root, nextPlan: '换假设' })
    assert.equal(moved.ok, true, moved.text)
    assert.equal(moved.round, 2)
    assert.match(moved.text, /日志已清空/)

    // 新一轮开始时 lastRead 必须归零，否则闸门 C 会永久失效（字节数永远比不过旧值）。
    assert.equal(service.tasks.get(SESSION).lastRead.bytes, 0)
    const emptyOk = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root, nextPlan: '再换' })
    assert.equal(emptyOk.ok, true, '空日志没有可丢的东西，不该被闸门拦住')
    assert.equal(emptyOk.round, 3)
  } finally {
    await workspace.cleanup()
  }
})

test('闸门 C 的降级不能被"带数字的理由"破坏（同一原因连续 3 次必须放行）', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    const stubPath = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, 'runtime', 'probe.mjs')
    const { probe } = await import(pathToFileURL(stubPath).href)
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第一轮' })
    await service.reproduce({ hash: started.hash, sessionId: SESSION })

    // 每一次投递的字节数都不同——如果闸门把数字拼进"比较键"，它永远不会降级。
    probe('src/app.js:1:a', { n: 1 })
    const first = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root })
    assert.equal(first.ok, false)
    probe('src/app.js:2:b', { n: 2 })
    const second = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root })
    assert.equal(second.ok, false)
    probe('src/app.js:3:c', { n: 3 })
    const third = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root })
    assert.equal(third.ok, true, '连续 3 次同一原因之后必须放行（§16.3.0）')
    assert.match(third.text, /降级/)
    assert.ok(service.debts.some((entry) => entry.key.startsWith('gate:unread-log')), '降级要写进欠账')
  } finally {
    await workspace.cleanup()
  }
})

test('S3：continue 清空日志但保留哈希；S4：read 真的读到探针写的行', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    const stubPath = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, 'runtime', 'probe.mjs')
    const { probe } = await import(pathToFileURL(stubPath).href)
    probe('src/app.js:1:items', { count: 0 }, { msg: '进入' })
    probe.warn('src/app.js:2:branch', { taken: 'left' }, { msg: '走了左分支' })

    const read = await service.read({ sessionId: SESSION, workspace: workspace.root })
    assert.equal(read.ok, true)
    assert.equal(read.lines, 2)
    assert.match(read.text, /1  src\/app\.js:1:items/, '分组计数必须能读到真日志')
    assert.match(read.text, /走了左分支/)

    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第一轮' })
    // S3 的前置是 `active` 或 `awaiting-agent`：交卷之后球在用户脚下，
    // Agent 必须先等到用户表态（S6），才能开下一轮。这是状态机的一部分，不是阻碍。
    const blocked = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root })
    assert.equal(blocked.ok, false)
    assert.match(blocked.text, /要求状态是/)

    await service.reproduce({ hash: started.hash, sessionId: SESSION })
    // 用户复现后新写了一条：它还没被读过，所以必须先 read（这正是闸门 C 要保护的东西）。
    probe('src/app.js:9:stale', { round: 1 }, { msg: '这一条会被 continue 清掉' })
    await service.read({ sessionId: SESSION, workspace: workspace.root })

    const moved = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root, nextPlan: '换个假设' })
    assert.equal(moved.ok, true, moved.text)
    assert.equal(moved.hash, started.hash, '哈希必须不变')
    assert.equal(moved.round, 2)
    assert.match(moved.text, /日志已清空/)

    const afterContinue = await service.read({ sessionId: SESSION, workspace: workspace.root })
    assert.match(afterContinue.text, /日志存在但为空/, '清空必须是 truncate，不是删文件')

    // 桩还在，写进去还能被读到（说明清空没换目录、没换文件）。
    probe('src/app.js:3:after', { round: 2 }, { msg: '第二轮' })
    const second = await service.read({ sessionId: SESSION, workspace: workspace.root })
    assert.match(second.text, /第二轮/)
  } finally {
    await workspace.cleanup()
  }
})

test('S5/S7：未经用户表态 end 被拒；resolve 幂等只唤醒一次；end 只撤探针、绝不回滚修复', async () => {
  const { service, fake, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    const sourcePath = join(workspace.root, 'src', 'app.js')
    await workspace.write('src/app.js', [
      'const items = []',
      probeBlock(started.hash, "probe('src/app.js:1:items')"),
      `// dsh-debug:fix ${started.hash} 修复：空数组时返回 0`,
      'export function total() { return items.length === 0 ? 0 : items.length }',
    ].join('\n'))
    const withFix = await readFile(sourcePath, 'utf8')

    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '空数组分支' })

    // 用户还没表态：Agent 不得自作主张收尾（§9.4）。
    const premature = await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '我先关了' })
    assert.equal(premature.ok, false)
    assert.match(premature.text, /没有这个表态|要求用户/)

    const resolved = await service.resolve({ hash: started.hash, sessionId: SESSION })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.status, 'awaiting-agent')
    assert.equal(fake.prompts.length, 1, 'S5 必须唤醒 Agent 一次')
    assert.match(fake.prompts[0].content[0].text, /问题已解决/)
    assert.equal(fake.prompts[0].sessionId, SESSION)
    assert.equal(fake.prompts[0].mode, 'queue')

    // 重复点击：幂等，绝不产生第二次 prompt。
    const again = await service.resolve({ hash: started.hash, sessionId: SESSION })
    assert.equal(again.duplicate, true)
    assert.equal(fake.prompts.length, 1)

    const ended = await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工', verified: true })
    assert.equal(ended.ok, true, ended.text)
    assert.deepEqual(ended.cleanedFiles, ['src/app.js'])
    assert.deepEqual(ended.residualFiles, [])

    const after = await readFile(sourcePath, 'utf8')
    assert.ok(!after.includes('dsh-debug:probe'), '探针块必须摘干净')
    assert.ok(after.includes('dsh-debug:fix'), '修复标记必须保留')
    assert.ok(after.includes('items.length === 0 ? 0 : items.length'), '修复本身必须原样保留')
    assert.notEqual(after, withFix, '至少探针那几行应该没了')
    assert.ok(ended.keptFiles.includes('src/app.js'))

    // 任务目录随任务一起消失。
    const dir = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash)
    await assert.rejects(() => stat(dir))
    assert.equal(service.tasks.size, 0)

    // end 幂等：任务不存在时返回"无活跃任务"，不报错。
    const twice = await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '再来' })
    assert.equal(twice.ok, false)
    assert.match(twice.text, /没有进行中的调试任务/)
  } finally {
    await workspace.cleanup()
  }
})

test('隔离区：hash 不属于任何已知任务时，end 暂停并要求用户逐条决定（不允许静默保留）', async () => {
  const { service, workspace } = await setup({
    'src/foreign.js': 'const x = 1 // dsh-debug:probe 0011aabb start\nconst y = 2\n',
  })
  try {
    const started = await startTask(service, workspace)
    await workspace.write('src/app.js', `${probeBlock(started.hash, "probe('x')")}\nexport const a = 1\n`)
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '看看' })
    await service.resolve({ hash: started.hash, sessionId: SESSION })

    const paused = await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工' })
    assert.equal(paused.ok, false)
    assert.equal(paused.needsDecision, true)
    assert.match(paused.text, /无法判定归属/)
    assert.match(paused.text, /ask_user_question/)
    assert.equal(service.tasks.get(SESSION).status, 'awaiting-agent', '有未决隔离项时任务不得关闭')

    const finished = await service.end({
      sessionId: SESSION,
      workspace: workspace.root,
      summary: '收工',
      quarantine: [{ path: 'src/foreign.js', line: 1, decision: 'mine' }],
    })
    assert.equal(finished.ok, true, finished.text)
    assert.match(finished.text, /隔离区决定/)
    // `mine` = 用户自己处理 ⇒ 宿主不碰那一行。
    const foreign = await readFile(join(workspace.root, 'src', 'foreign.js'), 'utf8')
    assert.match(foreign, /dsh-debug:probe 0011aabb start/)
  } finally {
    await workspace.cleanup()
  }
})

test('宿主自动迁移：awaiting-user 时收到用户消息 ⇒ 回到 active（§9.3.2）', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第一轮' })
    assert.equal(service.tasks.get(SESSION).status, 'awaiting-user')

    service.onSessionEvent({ header: { id: SESSION } }, { type: 'user/message' })
    assert.equal(service.tasks.get(SESSION).status, 'active')

    // 其它事件类型不该动状态。
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第二轮' })
    service.onSessionEvent({ header: { id: SESSION } }, { type: 'assistant/message' })
    assert.equal(service.tasks.get(SESSION).status, 'awaiting-user')
    assert.ok(started.hash)
  } finally {
    await workspace.cleanup()
  }
})

test('子 Agent 继承父会话任务，不新建哈希（§11.1）', async () => {
  const { service, fake, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    fake.agents.set(SESSION, { id: SESSION, session: { header: { id: SESSION, cwd: workspace.root } } })
    fake.agents.set('session-child', {
      id: 'session-child',
      session: { header: { id: 'session-child', cwd: workspace.root, parentSession: SESSION } },
    })

    const read = await service.read({ sessionId: 'session-child', workspace: workspace.root })
    assert.equal(read.ok, true, '子会话必须能看到父会话的任务')
    assert.equal(read.hash, started.hash)
  } finally {
    await workspace.cleanup()
  }
})

test('面板载荷：无任务时 task=null；有任务时带状态、日志量、探针账与"残留检测"自检', async () => {
  const { service, workspace } = await setup()
  try {
    assert.deepEqual(await service.panelState(SESSION), { task: null })

    const started = await startTask(service, workspace)
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '结论如下' })
    const state = await service.panelState(SESSION)
    assert.equal(state.task.hash, started.hash)
    assert.equal(state.task.round, 1)
    assert.equal(state.task.status, 'awaiting-user')
    assert.equal(state.task.lastReport, '结论如下')
    assert.equal(state.task.detector.available, true, '可写的临时目录里闸门必须是在工作的')
    assert.equal(state.task.detector.writeProbe, true)
  } finally {
    await workspace.cleanup()
  }
})

test('guidanceFor：无任务/任务结束后必须为空（否则没进调试的会话也会被注入准则）', async () => {
  const { service, workspace } = await setup()
  try {
    assert.equal(service.guidanceFor(SESSION), null)
    const started = await startTask(service, workspace)
    assert.equal(service.guidanceFor(SESSION).hash, started.hash)

    service.onSessionDisposed(SESSION)
    assert.equal(service.guidanceFor(SESSION), null)
  } finally {
    await workspace.cleanup()
  }
})

test('票据 TTL：过期的票据不能再用（陈旧票据不该被后到的调用用掉）', async () => {
  const { service, workspace } = await setup()
  try {
    await service.issueTicket({ sessionId: OTHER_SESSION, text: '旧票', workspace: workspace.root })
    const ticket = service.tickets.get(OTHER_SESSION)
    ticket.issuedAt = Date.now() - 31 * 60 * 1000
    service.tickets.set(OTHER_SESSION, ticket)

    const refused = await service.start({ sessionId: OTHER_SESSION, goal: '用旧票', workspace: workspace.root })
    assert.equal(refused.ok, false)
    assert.match(refused.text, /未进入调试模式/)
  } finally {
    await workspace.cleanup()
  }
})

test('会话结束只解除绑定，不删任务目录（删除只发生在 end 里）', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    service.onSessionDisposed(SESSION)
    assert.equal(service.tasks.size, 0)
    const dir = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash)
    assert.ok((await stat(dir)).isDirectory(), '任务目录必须还在，等用户回来收尾')

    // 跨重启恢复：同一个会话再问一次，任务应该被重新认领。
    service.restoreAttempts.clear()
    const restored = await service.findTask(SESSION, workspace.root)
    assert.equal(restored.hash, started.hash)
    assert.equal(restored.round, 1)
  } finally {
    await workspace.cleanup()
  }
})

test('写探针自检失败时必须显形（绝不假装保护着）', async () => {
  const { service, workspace } = await setup()
  try {
    // 把 workspace 换成一个不可能建目录的路径，模拟"宿主没有写权限"。
    const broken = join(workspace.root, 'src', 'app.js', 'nested')
    const probe = await service.ensureWriteProbe(broken)
    assert.equal(probe.ok, false)
    assert.ok(service.debts.some((entry) => entry.key === 'write-probe'))
  } finally {
    await workspace.cleanup()
  }
})

test('R5 欠账看板：列出未关闭的任务，收尾后消失，且绝不自动删目录', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const other = await createWorkspace({ 'src/b.js': 'export const b = 1\n' })
  const fake = createFakeContext({ cwd: workspace.root })
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger })
  try {
    await service.issueTicket({ sessionId: SESSION, text: 'x', workspace: workspace.root })
    const started = await service.start({ sessionId: SESSION, goal: '列表不刷新', workspace: workspace.root })

    const board = await service.debtBoard()
    assert.equal(board.tasks.length, 1)
    assert.equal(board.tasks[0].hash, started.hash)
    assert.equal(board.tasks[0].status, 'active')
    assert.equal(board.stale.length, 0, '刚建立的任务不该被算作陈旧欠账')

    // 别的会话的欠账也要看得见（这是"跨任务"的意义），并且能给 /debug 一句提醒。
    await service.issueTicket({ sessionId: OTHER_SESSION, text: 'y', workspace: other.root })
    await service.start({ sessionId: OTHER_SESSION, goal: '另一个仓库的问题', workspace: other.root })
    assert.equal((await service.debtBoard()).tasks.length, 2)
    const notice = await service.debtNotice(SESSION)
    assert.match(notice, /另有 1 个未收尾的调试任务/)

    // 收尾之后从看板上消失。注意：**没有任何 TTL 会自动删目录**。
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: 'ok' })
    await service.resolve({ hash: started.hash, sessionId: SESSION })
    await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工' })
    const after = await service.debtBoard()
    assert.equal(after.tasks.length, 1)
    assert.equal(after.tasks[0].sessionId, OTHER_SESSION)
  } finally {
    await workspace.cleanup()
    await other.cleanup()
  }
})

test('收尾时会备份被改写的文件（绝不自动还原，但要留可查的入口）', async () => {
  const { service, workspace } = await setup()
  try {
    const started = await startTask(service, workspace)
    await workspace.write('src/app.js', `${probeBlock(started.hash, "probe('x')")}\nexport const a = 1\n`)
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: 'ok' })
    await service.resolve({ hash: started.hash, sessionId: SESSION })
    await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工' })

    // 任务目录已删，所以备份也随之消失——这是设计：任务关闭即删除（§10）。
    const dir = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash)
    await assert.rejects(() => stat(dir))
    await rm(dir, { recursive: true, force: true })
  } finally {
    await workspace.cleanup()
  }
})
