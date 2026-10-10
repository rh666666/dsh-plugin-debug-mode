/**
 * lib/routes.js —— 面板 ↔ 宿主的同源 HTTP 路由（DESIGN.md §6.2 的路由表）。
 *
 * 为什么是这条路：包通道的客户端半里**没有 `host.call`**（那是动态通道的 API），
 * 所以浏览器和宿主之间只剩同源 `fetch` + 轮询。这不是将就——两个已发布的第三方
 * 插件用的就是这一套（§9.1.2）。
 *
 * 三条纪律：
 *   · 所有响应都是 JSON，且**永远带明确文案**：面板要把 4xx 的 reason 显示给人看；
 *   · 两个用户信号**幂等**：重复点击只处理一次，不产生第二次 prompt（§6.2）；
 *   · body 有上限：诊断端口不能变成内存放大器。
 */

/** 路由前缀；改它必须同时改 src/client.js 的 STATE_URL。 */
export const ROUTE_PREFIX = '/dsh-debug-mode'

/** 请求体上限：面板只发几十字节的 JSON，超过就是有人在乱来。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 探针摄入的 CORS 头。
 *
 * 为什么必须开：被调试的页面十有八九是 `file://` 打开的（源是 `null`），
 * 或者是另一个端口上的 dev server。没有这些头，浏览器的 POST 会被直接挡掉，
 * 而**探针的失败是静默的**——用户只会看到"日志是空的"，然后怀疑自己埋错了地方。
 *
 * `*` 而不是回显 Origin：这里没有凭据、没有 cookie，唯一能做的事是往一个
 * **已知且活跃**的任务日志里追加一条协议记录（见 `service.ingestProbe` 的校验）。
 * DESIGN.md §16.4 已经记过一次教训："不可伪造的 token"在宿主自己开路由的前提下
 * 是安全戏剧——所以这里如实按"审计 + 摩擦"来设计，而不是假装有授权。
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
 * 注册面板用的三条路由。
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
  // 因为"删除只发生在 end 里"（§16.3 R5）。
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

  // POST /probe?h=<hash> —— 「无法写文件的运行时」的摄入端点（§7.6）。
  //
  // 为什么在宿主而不是让 Agent 自己起个接收端：起服务器要跑命令，而调试模式
  // **本来就不该需要任何命令**（§3.10）。宿主手里已经有一个 HTTP 载体（webServer），
  // 复用它就是零成本的。
  //
  // 只读的 body：这里收的是探针记录，不是控制指令——任何**状态迁移**都不走这条路。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/probe`,
    handler: (req, res) => {
      void (async () => {
        for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader?.(name, value)
        try {
          const method = (req.method ?? '').toUpperCase()
          if (method === 'OPTIONS') {
            // 预检：即使我们把桩写成 CORS 简单请求，别人也可能用 application/json。
            res.statusCode = 204
            res.end()
            return
          }
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method-not-allowed', reason: '这个路由只接受 POST' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const hash = url.searchParams.get('h') ?? url.searchParams.get('task') ?? ''
          const body = await readBody(req)
          if (!body.ok) {
            sendJson(res, 400, { ok: false, error: 'bad-body', reason: body.reason })
            return
          }
          // 探针桩发的是 NDJSON 纯文本；也接受结构化的 JSON body。
          const payload = body.raw ? body.raw : body.value
          const result = await service.ingestProbe({ hash, payload })
          sendJson(res, result.ok ? 204 : result.code, result)
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
          const { hash, sessionId, note } = parsed.value
          if (!hash || typeof hash !== 'string') {
            sendJson(res, 400, { error: 'missing-hash', reason: '缺少 hash' })
            return
          }
          const result = await run({
            hash,
            sessionId: typeof sessionId === 'string' ? sessionId : undefined,
            note: typeof note === 'string' ? note : undefined,
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
