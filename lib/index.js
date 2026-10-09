/**
 * lib/index.js —— 宿主半入口。
 *
 * 当前状态：**M0 骨架**。只有插件标识与依赖声明；信号工具、日志管道、
 * 唤醒通道与系统提示词段落属于 M1–M2（见 DESIGN.md §14）。
 *
 * 写实现时的顺序建议：
 *   1. lib/debug-service.js —— DebugService（唯一真相：任务表 + 日志管道 + 票据闸门）
 *   2. lib/command.js       —— `/debug` 命令（签票 + 投递指令文本，见 DESIGN.md §3.5）
 *   3. lib/tools.js         —— 5 个 dsh_debug_* 工具（见 DESIGN.md §6.2）
 *   4. lib/routes.js        —— 面板的 state/resolve/reproduce 路由（见 DESIGN.md §6.2）
 *   5. lib/prompt.js        —— systemPrompt section（见 AGENTS.md §5）
 *   6. lib/client.js        —— 面板（由 scripts/build-client.mjs 从 src/client.js 生成）
 */

/** 插件名（DSH Loader 的条目标识，与包名一致）。 */
export const name = 'dsh-plugin-debug-mode'

/**
 * 硬依赖（缺一项插件就 park，所以只写真正必需的）：
 *   · tools            —— 注册 5 个 dsh_debug_* 信号工具
 *   · systemPrompt     —— 注入调试准则段落
 *   · webServer        —— 面板的 /dsh-debug-mode/* 路由（浏览器↔宿主的唯一通道）
 *   · sessionController—— 把「用户点了按钮」变成 Agent 的下一轮输入
 *
 * 说明：webServer 写成硬依赖是有意的——本插件是 GUI 功能，没有 HTTP 载体就没有面板，
 * 与其在浏览器半里到处判空，不如让它在无 webserver 的 profile 下干脆不加载
 * （参考 dsh-plugin-wallpaper-engine 的同一取舍）。其它可选能力一律用 ctx.get() 软取。
 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessionController']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // TODO(M1): const service = new DebugService(ctx)
  // TODO(M2): ctx.tools.register(...) —— 5 个信号工具，**必须在 agent 作用域注册**
  //           （'agent/created' 是 serial 事件、this: Scoped<Agent>），
  //           在 apply(ctx) 里裸注册 = 全局可见，见 DESIGN.md §6.2.1。
  // TODO(M2): ctx.systemPrompt.section({ name, order: 900, text: () => service.activeGuidance() })
  //           —— 无活跃任务时返回空串；'text' 字段本身就是那个 thunk。
  // TODO(M2): ctx.webServer.register({ kind: 'exact', path: '/dsh-debug-mode/state', handler })
  // TODO(M4): ctx.on('session/disposed', ...) 清理任务表；ctx.effect 释放任务目录
  void ctx
}

export default { name, inject, apply }
