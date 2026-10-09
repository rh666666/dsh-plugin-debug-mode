// 本文件由 scripts/build-client.mjs 生成，请勿手改。
// 源码：src/client.js · 平台模块：react
// 生成时间不写入产物（保证同输入同字节，便于 diff 审阅）。
window.__ModuleLoader__.load({
	id: "dsh-plugin-debug-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * src/client.js —— 浏览器半源码（**由 scripts/build-client.mjs 编译成 lib/client.js**）。
		 *
		 * 这一版是 **M4 的面板骨架**：座位、轮询、三态渲染、草稿协调都已就位；
		 * 真正的按钮交互（POST /resolve、/reproduce）留给 M4 收口。
		 *
		 * 硬约束（改本文件前先读 DESIGN.md §9.1）：
		 *   · 只能 `import` 平台种子表里的模块（目前只用到 `react`），构建脚本会拦截违规。
		 *   · 本通道**没有** `host.call`、没有 `styles.insert`——宿主通信一律走同源 fetch。
		 *   · 座位只注册一次却服务**所有会话**，必须按 `sessionId` 自过滤，无关时 `return null`。
		 *
		 * 座位选型（DESIGN.md §9.1.3）：`conversation.composer.dock`，不是 turnTail。
		 * 理由是它给到 `useInput`——面板因此能看见用户正在打什么，从而避免
		 * 「打了半句描述又顺手点按钮 ⇒ 同一条信息送两遍」的竞态（§9.3.1）。
		 */

		const { createElement, useEffect, useState } = require("react");

		/** Cordis 依赖键列表。座位服务是 `slots`。 */
		const inject = ['slots']

		/** 与宿主半约定的路由前缀（见 DESIGN.md §6.2 的路由表）。 */
		const STATE_URL = '/dsh-debug-mode/state'

		/** 轮询间隔：面板只需要「用户复现完」这一个时刻，1s 足够，也不至于打爆宿主。 */
		const POLL_MS = 1000

		/** 座位 key（本插件自己的 id，不会覆盖首方在同一个 dock 里的 cell）。 */
		const SLOT_ID = 'debug-mode-decision'

		/**
		 * 拉取当前任务状态。
		 * 任何失败都安静返回 null——调试插件的面板不该在别人的页面上抛错。
		 * @param {string} sessionId
		 */
		async function fetchTaskState(sessionId) {
		  try {
		    const response = await fetch(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`, {
		      headers: { accept: 'application/json' },
		    })
		    if (!response.ok) return null
		    const payload = await response.json()
		    return payload && payload.task ? payload.task : null
		  } catch {
		    return null
		  }
		}

		/**
		 * 输入框里有没有「还没发出去的内容」。
		 *
		 * ⚠️ `InputState` 的字段形状**尚未核实**（DESIGN.md §15 第 2 项），所以这里按
		 * 候选字段名依次探测，拿到就返回，全都读不到就保守地认为「没有草稿」——
		 * 保守方向的代价只是少了一次禁用（用户仍会看到提示），反过来则会误禁用输入。
		 * 首次接真宿主时把实际形状打印一次，然后删掉这段探测、写死字段。
		 *
		 * @param {unknown} input
		 * @returns {boolean}
		 */
		function hasDraft(input) {
		  if (!input || typeof input !== 'object') return false
		  const candidates = ['draft', 'text', 'value', 'content', 'composing']
		  for (const key of candidates) {
		    const value = input[key]
		    if (typeof value === 'string' && value.trim() !== '') return true
		  }
		  return false
		}

		/** 状态 → 中文标签（面板头部）。 */
		function statusLabel(status) {
		  switch (status) {
		    case 'active': return 'Agent 正在埋点/排查'
		    case 'awaiting-user': return '等你复现并选择'
		    case 'awaiting-agent': return '已通知 Agent…'
		    default: return String(status ?? '')
		  }
		}

		/**
		 * 调试面板。props 由座位给出（已核实 `conversation.composer.dock` 的 standardProps）：
		 *   · sessionId —— 当前会话，直接给到，不需要从别处推
		 *   · useInput(selector) —— 读输入框状态（用于草稿协调）
		 *   · useSession(selector) —— 订阅会话状态切片
		 */
		function DebugPanel(props) {
		  const sessionId = props.sessionId
		  const useInput = props.useInput
		  const [task, setTask] = useState(null)

		  // 草稿：有未发送内容时禁用两个按钮，避免同一条描述被送两遍（DESIGN.md §9.3.1）。
		  // 钩子可选：拿不到就当空草稿（服务旧宿主）。
		  let draft = false
		  if (typeof useInput === 'function') {
		    try {
		      draft = hasDraft(useInput((state) => state))
		    } catch {
		      draft = false
		    }
		  }

		  useEffect(() => {
		    if (!sessionId) return undefined
		    let alive = true
		    const tick = () => {
		      fetchTaskState(sessionId).then((next) => {
		        if (alive) setTask(next)
		      })
		    }
		    tick()
		    const timer = setInterval(tick, POLL_MS)
		    return () => {
		      alive = false
		      clearInterval(timer)
		    }
		  }, [sessionId])

		  // 坐席约定：没有内容就返回 null，否则每个会话的输入框下方都会挂一个空壳。
		  if (!sessionId || !task) return null

		  const waiting = task.status === 'awaiting-user'
		  const canDecide = waiting && !draft

		  const rows = [
		    createElement('div', { className: 'dsh-debug-mode-head', key: 'head' },
		      `调试模式 · 任务 ${task.hash} · 第 ${task.round} 轮`,
		      createElement('span', { className: 'dsh-debug-mode-badge', key: 'st' }, statusLabel(task.status)),
		    ),
		  ]

		  if (task.lastReport) {
		    rows.push(createElement('div', { className: 'dsh-debug-mode-report', key: 'rep' }, task.lastReport))
		  }

		  if (waiting) {
		    rows.push(createElement('div', { className: 'dsh-debug-mode-hint', key: 'hint' },
		      draft
		        ? '输入框里有未发送的内容 —— 直接发送即可，它会被当成「问题复现，继续排查」。'
		        : '可以直接在输入框描述现象，也可以在这里做个结论：',
		    ))
		    rows.push(createElement('div', { className: 'dsh-debug-mode-actions', key: 'act' },
		      createElement('button', { type: 'button', disabled: !canDecide, key: 'ok' }, '问题已解决'),
		      createElement('button', { type: 'button', disabled: !canDecide, key: 'again' }, '问题复现，需要进一步修复'),
		    ))
		  }

		  return createElement('div', { className: 'dsh-debug-mode-panel' }, rows)
		}

		/**
		 * @param {import('@deepseek-ai/cordis').Context} ctx
		 */
		function apply(ctx) {
		  // inject 是「声明感知」的：座位声明塌陷时注册随之释放、回来时重装。
		  // 绝不要裸调 ctx.slots.register —— 座位可能稍后才声明（见 DESIGN.md §9.1.3）。
		  ctx.slots.inject('conversation.composer.dock', () =>
		    ctx.slots.register(
		      { name: 'conversation.composer.dock', id: SLOT_ID, order: 100, label: () => '调试模式' },
		      (props) => createElement(DebugPanel, props),
		    ),
		  )
		}


		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
