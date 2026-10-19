/**
 * lib/index.js —— 宿主半入口：把服务、命令、工具、提示词、路由装到一起。
 *
 * 注册面一共五处，每一处的**作用域**都是有意的：
 *
 *   · `ctx.commands.register`    —— **全局**：所有会话都能敲 `/debug`，而"只有 `/debug`
 *     能进入"由宿主侧票据校验兜住（AGENTS.md §1.1 第 1 条）。
 *   · `ctx.webServer.register`   —— 三条同源路由，面板的通道（AGENTS.md §6「浏览器↔宿主
 *     只有一条路」）。
 *   · `ctx.tools.register` × 5   —— **agent 作用域**：工具对所有会话可见这件事无法
 *     按会话动态开关，所以入口约束只能落在宿主侧票据校验上；在 agent 作用域注册
 *     还能让注册随会话释放，并给将来 `restrict()` 留出按会话收窄的口子
 *     （AGENTS.md §6「工具必须注册在 agent 作用域」）。
 *   · `ctx.systemPrompt.section` —— 同样在 agent 作用域，且 `text` 是 **thunk**：
 *     只有任务活跃时才返回正文（AGENTS.md §1.1 第 7 条）。
 *   · `ctx.on('session/event' | 'session/disposed')` —— 任务表的自动迁移与清理。
 */

import { DebugService } from './debug-service.js'
import { registerDebugCommand } from './command.js'
import { registerTools } from './tools.js'
import { registerRoutes } from './routes.js'
import { debugGuidance } from './prompt.js'

/** 插件名（DSH Loader 的条目标识，与包名一致）。 */
export const name = 'dsh-plugin-debug-mode'

/**
 * 硬依赖（缺一项插件就 park，所以只写真正必需的）：
 *   · commands         —— 用户侧唯一入口 `/debug`；没有它插件毫无意义
 *   · tools            —— 5 个 dsh_debug_* 信号工具
 *   · systemPrompt     —— 注入调试准则段落
 *   · webServer        —— 面板的 /dsh-debug-mode/* 路由（浏览器↔宿主的唯一通道）
 *   · sessionController—— 把「用户点了按钮」变成 Agent 的下一轮输入
 *
 * webServer 写成硬依赖是有意的：本插件是 GUI 功能，没有 HTTP 载体就没有面板，
 * 与其在浏览器半里到处判空，不如让它在无 webserver 的 profile 下干脆不加载。
 * 其它可选能力（agents）一律用 ctx.get() 软取。
 */
export const inject = ['commands', 'tools', 'systemPrompt', 'webServer', 'sessionController']

/**
 * 调试准则段落的排序位置。
 *
 * 取值依据（已核实 `@deepseek-ai/dsh-system-prompt` 的 `SECTION_ORDERS`）：
 * `TOOLS_SDK: 5000` 是工具文档区的末尾，`DELIVERABLE_FILE_REFERENCES: 9000` 是下一段。
 * 插在 5050 意味着这段准则**紧跟工具说明**——模型刚读完工具表就看到"什么时候用它们"。
 * 早先设计里写的 900 是猜的（当时 SECTION_ORDERS 不可读），现已改为实测值。
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
   * ③④ 按会话装配工具与提示词。
   *
   * 为什么用 `agent.ctx.inject([...])` 而不是在事件回调里直接注册：`agent/created`
   * 的 `this` 是**这一次派发**的作用域，往里注册会随派发结束一起释放。`agent.ctx`
   * 才是那个会话的持久上下文（首方的 tool-subagent 用的就是这一招）。
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
        // thunk：无活跃任务时必须返回空串，否则没进调试模式的会话也会收到「去埋点」的指令。
        text: () => debugGuidance(service.guidanceFor(sessionId)),
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

  // ⑤ 会话观察：状态自动迁移（AGENTS.md §1.1 第 9 条）与清理。这是"观察"而不是
  //    "拦截"：
  //    用户消息本身照常送达 Agent，宿主只是顺带把状态对齐。
  ctx.on('session/event', (session, event) => service.onSessionEvent(session, event))
  ctx.on('session/disposed', (session) => {
    service.onSessionDisposed(session?.header?.id ?? session?.id)
  })

  return service
}

export default { name, inject, apply }
