/**
 * lib/task.js —— 调试任务的标识、路径与状态形状（宿主半内部使用）。
 *
 * 这里只做**纯函数**：够哈希、够路径、够状态迁移，不碰文件系统，方便单测。
 */

import { LOG_FILE_EXT, LOG_ROOT } from './protocol.js'

/** 任务哈希：8 位小写十六进制（碰撞概率与日志目录长度之间的折中）。 */
export const HASH_LENGTH = 8

/** 状态机的状态取值（见 DESIGN.md §6.3）。 */
export const STATUS = Object.freeze({
  ACTIVE: 'active',
  AWAITING_USER: 'awaiting-user',
  AWAITING_AGENT: 'awaiting-agent',
  CLOSED: 'closed',
})

/**
 * 生成任务哈希。**必须**用 CSPRNG：哈希同时是日志文件名，
 * 可猜的哈希意味着别的会话能猜到并读到别人的日志。
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

/** 任务目录：`.dsh/debug-mode/tasks/<hash>/`（相对仓库根，POSIX 分隔符）。 */
export function taskDir(hash) {
  return `${LOG_ROOT}/tasks/${hash}`
}

/** 探针日志文件：`.dsh/debug-mode/tasks/<hash>/<hash>.log`（相对仓库根）。 */
export function logPath(hash) {
  return `${taskDir(hash)}/${hash}${LOG_FILE_EXT}`
}

/**
 * 生成给被调试项目的探针桩的目标路径。
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
 * @property {string} goal          需求描述（首次启动时由 Agent 记录）。
 * @property {string} status        STATUS 之一。
 * @property {number} round         第几轮调试，从 1 开始。
 * @property {number} createdAt     epoch ms
 * @property {number} updatedAt     epoch ms
 * @property {number} probeWrites   累计写入行数（读日志时用于报告增量）。
 * @property {string} [lastReport]  Agent 最近一次提交的分析结论。
 * @property {string} [headline] 面板顶部那句「一句简短的回复」（Agent 给；缺省时由 analysis 第一行兜底）
 * @property {string[]} [reproSteps] 让用户照着做的复现步骤清单（面板渲染成编号列表）
 * @property {string[]} probeFiles  本次任务**加过探针**的文件（收尾时核对探针是否摘干净）。
 * @property {string[]} changedFiles 本次任务**改过行为**的文件（收尾时**不得**回滚，只做清单核对）。
 * @property {import('./protocol.js').ProbeRecord[]} [lastRead] 最近一次读取的摘要（面板/诊断用）
 * @property {{probe: string, why: string}[]} [probes] Agent 自报的探针清单（读日志时用来点名"计数 0"）
 * @property {string[]} [reportedChangedFiles] Agent 自报的改动（与 diff 对账，diff 为准）
 * @property {string[]} [strayArtifacts] R1 扫出来的新增文件（真检测，不靠自报）
 * @property {{path: string, find: string, replace: string}[]} [undoHint] Agent 给的精确还原点（宿主绝不自动应用）
 * @property {{lastReportLines: number, staleRounds: number}} [evidence] R4 停止规则的键是「证据增量」
 * @property {{ok: boolean, truncated: boolean, error: string|null, at: number, count: number}} [index] 最近一次索引结果
 * @property {string} [userVerdict] 用户在面板上的表态：`resolved` / `reproduced`（§9.4 的收尾前置）
 * @property {string} [userNote] 用户随信号附带的补充说明（§9.3.3）
 * @property {string[]} [notes] 宿主写给 Agent 的提醒（闸门降级等），有上限
 * @property {string} [pendingPlan] 本轮 `dsh_debug_continue` 给出的下一轮计划
 */

/** @returns {DebugTask} */
export function createTask({ hash, sessionId, workspace, goal, now = Date.now() }) {
  return {
    hash,
    sessionId,
    workspace,
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
 * 状态迁移白名单。非法迁移抛错而不是静默改写——状态机是这个插件的核心不变量，
 * 悄悄兜底会让「结束调试信号」在错误的时机删掉日志。
 *
 * `awaiting-user → active` 是 §9.3.2 的**宿主自动迁移**：用户没有点按钮，而是直接在
 * 输入框里描述了现象，这说明球又回到了 Agent 脚下。它不是"用户信号"，所以走这条路
 * 而不是 `awaiting-user → awaiting-agent`——面板必须立刻收起按钮（否则用户会以为
 * 系统还在等他做选择），但又不能假装"用户已经下过结论"。
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
