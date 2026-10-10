/**
 * lib/command.js —— `/debug` 命令：**用户侧唯一的入口**（DESIGN.md §3）。
 *
 * 它做四件事（§3.5：「命令不该干重活」）：
 *   1. 检查本会话有没有活跃任务；
 *   2. 签一张会话级一次性票据；
 *   3. 用插件写死的指令文本**开一轮对话**（`sessionController.prompt`）；
 *   4. 返回一句**给人看**的结果说明。
 *
 * ⚠️ 第 3 步为什么必须显式做：**命令 handler 返回的 `text` 不会发给模型。**
 * 已核实 `@deepseek-ai/dsh-commands` 的 `execute()`——注释原文是 "Parse and execute
 * a known command **without sending it to the model**"，返回值只进 `command/done`
 * 这个 log-only 事件。所以只返回 text 的话，用户敲完 `/debug <描述>` 什么都不会发生，
 * 还得自己再补一句「开始」——那段描述甚至根本没进对话。修复方式就是：签完票之后
 * 主动投一轮（`deliverTurn`），内容 = 插件指令 + 用户描述原文。
 *
 * 指令正文仍然由插件写死：用户敲的描述只作为**数据**附在里面，模型既不能改写这段
 * 指令，也不能凭自己的判断"想调试就调试"（闸门确定性的来源，DESIGN.md §3.5）。
 */

import { debugCommandInstruction } from './prompt.js'
import { TICKET_TTL_MS } from './debug-service.js'

/** 命令名（不带斜杠）。改它等于改用户侧入口，必须同步 DESIGN.md §3 与 README。 */
export const COMMAND_NAME = 'debug'

/**
 * 注册 `/debug`。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./debug-service.js').DebugService} service
 * @returns {() => void} disposer
 */
export function registerDebugCommand(ctx, service) {
  return ctx.commands.register({
    name: COMMAND_NAME,
    description: '进入调试模式：让 Agent 分析问题并主动在代码库里埋探针',
    input: { hint: '<现象描述：什么操作、什么预期、实际发生了什么>' },
    async handler(invocation) {
      // invocation.agent.id 是唯一可信的会话身份（§3.5）。
      const sessionId = invocation?.agent?.id
      if (!sessionId) {
        return { kind: 'error', text: '这条命令需要一个会话身份，当前调用没有——请在一个会话里重试。' }
      }
      const workspace = invocation?.agent?.session?.header?.cwd
      const text = String(invocation?.rawInput ?? '').trim()

      const issued = await service.issueTicket({ sessionId, text, workspace })
      if (!issued.ok) return { kind: 'error', text: issued.text }

      // R5：别的仓库/会话里有没收尾的任务时顺带说一句。这是**提示**而不是闸门——
      // 陈旧欠账不该拦住任何人，但也不该没人知道（§16.3 R5）。
      const notice = await service.debtNotice(sessionId)

      // ★ 真正让这件事发生的一步：把指令**开成一轮对话**。
      const instruction = debugCommandInstruction({
        text,
        expiresInMinutes: Math.round(TICKET_TTL_MS / 60000),
      })
      const delivered = await service.deliverTurn({
        sessionId,
        text: instruction,
        tag: 'debug-command',
      })
      if (!delivered) {
        // 票据已经签好了，所以用户只要把描述发出来就能继续——但**必须明说**，
        // 否则他会对着一个没反应的会话等下去（那正是这次要修掉的老毛病）。
        return {
          kind: 'error',
          text: [
            '没能自动开始这一轮（宿主拒绝了这次投递）。',
            '票据已经签好了：请**把现象描述直接发送**，Agent 就会进入调试流程。',
            notice ? `\n${notice}` : '',
          ].filter(Boolean).join('\n'),
        }
      }

      return {
        kind: 'success',
        text: [
          text
            ? '已进入调试模式 · 本轮已开始，Agent 正在分析你描述的现象。'
            : '已进入调试模式 · 本轮已开始。你没写描述，Agent 会先问你现象与复现路径。',
          notice ? `\n${notice}` : '',
        ].filter(Boolean).join('\n'),
      }
    },
  })
}
