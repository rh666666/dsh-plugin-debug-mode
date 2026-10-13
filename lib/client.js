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
		 * 这一版是**输入框上方那张可折叠的浮动卡片**：座位、轮询、折叠、三态渲染、按钮接线、
		 * 草稿协调、样式令牌全部就位。
		 *
		 * 硬约束（改本文件前先）：
		 *   · 只能 `import` 平台种子表里的模块（目前只用到 `react`），构建脚本会拦截违规。
		 *   · 本通道**没有** `host.call`、没有 `styles.insert`——宿主通信一律走同源 fetch，
		 * 样式只能自己插 `<style>`。
		 *   · 座位只注册一次却服务**所有会话**，必须按 `sessionId` 自过滤，无关时 `return null`；
		 * 绝不要在模块级放"当前任务"这类全局状态。
		 *
		 * 座位选型：`conversation.input.dock`——首方把它在**输入框卡片正上方**按普通
		 * 文档流渲染（`composerStack` 里 `renderSlot("conversation.input.dock", zone)` 紧跟着就是
		 * `inputBar`），所以它既贴近输入框、又**不可能遮挡**输入框。
		 * 早先用的 `conversation.composer.dock` 渲染在卡片**下方**，会把输入框往上挤，
		 * 正是"挤兑了提示词输入框的位置"那个问题。
		 */

		const { createElement, useEffect, useState } = require("react");

		/** Cordis 依赖键列表。座位服务是 `slots`。 */
		const inject = ['slots']

		/** 与宿主半约定的路由前缀（ 的路由表）。 */
		const ROUTE_PREFIX = '/dsh-debug-mode'

		/** 轮询间隔：面板只需要"用户复现完"这一个时刻，1s 足够，也不至于打爆宿主。 */
		const POLL_MS = 1000

		/** 座位 key（本插件自己的 id，不会覆盖别人在同一个 dock 里的 cell）。 */
		const SLOT_ID = 'debug-mode-decision'

		/**
		 * 座位 key。首方把 `conversation.input.dock` 描述为 "Full-width entries above the
		 * composer card"，并且【在文档流里】渲染——所以它不会浮在输入框上面。
		 */
		const SLOT_KEY = 'conversation.input.dock'

		/**
		 * 在同座位里的排序位置。
		 *
		 * 该座位现有占用者是 `todo`(0) / `goal`(10) / `queue`(20)，都在我们前面；
		 * 取 30 意味着这张卡片排在**紧贴输入框**的那一格——需要用户动手的东西应该离手最近。
		 */
		const SLOT_ORDER = 30

		/**
		 * 状态 tag 的座位：`conversation.input.left`（输入框工具行左侧，`+` / 回形针之后）。
		 *
		 * [!] **绝对不要把它放回 `conversation.input.plan`。** 实测过一次启动崩溃（2026-10-13 的
		 * `crash-...-web-boot.log`：`@deepseek-ai/dsh-client-ui-plan: failed`），根因是
		 * `SlotCore.register` 对 `kind: "single"` 的处理**是抛错，不是后来者顶掉前者**：
		 *
		 *     case "single": {
		 *       const m = i.entries.find(g => (g.options.priority ?? 0) === c)
		 *       if (m) throw new Error(`single slot "${t.name}" already has a registration ...`)
		 *     }
		 *
		 * 我们在 priority 0 占了那一格，于是轮到首方 Plan 插件装配时它自己的 register 抛错、
		 * entry 起不来，web boot 断言「1 entry did not activate」把应用直接打崩——
		 * **启动即崩，与有没有调试任务无关**（`apply` 在装配期就跑，register 就在里面）。
		 * 推论两条，都很容易踩：
		 *   ① 单占用座位上的冲突是**错误**而不是观感取舍，所以"两个模式不共存、可以抢"这个理由
		 *      从一开始就不成立——不共存的是**运行时**，不是**装配期**；
		 *   ② inspect provider 的 `replaceRisk` 只说到"会遮住首方 UI"，**没**说到"会抛错、会崩"。
		 *      判断一格能不能占，看它的 `kind`/`scope` 与当前 occupants，别只看 `purpose` 描述。
		 *
		 * 为什么是 `input.left` 而不是 `input.right`：两者都是 list、都不会抛错；但 `input.right`
		 * 的同排占用者里有模型选择器，而 `input.left` **当前零占用者**——在零占用者的 list 座位上，
		 * 我的 order 只决定自己排在哪，不可能顶掉任何人的东西。
		 */
		const CHIP_KEY = 'conversation.input.left'

		/** 状态 tag 的座位 id：与面板分开，两个 cell 各自独立注册、互不覆盖。 */
		const CHIP_ID = 'debug-mode-chip'

		/**
		 * 状态 tag 在同座位里的排序位置。
		 *
		 * list 座位先按 `priority`、再按 `order` 升序渲染；该座位现在没有别的占用者，
		 * 取 0 就是「工具行的 `+` / 回形针之后紧接着」——贴着输入框的操作区。
		 */
		const CHIP_ORDER = 0

		/** 样式表标识：按它去重，避免 HMR 后插进来七八份。 */
		const STYLE_ID = 'dsh-plugin-debug-mode/panel.css'

		/**
		 * 输入框里有没有"还没发出去的内容"。
		 *
		 * [!] 字段名是**实测**的，不是猜的：`@deepseek-ai/dsh-client-ui-conversation` 的
		 * `SessionInputShell.compose()` 就是 `{ draft, attachmentIds, draftRev, phase,
		 * occurrences, queue }`，而它自己比较草稿用的也是 `inputState.draft === ""`。
		 *
		 * 「有附件但没文字」也算未发送内容：那种状态下点按钮同样是"同一条信息送两遍"。
		 *
		 * @param {unknown} input
		 * @returns {boolean}
		 */
		function hasDraft(input) {
		  if (!input || typeof input !== 'object') return false
		  if (typeof input.draft === 'string' && input.draft.trim() !== '') return true
		  if (Array.isArray(input.attachmentIds) && input.attachmentIds.length > 0) return true
		  return false
		}

		/**
		 * 一句话状态（折叠时**只剩这一行**，所以它必须自己说清楚现在轮到谁）。
		 *
		 * 折叠态不能是"信息量为零"的一个色块：用户很可能就靠它决定要不要展开。
		 */
		function statusLine(status, verdict) {
		  switch (status) {
		    case 'active': return 'Agent 正在埋点/排查'
		    case 'awaiting-user': return '轮到你复现并选择'
		    case 'awaiting-agent':
		      return verdict === 'resolved' ? '已通知 Agent 清理探针' : '已通知 Agent 读日志'
		    case 'closed': return '已结束'
		    default: return String(status ?? '')
		  }
		}

		/**
		 * 拉取当前任务状态。任何失败都安静返回 null——
		 * 调试插件的面板不该在别人的页面上抛错。
		 * @param {string} sessionId
		 */
		async function fetchTaskState(sessionId) {
		  try {
		    const response = await fetch(`${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(sessionId)}`, {
		      headers: { accept: 'application/json' },
		      cache: 'no-store',
		    })
		    if (!response.ok) return null
		    const payload = await response.json()
		    return payload && payload.task ? payload.task : null
		  } catch {
		    return null
		  }
		}

		/**
		 * 轮询当前会话的调试任务（`task` 为 null = 没有活跃任务）。
		 *
		 * 为什么两个 cell（面板卡片与状态 tag）各poll一次而不是共用一份模块级状态：
		 * 本通道的硬约束是**绝不在模块级放"当前任务"这类全局状态**——座位只注册一次却服务
		 * 所有会话，一份模块级缓存会把 A 会话的任务显示到 B 会话的输入框上。
		 * 各自按 `sessionId` 自己拉，是这里唯一安全的形状；代价是活跃调试期间每秒多一个
		 * 本地请求（宿主 `/state` 是同一套载荷：`findTask` 命中内存、`logStat` 命中行数缓存）。
		 *
		 * @param {string | undefined} sessionId
		 * @returns {{task: object | null}}
		 */
		function useTaskState(sessionId) {
		  const [task, setTask] = useState(null)

		  useEffect(() => {
		    if (!sessionId) return undefined
		    let alive = true
		    const tick = () => {
		      fetchTaskState(sessionId).then((next) => {
		        // 卸载后到达的响应必须丢掉，否则会把状态写到已销毁的 cell 上。
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

		  return { task }
		}

		/**
		 * 把用户的表态投给宿主。
		 *
		 * [!] `body` 必须**只放进调用方真的要表态的字段**：面板那两个按钮发 `{hash, sessionId}`、
		 * chip 上的叉多发一个 `anytime: true`。这里刻意不写成"把 input 整个序列化"——
		 * 那份 input 里以后再加上渲染用的字段（状态、轮次…）时，它们会**悄悄**一起被发到宿主，
		 * 而宿主对多余字段没有校验，于是"发出去的东西"与"表态的内容"就再也对不上了。
		 *
		 * @param {'resolve'|'reproduce'} signal
		 * @param {{hash: string, sessionId: string, anytime?: boolean}} input
		 * @returns {Promise<{ok: boolean, reason: string}>}
		 */
		async function postSignal(signal, input) {
		  try {
		    const body = { hash: input.hash, sessionId: input.sessionId }
		    // 只有 chip 会带它：`resolved` 表态因此不受"轮到用户了吗"那道门约束。
		    if (input.anytime === true) body.anytime = true
		    const response = await fetch(`${ROUTE_PREFIX}/${signal}`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify(body),
		    })
		    const payload = await response.json().catch(() => ({}))
		    if (!response.ok) {
		      return { ok: false, reason: String(payload?.reason ?? payload?.text ?? `HTTP ${response.status}`) }
		    }
		    return { ok: true, reason: '' }
		  } catch (error) {
		    return { ok: false, reason: String(error?.message ?? error) }
		  }
		}

		/**
		 * 面板样式：一张**浮动卡片**。
		 *
		 * 令牌来源有两级，都在注释里写清楚，免得下一个人以为是猜的：
		 *   · `client/Theme` inspect provider 给出的权威别名令牌（bg-layer-*、border-l*、
		 *     label-*、brand-primary、state-*）——这些是**可以照着写**的；
		 *   · 首方样式表里实际出现过的补充令牌（radius-lg、elevation-panel、label-tertiary…）。
		 * 每一处 `var()` 都带 fallback：万一某个名字将来改了，最坏结果是"回到朴素外观"，
		 * 而不是整块面板变成透明/不可读。
		 */
		const CSS = [
		  // 卡片本体：宽高跟随 composer 卡片，居中——看起来才像"贴在输入框上方"，
		  // 而不是一条横穿整个窗口的横幅。
		  '.dsh-dbg{box-sizing:border-box;width:100%;',
		  'max-width:var(--dsh-composer-card-max-width,100%);margin:0 auto 6px;',
		  'border-radius:var(--dsw-radius-lg,10px);overflow:hidden;',
		  'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));',
		  'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));',
		  'box-shadow:var(--dsw-elevation-panel,0 4px 16px rgba(0,0,0,.10));',
		  'color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}',
		  // 需要用户动手时给一道品牌色左沿：折叠成一个色条也仍然"在说话"。
		  '.dsh-dbg.is-action{border-left:3px solid var(--dsw-alias-brand-primary,#2563eb)}',

		  // 头部：整行是一个 button（键盘可达、语义正确），折叠态下它是唯一可见的部分。
		  // `flex-wrap:nowrap` + `overflow:hidden` 是有意的：窄窗口下宁可让状态文字截断，
		  // 也不要把这一行折成两行——折叠的意义就是"只占一行"。
		  '.dsh-dbg-head{display:flex;align-items:center;flex-wrap:nowrap;gap:8px;width:100%;',
		  'box-sizing:border-box;overflow:hidden;',
		  'padding:6px 10px;margin:0;border:0;background:transparent;color:inherit;font:inherit;',
		  'text-align:left;cursor:pointer}',
		  '.dsh-dbg-head:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}',
		  '.dsh-dbg-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:-2px}',
		  // 折叠箭头用**内联 SVG**，不用字符箭头、更不碰 emoji：字符的字形回退按平台/字体各不相同
		  // （实测过 `▸` 在某些等宽字体下变成方框），而 SVG 的线条由我们自己画，到哪都一样。
		  // 方向只有一种画法：折起时朝右，展开时整块转 90°。
		  '.dsh-dbg-chev{flex:none;display:inline-flex;align-items:center;width:12px;',
		  'color:var(--dsw-alias-label-secondary,#6b7280)}',
		  '.dsh-dbg-svg{display:block;transition:transform .12s ease}',
		  '.dsh-dbg-head[aria-expanded="true"] .dsh-dbg-chev .dsh-dbg-svg{transform:rotate(90deg)}',
		  '.dsh-dbg-title{flex:none;font-weight:500}',
		  '.dsh-dbg-sep{flex:none;color:var(--dsw-alias-label-secondary,#6b7280)}',
		  // 状态是这一行里最该被牺牲的（可以截断），meta 反而要完整——它是唯一的量化信息。
		  '.dsh-dbg-status{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
		  'color:var(--dsw-alias-label-secondary,#6b7280)}',
		  '.dsh-dbg-spacer{flex:1 1 auto;min-width:0}',
		  '.dsh-dbg-meta{flex:none;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}',
		  '.dsh-dbg.is-action .dsh-dbg-status{color:var(--dsw-alias-brand-primary,#2563eb)}',

		  // 正文
		  '.dsh-dbg-body{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px}',
		  '.dsh-dbg-headline{margin:0;font-weight:500;white-space:pre-wrap;word-break:break-word}',
		  '.dsh-dbg-caption{color:var(--dsw-alias-label-secondary,#6b7280)}',
		  // 步骤区限高：清单再长也不许把输入框顶出视野（"不应遮挡输入框"这条同时管长度）。
		  '.dsh-dbg-steps{margin:0;padding-left:22px;max-height:132px;overflow-y:auto;',
		  'color:var(--dsw-alias-label-primary,inherit)}',
		  '.dsh-dbg-steps li{margin:2px 0;word-break:break-word}',

		  '.dsh-dbg-hint{color:var(--dsw-alias-label-secondary,#6b7280)}',

		  // ── 状态 tag：与首方 Plan chip 同一套几何，但配色是**调试黄** ──
		  // 几何（`corner-shape:round` + `border-radius:999px` + `padding:2px 8px` + 13px/20px/500）
		  // 逐字照抄 `dsh-client-ui-plan` 的 Plan chip，所以它看起来和 Plan 是同一族的 chip。
		  //
		  // [!] 配色**必须**与 Plan chip 不同，这里踩过两次：
		  //   ① 先按名字猜"warn=计划、business=蓝"给调试配了蓝 —— 实测反了：**Plan chip 是蓝的**。
		  //      令牌名里的 warn/business 与"哪个模式用它"没有关系，别按名字推语义，要么实测、
		  //      要么照抄首方那个 chip 的实际取值；
		  //   ② 于是调试改用 `state-warn-tertiary` 底 + `state-warn-label` 字。
		  // 这两个令牌明暗主题各有一套（浅色=amber-600 字 + amber-100 底；深色=amber-600 字 +
		  // amber-900 底），所以**不需要自己判 `prefers-color-scheme`**。
		  // 特意不用 `--dsw-alias-brand-primary`：它在浅色主题下解析成 near-black，
		  // 字与底会一起变黑，chip 会糊成一块黑药丸。
		  // fallback 只取一个"至少还能看"的值，不复制主题的两套色——同一句也适用于下面所有 var()。
		  '.dsh-dbg-chip{corner-shape:round;flex:none;display:inline-flex;align-items:center;gap:4px;',
		  'padding:2px 8px;border-radius:999px;font-size:13px;font-weight:500;line-height:20px;',
		  // 它是 button（叉要能点），所以把浏览器默认外观全部清掉，只留上面这套 chip 造型。
		  'appearance:none;border:none;font-family:inherit;cursor:pointer;',
		  'background:var(--dsw-alias-state-warn-tertiary,rgba(221,134,41,.16));',
		  'color:var(--dsw-alias-state-warn-label,#dd8629);white-space:nowrap}',
		  '.dsh-dbg-chip:hover:not(:disabled){color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
		  '.dsh-dbg-chip:focus-visible{outline:2px solid var(--dsw-alias-state-warn-label,#dd8629);outline-offset:2px}',
		  '.dsh-dbg-chip:disabled{opacity:.6;cursor:default}',
		  '.dsh-dbg-chip .dsh-dbg-svg{flex:none;display:block;transition:transform .12s ease}',
		  // 悬停时叉转 90°：这一下是"它真的能点"的提示，不额外加文字。
		  '.dsh-dbg-chip:hover:not(:disabled) .dsh-dbg-svg{transform:rotate(90deg)}',
		  '.dsh-dbg-actions{display:flex;gap:8px;flex-wrap:wrap}',
		  // 两个按钮同权重：它们是一个二选一，把某一个做成"主按钮"等于替用户表态。
		  '.dsh-dbg-btn{appearance:none;cursor:pointer;padding:4px 12px;',
		  'border-radius:var(--dsw-radius-md,8px);font-size:13px;line-height:22px;',
		  'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
		  'background:transparent;color:var(--dsw-alias-label-primary,inherit)}',
		  '.dsh-dbg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
		  '.dsh-dbg-btn:disabled{cursor:not-allowed;opacity:.5}',

		  // 警告块：图标是**内联 SVG**（一个实心三角 + 一个感叹号），文字照旧。
		  // 图标 `aria-hidden`，语义仍然只由文字承担——屏幕阅读器不该读出"三角形"。
		  '.dsh-dbg-warn{display:flex;align-items:flex-start;gap:6px;',
		  'color:var(--dsw-alias-state-warn-primary,#b45309)}',
		  '.dsh-dbg-warn .dsh-dbg-svg{flex:none;margin-top:2px}',
		  '.dsh-dbg-error{color:var(--dsw-alias-state-error-primary,#b91c1c)}',
		].join('')

		/** 插一次样式表。`document` 在测试沙箱里不存在，所以必须判空。 */
		function ensureStyles() {
		  if (typeof document === 'undefined' || !document.createElement) return
		  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
		  const tag = document.createElement('style')
		  tag.dataset.pluginCss = STYLE_ID
		  tag.textContent = CSS
		  document.head?.appendChild(tag)
		}

		/**
		 * 调试面板。
		 *
		 * props 由座位给出（`conversation.input.dock` 的 standardProps 与 ownerProps 都已核实）：
		 *   · sessionId —— 当前会话，直接给到，不需要从别处推
		 *   · useInput(selector) —— 读输入框状态（用于草稿协调）
		 *   · input（ownerProps，InputZone.input）—— 同一份 InputState 的快照，作为兜底
		 */
		function DebugPanel(props) {
		  const sessionId = props.sessionId
		  const useInput = props.useInput
		  const ownerInput = props.input ?? props.zone?.input

		  const [busy, setBusy] = useState('')
		  const [failure, setFailure] = useState('')
		  const [verdictSent, setVerdictSent] = useState('')
		  /** 轮询宿主：没有任务时是 null，面板据此渲染空。 */
		  const { task } = useTaskState(sessionId)
		  /**
		   * 宿主已经迁移过状态（用户的选择被接受）时，清掉本地的"发送中"标记。
		   *
		   * 副作用不能在渲染期做，所以这里跟着轮询结果走——同一次轮询返回的是同一个引用，
		   * 只有 `/state` 真的给出新对象时它才重跑。
		   */
		  useEffect(() => {
		    if (!task) return
		    if (task.status === 'awaiting-user') return
		    setBusy('')
		    setVerdictSent(task.userVerdict ?? '')
		  }, [task])
		  /**
		   * 手动折叠覆盖：`{ status, collapsed }`——记的是"针对哪个状态折的"。
		   *
		   * 为什么不是简单的 boolean：默认策略要**跟着状态走**（轮到用户复现时自动展开，
		   * 其余时候自动收起），而用户手动折过之后这个选择应当保留到下一次状态变化为止。
		   * 把状态一起记下来，"是否需要覆盖"就变成了渲染期的一次比较——
		   * 不需要在轮询回调里跟陈旧闭包较劲，也不需要在 setState 的 updater 里做副作用。
		   */
		  const [foldOverride, setFoldOverride] = useState({ status: null, collapsed: false })

		  // 草稿：有未发送内容时禁用两个按钮，避免同一条描述被送两遍。
		  // 这个条件在同一个座位上是稳定的（standardProps 不会中途增减），所以不算违反 hooks 规则。
		  let draft = false
		  if (typeof useInput === 'function') {
		    try {
		      draft = hasDraft(useInput((state) => state))
		    } catch {
		      draft = false
		    }
		  } else {
		    draft = hasDraft(ownerInput)
		  }

		  // 坐席约定：没有内容就返回 null，否则每个会话的输入框上方都会挂一个空壳。
		  if (!sessionId || !task) return null

		  const decide = (signal) => {
		    setBusy(signal)
		    setFailure('')
		    postSignal(signal, { hash: task.hash, sessionId }).then((result) => {
		      setBusy('')
		      if (result.ok) {
		        setVerdictSent(signal === 'resolve' ? 'resolved' : 'reproduced')
		        return
		      }
		      setFailure(result.reason)
		    })
		  }

		  const waiting = task.status === 'awaiting-user'
		  const verdict = task.userVerdict || verdictSent
		  const resolved = verdict === 'resolved'
		  const locked = busy !== '' || draft
		  const steps = Array.isArray(task.reproSteps) ? task.reproSteps : []
		  const headline = String(task.headline ?? '').trim()

		  // 折叠策略：默认"轮到用户就展开、其余收起"；用户手动折过之后，
		  // 这个选择只对**当前状态**有效，状态一变就回到默认策略。
		  const collapsed = foldOverride.status === task.status
		    ? foldOverride.collapsed === true
		    : task.status !== 'awaiting-user'
		  const toggleCollapsed = () => setFoldOverride({ status: task.status, collapsed: !collapsed })

		  // ── 头部：折叠时唯一可见的一行，所以它自己必须说清楚"现在轮到谁" ──
		  const head = createElement('button', {
		    type: 'button',
		    key: 'head',
		    className: 'dsh-dbg-head',
		    'aria-expanded': collapsed ? 'false' : 'true',
		    title: collapsed ? '展开调试面板' : '收起调试面板',
		    onClick: toggleCollapsed,
		  },
		  createElement('span', { className: 'dsh-dbg-chev', key: 'chev' }, chevronSvg()),
		  createElement('span', { className: 'dsh-dbg-title', key: 'title' }, '调试模式'),
		  createElement('span', { className: 'dsh-dbg-sep', key: 'sep' }, '·'),
		  createElement('span', { key: 'hash' }, `#${task.hash}`),
		  createElement('span', { className: 'dsh-dbg-sep', key: 'sep2' }, '·'),
		  createElement('span', { key: 'round' }, `第 ${task.round} 轮`),
		  createElement('span', { className: 'dsh-dbg-status', key: 'status' }, `· ${statusLine(task.status, verdict)}`),
		  createElement('span', { className: 'dsh-dbg-spacer', key: 'spacer' }),
		  createElement('span', { className: 'dsh-dbg-meta', key: 'meta' },
		    `${task.logLines ?? 0} 行 · ${formatBytes(task.logBytes ?? 0)}`))

		  const body = []
		  if (collapsed !== true) {
		    // ① 一句简短的回复 —— 面板上第一个被读到的东西。
		    if (headline) body.push(createElement('p', { className: 'dsh-dbg-headline', key: 'headline' }, headline))

		    // ② 需要用户操作的复现步骤清单 —— 面板存在的理由。
		    if (waiting && steps.length > 0) {
		      body.push(createElement('div', { key: 'steps' },
		        createElement('div', { className: 'dsh-dbg-caption' }, '请按这个顺序复现：'),
		        createElement('ol', { className: 'dsh-dbg-steps' },
		          steps.map((step, index) => createElement('li', { key: `s${index}` }, step))),
		))
		    } else if (waiting) {
		      // 没给步骤时不留白：说清"该做什么"，而不是让用户对着一个按钮发呆。
		      body.push(createElement('div', { className: 'dsh-dbg-caption', key: 'nosteps' },
		        '请按你印象里的操作再复现一次；若步骤已经变了，直接在输入框里描述新的现象即可。'))
		    }

		    if (waiting) {
		      body.push(createElement('div', { className: 'dsh-dbg-hint', key: 'hint' },
		        draft
		          ? '输入框里有未发送的内容 —— 直接发送即可，它会被当成「问题复现，继续排查」。'
		          : '也可以不用按钮：直接在输入框里描述现象，同样算「还在」。',
		))
		      body.push(createElement('div', { className: 'dsh-dbg-actions', key: 'actions' },
		        createElement('button', {
		          type: 'button',
		          key: 'resolve',
		          className: 'dsh-dbg-btn',
		          disabled: Boolean(locked),
		          onClick: () => decide('resolve'),
		        }, '问题已解决'),
		        createElement('button', {
		          type: 'button',
		          key: 'reproduce',
		          className: 'dsh-dbg-btn',
		          disabled: Boolean(locked),
		          onClick: () => decide('reproduce'),
		        }, '问题复现，需要进一步修复'),
		))
		    } else if (task.status === 'awaiting-agent') {
		      // 收尾三态：用户永远该知道代码库被留下了什么。
		      body.push(createElement('div', { className: 'dsh-dbg-hint', key: 'pending' },
		        resolved
		          ? '已通知 Agent 清理探针 —— 探针不摘干净就不算结束，收尾结果会出现在本轮回复里。'
		          // 「复现」之后日志**保留**着：Agent 要先读它，读完、开下一轮时才清空。
		          : '已通知 Agent。这一轮的日志保留着，等它读完再开下一轮。',
		))
		    } else {
		      body.push(createElement('div', { className: 'dsh-dbg-hint', key: 'active' },
		        task.status === 'active'
		          ? 'Agent 正在改代码/埋点，等它交卷后这里会开放选择。'
		          : statusLine(task.status, verdict),
		))
		    }

		    // [!] 失效必须可见（第 2 条）：闸门依赖"能写、能扫"，
		    // 缺了这个前提就绝不能让界面看起来还在保护着。
		    if (task.detector && task.detector.available === false) {
		      body.push(warnRow('detector', [
		        '残留检测未生效：宿主无法完整扫描这个工作区，收尾时的"已清理干净"结论不可靠。',
		        task.detector.writeProbeError
		          ? createElement('span', { key: 'why' }, `（${task.detector.writeProbeError}）`)
		          : null,
		      ]))
		    }
		    for (const [index, note] of (task.notes ?? []).entries()) {
		      body.push(warnRow(`note-${index}`, [stripTextMarker(note)]))
		    }
		    if (failure) {
		      body.push(createElement('div', { className: 'dsh-dbg-error', key: 'failure' },
		        `操作失败：${failure} —— 可以直接在输入框里把结论告诉 Agent。`))
		    }
		  }

		  return createElement('div', {
		    className: waiting ? 'dsh-dbg is-action' : 'dsh-dbg',
		    // 折叠/展开对无障碍与测试都可见，不用去猜 DOM 结构。
		    'data-collapsed': collapsed ? 'true' : 'false',
		    'data-status': task.status,
		  }, [head, collapsed === true ? null : createElement('div', { className: 'dsh-dbg-body', key: 'body' }, body)])
		}

		/**
		 * 调试模式的状态 tag（坐在输入框工具行左侧的 list 座位上，见 CHIP_KEY）。
		 *
		 * 观感照抄 Plan chip：同一套几何 + 一个关闭图标，但**配色是黄的、文案是「调试」**，
		 * 于是两个模式的 chip 一眼分得开（Plan 是蓝的，已实测）。
		 *
		 * 叉的语义 = **「问题已解决」这个表态本身**，不是另一套"取消"：
		 *   · 它走的就是 S5 的 `resolved`，所以 `dsh_debug_end` 那道"用户确实表过态"的门照样成立，
		 *     收尾仍然由 Agent 调 `dsh_debug_end` 完成（摘探针 + 删任务目录，日志随之删掉）；
		 *   · 差别只在**窗口**：面板按钮要等 `awaiting-user`（也就是"先报告再表态"），
		 *     而这个叉一直挂着，随时可按——`anytime` 标记就是这件事的载体。
		 *   为什么必须这样：两道门叠起来（S5 要求 awaiting-user + end 要求 resolved）会让用户
		 *   **进了调试就出不来**，实测反馈原话是"一旦进入很难退出"。这个叉把出路还给用户，
		 *   却不新增第二套会漂移的表态。
		 *
		 * 没有任务、或没有 sessionId 时渲染 null——座位服务所有会话，绝不能在无关会话里挂空壳。
		 */
		function DebugChip(props) {
		  const sessionId = props.sessionId
		  const { task } = useTaskState(sessionId)
		  /** 一次点击只发一次：请求回来之前禁用，避免"服务端处理两次"。 */
		  const [sending, setSending] = useState(false)

		  if (!sessionId || !task) return null

		  const close = () => {
		    if (sending) return
		    setSending(true)
		    // 走既有的 `/resolve`（不是新路由、也不是新语义），多带一个 `anytime` 标记。
		    postSignal('resolve', { hash: task.hash, sessionId, anytime: true }).then(() => {
		      setSending(false)
		    })
		  }

		  return createElement('button', {
		    type: 'button',
		    className: 'dsh-dbg-chip',
		    // 眼睛看到的是图标，屏幕阅读器要听到的是动作；语义由 aria-label 承担。
		    'aria-label': '结束调试：按「问题已解决」收尾（摘除探针，保留修复）',
		    title: '结束调试 —— 等同于「问题已解决」：Agent 会摘除探针、删掉日志，保留你的修复',
		    disabled: sending,
		    onClick: close,
		    'data-debug-hash': task.hash,
		    'data-debug-status': task.status,
		  }, ['调试', closeSvg()])
		}

		/**
		 * 关闭图标：**内联 SVG**（一个叉），与 Plan chip 用的 `IconCloseFill14` 同义。
		 *
		 * 为什么不用字符画的叉（`U+00D7` 乘法号、`U+2715`/`U+2716` 这类"叉号"）：
		 * 字形由字体决定，回退到哪个字体是平台的事——实测过等宽字体下会变成方框，
		 * 而且后两个码点落在本仓库禁用的符号区（AGENTS.md §4.4 的 `U+2600-U+27BF`，
		 * 所以这条注释也只能用码点举例：把字符本身写进来，守卫就会把文档自己判违规）。
		 * 图标本身 `aria-hidden`：语义由旁边的文字与 `aria-label` 承担。
		 */
		function closeSvg() {
		  return createElement('svg', {
		    className: 'dsh-dbg-svg',
		    key: 'svg',
		    width: '10',
		    height: '10',
		    viewBox: '0 0 10 10',
		    'aria-hidden': 'true',
		    focusable: 'false',
		  }, createElement('path', {
		    key: 'path',
		    d: 'M2.4 2.4 L7.6 7.6 M7.6 2.4 L2.4 7.6',
		    fill: 'none',
		    stroke: 'currentColor',
		    strokeWidth: '1.5',
		    strokeLinecap: 'round',
		  }))
		}

		/** 人类可读的字节数（面板上的日志量）。 */
		function formatBytes(bytes) {
		  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
		  if (bytes < 1024) return `${bytes} B`
		  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		}

		/**
		 * 折叠箭头：**内联 SVG**（一条折线，折起时朝右，展开时由 CSS 转 90°）。
		 *
		 * 为什么不用 `▸/▾` 这类字符：字形由字体决定，回退到哪个字体是平台的事——实测在等宽字体下
		 * 会渲染成方框。SVG 由我们自己画线，到哪都一样，而且不碰 emoji（AGENTS.md §4.4）。
		 */
		function chevronSvg() {
		  return createElement('svg', {
		    className: 'dsh-dbg-svg',
		    key: 'svg',
		    width: '10',
		    height: '10',
		    viewBox: '0 0 10 10',
		    'aria-hidden': 'true',
		    focusable: 'false',
		  }, createElement('path', {
		    key: 'path',
		    d: 'M3.2 1.6 L6.8 5 L3.2 8.4',
		    fill: 'none',
		    stroke: 'currentColor',
		    strokeWidth: '1.6',
		    strokeLinecap: 'round',
		    strokeLinejoin: 'round',
		  }))
		}

		/**
		 * 警告图标：**内联 SVG**（空心三角 + 感叹号）。
		 *
		 * 文本通道（工具返回值、指南、CLI）只能用 ASCII 的 `[!]`；面板是浏览器，就该用真正干净的图标。
		 * 图标本身 `aria-hidden`——语义由旁边的文字承担，屏幕阅读器不该读出"三角形"。
		 */
		function warnSvg() {
		  return createElement('svg', {
		    className: 'dsh-dbg-svg',
		    key: 'svg',
		    width: '12',
		    height: '12',
		    viewBox: '0 0 12 12',
		    'aria-hidden': 'true',
		    focusable: 'false',
		  }, [
		    createElement('path', {
		      key: 'tri',
		      d: 'M6 1.4 L11.1 10.6 H0.9 Z',
		      fill: 'none',
		      stroke: 'currentColor',
		      strokeWidth: '1.2',
		      strokeLinejoin: 'round',
		    }),
		    createElement('path', {
		      key: 'bar',
		      d: 'M6 4.8 V7.3',
		      fill: 'none',
		      stroke: 'currentColor',
		      strokeWidth: '1.2',
		      strokeLinecap: 'round',
		    }),
		    createElement('path', {
		      key: 'dot',
		      d: 'M6 8.6 V9.1',
		      fill: 'none',
		      stroke: 'currentColor',
		      strokeWidth: '1.4',
		      strokeLinecap: 'round',
		    }),
		  ])
		}

		/** 面板上的一行警告：图标 + 正文。 */
		function warnRow(key, children) {
		  return createElement('div', { className: 'dsh-dbg-warn', key }, [warnSvg(), ...children.filter(Boolean)])
		}

		/**
		 * 去掉宿主文本里的 ASCII 标记前缀（`[!] `）。
		 *
		 * 宿主在**纯文本通道**（工具返回值、日志）里必须写出 `[!]`，因为那边没有图标可用；
		 * 而面板已经用 SVG 画了同一个语义，再把 `[!]` 印出来就是一句话说两遍。
		 */
		function stripTextMarker(text) {
		  return String(text ?? '').replace(/^\[!\]\s*/, '')
		}

		/**
		 * @param {import('@deepseek-ai/cordis').Context} ctx
		 */
		function apply(ctx) {
		  ensureStyles()
		  // inject 是「声明感知」的：座位声明塌陷时注册随之释放、回来时重装。
		  // 绝不要裸调 ctx.slots.register —— 座位可能稍后才声明。
		  ctx.slots.inject(SLOT_KEY, () =>
		    ctx.slots.register(
		      { name: SLOT_KEY, id: SLOT_ID, order: SLOT_ORDER, label: () => '调试模式' },
		      (props) => createElement(DebugPanel, props),
		    ),
		  )

		  // 状态 tag：坐在 `conversation.input.left`（list 座位、当前零占用者）。
		  // 绝不要挪到 `conversation.input.plan` —— 见 CHIP_KEY 上面那段崩溃复盘。
		  ctx.slots.inject(CHIP_KEY, () =>
		    ctx.slots.register(
		      { name: CHIP_KEY, id: CHIP_ID, order: CHIP_ORDER, label: () => '调试' },
		      (props) => createElement(DebugChip, props),
		    ),
		  )
		}


		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
