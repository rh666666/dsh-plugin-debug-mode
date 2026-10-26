/**
 * 调试任务的标识、路径与状态形状（宿主半内部使用）。纯函数，不碰文件系统。
 *
 * 产物根的**形状**在这里定义，实际解析由 `DebugService.resolveArtifactRoot` 完成：
 *   · 首选 `<os.tmpdir()>/dsh-debug-mode/tasks/<hash>/`——调试产物属于运行期垃圾，
 *     不该出现在被调试仓库的 diff 里；
 *   · 临时根不可写（ACL、只读挂载、同名文件占位等）时回退
 *     `<workspace>/.dsh/debug-mode/tasks/<hash>/`，与旧版本布局一致，无需迁移；
 *     回退必须上报（任务 notes、欠账、`start` 返回正文）；
 *   · 两个根都不可写时 `start` 拒绝启动，不猜第三个位置。
 *
 * 权限：临时根 0700、产物文件 0600（POSIX 下 `/tmp` 全用户可写）。mode 由 DebugService 传入。
 *
 * 目录名固定为 `dsh-debug-mode`：`lib/scan.js` 的桩引用扫描按它匹配。
 */

import { LOG_FILE_EXT } from './protocol.js'

/** 任务哈希：8 位小写十六进制（碰撞概率与日志目录长度之间的折中）。 */
export const HASH_LENGTH = 8

/** 临时目录下的固定子目录名（`<os.tmpdir()>/dsh-debug-mode`）。 */
export const TEMP_ROOT_NAME = 'dsh-debug-mode'

/** 回退落点（相对工作区根，POSIX 分隔符）。 */
export const WORKSPACE_ROOT_REL = '.dsh/debug-mode'

/** 状态机的状态取值；迁移白名单见文件末尾的 `TRANSITIONS`。 */
export const STATUS = Object.freeze({
  ACTIVE: 'active',
  AWAITING_USER: 'awaiting-user',
  AWAITING_AGENT: 'awaiting-agent',
  CLOSED: 'closed',
})

/**
 * 生成任务哈希。必须使用 CSPRNG：哈希同时是日志文件名，可猜的哈希会让别的会话读到别人的日志。
 * @param {(size: number) => Uint8Array} [randomBytes] 测试注入用
 * @returns {string}
 */
export function createHash(randomBytes) {
  const bytes = randomBytes
    ? randomBytes(HASH_LENGTH / 2)
    : globalThis.crypto.getRandomValues(new Uint8Array(HASH_LENGTH / 2))
  let hash = ''
  for (const byte of bytes) hash += byte.toString(16).padStart(2, '0')
  return hash.slice(0, HASH_LENGTH)
}

/**
 * 任务目录：`tasks/<hash>/` —— **相对产物根**（临时根或回退根），POSIX 分隔符。
 * 绝对路径由 `DebugService.taskAbsDir(task)` 拼。
 */
export function taskDir(hash) {
  return `tasks/${hash}`
}

/** 探针日志文件：`tasks/<hash>/<hash>.log`（相对产物根）。 */
export function logPath(hash) {
  return `${taskDir(hash)}/${hash}${LOG_FILE_EXT}`
}

/**
 * 生成给被调试项目的探针桩的目标路径（相对产物根）。
 * `runtime/probe.mjs` 是 JS/TS 项目的默认落点；其它语言由 Agent 按同一协议自写，
 * 路径约定为 `runtime/probe.<ext>`。
 * @param {string} hash
 * @param {string} [ext='mjs']
 */
export function probeStubPath(hash, ext = 'mjs') {
  return `${taskDir(hash)}/runtime/probe.${ext}`
}

/**
 * 一个调试任务的全部持久化状态。字段冻结；新增字段必须可选。
 * @typedef {object} DebugTask
 * @property {string} hash
 * @property {string} sessionId     绑定的会话：一个会话同时只允许一个活跃任务。
 * @property {string} workspace     仓库根绝对路径（POSIX 归一化后存储）。
 * @property {string} [artifactRoot] 产物根绝对路径（临时根或回退根）。缺省 = 旧版本任务，
 *   按 `<workspace>/.dsh/debug-mode` 处理；**解析结果一经写入就不再变**，否则同一任务
 *   的日志会在两个地方各长一半。
 * @property {'temp'|'workspace'} [artifactRootKind] 产物根的种类；缺省按 `workspace`。
 * @property {string} goal          需求描述（首次启动时由 Agent 记录）。
 * @property {string} status        STATUS 之一。
 * @property {number} round         第几轮调试，从 1 开始。
 * @property {number} createdAt     epoch ms
 * @property {number} updatedAt     epoch ms
 * @property {number} probeWrites   累计写入行数（读日志时用于报告增量）。
 * @property {string} [lastReport]  Agent 最近一次提交的分析结论。
 * @property {string} [headline] 面板顶部那句「一句简短的回复」（Agent 给；缺省时由 analysis 第一行兜底）
 * @property {string[]} [reproSteps] 让用户照着做的复现步骤清单（面板渲染成编号列表）
 * @property {string[]} probeFiles  本次任务**加过探针**的文件（收尾的清理范围之一）。
 * @property {string[]} changedFiles 本次任务**改过行为**的文件（修复账：代码保留，只清调试标记）。
 * @property {import('./protocol.js').ProbeRecord[]} [lastRead] 最近一次读取的摘要（面板/诊断用）
 * @property {{probe: string, why: string}[]} [probes] Agent 自报的探针清单（读日志时用来点名"计数 0"）
 * @property {string[]} [reportedChangedFiles] Agent 自报的改动（与 diff 对账，diff 为准）
 * @property {string[]} [strayArtifacts] git 检测到的新增（未跟踪）文件
 * @property {string[]} [stubRefFiles] 仍在引用探针桩路径的文件。桩会随任务目录删除，
 *   所以这些文件必须进账本（扫描范围可能没看到它们，而收尾不许漏）。
 * @property {string[]} [scanCandidates] 下次扫描必须完整读取的文件（账本累积）
 * @property {'git'|'ledger'} [changeSource] 改动检测来源：`git` = 看了工作区改动；
 *   `ledger` = 只看 Agent 报备的文件（没有 git 或不是仓库）。
 * @property {string|null} [gitError] git 检测不可用的原因（`changeSource === 'ledger'` 时）
 * @property {string[]} [gitChangedFiles] 最近一次 git status 给出的改动文件
 * @property {{complete: boolean, source: 'git'|'ledger', changed: number, scanned: number,
 *   unreadable: string[], at: number}} [scanCoverage] 最近一次账本扫描的覆盖度。
 *   `complete` 只表示清单里的文件都读到了，不表示全仓没有残留。
 * @property {{at: number, reasons: object, coverage: object}} [residual]
 *   收尾未干净的原因（同时落成 `residual.json`，欠账看板据此把已关闭任务也列出来）
 * @property {{path: string, find: string, replace: string}[]} [undoHint] Agent 给的精确还原点（宿主绝不自动应用）
 * @property {{lastReportLines: number, staleRounds: number}} [evidence] R4 停止规则的键是「证据增量」
 * @property {string} [userVerdict] 用户在面板上的表态：`resolved` / `reproduced`。
 * @property {string} [userNote] 用户随信号附带的补充说明
 * @property {{verdict: string, anytime: boolean, at: number, text: string}} [lastSignal]
 *   最近一次用户表态的快照。`text` 就是当时投给 Agent 的那条用户消息正文——
 *   指令不在这里，它由 `debugSignalGuidance()` 注入（宿主替用户说了什么，必须可查）。
 * @property {string[]} [notes] 宿主写给 Agent 的提醒（闸门降级等），有上限
 * @property {string} [pendingPlan] 本轮 `dsh_debug_continue` 给出的下一轮计划
 */

/** @returns {DebugTask} */
export function createTask({
  hash,
  sessionId,
  workspace,
  goal,
  artifactRoot,
  artifactRootKind,
  now = Date.now(),
}) {
  return {
    hash,
    sessionId,
    workspace,
    ...(artifactRoot ? { artifactRoot } : {}),
    ...(artifactRootKind ? { artifactRootKind } : {}),
    goal: String(goal ?? '').trim(),
    status: STATUS.ACTIVE,
    round: 1,
    createdAt: now,
    updatedAt: now,
    probeWrites: 0,
    probeFiles: [],
    changedFiles: [],
    probes: [],
    notes: [],
    evidence: { lastReportLines: 0, staleRounds: 0 },
  }
}

/**
 * 状态迁移白名单。非法迁移抛错而不静默改写：兜底会让结束信号在错误的时机删掉日志。
 *
 * `awaiting-user → active` 是宿主自动迁移：用户没有点按钮，而是直接在输入框里描述了现象。
 * 它不属于用户信号，因此不走 `→ awaiting-agent`——面板要立刻收起按钮，同时不能假装
 * 用户已经下过结论。
 *
 * @param {DebugTask} task
 * @param {string} next
 */
export const TRANSITIONS = Object.freeze({
  [STATUS.ACTIVE]: [STATUS.AWAITING_USER, STATUS.CLOSED],
  [STATUS.AWAITING_USER]: [STATUS.ACTIVE, STATUS.AWAITING_AGENT, STATUS.CLOSED],
  [STATUS.AWAITING_AGENT]: [STATUS.ACTIVE, STATUS.CLOSED],
  [STATUS.CLOSED]: [],
})

export function transition(task, next) {
  const allowed = TRANSITIONS[task.status] ?? []
  if (!allowed.includes(next)) {
    throw new Error(`debug-mode: illegal transition ${task.status} -> ${next}`)
  }
  task.status = next
  return task
}
