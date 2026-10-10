/**
 * test/wiring.test.mjs —— 宿主装配面的守卫：命令、路由、提示词段落。
 *
 * 这三处有一个共同点：**它们的行为是模型看不到的**。命令返回错了指令，模型只会
 * 一头雾水；提示词段落没判空，没进调试模式的会话会被注入"去埋点"；路由返回错了
 * 状态码，面板按钮就静默失效。所以它们必须在没有浏览器、没有真实宿主的情况下可测。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, SECTION_NAME, SECTION_ORDER } from '../lib/index.js'
import { registerDebugCommand, COMMAND_NAME } from '../lib/command.js'
import { ROUTE_PREFIX, registerRoutes } from '../lib/routes.js'
import { DebugService } from '../lib/debug-service.js'
import { debugCommandInstruction, debugGuidance } from '../lib/prompt.js'
import { createAgent, createFakeContext, createWorkspace } from './helpers.mjs'

const SESSION = 'session-aaaa'

/**
 * 造一个假的请求 / 响应，够跑通路由处理器。
 *
 * `done` 必须在工厂里就建好：有些分支（405、400）是**同步**应答的，
 * 在 `deliver()` 里才建 promise 就会永远等下去。
 */
function fakeHttp({ method = 'GET', url = '/', body } = {}) {
  const listeners = new Map()
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const req = {
    method,
    url,
    on(name, listener) {
      listeners.set(name, listener)
      return req
    },
  }
  const res = {
    statusCode: 200,
    headers: {},
    payload: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      this.payload = chunk ?? ''
      resolveDone()
    },
  }
  return {
    req,
    res,
    /** 把 body 事件与 end 事件送到处理器上，然后等应答。 */
    async deliver() {
      if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
      listeners.get('end')?.()
      await done
      return { status: res.statusCode, json: res.payload ? JSON.parse(res.payload) : null, headers: res.headers }
    },
  }
}

test('debugGuidance：无任务必须返回空串（否则没进调试的会话也会收到"去埋点"）', () => {
  assert.equal(debugGuidance(null), '')
  assert.equal(debugGuidance({}), '')

  const text = debugGuidance({ hash: 'deadbeef', round: 1, status: 'active' })
  assert.match(text, /deadbeef/)
  assert.match(text, /只读取证轮/, '第 1 轮必须明说"本轮不许改代码"')

  const second = debugGuidance({ hash: 'deadbeef', round: 2, status: 'active' })
  assert.match(second, /先按假设改代码/)
  assert.ok(!/只读取证轮/.test(second), '第 2 轮起不该再说"不许改代码"')
})

test('/debug 命令：签票 + 投递插件写死的指令正文', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const fake = createFakeContext({ cwd: workspace.root })
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger })
  try {
    registerDebugCommand(fake.ctx, service)
    assert.equal(fake.commands.length, 1)
    assert.equal(fake.commands[0].name, COMMAND_NAME)
    assert.equal(fake.commands[0].name, 'debug')
    assert.ok(fake.commands[0].input?.hint, '命令必须声明输入提示，否则用户不知道能写什么')

    const agent = createAgent({ id: SESSION, cwd: workspace.root })
    const result = await fake.commands[0].handler({
      agent,
      rawInput: '点了保存列表不刷新',
      commandId: 'c1',
      attachments: [],
    })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /点了保存列表不刷新/, '用户的描述必须原样带上（它是数据，不是指令）')
    assert.match(result.text, /dsh_debug_start/)
    assert.match(result.text, /不要调用 `dsh_debug_start`/, '必须告诉 Agent"一眼看出根因就别进调试"')

    // 票据确实签出来了。
    const ticket = await service.peekTicket(SESSION, workspace.root)
    assert.ok(ticket && ticket.text === '点了保存列表不刷新')

    // 已有活跃任务时，命令必须拒绝并点名既有哈希。
    await service.start({ sessionId: SESSION, goal: 'g', workspace: workspace.root })
    const second = await fake.commands[0].handler({ agent, rawInput: '再来一次' })
    assert.equal(second.kind, 'error')
    assert.match(second.text, /不要新开第二个任务/)
  } finally {
    await workspace.cleanup()
  }
})

test('debugCommandInstruction 在用户没写描述时仍然可执行（不猜现象）', () => {
  const text = debugCommandInstruction({ text: '', expiresInMinutes: 30 })
  assert.match(text, /请先用一句话向用户确认现象/)
  assert.match(text, /30 分钟/)
})

test('路由：/state 无任务也要 200；缺参数 400；/resolve 未知 hash 404；非 POST 405', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const fake = createFakeContext({ cwd: workspace.root })
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger })
  try {
    registerRoutes(fake.ctx, service)
    assert.deepEqual(fake.routes.map((route) => route.path), [
      `${ROUTE_PREFIX}/state`,
      `${ROUTE_PREFIX}/board`,
      `${ROUTE_PREFIX}/probe`,
      `${ROUTE_PREFIX}/resolve`,
      `${ROUTE_PREFIX}/reproduce`,
    ])
    assert.ok(fake.routes.every((route) => route.kind === 'exact'))

    const state = fake.routes.find((route) => route.path.endsWith('/state'))
    const noTask = fakeHttp({ url: `${ROUTE_PREFIX}/state?sessionId=${SESSION}` })
    state.handler(noTask.req, noTask.res)
    const noTaskResult = await noTask.deliver()
    assert.equal(noTaskResult.status, 200, '没有任务不是错误，面板靠这个区分"空"与"故障"')
    assert.deepEqual(noTaskResult.json, { task: null })
    assert.equal(noTaskResult.headers['Cache-Control'], 'no-store')

    const missing = fakeHttp({ url: `${ROUTE_PREFIX}/state` })
    state.handler(missing.req, missing.res)
    assert.equal((await missing.deliver()).status, 400)

    const resolve = fake.routes.find((route) => route.path.endsWith('/resolve'))
    const wrongMethod = fakeHttp({ method: 'GET', url: `${ROUTE_PREFIX}/resolve` })
    resolve.handler(wrongMethod.req, wrongMethod.res)
    assert.equal((await wrongMethod.deliver()).status, 405)

    const unknownHash = fakeHttp({ method: 'POST', url: `${ROUTE_PREFIX}/resolve`, body: { hash: 'ffffffff' } })
    resolve.handler(unknownHash.req, unknownHash.res)
    const unknown = await unknownHash.deliver()
    assert.equal(unknown.status, 404)
    assert.match(unknown.json.text, /没有哈希为 ffffffff 的任务/)

    const badBody = fakeHttp({ method: 'POST', url: `${ROUTE_PREFIX}/resolve` })
    resolve.handler(badBody.req, badBody.res)
    assert.equal((await badBody.deliver()).status, 400)
  } finally {
    await workspace.cleanup()
  }
})

test('路由：/reproduce 把用户选择变成 Agent 的下一轮输入（并保持幂等）', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const fake = createFakeContext({ cwd: workspace.root })
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger })
  try {
    registerRoutes(fake.ctx, service)
    await service.issueTicket({ sessionId: SESSION, text: 'x', workspace: workspace.root })
    const started = await service.start({ sessionId: SESSION, goal: 'x', workspace: workspace.root })
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第一轮' })

    const reproduce = fake.routes.find((route) => route.path.endsWith('/reproduce'))
    const call = () => {
      const http = fakeHttp({
        method: 'POST',
        url: `${ROUTE_PREFIX}/reproduce`,
        body: { hash: started.hash, sessionId: SESSION, note: '只在切换标签页后复现' },
      })
      reproduce.handler(http.req, http.res)
      return http.deliver()
    }

    const first = await call()
    assert.equal(first.status, 200)
    assert.equal(first.json.ok, true)
    assert.equal(first.json.delivered, true)
    assert.equal(fake.prompts.length, 1)
    assert.match(fake.prompts[0].content[0].text, /问题复现/)
    assert.match(fake.prompts[0].content[0].text, /只在切换标签页后复现/, 'note 必须随指令一起投给 Agent')

    const second = await call()
    assert.equal(second.status, 200)
    assert.equal(second.json.duplicate, true)
    assert.equal(fake.prompts.length, 1, '重复点击绝不能产生第二次 prompt')
  } finally {
    await workspace.cleanup()
  }
})

test('apply 装配：一个命令 + 五条路由；每个 agent 拿到 5 个工具与一个"按需非空"的提示词段落', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const fake = createFakeContext({ cwd: workspace.root })
  try {
    const service = apply(fake.ctx)
    assert.equal(fake.commands.length, 1)
    assert.equal(fake.routes.length, 5)

    // 装配时还没有 agent：既没有全局兜底注册，也没有凭空造段落。
    assert.equal(fake.toolRegistrations.length, 0)
    assert.equal(fake.sections.length, 0)

    fake.emit('agent/created', { agent: createAgent({ id: SESSION, cwd: workspace.root, mountCtx: fake.ctx }) })
    assert.equal(fake.toolRegistrations.length, 5, '工具必须注册到该会话的作用域里')
    assert.equal(fake.sections.length, 1)

    const section = fake.sections[0]
    assert.equal(section.name, SECTION_NAME)
    assert.equal(section.order, SECTION_ORDER)
    assert.equal(typeof section.text, 'function', 'text 必须是 thunk')
    assert.equal(section.text({}), '', '没有活跃任务时必须注入空串')

    await service.issueTicket({ sessionId: SESSION, text: 'x', workspace: workspace.root })
    await service.start({ sessionId: SESSION, goal: 'x', workspace: workspace.root })
    const withTask = section.text({})
    assert.match(withTask, /调试模式/)
    assert.equal(withTask.includes('deadbeef'), false)
    assert.match(withTask, /任务 [0-9a-f]{8}/, '任务活跃时必须真的给出准则')

    // 会话事件 → 状态自动迁移（§9.3.2）。
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '交卷' })
    assert.equal(service.tasks.get(SESSION).status, 'awaiting-user')
    fake.emit('session/event', { header: { id: SESSION } }, { type: 'user/message' })
    assert.equal(service.tasks.get(SESSION).status, 'active')
  } finally {
    await workspace.cleanup()
  }
})

test('apply 在拿不到 agent 作用域时退化为一次全局注册，并且只退一次', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const fake = createFakeContext({ cwd: workspace.root })
  const injected = []
  fake.ctx.inject = (keys, callback) => {
    injected.push(keys)
    callback(fake.ctx)
    return () => undefined
  }
  try {
    apply(fake.ctx)
    // 没有任何可挂载的 agent.ctx。
    const legacy = { id: SESSION, session: { header: { id: SESSION, cwd: workspace.root } } }
    fake.emit('agent/created', { agent: legacy })
    fake.emit('agent/created', { agent: { ...legacy, id: 'session-bbbb' } })
    assert.equal(injected.length, 1, '兜底只能注册一次，否则会重复注册五个工具')
    assert.equal(fake.toolRegistrations.length, 5)
    assert.ok(fake.warnings.some((message) => /退化为全局注册/.test(message)), '降级必须说出来')
  } finally {
    await workspace.cleanup()
  }
})

test('reproduce 在任务已结束后返回 409（面板不会因为过期的 hash 反复失败）', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const fake = createFakeContext({ cwd: workspace.root })
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger })
  try {
    registerRoutes(fake.ctx, service)
    const result = await service.reproduce({ hash: 'deadbeef', sessionId: SESSION })
    assert.equal(result.ok, false)
    assert.equal(result.code, 404)

    await service.issueTicket({ sessionId: SESSION, text: 'x', workspace: workspace.root })
    const started = await service.start({ sessionId: SESSION, goal: 'x', workspace: workspace.root })
    const wrongSession = await service.resolve({ hash: started.hash, sessionId: 'session-other' })
    assert.equal(wrongSession.ok, false)
    assert.equal(wrongSession.code, 403, 'A 会话的任务不许被 B 会话关掉')

    // 不在 awaiting-user 窗口里也不接受（active 时用户抢答）。
    const tooEarly = await service.resolve({ hash: started.hash, sessionId: SESSION })
    assert.equal(tooEarly.ok, false)
    assert.equal(tooEarly.code, 409)
  } finally {
    await workspace.cleanup()
  }
})
