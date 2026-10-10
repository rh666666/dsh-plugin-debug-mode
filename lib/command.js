/**
 * lib/command.js —— `/debug` 命令：**用户侧唯一的入口**（DESIGN.md §3）。
 *
 * 它刻意只做三件事（§3.5：「命令不该干重活」）：
 *   1. 检查本会话有没有活跃任务；
 *   2. 签一张会话级一次性票据；
 *   3. 返回一段**由插件写死**的指令文本。
 *
 * 第 3 点是整个闸门确定性的来源：命令是"被解析执行、不发给模型"的，所以
 * `handler` 返回的 `text` 是宿主放进对话的固定内容，用户敲的描述只作为**数据**
 * 附在后面。模型既不能改写这段指令，也不能凭自己的判断"想调试就调试"。
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

      return {
        kind: 'success',
        text: [
          debugCommandInstruction({
            text,
            expiresInMinutes: Math.round(TICKET_TTL_MS / 60000),
          }),
          notice ? `\n${notice}` : '',
        ].filter(Boolean).join('\n'),
      }
    },
  })
}
