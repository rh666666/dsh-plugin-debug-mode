/**
 * lib/task.js —— 调试任务的标识、路径与状态形状（宿主半内部使用）。
 *
 * 这里只做**纯函数**：够哈希、够路径、够状态迁移，不碰文件系统，方便单测。
 *
 * ── 产物落在哪（**这里定的是形状，解析由 DebugService.resolveArtifactRoot 做**）──
 *
 * 首选**用户临时目录**：`<os.tmpdir()>/dsh-debug-mode/tasks/<hash>/`。理由是"调试插件不该
 * 往别人的仓库里写东西"：产物（日志、探针桩、state.json、backups）本来是运行期垃圾，
 * 混进仓库就要靠 `.gitignore` 和用户自觉去兜，而它其实一行都不该出现在 diff 里。
 *
 * 临时根不可写时（ACL、只读挂载、被同名文件占位……）**回退**到
 * `<workspace>/.dsh/debug-mode/tasks/<hash>/`——与 v0.18 及以前逐字相同，所以旧任务
 * 不需要任何迁移。回退**必须出声**（任务 notes + 欠账 + `start` 返回正文），
 * 否则"产物悄悄回到仓库里"就是最不该有的一种静默行为。
 *
 * 两个根都写不进去时不猜第三个落点：`start` 直接拒绝，并把两个候选路径都给出来。
 *
 * 权限：临时根建议 0700、产物文件 0600（POSIX 下 `/tmp` 是全用户可写的，不做这一步
 * 等于把探针日志摊给同机其他用户；Windows 忽略该位）。mkdir/writeFile 的 mode 由
 * DebugService 传，这里不碰文件系统。
 *
 * 目录名必须是 `dsh-debug-mode`（连字符）：`lib/scan.js` 的桩引用扫描与文档都按它匹配。
 */

import { LOG_FILE_EXT } from './protocol.js'

/** 任务哈希：8 位小写十六进制（碰撞概率与日志目录长度之间的折中）。 */
export const HASH_LENGTH = 8

/** 临时目录下的固定子目录名（`<os.tmpdir()>/dsh-debug-mode`）。 */
export const TEMP_ROOT_NAME = 'dsh-debug-mode'

/** 回退落点（相对工作区根，POSIX 分隔符）：与 v0.18 及以前一致。 */
export const WORKSPACE_ROOT_REL = '.dsh/debug-mode'

/** 状态机的状态取值；迁移白名单见文件末尾的 `TRANSITIONS`。 */
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
 * @property {string[]} probeFiles  本次任务**加过探针**的文件（收尾时核对探针是否摘干净）。
 * @property {string[]} changedFiles 本次任务**改过行为**的文件（收尾时**不得**回滚，只做清单核对）。
 * @property {import('./protocol.js').ProbeRecord[]} [lastRead] 最近一次读取的摘要（面板/诊断用）
 * @property {{probe: string, why: string}[]} [probes] Agent 自报的探针清单（读日志时用来点名"计数 0"）
 * @property {string[]} [reportedChangedFiles] Agent 自报的改动（与 diff 对账，diff 为准）
 * @property {string[]} [strayArtifacts] R1 扫出来的新增文件（真检测，不靠自报）
 * @property {{path: string, find: string, replace: string}[]} [undoHint] Agent 给的精确还原点（宿主绝不自动应用）
 * @property {{lastReportLines: number, staleRounds: number}} [evidence] R4 停止规则的键是「证据增量」
 * @property {{ok: boolean, truncated: boolean, error: string|null, at: number, count: number}} [index] 最近一次索引结果
 * @property {string} [userVerdict] 用户在面板上的表态：`resolved` / `reproduced`（的收尾前置）
 * @property {string} [userNote] 用户随信号附带的补充说明
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
 * 状态迁移白名单。非法迁移抛错而不是静默改写——状态机是这个插件的核心不变量，
 * 悄悄兜底会让「结束调试信号」在错误的时机删掉日志。
 *
 * `awaiting-user → active` 是  的**宿主自动迁移**：用户没有点按钮，而是直接在
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
