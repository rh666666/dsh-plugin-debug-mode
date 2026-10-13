/**
 * lib/routes.js —— 面板 ↔ 宿主的同源 HTTP 路由（的路由表）。
 *
 * 为什么是这条路：包通道的客户端半里**没有 `host.call`**（那是动态通道的 API），
 * 所以浏览器和宿主之间只剩同源 `fetch` + 轮询。这不是将就——两个已发布的第三方
 * 插件用的就是这一套。
 *
 * 三条纪律：
 *   · 所有响应都是 JSON，且**永远带明确文案**：面板要把 4xx 的 reason 显示给人看；
 *   · 两个用户信号**幂等**：重复点击只处理一次，不产生第二次 prompt；
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
 * 已经记过一次教训："不可伪造的 token"在宿主自己开路由的前提下
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
 * 注册面板与探针用的路由：
 *   · `GET  /state?sessionId=…` 面板轮询
 *   · `GET  /board`               R5 欠账看板
 *   · `POST /probe?h=<hash>` 探针摄入（`GET` 是通道自检）
 *   · `GET  /stub.js?h=<hash>` 浏览器桩（宿主即时渲染）
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

  // POST /probe?h=<hash> —— 「语言无关的统一入口」的摄入端点。
  //
  // 为什么在宿主而不是让 Agent 自己起个接收端：起服务器要跑命令，而调试模式
  // **本来就不该需要任何命令**。宿主手里已经有一个 HTTP 载体（webServer），
  // 复用它就是零成本的。
  //
  // 为什么写日志这件事必须收在这里：字段序、时间戳、8 KiB 截断、16 MiB 上限、
  // 并发追加、不写脏行——协议只该有**一份实现**。让每种语言照着文档各自实现一遍，
  // 等于把冻结协议复制成 N 份，而它们必然漂移。
  //
  // GET 是**通道自检**：让"通道活着吗"能在用户复现**之前**被单独测一次——
  // 投递是尽力而为的，通道死了的现象与"用户还没复现"一模一样。
  // 无论 GET 还是 POST 都**只读写日志**，不做任何状态迁移。
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

  // GET /stub.js?h=<hash> —— 浏览器桩（经典脚本）由宿主自己伺服。
  //
  // 为什么不能继续让被调试项目伺服那个文件：产物现在住在**用户临时目录**里，项目的
  // dev server 根本看不见它。而经典 `<script src>` 是跨源允许的（不触发预检、不需要
  // CORS 头），所以这里是页面拿到桩的最短路径。
  //
  // 为什么是**即时渲染**而不是读磁盘上的副本：临时目录被系统清理是它的正常行为，
  // 而"页面拿不到桩"的现象与"页面没加载桩"一模一样——这条路由读磁盘就等于把
  // 那份静默失败又请回来。
  //
  // 安全姿态与 /probe 同一套：只认**活跃任务**的哈希，不做任何状态迁移，
  // 不存在的哈希返回 404，已关闭的返回 409。
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
