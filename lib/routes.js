/**
 * 面板与探针用的同源 HTTP 路由。
 *
 * 浏览器与宿主之间只有同源 `fetch` + 轮询这一条路：包通道的客户端半没有 `host.call`。
 *
 * 约定：
 *   · 响应一律 JSON，错误必须带可读文案（面板要把 4xx 的 reason 显示给用户）；
 *   · 两个用户信号幂等：重复点击只处理一次，不产生第二次 prompt；
 *   · 请求体有上限，避免诊断端口变成内存放大器。
 */

/** 路由前缀；改它必须同时改 src/client.js 的 STATE_URL。 */
export const ROUTE_PREFIX = '/dsh-debug-mode'

/** 请求体上限：面板只发几十字节的 JSON，超过就是有人在乱来。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 探针摄入的 CORS 头。
 *
 * 被调试的页面通常是 `file://`（源为 `null`）或另一个端口上的 dev server，
 * 缺这些头时浏览器的 POST 会被直接挡掉；而探针失败是静默的，用户只会看到空日志。
 *
 * 用 `*` 而不回显 Origin：这里没有凭据与 cookie，请求唯一能做的事是往一个已知且活跃的
 * 任务日志里追加一条协议记录（校验见 `service.ingestProbe`）。本插件不声称能防止伪造，
 * 只保证行为可审计。
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '600',
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  // 面板每秒轮询同一路径，缓存会让它看到过期状态。
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * 读请求体，带硬上限（参照已发布插件的 http-body 做法）。
 *
 * 返回 `{ ok, raw, value, json }`：**原始文本**与"解析成 JSON 了吗"要分开给，
 * 因为探针摄入收的是 NDJSON 纯文本（浏览器 sendBeacon 只能发 CORS 简单请求，
 * 而 `application/json` 会触发预检——sendBeacon 做不了预检）。
 * 面板那三条路由则明确要求 `json === true`。
 */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    let overflow = false
    const chunks = []
    req.on('data', (chunk) => {
      if (overflow) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflow = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) {
        resolve({ ok: false, reason: '请求体过大' })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const trimmed = raw.trim()
      if (!trimmed) {
        resolve({ ok: true, raw: '', value: {}, json: false })
        return
      }
      try {
        const value = JSON.parse(trimmed)
        resolve({
          ok: true,
          raw: trimmed,
          value: value && typeof value === 'object' ? value : {},
          json: true,
        })
      } catch {
        resolve({ ok: true, raw: trimmed, value: {}, json: false })
      }
    })
    req.on('error', () => resolve({ ok: false, reason: '读取请求体失败' }))
  })
}

/** 面板路由要的是结构化 JSON：不是 JSON 就是 400，不做任何猜测式兜底。 */
function requireJsonBody(body) {
  if (!body.ok) return { ok: false, reason: body.reason }
  if (!body.json) return { ok: false, reason: '请求体不是合法 JSON' }
  return { ok: true, value: body.value }
}

/**
 * 注册面板与探针路由：
 *   · `GET  /state?sessionId=…`  面板轮询
 *   · `GET  /board`              欠账看板
 *   · `POST /probe?h=<hash>`     探针摄入（`GET` 为通道自检）
 *   · `GET  /stub.js?h=<hash>`   浏览器桩（宿主即时渲染）
 *   · `POST /resolve` `/reproduce` 用户二选一
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./debug-service.js').DebugService} service
 * @returns {Array<() => void>} disposers
 */
export function registerRoutes(ctx, service) {
  const disposers = []

  // GET /state?sessionId=… —— 面板轮询。**无任务时也要成功返回** `{task:null}`，
  // 否则面板会把"没有任务"当成一次网络故障。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (!sessionId) {
            sendJson(res, 400, { error: 'missing-session', reason: '缺少 sessionId 参数' })
            return
          }
          sendJson(res, 200, await service.panelState(sessionId))
        } catch (error) {
          sendJson(res, 500, { error: 'internal', reason: String(error?.message ?? error) })
        }
      })()
    },
  }))

  // GET /board —— R5 欠账看板：所有未关闭的任务目录。**只读、只提示**，
  // 因为"删除只发生在 end 里"（R5）。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/board`,
    handler: (req, res) => {
      void (async () => {
        try {
          sendJson(res, 200, await service.debtBoard())
        } catch (error) {
          sendJson(res, 500, { error: 'internal', reason: String(error?.message ?? error) })
        }
      })()
    },
  }))

  // POST /probe?h=<hash> —— 探针摄入端点，也是"写日志只有一份实现"的落点：
  // 字段序、时间戳、8 KiB 截断、16 MiB 上限、并发追加、脏行防护都在宿主这一侧，
  // 各语言的探针只负责投递。
  //
  // 端点由宿主提供而非由 Agent 自起服务：后者要跑命令，而调试流程不该依赖任何命令。
  //
  // GET 是同一条通道的自检：投递尽力而为，而"通道不通"与"用户还没复现"现象相同。
  // GET 与 POST 都只读写日志，不做状态迁移。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/probe`,
    handler: (req, res) => {
      void (async () => {
        for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader?.(name, value)
        try {
          const method = (req.method ?? '').toUpperCase()
          if (method === 'OPTIONS') {
            // 预检：即使桩走 CORS 简单请求，调用方也可能用 application/json。
            res.statusCode = 204
            res.end()
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const hash = url.searchParams.get('h') ?? url.searchParams.get('task') ?? ''

          if (method === 'GET' || method === 'HEAD') {
            const status = await service.probeStatus(hash)
            sendJson(res, status.ok ? 200 : status.code, status)
            return
          }
          if (method !== 'POST') {
            sendJson(res, 405, {
              ok: false,
              error: 'method-not-allowed',
              reason: '这个路由接受 POST（写探针记录）与 GET（通道自检）',
            })
            return
          }
          const body = await readBody(req)
          if (!body.ok) {
            sendJson(res, 400, { ok: false, error: 'bad-body', reason: body.reason })
            return
          }
          // 探针桩发的是 NDJSON 纯文本；也接受结构化的 JSON body。
          const payload = body.raw ? body.raw : body.value
          const result = await service.ingestProbe({ hash, payload })
          // 成功也回 200 + JSON 体（不是 204）：accepted/rejected 是投递方唯一的自检依据，
          // 而 204 按规范不许带体。失败码由 result.code 给出（400/404/409/500）。
          sendJson(res, result.ok ? 200 : result.code, result)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: 'internal', reason: String(error?.message ?? error) })
        }
      })()
    },
  }))

  // GET /stub.js?h=<hash> —— 浏览器桩由宿主即时渲染后返回。
  //
  // 产物位于用户临时目录，被调试项目的 dev server 看不见它；经典 `<script src>`
  // 跨源可用（不触发预检、不需要 CORS 头），是页面拿到桩的最短路径。
  //
  // 选择即时渲染而不是读磁盘副本：临时目录被清理是常态，而"读不到"与"没加载"现象相同。
  //
  // 校验与 /probe 一致：只认活跃任务的哈希，不做状态迁移，未知哈希 404、已关闭 409。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/stub.js`,
    handler: (req, res) => {
      void (async () => {
        try {
          const method = (req.method ?? '').toUpperCase()
          if (method !== 'GET' && method !== 'HEAD') {
            sendJson(res, 405, {
              ok: false,
              error: 'method-not-allowed',
              reason: '这个路由只接受 GET（脚本内容由 <script src> 取走）',
            })
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const hash = url.searchParams.get('h') ?? url.searchParams.get('task') ?? ''
          const stub = await service.browserStubSource(hash)
          if (!stub.ok) {
            sendJson(res, stub.code, { ok: false, error: 'stub-unavailable', reason: stub.reason })
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          // 面板与页面都会反复取它，缓存会让"换了任务"这件事看起来没发生。
          res.setHeader('Cache-Control', 'no-store')
          // 有的用户会用 module 方式 import 它（那需要 CORS），加上没有代价。
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(stub.source)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: 'internal', reason: String(error?.message ?? error) })
        }
      })()
    },
  }))

  /** `/resolve` 与 `/reproduce` 的形状完全一样，只有信号不同。 */
  const userSignalRoute = (path, run) => ({
    kind: 'exact',
    path: `${ROUTE_PREFIX}${path}`,
    handler: (req, res) => {
      void (async () => {
        try {
          if ((req.method ?? '').toUpperCase() !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed', reason: '这个路由只接受 POST' })
            return
          }
          const body = await readBody(req)
          const parsed = requireJsonBody(body)
          if (!parsed.ok) {
            sendJson(res, 400, { error: 'bad-body', reason: parsed.reason })
            return
          }
          const { hash, sessionId, note, anytime } = parsed.value
          if (!hash || typeof hash !== 'string') {
            sendJson(res, 400, { error: 'missing-hash', reason: '缺少 hash' })
            return
          }
          const result = await run({
            hash,
            sessionId: typeof sessionId === 'string' ? sessionId : undefined,
            note: typeof note === 'string' ? note : undefined,
            // 只有状态 tag（chip）上的叉会带它：`resolved` 表态因此不受"轮到用户了吗"
            // 这道门约束。面板上的两个按钮不带，窗口语义原样保留——那是"先后关系"的唯一保证。
            anytime: anytime === true,
          })
          sendJson(res, result.code ?? (result.ok ? 200 : 400), result)
        } catch (error) {
          sendJson(res, 500, { error: 'internal', reason: String(error?.message ?? error) })
        }
      })()
    },
  })

  disposers.push(ctx.webServer.register(userSignalRoute('/resolve', (input) => service.resolve(input))))
  disposers.push(ctx.webServer.register(userSignalRoute('/reproduce', (input) => service.reproduce(input))))

  return disposers
}
