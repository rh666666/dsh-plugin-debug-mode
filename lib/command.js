/**
 * `/debug` 命令：用户侧唯一入口。
 *
 * 三件事：① 检查会话是否已有活跃任务，并签一张会话级一次性票据；② 把用户的原始输入
 * 原样作为一条用户消息投进对话；③ 返回一句给人看的结果说明。
 *
 * 指令不走这条消息，由 `systemPrompt.section` 注入（见 `lib/index.js` 的 thunk），
 * 对话里因此只有用户自己的话。
 *
 * 第 ② 步必须显式做：命令 handler 的返回值不会进入模型（`@deepseek-ai/dsh-commands`
 * 的 `execute()` 只把它记进 `command/done`），只返回 text 的话模型什么也收不到。
 *
 * 用户没写描述时不投递：`sessionController.prompt` 拒绝空内容，编造用户发言比不投更糟。
 */

import { TICKET_TTL_MS } from './debug-service.js'

/** 命令名（不带斜杠）。改它等于改用户侧入口，必须与 README 同步。 */
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
      // invocation.agent.id 是唯一可信的会话身份。
      const sessionId = invocation?.agent?.id
      if (!sessionId) {
        return { kind: 'error', text: '这条命令需要一个会话身份，当前调用没有——请在一个会话里重试。' }
      }
      const workspace = invocation?.agent?.session?.header?.cwd
      // 只 trim 首尾空白：中间一个字符都不动，它就是用户的原话。
      const text = String(invocation?.rawInput ?? '').trim()

      const issued = await service.issueTicket({ sessionId, text, workspace })
      if (!issued.ok) return { kind: 'error', text: issued.text }

      // 陈旧欠账只作提示，不拦人。
      const notice = await service.debtNotice(sessionId)
      const minutes = Math.round(TICKET_TTL_MS / 60000)

      if (!text) {
        // 没有描述可投：只告知用户下一步，不编造一条用户消息。
        return {
          kind: 'success',
          text: [
            '已进入调试模式（门票已签好）。你没写描述——**直接在输入框里说现象就行**，',
            'Agent 拿到的是本次调试的准则，会先问你现象、期望与复现路径。',
            notice ? `\n${notice}` : '',
          ].filter(Boolean).join('\n'),
        }
      }

      // 把用户原话开成一轮对话——这一步才真正让 Agent 开始工作。
      const delivered = await service.deliverTurn({
        sessionId,
        text,
        tag: 'debug-command',
      })
      if (!delivered) {
        // 票据已签好，用户补发描述即可继续；必须说明，否则会话看起来毫无反应。
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
          '已进入调试模式 · 本轮已开始，Agent 正在分析你描述的现象。',
          `（门票 ${minutes} 分钟内有效且只用一次；调试准则由宿主的系统提示注入，对话里只有你自己那条描述。）`,
          notice ? `\n${notice}` : '',
        ].filter(Boolean).join('\n'),
      }
    },
  })
}
