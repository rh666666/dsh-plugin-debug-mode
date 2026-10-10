/**
 * test/ingest.test.mjs —— HTTP 探针通道的守卫（DESIGN.md §7.6）。
 *
 * 这条通道存在的唯一理由是：**调试模式不该需要任何命令**。
 * 浏览器页面（`file://`）既不能 import Node 桩、也没有文件系统；过去唯一的出路是
 * "起个本地服务器把页面伺服出来"——那要跑命令，于是在被沙箱挡住的环境里，
 * 整个调试流程从第一步就走不动。
 *
 * 所以要钉住的是三件事：
 *   1. 页面能真的把记录送到宿主，并且**落的还是同一份协议**（字段序由宿主说了算）；
 *   2. 投递方**不能**借这条通道写别的东西（哈希必须属于活跃任务，`task` 由宿主写死）；
 *   3. 限额与 Node 桩一致（单行 8 KiB、总量 16 MiB）。
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

import { DebugService, normalizeProbePayload, LOG_WARN_BYTES } from '../lib/debug-service.js'
import { renderBrowserStub, renderHttpGuide } from '../lib/probe-template.js'
import { RECORD_FIELDS, byteLength, parseLog } from '../lib/protocol.js'
import { ROUTE_PREFIX, registerRoutes } from '../lib/routes.js'
import { createFakeContext, createWorkspace } from './helpers.mjs'

const SESSION = 'session-aaaa'

/** 起服务并开一个任务；返回 { service, fake, workspace, task }。 */
async function setupTask() {
  const workspace = await createWorkspace({
    'src/app.js': 'export const a = 1\n',
    'buggy-demo.html': '<html><body><button id="add">+</button></body></html>\n',
  })
  const fake = createFakeContext({ cwd: workspace.root })
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger })
  await service.issueTicket({ sessionId: SESSION, text: '页面上的按钮点了没反应', workspace: workspace.root })
  const started = await service.start({ sessionId: SESSION, goal: '页面上的按钮点了没反应', workspace: workspace.root })
  assert.equal(started.ok, true, started.text)
  return { service, fake, workspace, started }
}

/** 极简 req/res 替身（与 wiring 测试同形，这里只有摄入路由需要）。 */
function fakeHttp({ method = 'POST', url = '/', body, contentType = 'text/plain;charset=utf-8' } = {}) {
  const listeners = new Map()
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const req = {
    method,
    url,
    headers: { 'content-type': contentType },
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
    async deliver() {
      if (body !== undefined) {
        const raw = typeof body === 'string' ? body : JSON.stringify(body)
        listeners.get('data')?.(Buffer.from(raw, 'utf8'))
      }
      listeners.get('end')?.()
      await done
      return { status: res.statusCode, json: res.payload ? JSON.parse(res.payload) : null, headers: res.headers }
    },
  }
}

test('normalizeProbePayload 三种形态都认，认不出来就返回空（绝不猜）', () => {
  assert.deepEqual(normalizeProbePayload({ probe: 'a' }), [{ probe: 'a' }])
  assert.deepEqual(normalizeProbePayload([{ probe: 'a' }, { probe: 'b' }]).length, 2)
  assert.deepEqual(normalizeProbePayload('{"probe":"a"}'), [{ probe: 'a' }])
  assert.deepEqual(normalizeProbePayload('{"probe":"a"}\n{"probe":"b"}\n'), [{ probe: 'a' }, { probe: 'b' }])
  assert.deepEqual(normalizeProbePayload('这不是 JSON'), [])
  assert.deepEqual(normalizeProbePayload(null), [])
  assert.deepEqual(normalizeProbePayload(42), [])
})

test('ingestProbe：落盘用同一份协议，task 由宿主写死，ts 缺失时由宿主补', async () => {
  const { service, workspace, started } = await setupTask()
  try {
    const result = await service.ingestProbe({
      hash: started.hash,
      payload: '{"probe":"buggy-demo.html:42:click","level":"warn","msg":"点了","data":{"n":1}}\n',
    })
    assert.equal(result.ok, true)
    assert.equal(result.accepted, 1)
    assert.equal(result.rejected, 0)

    const raw = (await readFile(join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, `${started.hash}.log`), 'utf8')).trimEnd()
    const parsed = JSON.parse(raw)
    // 	runcated 是可选字段：这条没被降级，就不该出现。RECORD_FIELDS 里的位置仍然钉住顺序。
      assert.deepEqual(Object.keys(parsed), RECORD_FIELDS.filter((field) => field !== 'truncated'), '字段序必须与冻结协议逐字一致')
    assert.equal(parsed.task, started.hash, 'task 必须由宿主写死')
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, 'ts 由宿主补')
    assert.equal(parsed.probe, 'buggy-demo.html:42:click')
    assert.deepEqual(parsed.data, { n: 1 })

    // 投递方谎报 task 与 ts 都不算数：task 被覆盖；ts 只有合法字符串才采信。
    await service.ingestProbe({
      hash: started.hash,
      payload: [{ task: 'ffffffff', ts: '2020-01-01T00:00:00.000+00:00', probe: 'x:1:y' }],
    })
    const { records } = parseLog(await readFile(
      join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, `${started.hash}.log`), 'utf8',
    ))
    assert.equal(records.length, 2)
    assert.equal(records[1].task, started.hash, '投递方谎报的 task 必须被覆盖')
    assert.equal(records[1].ts, '2020-01-01T00:00:00.000+00:00', '合法 ts 可以采信（跨进程时序要保留）')
  } finally {
    await workspace.cleanup()
  }
})

test('ingestProbe：脏记录被计数拒绝，但没有 probe 的整批不会污染日志', async () => {
  const { service, workspace, started } = await setupTask()
  try {
    const result = await service.ingestProbe({
      hash: started.hash,
      payload: [{ probe: 'ok:1:a' }, { nope: true }, { probe: '' }, 'not-an-object'],
    })
    assert.equal(result.accepted, 1)
    assert.equal(result.rejected, 3)

    const empty = await service.ingestProbe({ hash: started.hash, payload: 'not json at all' })
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 400)
    assert.equal(empty.accepted, 0)

    const { records, dirtyLines } = parseLog(await readFile(
      join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, `${started.hash}.log`), 'utf8',
    ))
    assert.equal(records.length, 1)
    assert.equal(dirtyLines, 0, '宿主自己序列化 ⇒ 永远不写脏行')
  } finally {
    await workspace.cleanup()
  }
})

test('ingestProbe：只认活跃任务的哈希（投递方不能借它写别的地方）', async () => {
  const { service, workspace, started } = await setupTask()
  try {
    const unknown = await service.ingestProbe({ hash: 'ffffffff', payload: { probe: 'x' } })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 404)

    const malformed = await service.ingestProbe({ hash: '../../etc/passwd', payload: { probe: 'x' } })
    assert.equal(malformed.ok, false)
    assert.equal(malformed.code, 400)

    const traversal = await service.ingestProbe({ hash: 'aabbccdd\n', payload: { probe: 'x' } })
    assert.equal(traversal.ok, false)

    // 收尾之后同一个哈希立刻失效。
    await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: 'ok' })
    await service.resolve({ hash: started.hash, sessionId: SESSION })
    await service.end({ sessionId: SESSION, workspace: workspace.root, summary: '收工' })
    const afterClose = await service.ingestProbe({ hash: started.hash, payload: { probe: 'x' } })
    assert.equal(afterClose.ok, false)
    assert.equal(afterClose.code, 404, '任务目录已删 ⇒ 找不到任务')
  } finally {
    await workspace.cleanup()
  }
})

test('ingestProbe：单行超 8 KiB 截断并标 truncated；到 16 MiB 只写一条 overflow', async () => {
  const { service, workspace, started } = await setupTask()
  const logAbs = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, `${started.hash}.log`)
  try {
    await service.ingestProbe({
      hash: started.hash,
      payload: [{ probe: 'big:1:x', msg: 'x'.repeat(20_000) }],
    })
    const line = (await readFile(logAbs, 'utf8')).trimEnd()
    assert.ok(line.length <= 8 * 1024 + 64, `单行必须被截断到 8 KiB 附近，实际 ${line.length}`)
    assert.ok(line.endsWith('}'))

    // 把日志垫到上限，再投一批。
    const { writeFile } = await import('node:fs/promises')
    await writeFile(logAbs, Buffer.alloc(LOG_WARN_BYTES, 0x0a))
    const before = (await stat(logAbs)).size
    const first = await service.ingestProbe({ hash: started.hash, payload: [{ probe: 'after:1:x' }] })
    assert.equal(first.ok, true)
    const afterFirst = (await stat(logAbs)).size
    assert.ok(afterFirst > before, '到顶时必须留下一条 overflow 说明')
    assert.match(await readFile(logAbs, 'utf8'), /debug-mode:overflow/)

    const second = await service.ingestProbe({ hash: started.hash, payload: [{ probe: 'after:2:x' }] })
    const afterSecond = (await stat(logAbs)).size
    assert.ok(afterSecond >= afterFirst)
    assert.equal(second.accepted, 0, '到顶之后停止接收，绝不把磁盘写满')
    assert.ok(service.debts.some((entry) => entry.key === `log-size:${started.hash}`), '到顶要写进欠账')
  } finally {
    await workspace.cleanup()
  }
})

test('摄入路由：CORS 头齐全、OPTIONS 预检 204、GET 自检、非法方法 405、体过大 400', async () => {
  const { service, fake, workspace, started } = await setupTask()
  try {
    registerRoutes(fake.ctx, service)
    const route = fake.routes.find((item) => item.path === `${ROUTE_PREFIX}/probe`)
    assert.ok(route, '必须注册 /probe 路由')

    const preflight = fakeHttp({ method: 'OPTIONS', url: `${ROUTE_PREFIX}/probe?h=${started.hash}` })
    route.handler(preflight.req, preflight.res)
    const preflightResult = await preflight.deliver()
    // 预检可以是 204：它本来就不带体。
    assert.equal(preflightResult.status, 204)
    assert.equal(preflightResult.headers['Access-Control-Allow-Origin'], '*')
    assert.match(preflightResult.headers['Access-Control-Allow-Methods'], /POST/)

    // GET = 通道自检：**在让用户复现之前**就能回答"通道活着吗"。
    const handshake = fakeHttp({ method: 'GET', url: `${ROUTE_PREFIX}/probe?h=${started.hash}` })
    route.handler(handshake.req, handshake.res)
    const handshakeResult = await handshake.deliver()
    assert.equal(handshakeResult.status, 200)
    assert.equal(handshakeResult.json.ok, true)
    assert.equal(handshakeResult.json.hash, started.hash)
    assert.equal(handshakeResult.json.httpRecords, 0, '还没发过记录')
    assert.equal(handshakeResult.headers['Access-Control-Allow-Origin'], '*')
    assert.match(handshakeResult.json.hint, /通道是通的/)

    const unknown = fakeHttp({ method: 'GET', url: `${ROUTE_PREFIX}/probe?h=ffffffff` })
    route.handler(unknown.req, unknown.res)
    assert.equal((await unknown.deliver()).status, 404)

    const wrongMethod = fakeHttp({ method: 'PUT', url: `${ROUTE_PREFIX}/probe?h=${started.hash}` })
    route.handler(wrongMethod.req, wrongMethod.res)
    const wrongResult = await wrongMethod.deliver()
    assert.equal(wrongResult.status, 405)
    assert.match(wrongResult.json.reason, /GET.*自检/)

    const missingHash = fakeHttp({ url: `${ROUTE_PREFIX}/probe`, body: '{"probe":"x"}' })
    route.handler(missingHash.req, missingHash.res)
    const missing = await missingHash.deliver()
    assert.equal(missing.status, 400)
    assert.equal(missing.headers['Access-Control-Allow-Origin'], '*', '失败响应也要带 CORS 头，否则页面只看到网络错误')

    const ok = fakeHttp({
      url: `${ROUTE_PREFIX}/probe?h=${started.hash}`,
      body: '{"probe":"buggy-demo.html:7:add"}\n{"probe":"buggy-demo.html:8:render"}\n',
    })
    route.handler(ok.req, ok.res)
    const accepted = await ok.deliver()
    // 200 而不是 204：响应体（accepted/rejected）是投递方唯一的自检依据，
    // 而 204 按 HTTP 规范不许带体（严格客户端会拒绝读取）。
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.accepted, 2)

    // 发过记录之后，自检必须如实反映"通道送进来过东西"。
    const after = fakeHttp({ method: 'GET', url: `${ROUTE_PREFIX}/probe?h=${started.hash}` })
    route.handler(after.req, after.res)
    const afterResult = await after.deliver()
    assert.equal(afterResult.json.httpRecords, 2)
    assert.ok(afterResult.json.httpLastAt > 0)
    assert.equal(afterResult.json.logLines, 2)

    const tooBig = fakeHttp({ url: `${ROUTE_PREFIX}/probe?h=${started.hash}`, body: 'x'.repeat(70 * 1024) })
    route.handler(tooBig.req, tooBig.res)
    assert.equal((await tooBig.deliver()).status, 400)
  } finally {
    await workspace.cleanup()
  }
})

test('浏览器桩：在 vm 沙箱里真的按同一协议发出一条记录（sendBeacon 优先，fetch 兜底）', async () => {
  const endpoint = 'http://127.0.0.1:19387/dsh-debug-mode/probe?h=deadbeef'
  const source = await renderBrowserStub({ hash: 'deadbeef', endpoint })
  assert.ok(!source.includes('__DSH_TASK__'), '锚点必须被替换')
  assert.ok(!source.includes('__DSH_ENDPOINT__'))
  assert.ok(source.includes('"deadbeef"'))

  /** 造一个最小浏览器环境，捕获 sendBeacon 的 blob 内容。 */
  const run = (options = {}) => {
    const beacons = []
    const fetches = []
    const timers = []
    const sandbox = {
      console,
      Blob: class {
        constructor(parts) { this.parts = parts }
        text() { return this.parts.join('') }
      },
      // 定时器替身要真的记住"被取消了"：桩在加载时会先 schedule 一次、再立刻 flush，
      // 那次 clearTimeout 如果不生效，测试就会去调用一个早被取消的定时器。
      setTimeout: (fn, ms) => { const handle = { fn, ms, cancelled: false }; timers.push(handle); return handle },
      clearTimeout: (handle) => { if (handle) handle.cancelled = true },
      navigator: {
        sendBeacon: options.beaconFails
          ? () => false
          : (url, blob) => { beacons.push({ url, payload: blob.parts.join('') }); return true },
      },
      fetch: (url, init) => { fetches.push({ url, init }); return Promise.resolve({}) },
    }
    sandbox.globalThis = sandbox
    runInContext(source, createContext(sandbox), { filename: 'probe.browser.js' })
    return { sandbox, beacons, fetches, timers }
  }

  const { sandbox, beacons, timers } = run()
  assert.equal(typeof sandbox.dshProbe, 'function', '经典脚本要挂在全局上（页面不能 import 它）')

  // ★ 加载即报到：脚本一执行就该发出一条 `debug-mode:ready`（并且立刻冲刷）。
  // 这一条同时证明「桩加载了」与「通道是通的」——没有它，"通道死了"和"埋点没执行"
  // 的现象一模一样（日志一片空白）。所以它必须是**不需要页面显式调用**的。
  assert.equal(beacons.length, 1, 'ready 记录必须在加载时立刻发出，不等 200ms 批量')
  const ready = JSON.parse(beacons[0].payload.trimEnd())
  assert.equal(ready.probe, 'debug-mode:ready')
  assert.equal(ready.data.runtime, 'browser')

  sandbox.dshProbe('buggy-demo.html:42:onclick', { itm: 'undefined', list: 3 }, { level: 'warn', msg: '点了' })
  const live = timers.filter((handle) => !handle.cancelled)
  assert.equal(live.length, 1, '批量发送：业务探针先排队，不逐条打网络')
  live[0].fn()

  assert.equal(beacons.length, 2)
  assert.equal(beacons[1].url, endpoint)
  const line = beacons[1].payload.trimEnd()
  assert.deepEqual(Object.keys(JSON.parse(line)), RECORD_FIELDS.filter((field) => field !== 'truncated'), '浏览器桩与协议模块的字段序必须一致（truncated 只在降级时出现）')
  const record = JSON.parse(line)
  assert.equal(record.task, 'deadbeef')
  assert.equal(record.probe, 'buggy-demo.html:42:onclick')
  assert.equal(record.level, 'warn')
  assert.equal(record.msg, '点了')
  assert.deepEqual(record.data, { itm: 'undefined', list: 3 })

  // sendBeacon 不可用时退回 fetch（仍是 CORS 简单请求：text/plain + no-cors）。
  const fallback = run({ beaconFails: true })
  assert.equal(fallback.fetches.length, 1, 'ready 那条在加载时就走 fetch 兜底')
  assert.equal(fallback.fetches[0].init.method, 'POST')
  assert.equal(fallback.fetches[0].init.mode, 'no-cors')
  assert.match(fallback.fetches[0].init.headers['content-type'], /text\/plain/)
  assert.equal(JSON.parse(String(fallback.fetches[0].init.body).trimEnd()).probe, 'debug-mode:ready')

  // 批量：一次 POST 可以带多条（NDJSON，一行一条）。
  fallback.sandbox.dshProbe('a:1:b')
  fallback.sandbox.dshProbe('a:2:c', { n: 2 })
  fallback.sandbox.dshProbe.flush()
  assert.equal(fallback.fetches.length, 2)
  const batched = String(fallback.fetches[1].init.body).trimEnd().split('\n')
  assert.equal(batched.length, 2, '批量：NDJSON 一行一条')
  assert.equal(JSON.parse(batched[0]).probe, 'a:1:b')
  assert.equal(JSON.parse(batched[1]).probe, 'a:2:c')
  assert.deepEqual(JSON.parse(batched[1]).data, { n: 2 })

  // 探针不许把页面搞挂：任何坏负载都安静降级。
  const hostile = run()
  const cyclic = { name: 'c' }
  cyclic.self = cyclic
  assert.doesNotThrow(() => {
    hostile.sandbox.dshProbe('x:1:y', cyclic)
    hostile.sandbox.dshProbe('x:2:y', undefined)
    hostile.sandbox.dshProbe(undefined, undefined)
  })
  assert.doesNotThrow(() => hostile.sandbox.dshProbe.flush())
})

test('多语言片段：占位符全部替换、锚点缺失即抛错（别让 Agent 照着字面量埋点）', async () => {
  const guide = await renderHttpGuide({
    hash: 'deadbeef',
    endpoint: 'http://127.0.0.1:19387/dsh-debug-mode/probe?h=deadbeef',
    logPath: '/repo/.dsh/debug-mode/tasks/deadbeef/deadbeef.log',
    probeStub: '/repo/.dsh/debug-mode/tasks/deadbeef/runtime/probe.mjs',
  })
  assert.ok(!guide.includes('{{'), '不得残留占位符')
  assert.ok(guide.includes('?h=deadbeef'), '端点必须烘死进去')
  assert.ok(guide.includes('/.dsh/debug-mode/tasks/deadbeef/deadbeef.log'))
  // 这份文件的全部意义：**语言无关**。所以常见语言都得有现成片段。
  for (const language of ['curl', 'Python', 'Node.js', 'Ruby', 'Go', 'PHP', 'PowerShell', 'Java']) {
    assert.ok(guide.includes(language), `片段里缺 ${language}`)
  }
  // 而且要写清"宿主替你管掉了什么"——否则 Agent 还是会去手写那些逻辑。
  assert.match(guide, /你\*\*不需要\*\*做的事/)
  // ts 的**双向**契约都要写清（v0.17 纠正过：不是"投递方伪造无效"）：
  // 省略 ⇒ 宿主补到达时刻；提供 ⇒ 采纳（批量投递靠它保住事件时刻）。
  assert.match(guide, /省略 `ts` 就补到达时刻/)
  assert.match(guide, /想给\*\*事件时刻\*\*就自己传 `ts`/)
  // 回执里那三个数字是唯一的自检依据，别丢。
  assert.match(guide, /response\.read\(\)/, 'Python 片段必须读回执，不能 urlopen(...).close()')
  assert.match(guide, /accepted/)

  await assert.rejects(
    () => renderHttpGuide({ template: '# 什么都没有', hash: 'x', endpoint: 'y', logPath: 'z', probeStub: 'w' }),
    /placeholder missing/,
  )
})

test('通道自检（probeStatus）：报出通道收过多少条，并给一句可照做的提示', async () => {
  const { service, workspace, started } = await setupTask()
  try {
    const before = await service.probeStatus(started.hash)
    assert.equal(before.ok, true)
    assert.equal(before.httpRecords, 0)
    assert.equal(before.logLines, 0)
    assert.match(before.hint, /还没有记录送进来/)

    // 最小调用：**只有 probe 一个字段**——任何语言写一行 JSON 就能埋点，这就是"统一入口"。
    const minimal = await service.ingestProbe({ hash: started.hash, payload: '{"probe":"app.py:1:x"}' })
    assert.equal(minimal.accepted, 1)

    const after = await service.probeStatus(started.hash)
    assert.equal(after.httpRecords, 1)
    assert.ok(after.httpLastAt > 0)
    assert.equal(after.logLines, 1)
    assert.match(after.hint, /已经送进来过 1 条/)

    assert.equal((await service.probeStatus('ffffffff')).code, 404)
    assert.equal((await service.probeStatus('not-a-hash')).code, 400)
  } finally {
    await workspace.cleanup()
  }
})

test('report 把通道状态摆出来：日志为空时"通道没通"与"用户还没复现"必须能区分', async () => {
  const { service, workspace, started } = await setupTask()
  try {
    const report = await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第一轮' })
    assert.equal(report.ok, true)
    // 宿主**只知道**自己经 HTTP 收到了几条；文件桩是直接写文件的，宿主看不见——
    // 所以它报"本轮日志 N 行"，不把 N 冒充成"文件桩写入条数"。
    assert.match(report.text, /探针通道：HTTP 累计收到 0 条 · 本轮日志 0 行/)
    assert.match(report.text, /本轮日志还是空的/)
    assert.match(report.text, /还从未被验证过/, '通道没被验证过时必须点名，否则会白等一整轮')
    assert.match(report.text, /GET/, '要告诉 Agent 怎么自检')
    assert.match(report.text, /输入框上方的两个按钮/, '面板在输入框上方，文案不能还写着下方')

    // 通过 HTTP 送一条进去之后，通道状态必须反映出来。
    await service.ingestProbe({ hash: started.hash, payload: { probe: 'app.py:9:y' } })
    await service.reproduce({ hash: started.hash, sessionId: SESSION })
    // 先读再 continue：这正是闸门 C 要求的顺序（没读过的字节不许被清掉）。
    await service.read({ sessionId: SESSION, workspace: workspace.root })
    const moved = await service.continueDebug({ sessionId: SESSION, workspace: workspace.root, nextPlan: 'x' })
    assert.equal(moved.ok, true, moved.text)
    const second = await service.report({ sessionId: SESSION, workspace: workspace.root, analysis: '第二轮' })
    // 第二轮：HTTP 计数是**累计值**（1），日志行数是**本轮**的（continue 已清空 ⇒ 0）。
    // 这两个数字放在一起看着"矛盾"，其实是两件事——所以措辞必须把它们分开说。
    assert.match(second.text, /探针通道：HTTP 累计收到 1 条 · 本轮日志 0 行/)
    assert.match(second.text, /通道是通的；空的是\*\*这一轮\*\*/, '通道已被证明过时，提示必须换成另一个方向')
    assert.ok(!/还从未被验证过/.test(second.text), '通道已经验证过了，不该再念那段自检话')
  } finally {
    await workspace.cleanup()
  }
})

test('端点来源：DSH_WEB_URL 优先，其次是 webServer.port（权威且总在手里）', async () => {
  const previous = process.env.DSH_WEB_URL
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  try {
    // ① 两个都有时，环境变量优先（部署可能把它改成代理/隧道地址）。
    process.env.DSH_WEB_URL = 'https://debug.example.com'
    const envFirst = new DebugService(createFakeContext({ cwd: workspace.root, webPort: 19387 }).ctx)
    assert.equal(envFirst.endpointBase(), 'https://debug.example.com')
    assert.equal(envFirst.probeEndpoint('deadbeef'), 'https://debug.example.com/dsh-debug-mode/probe?h=deadbeef')

    // ② 没有环境变量 ⇒ 用 webServer.port 拼回环地址。这正是"Agent 知道 origin
    //    却不知道路径"那件事的正解：地址本来就在插件自己手里。
    delete process.env.DSH_WEB_URL
    const ported = new DebugService(createFakeContext({ cwd: workspace.root, webPort: 19387 }).ctx)
    assert.equal(ported.endpointBase(), 'http://127.0.0.1:19387')
    assert.equal(ported.probeEndpoint('deadbeef'), 'http://127.0.0.1:19387/dsh-debug-mode/probe?h=deadbeef')

    // ③ 两个都没有 ⇒ null（绝不猜端口），由调用方明说。
    const bare = new DebugService(createFakeContext({ cwd: workspace.root }).ctx)
    assert.equal(bare.endpointBase(), null)
    assert.equal(bare.probeEndpoint('deadbeef'), null)

    // ④ 非法端口同样不猜。
    const bogus = new DebugService(createFakeContext({ cwd: workspace.root, webPort: 70000 }).ctx)
    assert.equal(bogus.endpointBase(), null)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_URL
    else process.env.DSH_WEB_URL = previous
    await workspace.cleanup()
  }
})

test('宿主摄入路径**不许有任何静默截断**：要么值完整，要么带 truncated 标记', async () => {
  const { service, workspace, started } = await setupTask()
  const logAbs = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash, `${started.hash}.log`)
  try {
    // 实测踩过的坑（v0.16）：`ingestProbe` 里曾有两条**没写进任何文档**的预截断——
    // `probe.slice(0, 200)` 与 `msg.slice(0, 2000)`。于是 10000 字符的 msg 被悄悄砍到
    // 2000，**8000 字符无声消失且没有任何标记**；而那一行只有 ~2 KB、根本没碰到 8 KiB
    // 上限，所以从"行是否超限"这个角度看一切正常（这就是它为什么能藏住）。
    // 更糟的是 Node 桩**没有**这两条预截断，同一条记录走文件桩会正确标 truncated——
    // 同一个协议在三处实现上给出不同结果。
    const cases = [
      { label: '长 msg @10000', payload: { probe: 'p:msg', msg: 'M'.repeat(10000) } },
      { label: '长 msg @10000 中文', payload: { probe: 'p:msg-zh', msg: '中'.repeat(10000) } },
      { label: '长 msg @30000', payload: { probe: 'p:msg-3w', msg: 'M'.repeat(30000) } },
      { label: '长 data', payload: { probe: 'p:data', data: { v: 'x'.repeat(20000) } } },
    ]

    for (const item of cases) {
      const receipt = await service.ingestProbe({ hash: started.hash, payload: item.payload })
      assert.equal(receipt.accepted, 1, `${item.label}: 必须被接受`)
      const { records, dirtyLines } = parseLog(await readFile(logAbs, 'utf8'))
      assert.equal(dirtyLines, 0, `${item.label}: 不许有脏行`)
      const record = records[records.length - 1]
      // 直接量**落盘那一行**的字节数（不是重新序列化估的）。
      const lineBytes = byteLength(await lastRawLine(logAbs))
      assert.ok(lineBytes <= 8 * 1024, `${item.label}: 单行不许超 8 KiB（实测 ${lineBytes}）`)

      const sentMsg = item.payload.msg
      if (sentMsg !== undefined && record.msg.length < sentMsg.length) {
        // 值被砍过 ⇒ **必须**有标记，且值里要写清省略了多少。
        assert.equal(record.truncated, true, `${item.label}: 砍了字符却没有截断标记（静默丢失）`)
        assert.match(record.msg, /省略 \d+ 字符/, `${item.label}: 值里要说清省略了多少`)
      }
    }

    // probe 标识同样不许被静默砍——它是分组计数的键，砍了会让两组悄悄合并成一组。
    const longProbe = `p:${'z'.repeat(500)}`
    await service.ingestProbe({ hash: started.hash, payload: { probe: longProbe } })
    const after = parseLog(await readFile(logAbs, 'utf8'))
    assert.equal(after.records[after.records.length - 1].probe, longProbe, '长 probe 标识不该被静默砍短')
  } finally {
    await workspace.cleanup()
  }
})

/** 日志最后一行**原文**（不含换行）——用来量真实落盘的字节数。 */
async function lastRawLine(logAbsolute) {
  const raw = (await readFile(logAbsolute, 'utf8')).trimEnd()
  return raw.slice(raw.lastIndexOf('\n') + 1)
}

test('start 会写出浏览器桩与多语言片段并把端点交给 Agent；端点未知时不写假地址', async () => {
  const { service, workspace, started } = await setupTask()
  const previous = process.env.DSH_WEB_URL
  try {
    const dir = join(workspace.root, '.dsh', 'debug-mode', 'tasks', started.hash)
    const guide = await readFile(join(dir, 'AGENT-PROBE-GUIDE.md'), 'utf8')
    // 指南里的两个新变量都必须被替换掉（残留占位符 = Agent 会照着字面量干活）。
    assert.ok(!guide.includes('{{'), '指南不得残留占位符')
    assert.match(guide, /不要运行任何命令/)

    if (previous && /^https?:\/\//i.test(previous)) {
      const stub = await readFile(join(dir, 'runtime', 'probe.browser.js'), 'utf8')
      assert.ok(!stub.includes('__DSH_ENDPOINT__'))
      assert.ok(stub.includes(`${previous.replace(/\/+$/, '')}${ROUTE_PREFIX}/probe?h=${started.hash}`),
        '端点必须是宿主的绝对地址（页面在 file:// 下，相对路径到不了宿主）')
      // 多语言片段也必须生成，并且端点/哈希都烘死好了。
      const snippets = await readFile(join(dir, 'runtime', 'probe.http.md'), 'utf8')
      assert.ok(!snippets.includes('{{'), '片段不得残留占位符')
      assert.ok(snippets.includes(`?h=${started.hash}`))
      assert.match(started.text, /HTTP 摄入端点/)
      assert.match(started.text, /浏览器探针桩/)
      assert.match(started.text, /埋点优先走 HTTP 通道/, 'start 的返回值必须把 HTTP 摆在首选位置')
      assert.match(started.text, /自检/, '并且提醒先自检再让用户复现')
    } else {
      // 端口未知时**不写一个猜的地址**：猜错的后果是探针静默丢失，
      // 那正是这个插件最不能接受的失败方式——所以宁可不生成，也要明说。
      const stubExists = await readFile(join(dir, 'runtime', 'probe.browser.js'), 'utf8').then(() => true, () => false)
      assert.equal(stubExists, false, '宿主地址未知时不该生成一个端点填错的桩')
      const snippetsExist = await readFile(join(dir, 'runtime', 'probe.http.md'), 'utf8').then(() => true, () => false)
      assert.equal(snippetsExist, false, '同理：多语言片段也不该带着假端点生成')
      assert.match(started.text, /宿主地址未知/)
      assert.match(guide, /宿主地址未知/)
    }
  } finally {
    await workspace.cleanup()
  }
})
