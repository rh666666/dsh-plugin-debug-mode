/**
 * 宿主半入口：装配命令、工具、提示词段落、路由与会话观察。
 *
 * 五处注册面的作用域都是刻意的：
 *
 *   · `ctx.commands.register`    —— 全局：所有会话都能敲 `/debug`；"只有 `/debug` 能进入"
 *     由宿主侧票据校验保证（工具对所有会话可见，只有返回值拦得住）。
 *   · `ctx.webServer.register`   —— 三条同源路由，面板与浏览器桩的唯一通道
 *     （包通道没有 `host.call`，浏览器侧只能 `fetch` 回来）。
 *   · `ctx.tools.register` × 5   —— agent 作用域：注册随会话释放，并给将来按会话收窄留出口子。
 *   · `ctx.systemPrompt.section` —— 同样在 agent 作用域，`text` 是 thunk，按下方优先级选正文。
 *   · `ctx.on('session/event' | 'session/disposed')` —— 任务表的自动迁移与清理。
 */

import { DebugService, TICKET_TTL_MS } from './debug-service.js'
import { registerDebugCommand } from './command.js'
import { registerTools } from './tools.js'
import { registerRoutes } from './routes.js'
import { debugGuidance, debugSignalGuidance, debugTicketGuidance } from './prompt.js'

/** 插件名（DSH Loader 的条目标识，与包名一致）。 */
export const name = 'dsh-plugin-debug-mode'

/**
 * 硬依赖：缺任一项插件不加载。
 *
 * `webServer` 列为硬依赖是有意的——本插件是 GUI 功能，没有 HTTP 载体就没有面板；
 * 与其在浏览器半到处判空，不如在无 webserver 的 profile 下干脆不加载。
 * 可选能力（`agents`）一律用 `ctx.get()` 软取。
 */
export const inject = ['commands', 'tools', 'systemPrompt', 'webServer', 'sessionController']

/**
 * 调试准则段落的排序位置。
 *
 * 取自 `@deepseek-ai/dsh-system-prompt` 的 `SECTION_ORDERS`：`TOOLS_SDK` 是 5000
 * （工具文档区末尾），插在 5050 使这段准则紧跟工具说明——模型读完工具表就能看到
 * 什么时候用它们。
 */
export const SECTION_ORDER = 5050

/** 段落名：全局唯一即可；带插件前缀避免和别人的段撞名。 */
export const SECTION_NAME = 'debug-mode:guidance'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const service = new DebugService(ctx)

  // ① 用户侧唯一入口。
  registerDebugCommand(ctx, service)

  // ② 面板通道。
  registerRoutes(ctx, service)

  /**
   * 按会话装配工具与提示词。
   *
   * 必须挂到 `agent.ctx` 而不是事件回调的 `this`：`agent/created` 的 `this` 属于本次派发，
   * 往里注册会随派发结束一起释放。
   */
  let globalFallback = false
  const installForAgent = (agent) => {
    const sessionId = agent?.id
    if (!sessionId) return
    const scoped = agent.ctx
    const mount = (runtimeCtx) => {
      registerTools(runtimeCtx, service)
      runtimeCtx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        // 四段正文按优先级选取：用户刚表态 > 任务活跃 > 持票待用 > 空串。
        // 空串是默认值，否则没进调试模式的会话也会收到「去埋点」的指令。
        text: () => {
          const signal = service.signalGuidanceFor(sessionId)
          if (signal) return debugSignalGuidance(signal)
          const task = service.guidanceFor(sessionId)
          if (task) return debugGuidance(task)
          const ticket = service.pendingTicket(sessionId)
          if (!ticket) return ''
          return debugTicketGuidance({
            expiresInMinutes: Math.round(TICKET_TTL_MS / 60000),
            hasUserText: Boolean(String(ticket.text ?? '').trim()),
          })
        },
      })
    }
    if (scoped && typeof scoped.inject === 'function') {
      scoped.inject(['tools', 'systemPrompt'], mount)
      return
    }
    // 兜底：拿不到 agent 作用域时退化成一次全局注册（并说出来）。
    // 宁可全局可见（闸门仍然在），也不要这个会话完全没有工具。
    if (globalFallback) return
    globalFallback = true
    ctx.logger?.warn?.('debug-mode: agent.ctx 不可用，工具与提示词段落退化为全局注册')
    ctx.inject(['tools', 'systemPrompt'], mount)
  }

  ctx.on('agent/created', ({ agent }) => installForAgent(agent))

  // 插件可能在 agent 已经存在之后才加载（HMR / 重新挂载），所以补一次扫描——
  // 否则那些会话的工具会一直缺到下次创建。
  try {
    for (const agent of ctx.get('agents')?.list?.() ?? []) installForAgent(agent)
  } catch (error) {
    ctx.logger?.warn?.(`debug-mode: 补装既有会话失败：${String(error?.message ?? error)}`)
  }

  // ⑤ 会话观察：状态自动迁移与清理。这是"观察"而不是"拦截"：用户消息本身照常送达
  //    Agent，宿主只是顺带把状态对齐。
  ctx.on('session/event', (session, event) => service.onSessionEvent(session, event))
  ctx.on('session/disposed', (session) => {
    service.onSessionDisposed(session?.header?.id ?? session?.id)
  })

  return service
}

export default { name, inject, apply }
