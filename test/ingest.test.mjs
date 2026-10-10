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
import { renderBrowserStub } from '../lib/probe-template.js'
import { RECORD_FIELDS, parseLog } from '../lib/protocol.js'
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
    assert.deepEqual(Object.keys(parsed), RECORD_FIELDS, '字段序必须与冻结协议逐字一致')
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

test('摄入路由：CORS 头齐全、OPTIONS 预检 204、非 POST 405、体过大 400', async () => {
  const { service, fake, workspace, started } = await setupTask()
  try {
    registerRoutes(fake.ctx, service)
    const route = fake.routes.find((item) => item.path === `${ROUTE_PREFIX}/probe`)
    assert.ok(route, '必须注册 /probe 路由')

    const preflight = fakeHttp({ method: 'OPTIONS', url: `${ROUTE_PREFIX}/probe?h=${started.hash}` })
    route.handler(preflight.req, preflight.res)
    const preflightResult = await preflight.deliver()
    assert.equal(preflightResult.status, 204)
    assert.equal(preflightResult.headers['Access-Control-Allow-Origin'], '*')
    assert.match(preflightResult.headers['Access-Control-Allow-Methods'], /POST/)

    const wrongMethod = fakeHttp({ method: 'GET', url: `${ROUTE_PREFIX}/probe?h=${started.hash}` })
    route.handler(wrongMethod.req, wrongMethod.res)
    assert.equal((await wrongMethod.deliver()).status, 405)

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
    assert.equal(accepted.status, 204)
    assert.equal(accepted.json.accepted, 2)

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
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
      clearTimeout: () => undefined,
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

  sandbox.dshProbe('buggy-demo.html:42:onclick', { itm: 'undefined', list: 3 }, { level: 'warn', msg: '点了' })
  assert.equal(timers.length, 1, '批量发送：先排队，不逐条打网络')
  timers[0].fn()

  assert.equal(beacons.length, 1)
  assert.equal(beacons[0].url, endpoint)
  const line = beacons[0].payload.trimEnd()
  assert.deepEqual(Object.keys(JSON.parse(line)), RECORD_FIELDS, '浏览器桩与协议模块的字段序必须一致')
  const record = JSON.parse(line)
  assert.equal(record.task, 'deadbeef')
  assert.equal(record.probe, 'buggy-demo.html:42:onclick')
  assert.equal(record.level, 'warn')
  assert.equal(record.msg, '点了')
  assert.deepEqual(record.data, { itm: 'undefined', list: 3 })

  // sendBeacon 不可用时退回 fetch（仍是 CORS 简单请求：text/plain + no-cors）。
  const fallback = run({ beaconFails: true })
  fallback.sandbox.dshProbe('a:1:b')
  fallback.sandbox.dshProbe.flush()
  assert.equal(fallback.fetches.length, 1)
  assert.equal(fallback.fetches[0].init.method, 'POST')
  assert.equal(fallback.fetches[0].init.mode, 'no-cors')
  assert.match(fallback.fetches[0].init.headers['content-type'], /text\/plain/)

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

test('start 会写出浏览器桩并把端点交给 Agent；端点未知时不写假地址', async () => {
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
      assert.match(started.text, /HTTP 摄入端点/)
      assert.match(started.text, /浏览器探针桩/)
    } else {
      // 端口未知时**不写一个猜的地址**：猜错的后果是探针静默丢失，
      // 那正是这个插件最不能接受的失败方式——所以宁可不生成，也要明说。
      const stubExists = await readFile(join(dir, 'runtime', 'probe.browser.js'), 'utf8').then(() => true, () => false)
      assert.equal(stubExists, false, '宿主地址未知时不该生成一个端点填错的桩')
      assert.match(started.text, /宿主地址未知/)
      assert.match(guide, /宿主地址未知/)
    }
  } finally {
    await workspace.cleanup()
  }
})
