/**
 * src/client.js —— 浏览器半源码（**由 scripts/build-client.mjs 编译成 lib/client.js**）。
 *
 * 这一版是 M4 的**可用面板**：座位注册、1s 轮询、三态渲染、按钮接线、草稿协调、
 * 收尾三态、样式令牌全部就位。
 *
 * 硬约束（改本文件前先读 DESIGN.md §9.1）：
 *   · 只能 `import` 平台种子表里的模块（目前只用到 `react`），构建脚本会拦截违规。
 *   · 本通道**没有** `host.call`、没有 `styles.insert`——宿主通信一律走同源 fetch，
 *     样式只能自己插 `<style>`。
 *   · 座位只注册一次却服务**所有会话**，必须按 `sessionId` 自过滤，无关时 `return null`；
 *     绝不要在模块级放"当前任务"这类全局状态。
 *
 * 座位选型（§9.1.3）：`conversation.composer.dock`，不是 turnTail。
 * 理由是它给到 `useInput`——面板因此能看见用户正在打什么，从而避免
 * 「打了半句描述又顺手点按钮 ⇒ 同一条信息送两遍」的竞态（§9.3.1）。
 */

import { createElement, useEffect, useState } from 'react'

/** Cordis 依赖键列表。座位服务是 `slots`。 */
export const inject = ['slots']

/** 与宿主半约定的路由前缀（见 DESIGN.md §6.2 的路由表）。 */
const ROUTE_PREFIX = '/dsh-debug-mode'

/** 轮询间隔：面板只需要"用户复现完"这一个时刻，1s 足够，也不至于打爆宿主。 */
const POLL_MS = 1000

/** 座位 key（本插件自己的 id，不会覆盖首方在同一个 dock 里的 cell）。 */
const SLOT_ID = 'debug-mode-decision'

/** 样式表标识：按它去重，避免 HMR 后插进来七八份。 */
const STYLE_ID = 'dsh-plugin-debug-mode/panel.css'

/**
 * 输入框里有没有"还没发出去的内容"。
 *
 * ⚠️ 字段名是**实测**的，不是猜的：`@deepseek-ai/dsh-client-ui-conversation` 的
 * `SessionInputShell.compose()` 就是 `{ draft: this.projection.clipboardText,
 * attachmentIds, draftRev, phase, occurrences, queue }`，而它自己比较草稿用的也是
 * `inputState.draft === ""`。（早先按候选字段名探测的写法已按 DESIGN.md §15 第 6 项
 * 的要求删掉——探测会在字段改名时静默失效，写死反而会在同一时刻立刻暴露。）
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

/** 状态 → 中文标签（面板头部）。 */
function statusLabel(status) {
  switch (status) {
    case 'active': return 'Agent 正在埋点/排查'
    case 'awaiting-user': return '等你复现并选择'
    case 'awaiting-agent': return '已通知 Agent…'
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
 * 把用户的二选一投给宿主。
 * @param {'resolve'|'reproduce'} signal
 * @param {{hash: string, sessionId: string}} input
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function postSignal(signal, input) {
  try {
    const response = await fetch(`${ROUTE_PREFIX}/${signal}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: input.hash, sessionId: input.sessionId }),
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

/** 面板的样式表：全部走 `--dsw-alias-*` 主题令牌，并且**每一处都带 fallback**。 */
const CSS = [
  '.dsh-debug-mode-panel{box-sizing:border-box;width:100%;margin:6px auto 0;display:flex;flex-direction:column;gap:8px;',
  'padding:10px 12px;border-radius:var(--dsw-radius-lg,10px);',
  'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));',
  'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));',
  'color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}',
  '.dsh-debug-mode-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:500}',
  '.dsh-debug-mode-badge{flex:none;padding:0 6px;border-radius:999px;font-size:12px;font-weight:400;',
  'color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
  '.dsh-debug-mode-count{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:12px}',
  '.dsh-debug-mode-report{white-space:pre-wrap;overflow:hidden;max-height:96px;',
  'color:var(--dsw-alias-label-secondary,#6b7280)}',
  '.dsh-debug-mode-hint{color:var(--dsw-alias-label-secondary,#6b7280)}',
  '.dsh-debug-mode-actions{display:flex;gap:8px;flex-wrap:wrap}',
  '.dsh-debug-mode-actions button{appearance:none;cursor:pointer;padding:4px 12px;border-radius:var(--dsw-radius-md,8px);',
  'font-size:13px;line-height:22px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
  'background:transparent;color:var(--dsw-alias-label-primary,inherit)}',
  '.dsh-debug-mode-actions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
  '.dsh-debug-mode-actions button:disabled{cursor:not-allowed;opacity:.5}',
  '.dsh-debug-mode-actions button.dsh-debug-mode-primary{border-color:transparent;',
  'background:var(--dsw-alias-button-primary-fill,#2563eb);color:var(--dsw-alias-button-primary-text,#fff)}',
  '.dsh-debug-mode-warn{color:var(--dsw-alias-label-warning,#b45309)}',
  '.dsh-debug-mode-error{color:var(--dsw-alias-label-error,#b91c1c)}',
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
 * 调试面板。props 由座位给出（已核实 `conversation.composer.dock` 的 standardProps）：
 *   · sessionId —— 当前会话，直接给到，不需要从别处推
 *   · useInput(selector) —— 读输入框状态（用于草稿协调）
 *   · useSession(selector) —— 订阅会话状态切片
 */
function DebugPanel(props) {
  const sessionId = props.sessionId
  const useInput = props.useInput
  const [task, setTask] = useState(null)
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')
  const [verdictSent, setVerdictSent] = useState('')

  // 草稿：有未发送内容时禁用两个按钮，避免同一条描述被送两遍（§9.3.1）。
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
        if (!alive) return
        setTask(next)
        // 宿主已经迁移过状态（用户的选择被接受）时，清掉本地的"发送中"标记。
        if (next && next.status !== 'awaiting-user') {
          setBusy('')
          setVerdictSent(next.userVerdict ?? '')
        }
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
  const locked = busy !== '' || draft
  const rows = []

  rows.push(createElement('div', { className: 'dsh-debug-mode-head', key: 'head' },
    createElement('span', { key: 'title' }, `调试模式 · 任务 ${task.hash} · 第 ${task.round} 轮`),
    createElement('span', { className: 'dsh-debug-mode-badge', key: 'status' }, statusLabel(task.status)),
    createElement('span', { className: 'dsh-debug-mode-count', key: 'count' },
      `${task.logLines ?? 0} 行 · ${formatBytes(task.logBytes ?? 0)}`),
  ))

  if (task.lastReport) {
    rows.push(createElement('div', { className: 'dsh-debug-mode-report', key: 'report' }, task.lastReport))
  }

  if (waiting) {
    rows.push(createElement('div', { className: 'dsh-debug-mode-hint', key: 'hint' },
      draft
        ? '输入框里有未发送的内容 —— 直接发送即可，它会被当成「问题复现，继续排查」。'
        : '可以直接在输入框描述现象，也可以在这里做个结论：',
    ))
    rows.push(createElement('div', { className: 'dsh-debug-mode-actions', key: 'actions' },
      createElement('button', {
        type: 'button',
        key: 'resolve',
        className: 'dsh-debug-mode-primary',
        disabled: Boolean(locked),
        onClick: () => decide('resolve'),
      }, '问题已解决'),
      createElement('button', {
        type: 'button',
        key: 'reproduce',
        disabled: Boolean(locked),
        onClick: () => decide('reproduce'),
      }, '问题复现，需要进一步修复'),
    ))
  } else if (task.status === 'awaiting-agent') {
    // 收尾三态（§9.4）：用户永远该知道代码库被留下了什么。
    const resolved = (task.userVerdict || verdictSent) === 'resolved'
    rows.push(createElement('div', { className: 'dsh-debug-mode-hint', key: 'pending' },
      resolved
        ? '已通知 Agent 清理探针 —— 探针不摘干净就不算结束，收尾结果会出现在本轮回复里。'
        // 「复现」之后日志**保留**着：Agent 要先读它，读完、开下一轮时才清空。
        : '已通知 Agent。这一轮的日志保留着，等它读完再开下一轮。',
    ))
  } else {
    rows.push(createElement('div', { className: 'dsh-debug-mode-hint', key: 'active' },
      task.status === 'active'
        ? 'Agent 正在改代码/埋点，等它交卷后这里会开放选择。'
        : statusLabel(task.status),
    ))
  }

  // ⚠️ 失效必须可见（§16.3.0 第 2 条）：闸门依赖"能写、能扫"，
  // 缺了这个前提就绝不能让界面看起来还在保护着。
  const detectorBroken = task.detector && task.detector.available === false
  if (detectorBroken) {
    rows.push(createElement('div', { className: 'dsh-debug-mode-warn', key: 'detector' },
      '残留检测未生效：宿主无法完整扫描这个工作区，收尾时的"已清理干净"结论不可靠。',
      task.detector.writeProbeError
        ? createElement('span', { key: 'why' }, `（${task.detector.writeProbeError}）`)
        : null,
    ))
  }
  for (const [index, note] of (task.notes ?? []).entries()) {
    rows.push(createElement('div', { className: 'dsh-debug-mode-warn', key: `note-${index}` }, note))
  }
  if (failure) {
    rows.push(createElement('div', { className: 'dsh-debug-mode-error', key: 'failure' },
      `操作失败：${failure} —— 可以直接在输入框里把结论告诉 Agent。`))
  }

  return createElement('div', { className: 'dsh-debug-mode-panel' }, rows)
}

/** 人类可读的字节数（面板上的日志量）。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ensureStyles()
  // inject 是「声明感知」的：座位声明塌陷时注册随之释放、回来时重装。
  // 绝不要裸调 ctx.slots.register —— 座位可能稍后才声明（见 DESIGN.md §9.1.3）。
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: SLOT_ID, order: 100, label: () => '调试模式' },
      (props) => createElement(DebugPanel, props),
    ),
  )
}
