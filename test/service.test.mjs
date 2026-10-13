/**
 * test/service.test.mjs —— 走完 S1→S7 的端到端守卫。
 *
 * 这里钉的不是"函数返回值"，而是**核心不变量**（AGENTS.md §1.1）：
 *   · 入口唯一：无票调用 `dsh_debug_start` 一律被拒；
 *   · 一个任务一个哈希；`continue` 清空日志但哈希不变；
 *   · 探针账与修复账分开记，收尾**只撤探针、绝不回滚修复**；
 *   · 用户信号幂等，不会产生第二次 prompt；
 *   · 闸门连续拒绝 3 次后降级为 warn-only 并记账（防死锁）；
 *   · **产物默认落用户临时目录**，回退工作区必须出声，两个根都不可写才拒绝。
 *
 * 全部走真实文件系统（临时目录），因为"收尾到底删了什么"只有真跑一遍才可信。
 *
 * [!] 每一处 `new DebugService(...)` 都必须注入自己的 `tempDir`（`createArtifactBase()`）：
 * `node --test` 并行跑多个测试文件，共用真实 `%TEMP%/dsh-debug-mode` 会让
 * `debtBoard` / 跨重启恢复这类"扫一遍所有任务目录"的断言互相污染。
 */

import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { ARTIFACT_ROOT, DebugService } from '../lib/debug-service.js'
import { createHash } from '../lib/task.js'
import {
  createArtifactBase,
  createFakeContext,
  createWorkspace,
  probeBlock,
  changeMark,
  readIfExists,
} from './helpers.mjs'

const SESSION = 'session-aaaa'
const OTHER_SESSION = 'session-bbbb'

/**
 * 起一个服务 + 临时工作区 + **自己的产物根父目录**。
 * @param {Record<string, string>} [files]
 * @param {{ tempDir?: string, webPort?: number, createHash?: () => string }} [options]
 */
async function setup(files = {}, options = {}) {
  const workspace = await createWorkspace({
    'src/app.js': 'const items = []\nexport function total() { return items.length }\n',
    'package.json': JSON.stringify({ name: 'demo', type: 'module' }),
    ...files,
  })
  const art = await createArtifactBase()
  const fake = createFakeContext({ cwd: workspace.root, ...(options.webPort ? { webPort: options.webPort } : {}) })
  const service = new DebugService(fake.ctx, {
    logger: fake.ctx.logger,
    tempDir: options.tempDir ?? art.base,
    ...(options.createHash ? { createHash: options.createHash } : {}),
  })
  return { service, fake, workspace, art }
}

/** 走完"签票 → start"，返回 hash 与路径。 */
async function startTask(service, workspace, sessionId = SESSION, goal = '点了保存列表不刷新') {
  await service.issueTicket({ sessionId, text: goal, workspace: workspace.root })
  const started = await service.start({ sessionId, goal, workspace: workspace.root })
  assert.equal(started.ok, true, started.text)
  return started
}

test('无票调用 dsh_debug_start 一律被拒（入口唯一的硬校验）', async () => {
  const { service, workspace, art } = await setup()
  try {
    const refused = await service.start({ sessionId: SESSION, goal: '偷偷调试', workspace: workspace.root })
    assert.equal(refused.ok, false)
    assert.match(refused.text, /未进入调试模式：本插件不允许 Agent 自行发起调试任务/)
    assert.match(refused.text, /\/debug/)
    // 被拒时不能留下任何痕迹：不建目录、不分配哈希。
    assert.equal(refused.hash, '')
    assert.equal(await readIfExists(join(workspace.root, '.dsh', 'debug-mode', 'tasks')), null)
    // 产物不进工作区（§1.1 第 15 条）：连 `.dsh/` 这个壳都不该被建出来。
    // 老断言只查了 `tasks/`，那样"顺手建了 `.dsh/`"照样能过——而它正是要防的东西
    // （`.dsh/` 一旦出现就会被 git status 与编辑器索引看见）。
    assert.equal(await readIfExists(join(workspace.root, '.dsh')), null, '被拒时产物不该在工作区里留下任何痕迹')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('S1：签票后 start 建出哈希、目录、桩与指南，并消费票据', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    assert.match(started.hash, /^[0-9a-f]{8}$/)
    assert.equal(started.round, 1)
    assert.equal(started.status, 'active')

    // 路径一律用返回值（`started.logPath` / `started.probeStub`）或 `pathsOf()`，
    // 不再手拼 `.dsh/debug-mode/...`：产物根是**运行时解析**出来的，手拼出来的那份
    // 从"临时目录优先"那一刻起就不再是真相。
    const task = service.tasks.get(SESSION)
    const paths = service.pathsOf(task)
    const dir = paths.dir
    assert.equal(started.logPath, paths.log)
    assert.equal(started.probeStub, paths.stub)
    assert.ok(await readIfExists(paths.log) !== null, '日志文件必须建出来')
    const stub = await readFile(paths.stub, 'utf8')
    assert.ok(stub.includes(`export const TASK = "${started.hash}"`), '桩里必须烘死 hash')
    assert.ok(!stub.includes('__DSH_TASK__'), '占位符必须被替换')
    assert.ok(await readIfExists(paths.guide) !== null)
    assert.ok(await readIfExists(join(dir, 'state.json')) !== null)
    assert.ok(await readIfExists(join(dir, 'index.json')) !== null, 'R1 基线索引必须落盘')

    // 指南里的哈希与路径必须是真值（否则 Agent 会照着占位符埋点）。
    const guide = await readFile(paths.guide, 'utf8')
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
    await art.cleanup()
  }
})

test('已有活跃任务时 /debug 拒绝再签票（明确告知既有哈希）', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    const refused = await service.issueTicket({ sessionId: SESSION, text: '再来一个', workspace: workspace.root })
    assert.equal(refused.ok, false)
    assert.ok(refused.text.includes(started.hash))
    assert.match(refused.text, /不要新开第二个任务/)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('S2：报告只加探针 → awaiting-user；探针账与修复账分开记', async () => {
  const { service, fake, workspace, art } = await setup()
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
    await art.cleanup()
  }
})

test('R4 L1 闸门：第 1 轮出现 dsh-debug:change 被拒；连续 3 次后降级为 warn-only', async () => {
  const { service, workspace, art } = await setup()
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

    // 连续第 3 次同一原因 ⇒ 按防死锁规则降级，绝不把会话卡死。
    const third = await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第三次' })
    assert.equal(third.ok, true, '连续拒绝 3 次后必须降级为 warn-only')
    assert.match(third.text, /降级/)
    assert.equal(service.debts.some((entry) => entry.key.startsWith('gate:round1-change')), true,
      '降级必须写进欠账（面板要能看见）')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('S2：面板要的两样东西——一句简短回复 + 复现步骤清单（缺了要有兜底）', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    await service.report({
      sessionId: SESSION,
      workspace: workspace.root,
      analysis: '一大段分析：我先怀疑缓存分支，又看了 total 的计算，最后发现……',
      headline: 'total 在 items 为空时算成了 null',
      reproSteps: ['打开保存对话框', '清空标题后点保存', '回到列表页'],
    })

    const state = await service.panelState(SESSION)
    assert.equal(state.task.headline, 'total 在 items 为空时算成了 null')
    assert.deepEqual(state.task.reproSteps, ['打开保存对话框', '清空标题后点保存', '回到列表页'])

    // 没给 headline ⇒ 拿 analysis 的第一行兜底（面板是给用户看的，空一块比说半句更糟）。
    await service.reproduce({ hash: started.hash, sessionId: SESSION })
    await service.continueDebug({ sessionId: SESSION, workspace: workspace.root, nextPlan: 'x' })
    await service.report({
      sessionId: SESSION,
      workspace: workspace.root,
      analysis: '- 缓存分支先命中了\n后面还有一大段不该出现在面板上的东西',
    })
    const fallback = await service.panelState(SESSION)
    assert.equal(fallback.task.headline, '缓存分支先命中了', '必须剥掉 Markdown 列表符号')
    assert.deepEqual(fallback.task.reproSteps, [], '没给步骤就是空数组，面板另有兜底文案')

    // 步骤会被规范化：去换行、超长截断、条数封顶——面板是卡片，不是文档。
    await service.reproduce({ hash: started.hash, sessionId: SESSION })
    await service.continueDebug({ sessionId: SESSION, workspace: workspace.root, nextPlan: 'y' })
    await service.report({
      sessionId: SESSION,
      workspace: workspace.root,
      analysis: 'x',
      reproSteps: ['  第一步\n换行了  ', '', 'x'.repeat(500), ...Array.from({ length: 20 }, (_, i) => `步骤 ${i}`)],
    })
    const normalized = (await service.panelState(SESSION)).task.reproSteps
    assert.equal(normalized[0], '第一步 换行了', '步骤里的换行要拍平（一条一句）')
    assert.ok(normalized[1].length <= 200, '超长步骤必须截断')
    assert.equal(normalized.length, 12, '条数封顶：面板不该被撑成一面墙')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('S6 不清空日志：用户点「复现」之后，现场必须原样留着等 Agent 来读', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    // 桩与日志的位置由返回值给出（临时目录优先，手拼会指到不存在的地方）。
    const { probe } = await import(pathToFileURL(started.probeStub).href)
    const logAbs = started.logPath

    // 第 1 轮：Agent 埋点 → 交卷 → 用户复现，复现过程写出了现场。
    probe('src/app.js:1:items', { count: 0 }, { msg: '第一轮现场' })
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第一轮' })
    const beforeSignal = (await stat(logAbs)).size
    assert.ok(beforeSignal > 0)

    const reproduced = await service.reproduce({ hash: started.hash, sessionId: SESSION })
    assert.equal(reproduced.ok, true)

    // (*) 这里是本次修复的核心断言：日志**一个字节都没少**。
    assert.equal((await stat(logAbs)).size, beforeSignal, 'S6 绝不许碰日志——Agent 还没读它')
    assert.match(await readFile(logAbs, 'utf8'), /第一轮现场/)

    // 而且宿主的唤醒指令必须让 Agent「先读」，不能说日志已经清了。
    const instruction = (await service.panelState(SESSION)).task
    assert.ok(instruction)
    const read = await service.read({ sessionId: SESSION, workspace: workspace.root })
    assert.match(read.text, /第一轮现场/, 'Agent 现在读得到用户刚刚复现出来的东西')
    // 2 行 = 桩加载时的 `debug-mode:ready` + 那一条业务探针。ready 在这里很关键：
    // 它证明"桩是通的"，于是"没看到我要的探针"就只能解释为"那段代码没走到"。
    assert.equal(read.lines, 2)
    assert.match(read.text, /debug-mode:ready/)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('闸门 C：日志里还有没读过的字节时拒绝清空；先读再 continue 才放行；三振后降级', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    const { probe } = await import(pathToFileURL(started.probeStub).href)

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
    await art.cleanup()
  }
})

test('闸门 C 的降级不能被"带数字的理由"破坏（同一原因连续 3 次必须放行）', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    const { probe } = await import(pathToFileURL(started.probeStub).href)
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
    assert.equal(third.ok, true, '连续 3 次同一原因之后必须放行')
    assert.match(third.text, /降级/)
    assert.ok(service.debts.some((entry) => entry.key.startsWith('gate:unread-log')), '降级要写进欠账')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('S3：continue 清空日志但保留哈希；S4：read 真的读到探针写的行', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    const { probe } = await import(pathToFileURL(started.probeStub).href)
    probe('src/app.js:1:items', { count: 0 }, { msg: '进入' })
    probe.warn('src/app.js:2:branch', { taken: 'left' }, { msg: '走了左分支' })

    const read = await service.read({ sessionId: SESSION, workspace: workspace.root })
    assert.equal(read.ok, true)
    // 3 行 = 桩加载时的 ready + 两条业务探针。
    assert.equal(read.lines, 3)
    assert.match(read.text, /1  src\/app\.js:1:items/, '分组计数必须能读到真日志')
    assert.match(read.text, /走了左分支/)
    assert.match(read.text, /1  debug-mode:ready/, 'ready 必须在分组里看得见——它区分"桩没加载"与"埋点没执行"')

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
    await art.cleanup()
  }
})

test('S5/S7：未经用户表态 end 被拒；resolve 幂等只唤醒一次；end 只撤探针、绝不回滚修复', async () => {
  const { service, fake, workspace, art } = await setup()
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

    // 用户还没表态：Agent 不得自作主张收尾。
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

    // 任务目录随任务一起消失。目录位置取自 `pathsOf(task)`：产物根是运行时解析的，
    // 这里必须问 service，而不是假设它落在工作区里。
    const dir = service.pathsOf(started).dir
    await assert.rejects(() => stat(dir))
    assert.equal(service.tasks.size, 0)

    // end 幂等：任务不存在时返回"无活跃任务"，不报错。
    const twice = await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '再来' })
    assert.equal(twice.ok, false)
    assert.match(twice.text, /没有进行中的调试任务/)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('chip 上的叉 = 「问题已解决」，但它不受 awaiting-user 约束（进了调试就出不来的修复点）', async () => {
  const { service, fake, workspace, art } = await setup()
  try {
    // `active` —— Agent 正在排查、还没交卷。这时面板上根本没有按钮可点。
    const started = await startTask(service, workspace)
    assert.equal(service.tasks.get(SESSION).status, 'active')

    // ① 面板那条路（不带 anytime）在 active 上仍然被拒：窗口语义没有被这条新通道放松。
    const panelWay = await service.resolve({ hash: started.hash, sessionId: SESSION })
    assert.equal(panelWay.ok, false)
    assert.equal(panelWay.code, 409)
    assert.match(panelWay.text, /不在"等用户下结论"的窗口里/)
    assert.equal(fake.prompts.length, 0, '被拒的表态不得唤醒 Agent')

    // ② chip 那条路（anytime）在 active 上直接成立：同一个 resolved 表态，只是不排队等。
    const chipWay = await service.resolve({ hash: started.hash, sessionId: SESSION, anytime: true })
    assert.equal(chipWay.ok, true, chipWay.text)
    assert.equal(chipWay.status, 'awaiting-agent')
    assert.equal(service.tasks.get(SESSION).userVerdict, 'resolved')
    assert.equal(fake.prompts.length, 1, '表态必须唤醒 Agent 去收尾')
    assert.match(fake.prompts[0].content[0].text, /问题已解决/)
    // 用户跳过了"复现 → 表态"那个窗口，所以这一轮必须明确禁止假装验证过。
    assert.match(fake.prompts[0].content[0].text, /verified/)
    assert.match(fake.prompts[0].content[0].text, /假装验证过/)

    // ③ 幂等：叉连点两次只唤醒一次。
    const again = await service.resolve({ hash: started.hash, sessionId: SESSION, anytime: true })
    assert.equal(again.duplicate, true)
    assert.equal(fake.prompts.length, 1)

    // ④ 收尾照旧走 dsh_debug_end 那道门——叉给的就是 resolved，所以门是开的。
    const ended = await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工' })
    assert.equal(ended.ok, true, ended.text)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('隔离区：hash 不属于任何已知任务时，end 暂停并要求用户逐条决定（不允许静默保留）', async () => {
  const { service, workspace, art } = await setup({
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
    await art.cleanup()
  }
})

test('宿主自动迁移：awaiting-user 时收到用户消息 ⇒ 回到 active', async () => {
  const { service, workspace, art } = await setup()
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
    await art.cleanup()
  }
})

test('子 Agent 继承父会话任务，不新建哈希', async () => {
  const { service, fake, workspace, art } = await setup()
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
    await art.cleanup()
  }
})

test('面板载荷：无任务时 task=null；有任务时带状态、日志量、探针账与"残留检测"自检', async () => {
  const { service, workspace, art } = await setup()
  try {
    assert.deepEqual(await service.panelState(SESSION), { task: null })

    const started = await startTask(service, workspace)
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '结论如下' })
    const state = await service.panelState(SESSION)
    assert.equal(state.task.hash, started.hash)
    assert.equal(state.task.round, 1)
    assert.equal(state.task.status, 'awaiting-user')
    assert.equal(state.task.lastReport, '结论如下')
    assert.equal(state.task.artifactRootKind, ARTIFACT_ROOT.TEMP, '产物默认落用户临时目录')
    // 可写的**临时**根下闸门照样是在工作的：写探针自检只关心"这个根能不能写"，
    // 与根在哪无关（这里钉住它，免得把"回退"误当成"检测能力"）。
    assert.equal(state.task.detector.available, true, '可写的临时目录里闸门必须是在工作的')
    assert.equal(state.task.detector.writeProbe, true)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('guidanceFor：无任务/任务结束后必须为空（否则没进调试的会话也会被注入准则）', async () => {
  const { service, workspace, art } = await setup()
  try {
    assert.equal(service.guidanceFor(SESSION), null)
    const started = await startTask(service, workspace)
    assert.equal(service.guidanceFor(SESSION).hash, started.hash)

    service.onSessionDisposed(SESSION)
    assert.equal(service.guidanceFor(SESSION), null)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('票据 TTL：过期的票据不能再用（陈旧票据不该被后到的调用用掉）', async () => {
  const { service, workspace, art } = await setup()
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
    await art.cleanup()
  }
})

test('会话结束只解除绑定，不删任务目录（删除只发生在 end 里）', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    service.onSessionDisposed(SESSION)
    assert.equal(service.tasks.size, 0)
    const dir = service.pathsOf(started).dir
    assert.ok((await stat(dir)).isDirectory(), '任务目录必须还在，等用户回来收尾')

    // 跨重启恢复：同一个会话再问一次，任务应该被重新认领。
    service.restoreAttempts.clear()
    const restored = await service.findTask(SESSION, workspace.root)
    assert.equal(restored.hash, started.hash)
    assert.equal(restored.round, 1)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('写探针自检失败时必须显形（绝不假装保护着）', async () => {
  const { service, fake, workspace, art } = await setup()
  try {
    // 用一个"位于文件内部"的路径做产物根：建档必然失败，等价于"宿主没有写权限"。
    // 这测的是**新**契约里的写探针（`probeWritable` / `resolveArtifactRoot`）：
    // 老测试调的是已经删掉的 `ensureWriteProbe`，它现在只会抛 TypeError。
    const blocker = join(art.base, 'blocker-file')
    await writeFile(blocker, 'x', 'utf8')
    const broken = join(blocker, 'nested')

    const probe = await service.probeWritable(broken)
    assert.equal(probe.ok, false)
    assert.ok(probe.error, '失败必须带上原因，否则面板只能说"不可用"')

    // 走到解析层：**两个候选**（临时根 / 回退根）都不可写 ⇒ 失败必须落进欠账，
    // 面板的 `detector.available` 与 `debts` 才有东西可显示。
    // 注意：跑在真宿主里的临时根默认是可写的，所以这里必须**把临时根也堵上**
    // （`tempDir` 指向一个文件内部），否则解析会正常选中临时根、断言必然落空。
    const blockedBase = join(art.base, 'blocked-temp-base')
    await writeFile(blockedBase, 'x', 'utf8')
    const blockedService = new DebugService(fake.ctx, { logger: fake.ctx.logger, tempDir: blockedBase })
    const blocked = await blockedService.resolveArtifactRoot(broken)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.kind, null)
    assert.ok(blockedService.debts.some((entry) => entry.key === 'write-probe'))
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('R5 欠账看板：列出未关闭的任务，收尾后消失，且绝不自动删目录', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const other = await createWorkspace({ 'src/b.js': 'export const b = 1\n' })
  const art = await createArtifactBase()
  const fake = createFakeContext({ cwd: workspace.root })
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger, tempDir: art.base })
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
    await art.cleanup()
  }
})

test('收尾时会备份被改写的文件（绝不自动还原，但要留可查的入口）', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    await workspace.write('src/app.js', `${probeBlock(started.hash, "probe('x')")}\nexport const a = 1\n`)
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: 'ok' })
    await service.resolve({ hash: started.hash, sessionId: SESSION })
    await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工' })

    // 任务目录已删，所以备份也随之消失——这是设计：任务关闭即删除。
    const dir = service.pathsOf(started).dir
    await assert.rejects(() => stat(dir))
    await rm(dir, { recursive: true, force: true })
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

/* ───────────────── 产物根：临时目录优先 / 回退 / 拒绝 / 粘性（§1.1 第 15 条） ───────────────── */

test('产物根 ①：默认选临时根，日志真的落在 <tempDir>/dsh-debug-mode 里', async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)

    // 为什么必须钉住：这是"产物不进工作区"的**唯一**可判定证据。老实现把它落在
    // `<ws>/.dsh/debug-mode/` 里，于是日志会跟着 git status 与编辑器索引跑。
    assert.equal(started.artifactRootKind, 'temp')
    // `artifactRoot` 是**产物根**（`<tempDir>/dsh-debug-mode`），`taskDir` 才是任务目录。
    // 两者别混：混了就会拼出 `…/tasks/<hash>/tasks/<hash>/…`（实现里真踩过一次）。
    assert.equal(started.artifactRoot, art.root)
    assert.equal(started.taskDir, join(art.root, 'tasks', started.hash))
    assert.equal(service.pathsOf(service.tasks.get(SESSION)).dir, started.taskDir)
    assert.ok((await stat(join(started.taskDir, `${started.hash}.log`))).isFile(),
      '日志文件必须真的落在临时产物根下')
    // 工作区里连 `.dsh/` 都不该出现。
    assert.equal(await readIfExists(join(workspace.root, '.dsh')), null)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('产物根 ②：临时根不可写 ⇒ 回退工作区，并且**出声**（notes + debts + 正文）', async () => {
  const { service, workspace, art } = await setup()
  try {
    // 用**同名文件**占位来制造"临时根建不出来"：跨平台可复现，不依赖 ACL / 只读挂载。
    await writeFile(art.root, '占用这个名字，让 mkdir 必失败', 'utf8')

    const started = await startTask(service, workspace)
    const root = service.legacyRoot(workspace.root)

    assert.equal(started.artifactRootKind, ARTIFACT_ROOT.WORKSPACE)
    assert.equal(started.artifactRoot, root)
    assert.equal(started.taskDir, join(root, 'tasks', started.hash))
    // 回退落点就是工作区里那个老位置，所以两个 `.gitignore` 必须被写出来：
    // 产物回到仓库里是**最不该静默发生**的事，而 `.gitignore` 是它唯一的护栏。
    assert.ok(await readIfExists(join(workspace.root, '.dsh', '.gitignore')) !== null, '.dsh/.gitignore 必须存在')
    assert.ok(await readIfExists(join(root, '.gitignore')) !== null, '回退根自己的 .gitignore 也必须存在')
    assert.match(started.text, /回退到.{0,4}工作区|回退到了工作区/, 'start 的返回正文必须说出回退')
    // 同一句说明要同时出现在三处：任务 notes、面板 debts、start 正文（§1.1 第 15 条）。
    const state = await service.panelState(SESSION)
    assert.ok(state.task.debts.some((reason) => /回退到工作区/.test(reason)), '回退必须进面板欠账')
    const task = service.tasks.get(SESSION)
    assert.ok((task.notes ?? []).some((note) => /回退/.test(note)), '回退必须进任务 notes')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('产物根 ③：两个根都不可写 ⇒ 拒绝启动，且**不消费票据**', async () => {
  const art = await createArtifactBase()
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  try {
    await writeFile(art.root, '占位：临时根建不出来', 'utf8')
    // 工作区回退根也建不出来：把"工作区"指到一个**文件内部**。
    const blocker = join(workspace.root, 'blocker-file')
    await writeFile(blocker, 'x', 'utf8')
    const brokenWorkspace = join(blocker, 'ws')

    const fake = createFakeContext({ cwd: workspace.root })
    const service = new DebugService(fake.ctx, { logger: fake.ctx.logger, tempDir: art.base })
    await service.issueTicket({ sessionId: SESSION, text: 'x', workspace: brokenWorkspace })
    const refused = await service.start({ sessionId: SESSION, goal: 'x', workspace: brokenWorkspace })

    assert.equal(refused.ok, false, '两个根都写不进去时必须拒绝，而不是假装能调试')
    assert.equal(refused.hash, '')
    // 两个候选路径都要给出来：只说"沙箱拒绝"等于让人自己去猜该改哪里。
    assert.ok(refused.text.includes(service.tempRoot()), '正文必须给出临时根路径')
    assert.ok(refused.text.includes(service.legacyRoot(brokenWorkspace)), '正文必须给出回退根路径')

    // 票据没被消费：换一个正常的工作区立刻就能起来（否则用户得重新敲一次 /debug）。
    const healthy = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
    try {
      const started = await service.start({ sessionId: SESSION, goal: 'x', workspace: healthy.root })
      assert.equal(started.ok, true, `票据不该被失败的那次消费掉：${started.text}`)
    } finally {
      await healthy.cleanup()
    }
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('产物根 ④：根的选择是**粘**的（同一 workspace 不会中途换根）', async () => {
  const { service, workspace, art } = await setup()
  try {
    // 先用文件占位 ⇒ 第一次解析必然回退。
    await writeFile(art.root, '占位', 'utf8')
    const first = await service.resolveArtifactRoot(workspace.root)
    assert.equal(first.ok, true)
    assert.equal(first.kind, ARTIFACT_ROOT.WORKSPACE)

    // 把占位文件删掉：临时根现在可写了，但**已经有任务落在回退根里**，
    // 中途换根会让同一份日志裂成两半（一半在临时目录、一半在仓库）。
    await rm(art.root, { force: true })
    const second = await service.resolveArtifactRoot(workspace.root)
    assert.equal(second.kind, first.kind, '中途换根 = 日志裂成两份')
    assert.equal(second.root, first.root)
  } finally {
    // 占位文件在 art.base 里，`art.cleanup()` 已经会带走它；这里显式再删一次是因为
    // 它是**文件**而不是目录，顺手也让"这一步到底留了什么"一眼可见。
    await rm(art.root, { force: true })
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('产物根 ⑤：走完整条流程，工作区里一个产物都不留（零外溢）', async () => {
  const { service, workspace, art } = await setup()
  try {
    const before = (await readdir(workspace.root, { recursive: true })).map((entry) => String(entry)).sort()
    const started = await startTask(service, workspace)
    // 第 1 轮只加探针（那一条改动会被收尾摘掉，所以最终快照仍应只有源码文件）。
    await workspace.write('src/app.js', [
      'const items = []',
      probeBlock(started.hash, "probe('src/app.js:1:items')"),
      'export function total() { return items.length }',
    ].join('\n'))

    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '空数组分支' })
    await service.resolve({ hash: started.hash, sessionId: SESSION })
    await service.continueDebug({ sessionId: SESSION, workspace: workspace.root, nextPlan: '换个假设' })
    await service.read({ sessionId: SESSION, workspace: workspace.root })
    // 再交卷一次，回到 awaiting-user，用户才能表态"已解决"（end 的前置）。
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第二轮' })
    await service.resolve({ hash: started.hash, sessionId: SESSION })
    const ended = await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工', verified: true })
    assert.equal(ended.ok, true, ended.text)

    assert.equal(await readIfExists(join(workspace.root, '.dsh')), null,
      '整条流程跑完，工作区里不该有 .dsh/ —— 产物全在用户临时目录里')
    const after = (await readdir(workspace.root, { recursive: true })).map((entry) => String(entry)).sort()
    // 快照只比**文件集合**：探针块被摘掉后内容会回到原样，但"多出来的文件"是可判定的。
    assert.deepEqual(after, before, '工作区根下的文件集合不该因为调试而变多')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('产物根 ⑥：旧任务（没有 artifactRoot 字段）按工作区解释，且能恢复、能收尾', async () => {
  const { service, workspace, art } = await setup()
  const hash = '0011aabb'
  const legacyDir = join(workspace.root, '.dsh', 'debug-mode', 'tasks', hash)
  try {
    // 手工造一份**旧形状**的 state.json：v0.18 及以前没有 artifactRoot / artifactRootKind。
    await mkdir(legacyDir, { recursive: true })
    const now = Date.now()
    await writeFile(join(legacyDir, 'state.json'), JSON.stringify({
      hash,
      sessionId: SESSION,
      workspace: workspace.root,
      goal: '升级前留下的在途任务',
      status: 'active',
      round: 1,
      createdAt: now,
      updatedAt: now,
      probeWrites: 0,
      probeFiles: [],
      changedFiles: [],
      probes: [],
      notes: [],
      evidence: { lastReportLines: 0, staleRounds: 0 },
    }, null, 2), 'utf8')

    const restored = await service.findTask(SESSION, workspace.root)
    assert.ok(restored, '旧任务必须能被恢复（否则升级会丢掉所有在途调试）')
    assert.equal(restored.hash, hash)
    assert.equal(restored.artifactRoot, undefined, '旧形状里本来就没有这个字段')
    // 缺省按 `workspace` 解释 ⇒ 绝对路径正好是升级前那个位置。
    assert.equal(service.artifactRootOf(restored), service.legacyRoot(workspace.root))
    assert.equal(service.pathsOf(restored).dir, legacyDir)

    // 再走一次 end：能把旧目录清掉（这是"旧任务不需要迁移"的全部意义）。
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '旧任务也能收尾' })
    await service.resolve({ hash, sessionId: SESSION })
    const ended = await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工旧任务' })
    assert.equal(ended.ok, true, ended.text)
    assert.equal(await readIfExists(join(legacyDir, 'state.json')), null, '旧任务目录必须随收尾一起消失')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('产物根 ⑦：哈希目录已存在就换一个（临时根是全局共享目录，跨仓库也会撞）', async () => {
  const taken = 'aaaaaaaa'
  let calls = 0
  const { service, workspace, art } = await setup({}, {
    createHash: () => {
      calls += 1
      return calls === 1 ? taken : createHash()
    },
  })
  try {
    // 预先占住第一个哈希的目录名（模拟另一个仓库的任务已经用它）。
    await mkdir(join(art.root, 'tasks', taken), { recursive: true })

    const started = await startTask(service, workspace)
    assert.notEqual(started.hash, taken, '撞上了就必须换一个哈希，否则会盖掉另一个任务的日志与 state.json')
    assert.match(started.hash, /^[0-9a-f]{8}$/)
    assert.equal(calls, 2, '第一次撞、第二次才成')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('产物根 ⑧：POSIX 权限——临时根 0700、日志 0600（/tmp 是全用户可写的）', { skip: process.platform === 'win32' }, async () => {
  const { service, workspace, art } = await setup()
  try {
    const started = await startTask(service, workspace)
    const rootMode = (await stat(art.root)).mode & 0o777
    assert.equal(rootMode, 0o700, `临时产物根必须是 0700，实际 ${rootMode.toString(8)}`)
    const logMode = (await stat(started.logPath)).mode & 0o777
    assert.equal(logMode, 0o600, `日志必须是 0600（探针日志不该给同机其他用户看），实际 ${logMode.toString(8)}`)
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})
