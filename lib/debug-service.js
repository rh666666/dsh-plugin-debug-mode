/**
 * 宿主半的调试服务：票据、任务表、日志管道、产物根、HTTP 摄入、唤醒与收尾。
 *
 * 这里承担的都是"必须由宿主判定"的职责——票据闸门、状态迁移、残留对账，
 * 提示词与模型自觉无法替代。
 *
 * 贯穿全文的两条约定：
 *   · 失败一律转成可读的中文返回值，而不是抛异常（工具返回值是模型唯一的纠正信号）；
 *   · 收尾清掉所有调试标记，但绝不动用户的修复代码。
 */

import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { byteLength, encodeRecord, formatRecord } from './protocol.js'
import {
  createHash,
  createTask,
  logPath,
  probeStubPath,
  STATUS,
  taskDir,
  TEMP_ROOT_NAME,
  transition,
  WORKSPACE_ROOT_REL,
} from './task.js'
import { readBrowserProbeTemplate, renderBrowserStub, renderHttpGuide, renderProbeStub } from './probe-template.js'
import { renderGuide, readGuideTemplate, USER_SIGNAL_LABEL } from './prompt.js'
import { renderLogSummary } from './summary.js'
import { ROUTE_PREFIX } from './routes.js'
import { gitChangedFiles } from './git.js'
import {
  applyCleanup,
  appendJournal,
  findMarkers,
  pairBlocks,
  planCleanup,
  removeMarkers,
  scanDeclared,
  verifySyntax,
} from './scan.js'

/** `/debug` 签发的票据存活时长。过期是**特性**：陈旧票据不该被后到的调用用掉。 */
export const TICKET_TTL_MS = 30 * 60 * 1000

/** 产物根的种类：临时目录 / 回退到工作区。 */
export const ARTIFACT_ROOT = Object.freeze({ TEMP: 'temp', WORKSPACE: 'workspace' })

/** 硬闸门连续拒绝同一原因多少次后降级为 warn-only（第 1 条，防死锁）。 */
export const GATE_DEGRADE_AFTER = 3

/** 日志读取的字数上限：超了只读尾部（要的是现场，不是全部历史）。 */
const LOG_READ_TAIL_BYTES = 8 * 1024 * 1024

/** 单任务日志总字节的告警线，同时也是写端与摄入端**共同的硬上限**。 */
export const LOG_WARN_BYTES = 16 * 1024 * 1024

/** 单条 HTTP 探针记录的行长上限（与 Node 桩的 8 KiB 一致）。 */
const PROBE_LINE_MAX_BYTES = 8 * 1024

/** 合法的日志级别；未知级别一律降级为 info，而不是写出一条读端看不懂的记录。 */
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error'])

/** 跨重启恢复的节流：面板每秒轮询，不能每秒扫一次目录。 */
const RESTORE_INTERVAL_MS = 15_000

/** 无活跃任务时的统一文案。 */
const NO_TASK_TEXT = '本会话没有进行中的调试任务。若用户确实要调试，请让 TA 先输入 `/debug <现象描述>`。'

/** `dsh_debug_start` 无票时的拒绝文案（，逐字冻结）。 */
const NO_TICKET_TEXT = [
  '未进入调试模式：本插件不允许 Agent 自行发起调试任务。',
  '请让用户输入 `/debug <现象描述>` 后再调用本工具。',
].join('\n')

/** 会话 id 用作文件名时只保留安全字符（SessionId 目前是 `session-<uuid>`，但不赌它一直这样）。 */
function safeFileName(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

/** 原子写：先写临时文件再 rename，避免半个 JSON 让跨重启恢复读出垃圾。 */
async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const staged = `${file}.tmp`
  await writeFile(staged, JSON.stringify(value, null, 2), 'utf8')
  await rename(staged, file)
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 读日志的尾部：文件超大时只取最后一段，并丢掉可能被截断的第一行。
 * @returns {Promise<{ text: string, bytes: number, truncated: boolean }>}
 */
async function readLogTail(absolute, maxBytes) {
  const info = await stat(absolute)
  if (info.size <= maxBytes) {
    return { text: await readFile(absolute, 'utf8'), bytes: info.size, truncated: false }
  }
  const handle = await open(absolute, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    await handle.read(buffer, 0, maxBytes, info.size - maxBytes)
    const text = buffer.toString('utf8')
    const newline = text.indexOf('\n')
    return { text: newline === -1 ? text : text.slice(newline + 1), bytes: info.size, truncated: true }
  } finally {
    await handle.close()
  }
}

export class DebugService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ logger?: { info?: Function, warn?: Function } }} [options]
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.options = options
    /** @type {Map<string, object>} sessionId -> DebugTask（内存里的活跃任务表） */
    this.tasks = new Map()
    /** @type {Map<string, {sessionId: string, text: string, issuedAt: number, workspace: string}>} */
    this.tickets = new Map()
    /** 闸门状态：key -> { reason, count, degraded } */
    this.gates = new Map()
    /** 欠账：降级与失效记录（面板常驻显示，） */
    this.debts = []
    /** 写探针自检结果：workspace -> { ok, kind, root, error, at }（产物根解析缓存） */
    this.writeProbes = new Map()
    /** 哈希生成器：测试注入用（验证"目标目录已存在就换一个哈希"的护栏）。 */
    this.hashFactory = typeof options.createHash === 'function' ? options.createHash : createHash
    /** 改动检测：默认问 git；测试可注入确定性的实现。 */
    this.listChanges = typeof options.listChanges === 'function' ? options.listChanges : gitChangedFiles
    /** 跨重启恢复的节流表 */
    this.restoreAttempts = new Map()
    /** 日志行数缓存（面板每秒轮询，不能每次重读大文件） */
    this.logLineCache = new Map()
    /** 见过的工作区根：R5 的欠账看板只能在自己知道的仓库里找（插件是全局的，没有"当前仓库"） */
    this.workspaces = new Set()
    /** 指南模板只读一次 */
    this.guideTemplate = null
    /** 浏览器桩模板只读一次（`GET /stub.js` 每次请求都要渲染它） */
    this.browserTemplate = null
  }

  /* ────────────────────────────── 基础设施 ────────────────────────────── */

  log(level, message) {
    const logger = this.options.logger ?? this.ctx?.logger
    try {
      logger?.[level]?.(`debug-mode: ${message}`)
    } catch {
      // 日志失败不该影响功能
    }
  }

  /** 会话的工作区根：优先用会话 cwd，退到进程 cwd（与首方工具同一套取值方式）。 */
  workspaceOf(sessionId) {
    const agents = this.ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    const cwd = agent?.session?.header?.cwd
    return resolve(cwd ?? process.cwd())
  }

  /* ────────────────────── 产物根：临时目录优先，不可写才回退 ────────────────────── */

  /**
   * 临时根的父目录。三级来源，**前者优先**：
   *   1. `options.tempDir`（测试与自检脚本注入，保证并行测试互不干扰）；
   *   2. `DSH_DEBUG_MODE_TMP`（用户级逃生口：`os.tmpdir()` 本身有问题时指到别处）；
   *   3. `os.tmpdir()`（Windows 下即 `%TEMP%`，本来就是按用户隔离的）。
   */
  tempBase() {
    const injected = this.options.tempDir
    if (typeof injected === 'string' && injected.trim()) return resolve(injected.trim())
    const fromEnv = process.env.DSH_DEBUG_MODE_TMP
    if (typeof fromEnv === 'string' && fromEnv.trim()) return resolve(fromEnv.trim())
    return resolve(tmpdir())
  }

  /** 临时产物根：`<tempBase>/dsh-debug-mode`。目录名被 lib/scan.js 的桩引用扫描依赖。 */
  tempRoot() {
    return join(this.tempBase(), TEMP_ROOT_NAME)
  }

  /**
   * 回退产物根（工作区里的 `.dsh/debug-mode/`）。布局与旧版本一致，旧任务无需迁移。
   */
  legacyRoot(workspace) {
    return join(workspace, ...WORKSPACE_ROOT_REL.split('/'))
  }

  /**
   * 解析产物根：**临时目录优先，不可写才回退工作区**，两个都不可写就返回失败。
   *
   * 为什么必须做"写探针"而不是 `fs.access`：ACL、只读挂载、容器挂载点这些情况下
   * `access` 给不出可信答案，而一次真实的建档-写-删能。为什么结果要**按 workspace 缓存**：
   * 面板每秒轮询都会走到这里，而且"同一工作区的中途换根"会让一份日志裂成两半。
   *
   * 为什么回退必须出声：产物回到仓库里是**最不该静默发生**的一件事，所以除了这里的
   * 欠账，调用方（`start`）还会把它写进任务 notes 与工具返回正文。
   *
   * @param {string} workspace 仓库根绝对路径
   * @returns {Promise<{ ok: boolean, kind: 'temp'|'workspace'|null, root: string|null, error: string|null, at: number, fellBack: boolean }>}
   */
  async resolveArtifactRoot(workspace) {
    this.workspaces.add(workspace)
    const cached = this.writeProbes.get(workspace)
    if (cached) return cached

    const errors = []
    const tempRoot = this.tempRoot()
    const tempProbe = await this.probeWritable(tempRoot)
    if (tempProbe.ok) {
      const result = {
        ok: true,
        kind: ARTIFACT_ROOT.TEMP,
        root: tempRoot,
        error: null,
        at: Date.now(),
        fellBack: false,
      }
      this.writeProbes.set(workspace, result)
      this.clearDebt('artifact-root')
      return result
    }
    errors.push(`临时目录 ${tempRoot}：${tempProbe.error}`)

    const fallback = this.legacyRoot(workspace)
    const fallbackProbe = await this.probeWritable(fallback)
    if (fallbackProbe.ok) {
      const result = {
        ok: true,
        kind: ARTIFACT_ROOT.WORKSPACE,
        root: fallback,
        error: tempProbe.error,
        at: Date.now(),
        fellBack: true,
      }
      this.writeProbes.set(workspace, result)
      // 回退是"功能还能用"，但不是"一切正常"：欠账要留，面板才看得到。
      this.recordDebt('artifact-root', `临时目录不可写（${tempProbe.error}），`
        + `本次调试产物回退到工作区 ${fallback}。`)
      this.log('warn', `临时产物根不可写，回退到工作区：${fallback}`)
      return result
    }
    errors.push(`回退目录 ${fallback}：${fallbackProbe.error}`)

    const result = {
      ok: false,
      kind: null,
      root: null,
      error: errors.join('；'),
      at: Date.now(),
      fellBack: false,
    }
    this.writeProbes.set(workspace, result)
    this.recordDebt('write-probe', `产物根不可写：${result.error}`)
    return result
  }

  /**
   * 一次真实的建档-写-删探针。**唯一**判断"这个根能不能用"的手段。
   * @param {string} root
   */
  async probeWritable(root) {
    const probeFile = join(root, '.probe-write-test')
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeFile(probeFile, String(Date.now()), { encoding: 'utf8', mode: 0o600 })
      await rm(probeFile, { force: true })
      return { ok: true, error: null }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * 任务的产物根（绝对路径）。
   *
   * `task.artifactRoot` 缺省表示升级前创建的任务，按工作区回退根处理——
   * 这是唯一允许走 `legacyRoot` 的分支，使旧的在途任务仍可读取与收尾。
   */
  artifactRootOf(task) {
    return task.artifactRoot ?? this.legacyRoot(task.workspace)
  }

  /** 任务目录的绝对路径。 */
  taskAbsDir(task) {
    return join(this.artifactRootOf(task), ...taskDir(task.hash).split('/'))
  }

  /**
   * 某个工作区的候选产物根（跨重启恢复用）：临时根 + 它自己的回退根。
   * 刻意**不**带上别的已知工作区：恢复是按 sessionId 匹配的，多扫几个仓库除了一点点
   * 磁盘代价没有任何收益，反而容易把"别的仓库的旧任务"误认成当前会话的。
   */
  candidateRoots(workspace) {
    const roots = [this.tempRoot()]
    if (workspace) roots.push(this.legacyRoot(workspace))
    return [...new Set(roots)]
  }

  /**
   * 欠账看板要扫的根：临时根 + 所有见过的仓库的回退根。
   * 临时目录里可能躺着在途任务，工作区里可能躺着升级前留下的任务——两者都要看得见
   * （看板只提示、不删，删除永远只发生在 `end` 里）。
   */
  boardRoots() {
    const roots = [this.tempRoot()]
    for (const workspace of [...this.workspaces, process.cwd()]) {
      if (workspace) roots.push(this.legacyRoot(workspace))
    }
    return [...new Set(roots)]
  }

  /** 记账一条欠账（降级 / 失效）。同一个 key 只留最新一条，面板不会越长越乱。 */
  recordDebt(key, reason) {
    const existing = this.debts.find((entry) => entry.key === key)
    if (existing) {
      existing.reason = reason
      existing.at = Date.now()
      existing.count += 1
      return existing
    }
    const entry = { key, reason, at: Date.now(), count: 1 }
    this.debts.push(entry)
    return entry
  }

  clearDebt(key) {
    this.debts = this.debts.filter((entry) => entry.key !== key)
  }

  /**
   * 过一道硬闸门：连续拒绝同一原因达到 `GATE_DEGRADE_AFTER` 次后降级为 warn-only 并记账。
   *
   * `reason` 必须是与每次拒绝内容无关的稳定文本——它是"同一原因"的比较键；
   * 数字与清单放进 `detail`。把变量内容写进 `reason` 会让比较永不相等，降级也就不会发生。
   *
   * @param {string} key 闸门标识
   * @param {string} reason 稳定的拒绝原因（比较键）
   * @param {string} [detail] 面向人和模型的补充正文（可含数字）
   * @returns {{ blocked: boolean, note: string }}
   */
  gate(key, reason, detail) {
    const entry = this.gates.get(key) ?? { reason, count: 0 }
    if (entry.reason !== reason) {
      entry.reason = reason
      entry.count = 0
    }
    entry.count += 1
    this.gates.set(key, entry)
    const body = detail ? `${reason}\n\n${detail}` : reason
    if (entry.count >= GATE_DEGRADE_AFTER) {
      entry.degraded = true
      this.recordDebt(`gate:${key}`, `闸门「${key}」连续拒绝 ${entry.count} 次后降级为 warn-only：${reason}`)
      return {
        blocked: false,
        note: `[!] 该闸门已连续拒绝 ${entry.count} 次，按防死锁规则降级为警告（本次放行）：\n\n${body}`,
      }
    }
    return { blocked: true, note: body }
  }

  /** 闸门被满足时清零，让"连续"这个词名副其实。 */
  passGate(key) {
    if (this.gates.delete(key)) this.clearDebt(`gate:${key}`)
  }

  /** 把一条说明塞进任务（有上限，避免 notes 无限增长）。 */
  addNote(task, note) {
    task.notes = [...(task.notes ?? []), note].slice(-10)
  }

  /* ────────────────────────────── 票据（S0/S1） ────────────────────────────── */

  /**
   * 签发票据。**只有 `/debug` 命令的处理器能调它**；任何工具参数都不接受伪造
   *。已有活跃任务时拒绝签发，并明确告知既有哈希。
   * @param {{ sessionId: string, text: string, workspace: string }} input
   */
  async issueTicket({ sessionId, text, workspace }) {
    const active = await this.findTask(sessionId, workspace)
    if (active) {
      return {
        ok: false,
        hash: active.hash,
        text: [
          `本会话已有进行中的调试任务 #${active.hash}（第 ${active.round} 轮 · ${active.status}）。`,
          '先把它解决，或在输入框上方的面板上继续——不要新开第二个任务：',
          '那会让日志裂成两份，"这次到底埋在哪"当场变成新的 bug。',
        ].join('\n'),
      }
    }
    const ticket = {
      sessionId,
      text: String(text ?? '').trim(),
      workspace,
      issuedAt: Date.now(),
    }
    this.tickets.set(sessionId, ticket)
    try {
      const file = await this.ticketFile(workspace, sessionId)
      if (file) await writeJsonAtomic(file, ticket)
      else this.log('warn', '产物根不可写，票据仅内存有效')
    } catch (error) {
      // 磁盘上写不下不影响本次会话：内存里的票据照样有效。
      this.log('warn', `票据落盘失败（仅内存有效）：${String(error?.message ?? error)}`)
    }
    return { ok: true, hash: '', ticket }
  }

  /**
   * 票据文件：与产物同根（`<root>/pending/<sessionId>.json`）。
   *
   * 解析不出产物根（两个候选都写不进去）时返回 `null`：那时也建不出任务，
   * 票据留在内存里即可——`start` 会把"两个候选路径都写不进去"如实报出来。
   */
  async ticketFile(workspace, sessionId) {
    const root = await this.resolveArtifactRoot(workspace)
    if (!root.ok) return null
    return join(root.root, 'pending', `${safeFileName(sessionId)}.json`)
  }

  /** 读票据：内存优先，其次磁盘（跨进程重启后仍能用一次）。 */
  async peekTicket(sessionId, workspace) {
    const memory = this.tickets.get(sessionId)
    if (memory) {
      if (Date.now() - memory.issuedAt > TICKET_TTL_MS) {
        await this.consumeTicket(sessionId, memory.workspace)
        return null
      }
      return memory
    }
    const root = workspace ?? this.workspaceOf(sessionId)
    const file = await this.ticketFile(root, sessionId)
    if (!file) return null
    const stored = await readJson(file)
    if (!stored) return null
    if (Date.now() - Number(stored.issuedAt ?? 0) > TICKET_TTL_MS) {
      await rm(file, { force: true })
      return null
    }
    this.tickets.set(sessionId, stored)
    return stored
  }

  /**
   * 持票期的只读快照，供 `systemPrompt.section` 的同步 thunk 使用。
   *
   * 与 `peekTicket` 的差别是刻意的：本方法**同步**（thunk 不能返回 Promise；
   * 渲染成 `[object Promise]` 等于这段提示消失）、**不碰磁盘**（每次模型请求都会调用）、
   * **不消费票据**（消费只发生在 `start` 成功之后）。
   *
   * 过期票据按"不存在"返回，但不在这里删除——删除是有副作用的异步操作，
   * 由 `peekTicket` / `start` 负责。进程重启后内存为空，代价只是少注入一段提示，
   * 入口校验仍以磁盘上的票据为准。
   *
   * @param {string} sessionId
   * @returns {{sessionId: string, text: string, issuedAt: number, workspace: string} | null}
   */
  pendingTicket(sessionId) {
    const ticket = this.tickets.get(sessionId)
    if (!ticket) return null
    if (Date.now() - Number(ticket.issuedAt ?? 0) > TICKET_TTL_MS) return null
    return ticket
  }

  /** 消费票据（一次性）。 */
  async consumeTicket(sessionId, workspace) {
    this.tickets.delete(sessionId)
    try {
      const file = await this.ticketFile(workspace ?? this.workspaceOf(sessionId), sessionId)
      if (file) await rm(file, { force: true })
    } catch {
      // 删不掉旧票据不是错误：TTL 会兜住它。
    }
  }

  /* ────────────────────────────── 任务表 ────────────────────────────── */

  /**
   * 内存任务；没有就尝试跨重启恢复（节流）。
   *
   * 子 Agent（subagent / workflow）**继承父会话的任务**而不是新建：否则
   * 一个任务会裂成多个哈希，日志四分五裂——那正是这个插件要消灭的东西。
   */
  async findTask(sessionId, workspace) {
    for (const id of this.sessionChain(sessionId)) {
      const task = this.tasks.get(id)
      if (task) return task
    }
    for (const id of this.sessionChain(sessionId)) {
      const restored = await this.restoreForSession(id, workspace)
      if (restored) return restored
    }
    return null
  }

  /** 会话链：自己 + 父会话（只有一层就够——父子层级由 DSH 保证）。 */
  sessionChain(sessionId) {
    const chain = [sessionId]
    try {
      const agent = this.ctx.get('agents')?.get?.(sessionId)
      const parent = agent?.session?.header?.parentSession
      if (parent && parent !== sessionId) chain.push(parent)
    } catch {
      // 拿不到就只认自己
    }
    return chain
  }

  /**
   * 跨重启恢复：`state.json` 存在的唯一理由。
   * 面板每秒轮询，所以这里必须节流，否则一个长会话能把磁盘打满。
   */
  async restoreForSession(sessionId, workspace) {
    const attempt = this.restoreAttempts.get(sessionId) ?? 0
    if (Date.now() - attempt < RESTORE_INTERVAL_MS) return null
    this.restoreAttempts.set(sessionId, Date.now())
    const root = workspace ?? this.workspaceOf(sessionId)
    // 产物根可能有两个（临时根 / 工作区回退根），所以恢复要逐个找：升级前的任务只可能
    // 在后者里，而升级后的在途任务只可能在前者里。
    for (const candidate of this.candidateRoots(root)) {
      const restored = await this.restoreFromRoot(candidate, sessionId)
      if (restored) return restored
    }
    return null
  }

  /** 在一个产物根里按 sessionId 找一个未关闭的任务；`state.json` 是恢复的唯一依据。 */
  async restoreFromRoot(root, sessionId) {
    const tasksRoot = join(root, 'tasks')
    let entries
    try {
      entries = await readdir(tasksRoot, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const state = await readJson(join(tasksRoot, entry.name, 'state.json'))
      if (!state || state.sessionId !== sessionId) continue
      if (state.status === STATUS.CLOSED) continue
      this.tasks.set(sessionId, state)
      this.log('info', `恢复任务 #${state.hash}（${state.status}）于 ${root}`)
      return state
    }
    return null
  }

  /** 按哈希找任务；找不到时先尝试按会话恢复一次（重启后面板仍能点按钮）。 */
  async findByHash(hash, sessionId) {
    for (const task of this.tasks.values()) {
      if (task.hash === hash) return task
    }
    if (sessionId) {
      await this.restoreForSession(sessionId)
      for (const task of this.tasks.values()) {
        if (task.hash === hash) return task
      }
    }
    return null
  }

  /** 落盘任务状态；失败只记日志——内存里的任务仍在工作。 */
  async persist(task) {
    task.updatedAt = Date.now()
    try {
      await writeJsonAtomic(join(this.taskAbsDir(task), 'state.json'), task)
    } catch (error) {
      this.log('warn', `state.json 写入失败：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 任务目录就绪（`runtime/` 与 `backups/`）。
   *
   * [!] **只有回退根**才顺带创建 `<workspace>/.dsh/` 与两个 `.gitignore`：产物落在仓库里
   * 才需要"永不进版本库"的保证。临时根模式下，工作区里**一个字节都不写**——这正是
   * 这次改动的目的，写成"总是创建 .dsh/"就等于把目的取消了。
   */
  async ensureTaskDir(task) {
    const dir = this.taskAbsDir(task)
    await mkdir(join(dir, 'runtime'), { recursive: true, mode: 0o700 })
    await mkdir(join(dir, 'backups'), { recursive: true, mode: 0o700 })
    if (this.artifactRootOf(task) === this.legacyRoot(task.workspace)) {
      const dshRoot = join(task.workspace, '.dsh')
      await mkdir(dshRoot, { recursive: true })
      // 两处都写：一处保证 `.dsh/` 整体被忽略，一处是历史落点，避免下一个人以为漏了。
      await writeFile(join(dshRoot, '.gitignore'), '*\n', 'utf8')
      await writeFile(join(this.legacyRoot(task.workspace), '.gitignore'), '*\n', 'utf8')
    }
    return dir
  }

  /** 任务的绝对路径组（工具返回值与指南都用它）。**单一来源**：全部由产物根推导。 */
  pathsOf(task) {
    // 注意：`taskDir` / `logPath` / `probeStubPath` 都是**相对产物根**的形状，所以必须拿根去拼。
    // 拿任务目录去拼会得到 `…/tasks/<hash>/tasks/<hash>/<hash>.log`（冒烟测试当场抓到过）。
    const root = this.artifactRootOf(task)
    const dir = join(root, ...taskDir(task.hash).split('/'))
    return {
      dir,
      log: join(root, ...logPath(task.hash).split('/')),
      stub: join(root, ...probeStubPath(task.hash).split('/')),
      browserStub: join(dir, 'runtime', 'probe.browser.js'),
      httpGuide: join(dir, 'runtime', 'probe.http.md'),
      guide: join(dir, 'AGENT-PROBE-GUIDE.md'),
    }
  }

  /**
   * 把本次任务的产物写到磁盘；**幂等**，可重复调用。
   *
   * 产物位于临时目录，而临时目录被系统清理是常态；日志与探针桩属于运行期必需，
   * 调用方（`start`、`continueDebug`）因此会在使用前重新补齐而不是假定它们存在。
   *
   * @param {object} task
   * @param {{ fresh?: boolean }} [options] `fresh` 表示首次落盘，日志写成空文件
   * @returns {Promise<{ dir: string, paths: object, channelReady: boolean, endpoint: string|null }>}
   */
  async provisionArtifacts(task, options = {}) {
    const paths = this.pathsOf(task)
    const dir = await this.ensureTaskDir(task)
    const endpoint = this.probeEndpoint(task.hash)

    // 日志文件在 start 就建出来（空文件）：探针第一次写入时它已经存在，用户也能立刻
    // `tail -f` 上去；"文件不存在"与"文件为空"因此是两种不同的信号。
    if (options.fresh || !(await this.fileExists(paths.log))) {
      await writeFile(paths.log, '', { encoding: 'utf8', mode: 0o600 })
    }
    if (!(await this.fileExists(paths.stub))) {
      await writeFile(paths.stub, await renderProbeStub({
        hash: task.hash,
        logAbsolutePath: paths.log,
      }), { encoding: 'utf8', mode: 0o600 })
    }

    // HTTP 通道：这是**语言无关的统一入口**——写日志这件事只有宿主一份实现。
    // 端口未知时**不写一个猜的地址**——探针的失败是静默的，那比没有更糟。
    if (endpoint) {
      if (!(await this.fileExists(paths.browserStub))) {
        await writeFile(paths.browserStub, await renderBrowserStub({
          hash: task.hash,
          endpoint,
        }), { encoding: 'utf8', mode: 0o600 })
      }
      if (!(await this.fileExists(paths.httpGuide))) {
        await writeFile(paths.httpGuide, await renderHttpGuide({
          hash: task.hash,
          endpoint,
          logPath: paths.log,
          probeStub: paths.stub,
        }), { encoding: 'utf8', mode: 0o600 })
      }
    }

    // 指南每次都重写：它带 `{{ROUND}}` 与任务地址，重写一次的成本远低于"读到上一轮的轮次"。
    this.guideTemplate = this.guideTemplate ?? (await readGuideTemplate())
    await writeFile(paths.guide, renderGuide({
      template: this.guideTemplate,
      hash: task.hash,
      logPath: paths.log,
      probeStub: paths.stub,
      probeImport: toFileUrl(paths.stub),
      browserStubUrl: endpoint ? this.browserStubUrl(task.hash) : null,
      browserStub: endpoint ? paths.browserStub : '（宿主地址未知，未生成——见下面「HTTP 探针通道」）',
      httpGuide: endpoint ? paths.httpGuide : '（宿主地址未知，未生成）',
      probeEndpoint: endpoint ?? '（宿主地址未知：请让用户告诉你 DSH Web UI 的地址）',
      round: task.round,
      goal: task.goal,
      taskDir: dir,
      artifactRootKind: this.artifactRootOf(task) === this.legacyRoot(task.workspace)
        ? ARTIFACT_ROOT.WORKSPACE
        : ARTIFACT_ROOT.TEMP,
    }), { encoding: 'utf8', mode: 0o600 })

    return { dir, paths, channelReady: Boolean(endpoint), endpoint }
  }

  /** 文件存在且是普通文件。幂等补贴产物时的判据（读不到就当不存在）。 */
  async fileExists(absolute) {
    try {
      return (await stat(absolute)).isFile()
    } catch {
      return false
    }
  }

  /**
   * 路径是否存在（文件或目录）。
   *
   * 与 `fileExists` 分开：哈希防撞要问的是"这个任务目录名被占了没有"，
   * 用 `isFile()` 问目录永远得到 false。
   */
  async pathExists(absolute) {
    try {
      await stat(absolute)
      return true
    } catch {
      return false
    }
  }

  /**
   * 宿主 Web 基地址的绝对形式（页面可能跑在 `file://` 下，相对路径到不了宿主）。
   *
   * 取值顺序：`DSH_WEB_URL` 优先（部署若改走代理或隧道，以它为准），
   * 否则用 `ctx.webServer.port`（`webServer` 是硬依赖，端口总在手里）。
   * 两者都拿不到时返回 null，调用方必须如实报告地址未知——不猜端口，
   * 猜错的后果是探针静默丢失。
   *
   * @returns {string|null}
   */
  endpointBase() {
    const url = process.env.DSH_WEB_URL
    if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) return url.trim().replace(/\/+$/, '')
    const port = this.ctx?.webServer?.port
    if (Number.isInteger(port) && port > 0 && port <= 65535) return `http://127.0.0.1:${port}`
    return null
  }

  /** 某个任务的 HTTP 摄入端点（绝对 URL）；宿主地址未知时返回 null。 */
  probeEndpoint(hash) {
    const base = this.endpointBase()
    return base ? `${base}${ROUTE_PREFIX}/probe?h=${hash}` : null
  }

  /**
   * 某个任务的**浏览器桩 URL**（宿主自己伺服，`GET /dsh-debug-mode/stub.js?h=<hash>`）。
   *
   * 为什么浏览器桩不能再靠"把文件放进被调试项目、由它自己的 dev server 伺服"：产物现在
   * 住在用户临时目录里，项目根本看不见它。经典的 `<script src>` 不受 CORS 限制，所以
   * 让宿主自己发这份脚本是最短的路径——而且它是**即时渲染**的，临时目录被清理也不影响。
   *
   * 宿主地址未知时返回 null（那时连摄入端点都没有，桩也就没有意义）。
   */
  browserStubUrl(hash) {
    const base = this.endpointBase()
    return base ? `${base}${ROUTE_PREFIX}/stub.js?h=${hash}` : null
  }

  /**
   * 浏览器桩源码（`GET /stub.js` 的正文）。**即时渲染**，不读磁盘上的副本。
   * @returns {Promise<{ ok: boolean, code: number, source?: string, reason?: string, hash?: string }>}
   */
  async browserStubSource(hash) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{8}$/.test(hash)) {
      return { ok: false, code: 400, reason: '缺少或非法的 h 参数（应为 8 位十六进制任务哈希）' }
    }
    const task = await this.findByHash(hash)
    if (!task) return { ok: false, code: 404, reason: `没有哈希为 ${hash} 的任务（可能已经结束了）` }
    if (task.status === STATUS.CLOSED) return { ok: false, code: 409, reason: `任务 #${hash} 已经结束了` }
    const endpoint = this.probeEndpoint(hash)
    if (!endpoint) {
      return {
        ok: false,
        code: 503,
        reason: '宿主地址未知（既没有 DSH_WEB_URL 也拿不到 webServer.port），'
          + '无法把摄入端点烘进桩里——请让用户告诉你 DSH Web UI 的地址。',
      }
    }
    this.browserTemplate = this.browserTemplate ?? (await readBrowserProbeTemplate())
    const source = await renderBrowserStub({ template: this.browserTemplate, hash, endpoint })
    return { ok: true, code: 200, source, hash }
  }

  /* ────────────────────────────── HTTP 探针摄入 ────────────────────────────── */

  /**
   * 接收来自浏览器或远端运行时的探针记录。
   *
   * 三项校验都在宿主侧完成：
   *   1. 用 `formatRecord()` 重新序列化后落盘——HTTP 通道只负责传输，不构成协议的第二份实现；
   *   2. 哈希必须属于一个活跃任务，路径全部由任务表推导，不接受投递方给出的路径；
   *   3. 单行 8 KiB、单任务 16 MiB 限额，到顶写一条 `debug-mode:overflow` 后停止追加。
   *
   * @param {{ hash: string, payload: unknown }} input
   * @returns {Promise<{ ok: boolean, code: number, accepted: number, rejected: number, reason?: string, bytes?: number }>}
   */
  async ingestProbe({ hash, payload }) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{8}$/.test(hash)) {
      return { ok: false, code: 400, accepted: 0, rejected: 0, reason: '缺少或非法的 h 参数（应为 8 位十六进制任务哈希）' }
    }
    const task = await this.findByHash(hash)
    if (!task) {
      return { ok: false, code: 404, accepted: 0, rejected: 0, reason: `没有哈希为 ${hash} 的任务（可能已经结束了）` }
    }
    if (task.status === STATUS.CLOSED) {
      return { ok: false, code: 409, accepted: 0, rejected: 0, reason: `任务 #${hash} 已经结束了` }
    }

    const records = normalizeProbePayload(payload)
    if (records.length === 0) {
      return { ok: false, code: 400, accepted: 0, rejected: 0, reason: '请求体里没有可解析的探针记录' }
    }

    const paths = this.pathsOf(task)
    let bytes = 0
    try {
      bytes = (await stat(paths.log)).size
    } catch {
      bytes = 0
    }

    const lines = []
    let rejected = 0
    let degraded = 0
    let overflowed = false
    for (const raw of records) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        rejected += 1
        continue
      }
      if (typeof raw.probe !== 'string' || raw.probe.trim() === '') {
        rejected += 1
        continue
      }
      const record = {
        ts: typeof raw.ts === 'string' && raw.ts ? raw.ts : undefined,
        // `task` 由宿主写死：投递方说什么都不算数。
        task: hash,
        // 这里不做任何预截断：截断的唯一权威是 `encodeRecord()`，它会省略超长值、
        // 重新序列化，并留下 `truncated: true` 与省略量。在此处静默 slice 会让
        // 同一记录在 HTTP 与文件桩两条路径上得到不同结果。
        probe: raw.probe,
        level: LEVELS.has(raw.level) ? raw.level : 'info',
      }
      if (raw.msg !== undefined) record.msg = String(raw.msg)
      if (raw.data !== undefined) record.data = raw.data

      let line = formatRecord(record)
      // 超限时不切这一行——切出来的是半个 JSON。改为省略超长值后重新序列化
      // （见 `encodeRecord()`）。
      if (byteLength(line) > PROBE_LINE_MAX_BYTES) {
        const encoded = encodeRecord(record, PROBE_LINE_MAX_BYTES)
        line = encoded.line
        if (encoded.degraded) degraded += 1
      }
      const size = byteLength(line)
      if (bytes + size > LOG_WARN_BYTES) {
        overflowed = true
        break
      }
      lines.push(line)
      bytes += size
    }

    if (overflowed) {
      lines.push(formatRecord({
        task: hash,
        probe: 'debug-mode:overflow',
        level: 'warn',
        msg: `日志已达 ${LOG_WARN_BYTES} 字节上限，探针停止写入；请收窄埋点或开新一轮`,
      }))
      this.recordDebt(`log-size:${hash}`, `日志已达上限（${(LOG_WARN_BYTES / 1024 / 1024).toFixed(0)} MiB），写端已停止追加。`)
    }

    if (lines.length > 0) {
      try {
        await appendFile(paths.log, lines.join(''), { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        // 临时目录被系统清理过：目录没了，appendFile 会 ENOENT。补一次目录再写一次——
        // 这条通道是"尽力而为"的，但"能救回来的丢失"不该真的丢掉。
        if (error?.code === 'ENOENT') {
          try {
            await mkdir(dirname(paths.log), { recursive: true, mode: 0o700 })
            await appendFile(paths.log, lines.join(''), { encoding: 'utf8', mode: 0o600 })
          } catch (retryError) {
            return {
              ok: false,
              code: 500,
              accepted: 0,
              rejected: records.length,
              reason: `写入日志失败：${String(retryError?.message ?? retryError)}`,
            }
          }
        } else {
          return {
            ok: false,
            code: 500,
            accepted: 0,
            rejected: records.length,
            reason: `写入日志失败：${String(error?.message ?? error)}`,
          }
        }
      }
      task.probeWrites = (task.probeWrites ?? 0) + (lines.length - (overflowed ? 1 : 0))
      // 记下"这条通道真的送进来过东西"。它换来一个**可判定**的问题：
      // 「日志是空的」到底是**通道没通**，还是**埋点没被执行**——。
      task.httpChannel = {
        at: Date.now(),
        records: (task.httpChannel?.records ?? 0) + (lines.length - (overflowed ? 1 : 0)),
      }
      this.logLineCache.delete(paths.log)
      await this.persist(task)
    }

    return {
      ok: true,
      // 200 而非 204：响应体里的 accepted / rejected / bytes 是给自检用的；
      // HTTP 规范不允许 204 带响应体，严格客户端会拒绝读取。
      code: 200,
      accepted: lines.length - (overflowed ? 1 : 0),
      rejected,
      bytes,
      // 降级条数要报出来：它是"你的负载超了 8 KiB"的唯一提示，
      // 而且**不会**变成脏行（脏行是读端看不见的静默丢失）。
      ...(degraded > 0 ? { degraded } : {}),
      ...(overflowed ? { reason: '日志已到上限，本次只记录了 overflow 说明' } : {}),
    }
  }

  /**
   * 通道自检（`GET /probe`）：**在让用户复现之前**回答"这条通道活着吗"。
   *
   * 为什么值得单独一个入口：探针投递是**尽力而为**的（发不出去就丢，），
   * 于是通道一旦是死的，用户复现完看到的只有"日志是空的"——然后所有人开始怀疑埋点位置。
   * 这个 GET 让"通道"本身可以先被单独测一次。
   *
   * @param {string} hash
   */
  async probeStatus(hash) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{8}$/.test(hash)) {
      return { ok: false, code: 400, reason: '缺少或非法的 h 参数（应为 8 位十六进制任务哈希）' }
    }
    const task = await this.findByHash(hash)
    if (!task) {
      return { ok: false, code: 404, reason: `没有哈希为 ${hash} 的任务（可能已经结束了）` }
    }
    const paths = this.pathsOf(task)
    const logInfo = await this.logStat(paths.log)
    const records = task.httpChannel?.records ?? 0
    return {
      ok: true,
      code: 200,
      hash,
      round: task.round,
      status: task.status,
      logBytes: logInfo.bytes,
      logLines: logInfo.lines,
      // 日志的绝对路径：产物可能住在临时目录里，活模式自检脚本（`--endpoint`）需要它，
      // 而它自己拼不出来——产物根是运行时决定的，只有宿主知道。
      logPath: paths.log,
      // 通过 HTTP 通道收到过多少条（与文件桩写的无关）。
      httpRecords: records,
      httpLastAt: task.httpChannel?.at ?? null,
      hint: records > 0
        ? `通道已经送进来过 ${records} 条记录。`
        : '通道是通的，但还没有记录送进来——发一条真实探针再 GET 一次，'
          + 'accepted 与 httpRecords 都应该 +1；那才叫"通道通了"。',
    }
  }

  /**
   * 量一次工作区改动。**不做全仓遍历**：有 git 就问 git status，没有就只认账本。
   *
   * 返回的 `files` 已排除删除的文件；`untracked` 是本轮新增、还没被 git 跟踪的文件。
   * `changeSource` 会写进任务：面板与收尾报告必须说清这次到底看的是哪些文件。
   *
   * @param {object} task
   * @returns {Promise<{ok: boolean, files: string[], untracked: string[], deleted: string[], reason: string|null, error: string|null}>}
   */
  async detectChanges(task) {
    let changes
    try {
      changes = await this.listChanges(task.workspace)
    } catch (error) {
      // 改动检测失败不能挡住调试本身：退回账本，并把原因交给面板与正文。
      changes = {
        ok: false,
        files: [],
        untracked: [],
        deleted: [],
        reason: 'error',
        error: String(error?.message ?? error),
      }
    }
    task.changeSource = changes.ok ? 'git' : 'ledger'
    task.gitError = changes.ok ? null : (changes.reason ?? changes.error ?? 'error')
    task.gitChangedFiles = changes.ok ? changes.files : []
    return changes
  }

  /* ────────────────────────────── 扫描范围（R2 / 收尾的正确性） ────────────────────────────── */

  /**
   * 本次收尾**必须完整扫描**的相对路径集合：Agent 账本 + git 改动文件。
   *
   * 扫描范围只由这份集合决定：不再遍历仓库，所以"没报备、git 也没发现"的文件
   * 不在本次清理范围内——这一点必须由返回值与提示词如实说明。
   *
   * @param {object} task
   * @param {{ targetFiles?: string[], stubRefFiles?: string[], fixFiles?: string[] }} [scan]
   * @param {string[]} [extra] 本次调用的额外清单（自报的 cleanedFiles / git 改动）
   * @returns {string[]} POSIX 相对路径，去重后有序
   */
  candidatePaths(task, scan, extra) {
    const paths = [
      ...(task.probeFiles ?? []),
      ...(task.changedFiles ?? []),
      ...(task.strayArtifacts ?? []),
      ...(task.undoHint ?? []).map((hint) => hint?.path),
      ...(scan?.targetFiles ?? []),
      ...(scan?.stubRefFiles ?? []),
      ...(scan?.fixFiles ?? []),
      ...(task.scanCandidates ?? []),
      ...(extra ?? []),
    ]
    return [...new Set(paths
      .map((value) => String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter(isSafeRelativePath))]
      .sort()
  }

  /**
   * "已知任务哈希"：内存任务表 + 各候选产物根下 `tasks/<hash>` 的目录名。
   *
   * 为什么必须带上磁盘上的目录名：收尾未清干净时任务目录会被保留，它的哈希就活在
   * 那些残留标记里。只看内存会让下一个任务把**自己插件的**旧标记判成"陌生哈希"，
   * 于是同一批残留永远在隔离区里打转——那是"再也清不掉"的另一种形态。
   */
  async knownHashesFor() {
    const hashes = new Set()
    for (const task of this.tasks.values()) hashes.add(String(task.hash ?? '').toLowerCase())
    for (const root of this.boardRoots()) {
      let entries
      try {
        entries = await readdir(join(root, 'tasks'), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (/^[0-9a-f]{8}$/.test(entry.name)) hashes.add(entry.name)
      }
    }
    hashes.delete('')
    return [...hashes]
  }

  /* ────────────────────────────── S1 start ────────────────────────────── */

  /**
   * S1 启动调试。前置：本会话持有有效票据。
   * 幂等：已有活跃任务时返回既有信息，且**不消费票据**。
   */
  async start({ sessionId, goal, workspace }) {
    const root = workspace ?? this.workspaceOf(sessionId)
    this.workspaces.add(root)
    const existing = await this.findTask(sessionId, root)
    if (existing) {
      const paths = this.pathsOf(existing)
      return {
        ok: true,
        reused: true,
        hash: existing.hash,
        round: existing.round,
        status: existing.status,
        logPath: paths.log,
        probeStub: paths.stub,
        text: [
          `本会话已有进行中的调试任务 · #${existing.hash} · 第 ${existing.round} 轮 · ${existing.status}`,
          `日志：${paths.log}`,
          `探针桩：${paths.stub}`,
          '',
          '没有新建第二个任务（否则日志会裂成两份）。要继续就调用 `dsh_debug_continue`，',
          '要看现场就调用 `dsh_debug_read`。',
        ].join('\n'),
      }
    }

    const ticket = await this.peekTicket(sessionId, root)
    if (!ticket) {
      this.passGate(`no-ticket:${sessionId}`)
      return { ok: false, hash: '', round: 0, status: '', text: NO_TICKET_TEXT }
    }

    // 产物根：临时目录优先，不可写才回退工作区。两个都不可写就**不要假装能调试**：
    // 把两个候选路径与两个原因都摆出来，这比"沙箱拒绝"四个字有用得多。
    const artifact = await this.resolveArtifactRoot(root)
    if (!artifact.ok) {
      return {
        ok: false,
        hash: '',
        round: 0,
        status: '',
        text: [
          '无法创建调试任务：产物根一个都写不进去。',
          `候选一（首选）：${this.tempRoot()}`,
          `候选二（回退）：${this.legacyRoot(root)}`,
          `错误：${artifact.error}`,
          '',
          '这不是模型能绕开的问题。请让用户：把临时目录指到一个可写的位置'
          + '（环境变量 DSH_DEBUG_MODE_TMP），或给工作区写权限后重试。',
        ].join('\n'),
      }
    }

    // 产物根变成全局共享目录后，哈希目录名跨仓库也可能撞：撞了就换一个，
    // 否则会把另一个任务的 state.json/日志直接盖掉（那是最难查的一种"串台"）。
    let hash = ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = this.hashFactory()
      if (!(await this.pathExists(join(artifact.root, ...taskDir(candidate).split('/'))))) {
        hash = candidate
        break
      }
    }
    if (!hash) {
      return {
        ok: false,
        hash: '',
        round: 0,
        status: '',
        text: `连续 3 次生成的哈希目录都已存在（${artifact.root}）：请清理残留的任务目录后重试。`,
      }
    }

    const task = createTask({
      hash,
      sessionId,
      workspace: root,
      goal,
      artifactRoot: artifact.root,
      artifactRootKind: artifact.kind,
    })
    // 回退必须出声：写进任务 notes（面板会显示）与下面的返回正文。
    // 措辞与欠账、返回正文共用"回退到工作区"这个说法——三处各说各话等于没说。
    if (artifact.fellBack) {
      this.addNote(task, `[!] 临时目录不可写（${artifact.error}），本次调试产物**回退**到工作区 `
        + `${artifact.root}（已加 .gitignore，收尾会随任务一起删除）。`)
    }

    let channelReady = false
    let guide = ''
    try {
      const provisioned = await this.provisionArtifacts(task, { fresh: true })
      channelReady = provisioned.channelReady
      guide = await readFile(provisioned.paths.guide, 'utf8')

      // R1：改动检测只问 git（没有 git 就只认账本），不遍历仓库。
      await this.detectChanges(task)
      task.evidence = { lastReportLines: 0, staleRounds: 0 }
      await this.persist(task)
      this.tasks.set(sessionId, task)
      await appendJournal(join(provisioned.dir, 'journal.jsonl'), {
        op: 'start',
        task: hash,
        workspace: root,
        artifactRoot: artifact.root,
        artifactRootKind: artifact.kind,
        goal: task.goal,
      })
    } catch (error) {
      // 建到一半失败：把残留目录清掉，绝不留下"半个任务"。
      await rm(this.taskAbsDir(task), { recursive: true, force: true }).catch(() => {})
      this.log('warn', `任务创建失败：${String(error?.message ?? error)}`)
      return {
        ok: false,
        hash: '',
        round: 0,
        status: '',
        text: `创建调试任务失败（票据未消费，可重试）：${String(error?.message ?? error)}`,
      }
    }

    // 只有整条链都成功了才消费票据（被拒不消费）。
    await this.consumeTicket(sessionId, root)
    const paths = this.pathsOf(task)

    return {
      ok: true,
      reused: false,
      hash,
      round: task.round,
      status: task.status,
      logPath: paths.log,
      probeStub: paths.stub,
      probeImport: toFileUrl(paths.stub),
      probeEndpoint: this.probeEndpoint(hash) ?? '',
      browserStubUrl: this.browserStubUrl(hash) ?? '',
      artifactRoot: artifact.root,
      artifactRootKind: artifact.kind,
      taskDir: paths.dir,
      text: [
        `已进入调试模式 · 任务 #${hash} · 第 1 轮`,
        `产物目录：${paths.dir}（${artifact.kind === ARTIFACT_ROOT.TEMP ? '用户临时目录' : '工作区回退'}）`,
        `日志：${paths.log}`,
        artifact.fellBack
          ? '[!] 临时目录不可写，产物回退到了工作区——收尾会随任务一起删掉，但仍请知悉。'
          : '',
        task.changeSource === 'ledger'
          ? '[!] 未检测到 git：宿主不会遍历仓库，收尾只按你报备的文件清理——埋过点、改过的文件都要报。'
          : '',
        '',
        '**埋点优先走 HTTP 通道**（语言无关：写日志这件事只有宿主一份实现，',
        '不需要为某种语言照协议再写一个文件桩）：',
        channelReady
          ? `  · 摄入端点：${this.probeEndpoint(hash)}`
          : '  · [!] 宿主地址未知，没有生成 HTTP 通道的产物——请让用户告诉你 DSH Web UI 的地址',
        channelReady ? `  · 现成代码片段（curl/Python/Node/Ruby/Go/PHP/PowerShell/Java）：${paths.httpGuide}` : '',
        channelReady ? `  · 浏览器桩（宿主的 <script src>）：${this.browserStubUrl(hash)}` : '',
        channelReady ? `  · 浏览器桩的落盘副本（页面有 CSP 时整段粘贴它）：${paths.browserStub}` : '',
        `  · 自检（**在让用户复现之前先 GET 一次**）：GET ${this.probeEndpoint(hash) ?? '<端点>'}`,
        '',
        '需要"崩溃前最后几条必须落盘"或热路径时，才改用 Node 文件桩：',
        `  · ${paths.stub}（import 写法 ${toFileUrl(paths.stub)}）`,
        `埋点指南：${paths.guide}`,
        '',
        '下一步：按下面的指南分析并埋点，然后调用 `dsh_debug_report` 交卷。',
        '**第 1 轮只取证，不要改代码**——先改会掩盖现场。',
        '**不要为了调试运行任何命令**：复现是用户的事，你只需要埋点与发信号。',
        '',
        '───── 埋点指南 ─────',
        guide,
      ].filter(Boolean).join('\n'),
    }
  }

  /* ────────────────────────────── S2 report ────────────────────────────── */

  /**
   * S2 汇报埋点 = Agent 的交卷动作。前置：`active`。
   * 副作用：记录分析结论与两本账 → `awaiting-user`（面板据此开放两个按钮）。
   */
  async report({ sessionId, analysis, headline, reproSteps, probeFiles, changedFiles, probes, undoHint, workspace }) {
    const guard = await this.requireActive({ sessionId, workspace, expect: STATUS.ACTIVE })
    if (!guard.ok) return guard
    const current = guard.task
    const root = current.workspace
    const paths = this.pathsOf(current)
    const reportedProbe = normalizePaths(probeFiles)
    const reportedChanged = normalizePaths(changedFiles)

    // ── R1：改动检测只问 git（没有 git 就只认账本），绝不遍历仓库 ──
    const changes = await this.detectChanges(current)
    const gitChanged = changes.ok ? changes.files : []

    // ── R2：把"改过哪些文件"分成两类。这一步决定了收尾会不会误删用户的修复 ──
    // 扫描范围 = Agent 账本 + git 检测到的改动；两边都没有的文件不在本次范围内。
    const knownHashes = await this.knownHashesFor()
    const priority = this.candidatePaths(current, null, [...reportedProbe, ...reportedChanged, ...gitChanged])
    const scan = await scanDeclared(root, priority, {
      hash: current.hash,
      knownHashes,
    })
    const byPath = new Map(scan.affected.map((file) => [file.path, file]))
    const markedChanges = priority.filter((path) => (byPath.get(path)?.changeMarkers?.length ?? 0) > 0)
    const probeTouched = priority.filter((path) => byPath.get(path)?.hasTargetBlocks)
    const behaviorTouched = [...new Set([...markedChanges, ...reportedChanged])]
    // 既没有探针块、没有改动标记、也没有自报 ⇒ 归属不明。不硬闸门，但必须报出来：
    // 宿主只能观察到"git 说这个文件变了"，无法判断是修复还是探针，而猜错的代价是删掉用户代码。
    const unexplained = gitChanged
      .filter((path) => !behaviorTouched.includes(path) && !probeTouched.includes(path))

    // ── 闸门 A（R4 L1）：第 1 轮出现「行为改动」即拒绝 ──
    // 判据必须是 `dsh-debug:change` 标记或自报的 changedFiles，**不能**是"文件被改过"——
    // 埋探针本身就是在改文件，那样写会把这个插件自己变成死锁。
    if (current.round <= 1 && behaviorTouched.length > 0) {
      const gate = this.gate(
        `round1-change:${current.hash}`,
        '第 1 轮是只读取证轮：先改代码会掩盖现场，后面的日志再也证不出真相。'
        + '请先只埋探针取证；确需改代码，说明理由并征得用户同意，第 2 轮起再改。',
        `检测到 ${behaviorTouched.length} 个文件带着行为改动（dsh-debug:change 标记或你自报的 changedFiles）：\n`
        + behaviorTouched.slice(0, 12).map((path) => `  · ${path}`).join('\n'),
)
      if (gate.blocked) {
        await this.persist(current)
        return { ok: false, hash: current.hash, round: current.round, status: current.status, text: gate.note }
      }
      this.addNote(current, gate.note)
    } else {
      this.passGate(`round1-change:${current.hash}`)
    }

    // ── 语法自检：**只是提示**，永远不做硬闸门（推翻过它的硬闸门形态）──
    const syntax = await this.checkSyntax(root, priority)

    // ── 记账：两本账分开存，并用扫描的发现补全自报的遗漏 ──
    current.lastReport = String(analysis ?? '').trim()
    // 面板顶部那句「一句简短的回复」：Agent 给了就用它，没给就从分析里搓第一行。
    // 为什么要有兜底而不是留空：面板是**给用户看的**，空一块比说半句话更糟。
    current.headline = String(headline ?? '').trim().slice(0, 200) || deriveHeadline(current.lastReport)
    // 复现步骤同理——没有它，用户面对"请复现"只能凭记忆猜一遍当初怎么触发的。
    current.reproSteps = normalizeSteps(reproSteps)
    current.probes = Array.isArray(probes)
      ? probes
        .map((item) => ({ probe: String(item?.probe ?? ''), why: String(item?.why ?? '') }))
        .filter((item) => item.probe)
      : []
    current.probeFiles = [...new Set([
      ...(current.probeFiles ?? []),
      ...reportedProbe,
      ...scan.targetFiles,
    ])].sort()
    current.changedFiles = [...new Set([
      ...(current.changedFiles ?? []),
      ...reportedChanged,
      ...markedChanges,
      ...unexplained,
    ])].sort()
    current.reportedChangedFiles = reportedChanged
    current.strayArtifacts = changes.ok
      ? changes.untracked
      : (current.strayArtifacts ?? [])
    // 桩引用文件必须进账本：桩会随任务目录删除，而这些文件里的 import 还在。
    current.stubRefFiles = [...new Set([...(current.stubRefFiles ?? []), ...scan.stubRefFiles])].sort()
    // 下一次扫描的起点：这次命中的文件下次照样要完整读。
    current.scanCandidates = [...new Set([
      ...(current.scanCandidates ?? []),
      ...priority,
      ...scan.targetFiles,
      ...scan.stubRefFiles,
      ...scan.fixFiles,
    ])].sort()
    // 覆盖度落账：`complete` 只表示"清单里的文件都读到了"，不表示全仓没有残留。
    current.scanCoverage = {
      complete: scan.complete,
      source: changes.ok ? 'git' : 'ledger',
      changed: gitChanged.length,
      scanned: scan.scanned,
      unreadable: scan.unreadable.map((entry) => entry.path),
      at: Date.now(),
    }
    if (!scan.complete) {
      this.recordDebt(`scan-coverage:${current.hash}`,
        `${scan.unreadable.length} 个已报备/已改动的文件读不到，收尾无法证明它们干净。`)
    } else {
      this.clearDebt(`scan-coverage:${current.hash}`)
    }
    if (Array.isArray(undoHint)) {
      current.undoHint = undoHint
        .map((item) => ({
          path: String(item?.path ?? '').replace(/\\/g, '/').replace(/^\.\//, ''),
          find: String(item?.find ?? ''),
          replace: String(item?.replace ?? ''),
        }))
        .filter((item) => item.path && item.find && isSafeRelativePath(item.path))
    }

    const missingProbeReport = probeTouched.filter((path) => !reportedProbe.includes(path))

    // ── 停止规则（R4）：键是「证据增量」，不是轮次 ──
    const logInfo = await this.logStat(paths.log)
    const evidence = current.evidence ?? { lastReportLines: 0, staleRounds: 0 }
    if (logInfo.lines === evidence.lastReportLines && current.probes.length === 0) evidence.staleRounds += 1
    else evidence.staleRounds = 0
    evidence.lastReportLines = logInfo.lines
    current.evidence = evidence

    if (current.status === STATUS.ACTIVE) transition(current, STATUS.AWAITING_USER)
    await this.persist(current)

    const lines = [
      `已记录 · 任务 #${current.hash} · 第 ${current.round} 轮 · 现在等用户复现`,
      `日志：${logInfo.lines} 行 / ${logInfo.bytes} 字节`,
      `改动检测：${changes.ok ? `git（${gitChanged.length} 个改动文件）` : '仅账本（不是 git 仓库或 git 不可用）'}`,
      // 通道状态要摆出来：日志为空时，"通道没通"与"用户还没复现"是两件完全不同的事，
      // 而它们的现象一模一样。这两行让 Agent 不必靠猜。
      //
      // 措辞有讲究：HTTP 计数是**整个任务的累计值**（它衡量通道健康度），日志行数是
      // **本轮**的（continue 会清空）。混在一起说就会自相矛盾。另外宿主**只知道**自己
      // 经 HTTP 收到了几条——文件桩直接写文件，宿主看不见，所以绝不把日志行数
      // 冒充成"文件桩写入条数"：报一个自己其实不知道的数字，比不报更糟。
      `探针通道：HTTP 累计收到 ${current.httpChannel?.records ?? 0} 条 · 本轮日志 ${logInfo.lines} 行`,
    ]
    if (logInfo.lines === 0) {
      const viaHttp = current.httpChannel?.records ?? 0
      lines.push(
        '',
        '本轮日志还是空的——这在**交卷时是正常的**（用户还没复现）。',
        viaHttp > 0
          // 通道已经被证明过了：这一轮空就不是通道问题，而是"还没有东西发过来"。
          ? `HTTP 通道此前累计送进来过 ${viaHttp} 条，通道是通的；空的是**这一轮**。`
            + '先确认埋点所在那段代码真的会被执行到，再让用户复现。'
          // 通道从未被验证过：这时"通道死了"和"埋点没执行"长得一模一样，必须先自检。
          : '但这条通道**还从未被验证过**：投递是尽力而为的，"通道是死的"与"埋点没执行"'
            + '现象完全一样。请先自检（`GET` 上面那个端点，看 `httpRecords` 涨不涨），'
            + '或先让桩随便跑一次（桩加载时会写一条 `debug-mode:ready`），再让用户复现；'
            + '否则你会在"日志是空的"上面白等一整轮。',
)
    }
    if ((current.strayArtifacts ?? []).length > 0) {
      lines.push('', `本轮新增文件 ${current.strayArtifacts.length} 个（**git 检测到的**，不是自报）：`)
      for (const path of current.strayArtifacts.slice(0, 12)) lines.push(`  + ${path}`)
      if (current.strayArtifacts.length > 12) lines.push(`  …另有 ${current.strayArtifacts.length - 12} 个`)
      lines.push('这些不是探针块能摘掉的东西。请确认它们要么是用户的正常产物、要么现在删掉。')
    }
    if (missingProbeReport.length > 0) {
      lines.push('', '宿主在这些文件里找到了本任务的探针块，已经替你记进**探针账**：')
      for (const path of missingProbeReport.slice(0, 12)) lines.push(`  · ${path}`)
      lines.push('（下次把它们写进 probeFiles：两本账分开记，收尾才不会误删你的修复。）')
    }
    if (unexplained.length > 0) {
      lines.push('', `[!] 这 ${unexplained.length} 个文件被 git 检测到有改动，但你既没报备也没标 change：`)
      for (const path of unexplained.slice(0, 12)) lines.push(`  ? ${path}`)
      lines.push('宿主只能按"行为改动"记账（**收尾不会回滚它们**）。若它们其实是探针，请补上标记；')
      lines.push('若确实是修复，请补上 `dsh-debug:change <hash>` 备注——否则用户无从分辨哪块是修复、哪块是探针。')
    }
    const failedSyntax = syntax.filter((entry) => entry.verdict === 'failed')
    if (failedSyntax.length > 0) {
      lines.push('', `[!] 语法自检发现 ${failedSyntax.length} 个文件解析失败（仅提示，不阻断）：`)
      for (const entry of failedSyntax.slice(0, 6)) lines.push(`  [x] ${entry.path}：${entry.message}`)
    }
    if (!changes.ok) {
      lines.push(
        '',
        '[!] 这个工作区**不是 git 仓库**（或 git 不可用）：宿主不做全仓扫描，',
        `只按你报备的 probeFiles / changedFiles 清理（原因：${changes.reason ?? 'unknown'}）。`,
        '没有 git 时，**报全文件就是收尾能不能干净的唯一保证**——埋过点、改过行为都要报。',
      )
    }
    if (scan.unreadable.length > 0) {
      lines.push(
        '',
        `[!] 有 ${scan.unreadable.length} 个已报备/已改动的文件读不到，收尾无法证明它们干净：`,
        ...scan.unreadable.slice(0, 8).map((entry) => `  ! ${entry.path}（${entry.error}）`),
      )
    }
    if (evidence.staleRounds >= 3) {
      lines.push('', `[!] 已连续 ${evidence.staleRounds} 轮没有新增证据（日志行数没变且没有新探针）。`
        + '下一轮请换假设，或在 nextPlan 里说明为什么同一个假设还值得再试。')
    }
    if (current.notes?.length) lines.push('', ...current.notes)
    lines.push(
      '',
      '请在回复里告诉用户：可以在输入框直接描述现象，或点输入框上方的两个按钮。',
      '然后**停手等用户复现**——不要在同一轮里既埋点又猜结论。',
)

    return {
      ok: true,
      hash: current.hash,
      round: current.round,
      status: current.status,
      changedFiles: current.changedFiles,
      probeFiles: current.probeFiles,
      strayArtifacts: current.strayArtifacts ?? [],
      scanIncomplete: !scan.complete,
      text: lines.join('\n'),
    }
  }

  /** 对若干文件做语法自检（读不到的算"不可验证"，不算失败）。 */
  async checkSyntax(root, paths) {
    /** @type {Record<string, string>} */
    const sources = {}
    for (const path of paths.slice(0, 40)) {
      try {
        sources[path] = await readFile(join(root, ...path.split('/')), 'utf8')
      } catch {
        // 读不到就不判定——"不可验证"与"失败"必须分开。
      }
    }
    return verifySyntax(sources)
  }

  /* ────────────────────────────── S3 continue ────────────────────────────── */

  /**
   * 进入下一轮：清空日志、轮次 +1，哈希与目录不变。前置状态 `active` / `awaiting-agent`。
   *
   * 调用时日志里不得存在 Agent 尚未读过的字节（闸门 C，连续拒绝后降级）。
   * 清空发生在这里而不是用户表态时：此刻 Agent 已读完上一轮现场，清掉的只是旧证据。
   *
   * @param {{ sessionId: string, nextPlan?: string, workspace?: string }} input
   * @returns {Promise<object>}
   */
  async continueDebug({ sessionId, nextPlan, workspace }) {
    const guard = await this.requireActive({
      sessionId,
      workspace,
      expect: [STATUS.ACTIVE, STATUS.AWAITING_AGENT],
    })
    if (!guard.ok) return guard
    const current = guard.task

    // ── 闸门 B（R4 L2）：无新证据 ∧ 无新增假说 ∧ 无可判定残留 才拒绝 ──
    const stale = current.evidence?.staleRounds ?? 0
    if (stale >= 3 && !String(nextPlan ?? '').trim()) {
      const gate = this.gate(
        `stop-rule:${current.hash}`,
        '已连续多轮没有新增证据，而这次也没有给出新的假设（nextPlan 为空）。'
        + '换个假说，或在 nextPlan 里说明为什么同一个假设还值得再试一次。',
        `staleRounds = ${stale}（连续无新证据的轮数）。`,
)
      if (gate.blocked) {
        await this.persist(current)
        return { ok: false, hash: current.hash, round: current.round, status: current.status, text: gate.note }
      }
      this.addNote(current, gate.note)
    } else {
      this.passGate(`stop-rule:${current.hash}`)
    }

    const root = current.workspace
    const paths = this.pathsOf(current)
    const logInfo = await this.logStat(paths.log)
    const seenBytes = Number(current.lastRead?.bytes ?? 0)

    // ── 闸门 C：不许清掉还没读过的现场 ──
    // 清空是**破坏性**动作，而"还没读过多少"是一个可以用数字判定的问题：
    // 当前字节数 > 上次读取时的字节数 ⇒ 有东西是 Agent 没见过的。
    if (logInfo.bytes > 0 && logInfo.bytes > seenBytes) {
      const gate = this.gate(
        `unread-log:${current.hash}`,
        '本轮日志里还有**你没读过**的内容，清空它会直接扔掉现场。'
        + '先 `dsh_debug_read` 看一眼再 `dsh_debug_continue`；'
        + '确实不需要这些记录时，说明理由重试即可（同一原因连续 3 次会被放行）。',
        `日志现有 ${logInfo.lines} 行 / ${logInfo.bytes} 字节，`
        + `其中 ${logInfo.bytes - seenBytes} 字节是上次读取之后新增的。`,
)
      if (gate.blocked) {
        await this.persist(current)
        return { ok: false, hash: current.hash, round: current.round, status: current.status, text: gate.note }
      }
      this.addNote(current, gate.note)
    } else {
      this.passGate(`unread-log:${current.hash}`)
    }

    // 清空 = truncate 为 0 字节，**不删文件、不换目录**：删文件会让正在运行的
    // 探针桩把日志"复活"到别处，宿主再也找不到它（与"桩不持有 fd"同源考虑）。
    //
    // 清空之前先幂等补一次产物：产物住在临时目录里，系统清理它是正常行为，
    // 而"日志文件不见了"与"探针一次都没跑"在用户眼里长得一模一样。
    let artifactsDir = paths.dir
    try {
      const provisioned = await this.provisionArtifacts(current)
      artifactsDir = provisioned.dir
      await writeFile(paths.log, '', { encoding: 'utf8', mode: 0o600 })
      await truncate(paths.log, 0)
    } catch (error) {
      return {
        ok: false,
        hash: current.hash,
        round: current.round,
        status: current.status,
        text: `清空日志失败（轮次未推进）：${String(error?.message ?? error)}`,
      }
    }

    current.round += 1
    current.pendingPlan = String(nextPlan ?? '').trim()
    current.evidence = { lastReportLines: 0, staleRounds: 0 }
    // 读了 0 字节就是读了 0 字节：这个计数属于"上一轮"，新一轮从零开始，
    // 否则清空后 seenBytes 永远大于当前字节数，闸门 C 会彻底失效。
    current.lastRead = { at: Date.now(), bytes: 0, lines: 0 }
    this.logLineCache.delete(paths.log)
    if (current.status === STATUS.AWAITING_AGENT) transition(current, STATUS.ACTIVE)
    // 新一轮开始：刷新改动检测（git 可用性可能变了），不做任何全仓遍历。
    await this.detectChanges(current)
    await this.persist(current)
    await appendJournal(join(artifactsDir, 'journal.jsonl'), {
      op: 'continue',
      task: current.hash,
      round: current.round,
      clearedBytes: logInfo.bytes,
    })

    return {
      ok: true,
      hash: current.hash,
      round: current.round,
      status: current.status,
      logPath: paths.log,
      text: [
        `第 ${current.round} 轮开始 · 任务 #${current.hash} · 日志已清空（哈希不变）`,
        `日志：${paths.log}`,
        `上一轮清掉了 ${logInfo.bytes} 字节。`,
        current.pendingPlan ? `本轮计划：${current.pendingPlan}` : '',
        '',
        '哈希不变、目录不变，所以已经埋在代码里的探针**继续有效**——',
        '这一轮只要补新探针即可，不要重新建任务。改完仍然要 `dsh_debug_report` 交卷。',
        // 闸门降级时必须让模型真的看见这条警告——只写进 notes 而不输出，等于没警告。
        ...(current.notes?.length ? ['', ...current.notes] : []),
      ].filter(Boolean).join('\n'),
    }
  }

  /* ────────────────────────────── S4 read ────────────────────────────── */

  /**
   * S4 读日志。**只读**，但会更新 `task.lastRead` 供面板显示（S4）。
   * 日志内容一律经这里输出给 Agent：探针可能写出远超上下文容量的行，直接读文件会把
   * 整段原文灌进上下文；这里负责摘要、异常全量与"省略了多少"的显式声明。
   */
  async read({ sessionId, limit, level, probe, workspace }) {
    const guard = await this.requireActive({ sessionId, workspace })
    if (!guard.ok) return guard
    const current = guard.task
    const paths = this.pathsOf(current)

    let exists = true
    let tail = { text: '', bytes: 0, truncated: false }
    try {
      tail = await readLogTail(paths.log, LOG_READ_TAIL_BYTES)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        exists = false
      } else {
        return {
          ok: false,
          hash: current.hash,
          round: current.round,
          status: current.status,
          text: `读取日志失败：${String(error?.message ?? error)}`,
        }
      }
    }

    const text = renderLogSummary({
      hash: current.hash,
      round: current.round,
      exists,
      text: tail.text,
      bytes: tail.bytes,
      truncated: tail.truncated,
      limit: Number.isFinite(limit) ? limit : 200,
      level: level ?? undefined,
      probe: probe ?? undefined,
      declared: current.probes ?? [],
    })

    const lines = countLines(tail.text)
    this.logLineCache.set(paths.log, { bytes: tail.bytes, lines })
    current.lastRead = { at: Date.now(), bytes: tail.bytes, lines }
    if (tail.bytes > LOG_WARN_BYTES) {
      this.recordDebt(`log-size:${current.hash}`, `日志已达 ${(tail.bytes / 1024 / 1024).toFixed(1)} MiB，`
        + '建议收窄埋点（日志越大，模型的上下文越贵）。')
    }
    await this.persist(current)

    return { ok: true, hash: current.hash, round: current.round, status: current.status, lines, text }
  }

  /* ────────────────────────────── S5/S6 用户信号 ────────────────────────────── */

  /**
   * 用户选择「问题已解决」：记录表态、迁移状态、唤醒 Agent 去收尾。**不删日志**——
   * 删日志与摘探针必须同时发生，而那一步只能由 Agent 执行。
   *
   * 两个入口的窗口约束不同：面板按钮只在 `awaiting-user` 出现，走默认的窗口校验；
   * chip 上的叉一直可点，传 `anytime` 跳过"轮到用户了吗"这道门，语义仍是同一个
   * `userVerdict: 'resolved'`。
   *
   * @param {{ hash: string, sessionId: string, note?: string, anytime?: boolean }} input
   * @returns {Promise<object>}
   */
  async resolve({ hash, sessionId, note, anytime }) {
    return this.userSignal({ hash, sessionId, note, verdict: 'resolved', anytime })
  }

  /**
   * 用户选择「问题复现」：记录表态并唤醒 Agent。**不清空日志**——此刻用户刚复现完，
   * 证据正在日志里等 Agent 读取。清空只发生在 `dsh_debug_continue`。
   *
   * @param {{ hash: string, sessionId: string, note?: string }} input
   * @returns {Promise<object>}
   */
  async reproduce({ hash, sessionId, note }) {
    return this.userSignal({ hash, sessionId, note, verdict: 'reproduced' })
  }

  /**
   * 两个用户信号共用的落地逻辑。
   *
   * `anytime: true` 只对 `resolved` 有意义（chip 上的叉）：跳过"轮到用户了吗"这道门，
   * 剩下的校验一条不少——任务必须存在、必须属于这个会话、不能已经关闭。
   * 幂等判据也照旧：同一个 verdict 重复到达只回 `duplicate`，绝不产生第二次 prompt。
   */
  async userSignal({ hash, sessionId, note, verdict, anytime }) {
    const task = await this.findByHash(hash, sessionId)
    if (!task) return { ok: false, code: 404, text: `没有哈希为 ${hash} 的任务（可能已经结束了）。` }
    if (task.status === STATUS.CLOSED) return { ok: false, code: 409, text: `任务 #${hash} 已经结束了。` }
    if (sessionId && task.sessionId !== sessionId) {
      return { ok: false, code: 403, text: '这个任务不属于当前会话。' }
    }
    // 以**本次**信号为准：用户这次没补话，就不该把上一次的补充说明当成他刚说的话。
    // 那会让他读到一条自己没说过的消息（正是这一版要消灭的那类问题）。
    task.userNote = note ? String(note).slice(0, 2000) : ''

    // 幂等：重复点击只处理一次，绝不产生第二次 prompt（路由表）。
    if (task.status !== STATUS.AWAITING_USER) {
      if (task.userVerdict === verdict) {
        return { ok: true, duplicate: true, code: 200, hash, status: task.status, text: '该选择已经收到过了。' }
      }
      // `anytime` 只有 resolved 走这条路；它正是"不等 Agent 交卷就能收尾"的那条出路。
      if (!anytime || verdict !== 'resolved') {
        return {
          ok: false,
          code: 409,
          text: `任务 #${hash} 现在是 ${task.status}，不在"等用户下结论"的窗口里。`,
        }
      }
    }

    task.userVerdict = verdict
    // **不碰日志**（见上面 reproduce 的注释）。用户信号只负责：记表态 + 迁移 + 唤醒。
    //
    // `anytime` 那一趟要走**两步**迁移：状态机的白名单里 `active` 只能去
    // `awaiting-user` / `closed`（`TRANSITIONS`，非法迁移是抛错而不是兜底）。
    // 两步的语义恰好是对的：任务先进入"等用户下结论"，再用这次的 verdict 走到
    // `awaiting-agent`——它描述的是同一个事实「用户已经表态，等 Agent 收尾」。
    if (task.status !== STATUS.AWAITING_USER) transition(task, STATUS.AWAITING_USER)
    transition(task, STATUS.AWAITING_AGENT)
    // 注入段（`debugSignalGuidance`）依据这些字段决定说哪一段、带哪个哈希与轮次、
    // 是否走 chip 的 anytime 路径。它们与投递出去的用户消息是两件事：消息只有用户原话。
    // 快照保留到任务关闭（`end`）。
    task.lastSignal = {
      verdict,
      anytime: anytime === true,
      at: Date.now(),
      // 记下"这条消息里到底有什么"，面板与排查都用得着；
      // 与 `userNote` 的区别是它保留当时的取值，不会被下一轮覆盖掉。
      text: userSignalText({ verdict, note: task.userNote }),
    }
    await this.persist(task)

    const delivered = await this.wakeAgent(
      task.sessionId,
      // [!] 投给 Agent 的**只有用户自己的话**：他在 note 里补的那句，或者（没补时）
      // 按钮文案本身。指令（收尾该调什么、复现后先读再 continue）由
      // `debugSignalGuidance()` 经 systemPrompt 注入——与 `/debug` 同一个形态，
      // 所以对话里永远不会出现"用户没说过"的句子。
      userSignalText({ verdict, note: task.userNote }),
      hash,
    )
    return {
      ok: true,
      code: 200,
      hash,
      status: task.status,
      delivered,
      text: delivered
        ? '已通知 Agent。'
        : '状态已更新，但没能唤醒 Agent——请直接在输入框里把选择告诉 Agent。',
    }
  }

  /**
   * 把一段宿主产出的文本作为一轮对话投给 Agent。
   *
   * 命令 handler 的返回值不会进入模型（`@deepseek-ai/dsh-commands` 的 `execute()` 只把它
   * 记进 `command/done` 事件），所以"用户敲了命令、Agent 开始干活"必须靠这一次显式投递。
   *
   * @param {{ sessionId: string, text: string, tag?: string }} input
   *   `tag` 只用于让 requestId 可读；requestId 本身是幂等键，每次必须不同。
   * @returns {Promise<boolean>} 是否成功投出；失败不抛，由调用方如实告知用户。
   */
  async deliverTurn({ sessionId, text, tag = 'turn' }) {
    const controller = this.ctx.sessionController
    if (!controller?.prompt) return false
    try {
      await controller.prompt({
        // Branded 类型在运行时就是字符串；requestId 会被宿主当幂等键，
        // 所以它必须能区分"同一任务的第几次投递"。
        requestId: `debug-mode-${tag}-${Date.now()}-${randomUUID().slice(0, 8)}`,
        sessionId,
        // queue = `agent.followup(message)`：空闲时开一轮、忙时排队。steer 只在运行中有效。
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000))
      return true
    } catch (error) {
      this.log('warn', `投递对话失败：${String(error?.message ?? error)}`)
      return false
    }
  }

  /** 宿主 → Agent 的唤醒通道。失败不抛：面板必须能显示"没叫醒"。 */
  async wakeAgent(sessionId, text, hash) {
    return this.deliverTurn({ sessionId, text, tag: hash })
  }

  /* ────────────────────────────── S7 end ────────────────────────────── */

  /**
   * S7 结束调试。前置：用户**确实选择过「已解决」**——Agent 不得自作主张收尾。
   *
   * 动作顺序是有意的，每一步都在为下一步提供证据：
   *   量改动（git）→ 扫声明清单 → 备份并清除所有调试标记 → 复扫验证 → 删任务目录。
   * **绝不回滚 `changedFiles`**。
   */
  async end({ sessionId, summary, cleanedFiles, verified, quarantine, workspace }) {
    const guard = await this.requireActive({ sessionId, workspace })
    if (!guard.ok) return guard
    const current = guard.task
    const root = current.workspace
    const paths = this.pathsOf(current)
    const reportedCleaned = normalizePaths(cleanedFiles)

    if (current.userVerdict !== 'resolved') {
      return {
        ok: false,
        hash: current.hash,
        round: current.round,
        status: current.status,
        text: [
          '被拒绝：结束调试要求用户**确实在面板上选择过「问题已解决」**。',
          '现在还没有这个表态（Agent 不得自作主张收尾，）。',
          '请把工作停下来，让用户在输入框上方的面板上做一次选择。',
          '若用户只是在输入框里说了"解决了"，也请让 TA 用面板确认——面板之外的表述宿主无法验证。',
        ].join('\n'),
      }
    }

    const writeProbe = await this.resolveArtifactRoot(root)

    // ── R1：改动检测只问 git（没有 git 就只认账本），绝不遍历仓库 ──
    const changes = await this.detectChanges(current)
    const gitChanged = changes.ok ? changes.files : []

    // ── R2/R3：只扫声明清单（账本 + git 改动文件）。不在清单里的文件本次不看。 ──
    const knownHashes = await this.knownHashesFor()
    const declaredPaths = this.candidatePaths(current, null, [...reportedCleaned, ...gitChanged])
    const scan = await scanDeclared(root, declaredPaths, {
      hash: current.hash,
      knownHashes,
    })
    const quarantineList = dedupeQuarantine(scan.quarantine)
    const decisions = Array.isArray(quarantine) ? quarantine : []
    const undecided = quarantineList.filter((entry) => !decisions.some((decision) => sameQuarantine(decision, entry)))

    if (undecided.length > 0) {
      // 不允许静默保留：先把清单交出去，逐条让用户三选一。
      // 注意这里**不关闭任务**——"不确定就隔离，不静默"比"先关了再说"重要。
      return {
        ok: false,
        needsDecision: true,
        hash: current.hash,
        round: current.round,
        status: current.status,
        text: [
          `收尾暂停：检测到 ${undecided.length} 处**无法判定归属**的残留，需要用户逐条决定。`,
          '',
          '这些既不是本任务的探针，也不能确认是修复——"不确定就隔离，不静默"是硬规则。',
          '',
          ...undecided.slice(0, 20).map((entry, index) => [
            `${index + 1}. ${entry.path}${entry.line ? `:${entry.line}` : ''}`,
            ` 原因：${entry.reason}`,
            entry.text ? ` 原文：${String(entry.text).trim().slice(0, 160)}` : '',
          ].filter(Boolean).join('\n')),
          undecided.length > 20 ? `…另有 ${undecided.length - 20} 处（用 quarantine 参数一次性回答）` : '',
          '',
          '请用 ask_user_question 逐条问用户，三选一：',
          '  · `keep`   —— 保留（当作修复，收尾不动它）',
          '  · `delete` —— 删除（**先向用户展示 diff 再确认**）',
          '  · `mine`   —— 用户自己处理',
          '然后把决定回填进 `quarantine` 参数（`[{path, line?, hash?, decision}]`）再调用一次 `dsh_debug_end`。',
        ].filter(Boolean).join('\n'),
      }
    }

    const plan = await planCleanup(root, scan, current.hash)
    // `delete` 的隔离项：并入本次清理计划（仍然先备份）。
    // 同一文件可能已经在 plan 里：必须在**已清理后的文本**上继续删，
    // 否则第二次写入会把第一次删掉的探针块原样带回来。
    for (const decision of decisions.filter((item) => item?.decision === 'delete')) {
      const target = quarantineList.find((entry) => sameQuarantine(decision, entry))
      if (!target?.line) continue
      const existing = plan.plans.find((item) => item.path === target.path)
      const staged = await this.stageQuarantineDeletion(root, target, existing?.text)
      if (!staged) continue
      if (existing) {
        existing.text = staged.text
        existing.removed.push(...staged.removed)
        existing.removedLines.push(...staged.removedLines)
        existing.collapsedBlankLines = (existing.collapsedBlankLines ?? 0)
          + (staged.collapsedBlankLines ?? 0)
      } else {
        plan.plans.push(staged)
      }
    }

    // ── R6：先备份再写；**绝不自动还原**（backups 只给用户"查看 / diff"的入口）──
    const applied = await applyCleanup(root, plan.plans, {
      backupsDir: join(paths.dir, 'backups'),
      journalFile: join(paths.dir, 'journal.jsonl'),
      hash: current.hash,
    })

    // ── 复扫验证：清不干净要说出来，而不是假装干净（第 3 条）──
    // 复扫对象必须包含"刚摘过的文件"与声明清单里的全部文件：只靠 git 改动清单复扫，
    // 摘失败的那几个文件可能刚好已经不在清单里，于是失败被读成"干净"。
    const verifyPaths = [...new Set([...declaredPaths, ...applied.cleaned])].sort()
    const verify = await scanDeclared(root, verifyPaths, {
      hash: current.hash,
      knownHashes,
    })
    // 本任务标记、`fix`/`change` 备注、`dsh-debug:tmp` 之类垃圾注释，任何一样还在都不算无痕。
    const residual = verify.markerFiles

    const keptFixes = [...new Set([...(current.changedFiles ?? []), ...scan.fixFiles])].sort()
    const cleaned = [...new Set([...reportedCleaned, ...applied.cleaned])].sort()
    const safeUndo = await this.checkUndoHints(root, current.undoHint)

    /**
     * 无法证明"已清理干净"的全部理由。任何一条成立都不许宣称干净、也不许删掉证据。
     *
     * 为什么证据（任务目录）必须留下：备份与日志是唯一能还原现场的东西。删掉之后，
     * 遗留的标记连"属于哪个任务"都查得到没处查，下一次收尾只会把它当陌生哈希送进隔离区。
     */
    const unresolvedReasons = {
      residual,
      stubRefs: verify.stubRefFiles,
      failedWrites: applied.failed,
      unreadable: [...new Map([...plan.unreadable, ...verify.unreadable]
        .map((entry) => [entry.path, entry])).values()],
      unverified: !verify.complete,
      separated: plan.separated,
    }
    const incomplete = residual.length > 0
      || verify.stubRefFiles.length > 0
      || applied.failed.length > 0
      || unresolvedReasons.unreadable.length > 0
      || !verify.complete
      || plan.separated.length > 0

    // journal 必须在删目录**之前**写：appendJournal 会按需 mkdir，
    // 写到已删除的任务目录上等于把目录又"复活"成半个。
    await appendJournal(join(paths.dir, 'journal.jsonl'), {
      op: 'end',
      task: current.hash,
      summary: String(summary ?? '').slice(0, 2000),
      cleaned: applied.cleaned,
      kept: keptFixes,
      residual,
      stray: changes.ok ? changes.untracked : (current.strayArtifacts ?? []),
      incomplete,
      coverage: {
        complete: verify.complete,
        source: changes.ok ? 'git' : 'ledger',
        scanned: verify.scanned,
        unreadable: verify.unreadable.map((entry) => entry.path),
      },
    })

    // ── 最后一步：只有**证明干净**时任务目录才随任务一起消失（S7）──
    let removed = true
    let removeError = null
    if (incomplete) {
      // 保留证据：state.json / backups / 日志全部留下，并把"为什么没清干净"写进
      // 一个独立文件——欠账看板与下一次收尾都读它。
      removed = false
      current.residual = {
        at: Date.now(),
        reasons: {
          residual,
          stubRefs: verify.stubRefFiles,
          failedWrites: applied.failed.map((item) => item.path),
          unreadable: unresolvedReasons.unreadable.map((entry) => entry.path),
          unverified: !verify.complete,
          separated: plan.separated.map((item) => item.path),
        },
        coverage: {
          complete: verify.complete,
          source: changes.ok ? 'git' : 'ledger',
          unreadable: verify.unreadable.map((entry) => entry.path),
        },
      }
      try {
        await writeJsonAtomic(join(paths.dir, 'residual.json'), current.residual)
      } catch (error) {
        this.log('warn', `residual.json 写入失败：${String(error?.message ?? error)}`)
      }
    } else {
      try {
        await rm(paths.dir, { recursive: true, force: true })
      } catch (error) {
        removed = false
        removeError = String(error?.message ?? error)
      }
    }
    current.status = STATUS.CLOSED
    this.tasks.delete(current.sessionId)
    this.restoreAttempts.delete(current.sessionId)
    this.logLineCache.delete(paths.log)
    for (const key of [...this.gates.keys()]) {
      if (key.endsWith(`:${current.hash}`)) this.gates.delete(key)
    }
    // 关闭后仍要落一次 state：保留证据时它是欠账看板的唯一入口。
    if (incomplete) await this.persist(current)

    // 摘除时顺带收掉的空白行：**要记账**。用户已经连续五轮看到"摘完留下多余空行"，
    // 所以这件事不能悄悄做，也不能悄悄不做——报告里必须出现。
    const blankCollapsed = (plan.plans ?? []).reduce((sum, item) => sum + (item.collapsedBlankLines ?? 0), 0)
    const lines = []
    // [!] 首段即结论。收得不干净时**第一句话**就必须是失败摘要——
    // 模型与用户都只读得到前面几行，"已结束"打头会被读成"搞定了"。
    if (incomplete) {
      lines.push(
        `[!] 调试任务 #${current.hash} 已关闭，但收尾**没有清干净**（详见下方清单）。`,
        '任务目录已**保留**（日志、备份、账本都在），修复与证据一件没丢；',
        '不要在回复里说"已清理干净"——请如实说清哪些已摘除、哪些需要人工确认。',
        '',
      )
    } else {
      lines.push(`调试任务 #${current.hash} 已结束。`)
    }
    lines.push(
      summary ? `结论：${String(summary).trim()}` : '',
      '',
      `修复代码（保留）：${keptFixes.length} 个文件${keptFixes.length ? ' —— 收尾**没有**回滚它们' : ''}`,
      ...keptFixes.slice(0, 20).map((path) => `  · ${path}`),
      '',
      `调试标记（已清）：${applied.cleaned.length} 个文件`,
      ...applied.cleaned.slice(0, 20).map((path) => `  · ${path}`),
      applied.cleaned.length > 0
        ? '  · `probe` / `temp` 块整块删除；`fix` / `change` 只删标记注释，标注的代码原样保留'
        : '',
      blankCollapsed > 0
        ? `  · 顺带收敛了 ${blankCollapsed} 行摘除缝上的多余空行（只删纯空白行，不碰任何代码）`
        : '',
      applied.failed.length
        ? `  [x] 删除失败 ${applied.failed.length} 个：${applied.failed.map((item) => `${item.path}（${item.error}）`).join('、')}`
        : '',
      '',
      `清理范围：${declaredPaths.length} 个文件`
        + (changes.ok ? `（账本 + git 检测到的 ${gitChanged.length} 个改动）` : '（无 git，仅账本）'),
      `任务目录：${removed ? '已删除' : (incomplete ? '已保留（收尾未干净，证据留给你复核）' : `**删除失败**（${removeError}）`)}`,
      incomplete ? `  位置：${paths.dir}` : '',
    )

    if (residual.length > 0) {
      lines.push('', `[!] 复扫仍然发现 ${residual.length} 个文件里有本任务标记或调试记号，收尾**不算干净**：`)
      for (const path of residual.slice(0, 20)) lines.push(`  ! ${path}`)
      lines.push('这通常是"标记与调用分离"或"配对有歧义"造成的。请逐个人工确认。')
    }
    if (plan.separated.length > 0) {
      lines.push('', '[!] 疑似分离调用点（探针块里的标识符在块外还出现）：')
      for (const item of plan.separated.slice(0, 12)) lines.push(`  ? ${item.path} → ${item.name}`)
      lines.push('这类残留会让代码**编译不过**（桩已随任务目录删除，调用还在）。请逐个确认。')
    }
    if (verify.stubRefFiles.length > 0) {
      lines.push('', '[!] 仍有文件引用探针桩路径（桩已随任务目录删除）：')
      for (const path of verify.stubRefFiles.slice(0, 12)) lines.push(`  ! ${path}`)
    }
    const stray = changes.ok ? changes.untracked : (current.strayArtifacts ?? [])
    if (stray.length > 0) {
      lines.push('', `本轮新增文件 ${stray.length} 个（git 检测到的）：`)
      for (const path of stray.slice(0, 12)) lines.push(`  + ${path}`)
      lines.push('宿主**不删**它们——请确认是正常产物，还是该清的临时文件。')
    }
    if (safeUndo.length > 0) {
      lines.push('', `Agent 提供的精确还原点（宿主**没有**自动应用，按 R6「绝不自动还原」）：`)
      for (const item of safeUndo.slice(0, 10)) lines.push(`  · ${item.path}：可安全替换（find 唯一存在）`)
    }
    if (decisions.length > 0) {
      lines.push('', '隔离区决定（已记录）：')
      for (const decision of decisions.slice(0, 20)) {
        lines.push(`  ${decision?.decision || '?'}  ${decision?.path ?? '?'}`
          + `${decision?.line ? `:${decision.line}` : ''}`)
      }
    }
    // 收尾能力受限：写不进任务目录、或有声明文件读不到，都必须说出来。
    if (!writeProbe.ok || !verify.complete) {
      lines.push('', '[!] 收尾能力受限，这次的"干净"结论按此折扣看待：',
        '  · 任务目录可写：' + (writeProbe.ok ? '是' : `否（${writeProbe.error}）`),
        `  · 清理范围：${declaredPaths.length} 个文件`
          + (changes.ok ? `（含 git 改动 ${gitChanged.length} 个）` : '（无 git）'),
        `  · 读取失败：${verify.unreadable.length} 个`,
        changes.ok ? '' : `  · git 检测不可用：${changes.reason ?? 'unknown'}`)
    }
    if (!changes.ok) {
      lines.push('',
        '[!] 没有 git：本次只核对了账本里的文件。工作区别处若还有调试标记，宿主**没有看**。',
        '请在回复里说清这次清理的范围；要覆盖全仓，需要在 git 仓库里重跑一次收尾。')
    }

    lines.push('',
      `清理清单核对：你自报 ${reportedCleaned.length} 个，宿主实际清理 ${applied.cleaned.length} 个。`,
      `修复账共 ${keptFixes.length} 个文件，**一个都没有回滚**。`,
      verified === false ? '你声明本次没有验证——请在回复里写清用户还需要确认什么。' : '')

    return {
      ok: true,
      hash: current.hash,
      round: current.round,
      status: STATUS.CLOSED,
      cleanedFiles: cleaned,
      keptFiles: keptFixes,
      residualFiles: residual,
      // 收尾不干净的机器可判定标记。模型据此决定回复措辞，面板/测试据此断言。
      // 理由只在真正不干净时才出现：值为 undefined 的自有键会让宿主把整次工具
      // 调用判成"不是 lossless JSON"，收尾明明成功却报工具输出错误。
      scanIncomplete: incomplete,
      ...(incomplete ? { incompleteReasons: unresolvedReasons } : {}),
      text: lines.filter(Boolean).join('\n'),
    }
  }

  /**
   * 把一个隔离区条目变成删除计划（仍然先备份）。
   *
   * 如果用户决定删除的是一个**块**（别的任务的 probe/temp），必须整块摘除——
   * 只删 start 那一行会把块内的探针代码留在文件里，那是最糟的半清理状态。
   *
   * `baseText` 是同文件上一步清理后的文本：两次清理必须串行，否则后一次写回会把
   * 前一次删掉的块原样带回来。
   *
   * @param {string} root
   * @param {{path: string, line: number|null, hash: string|null}} target
   * @param {string} [baseText]
   */
  async stageQuarantineDeletion(root, target, baseText) {
    const absolute = join(root, ...String(target.path).split('/'))
    try {
      const text = typeof baseText === 'string' ? baseText : await readFile(absolute, 'utf8')
      const markers = findMarkers(text)
      // 有 hash 且确实有成对的块：按 hash 整块删。`baseText` 可能已经删过别的行，
      // 行号不再可靠，所以这里只认 hash。
      const hasBlock = target.hash
        && pairBlocks(markers).blocks.some((item) => item.hash === target.hash)
      if (hasBlock) {
        const result = removeMarkers(text, target.hash)
        if (result.removed.length > 0) {
          return {
            path: target.path,
            text: result.text,
            removed: result.removed.map((item) => ({ ...item, kind: 'quarantine' })),
            removedLines: result.removedLines,
            collapsedBlankLines: result.collapsedBlankLines,
          }
        }
      }
      // 没有成对的块（或没有 hash）：只删用户定位到的那一行。
      const marker = target.hash
        ? markers.find((item) => item.hash === target.hash)
        : markers.find((item) => item.line === Number(target.line))
      const lines = text.split(/\r?\n/)
      const eol = String(text).match(/\r?\n/)?.[0] ?? '\n'
      const index = marker ? marker.line - 1 : Number(target.line) - 1
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) return null
      lines.splice(index, 1)
      return {
        path: target.path,
        text: lines.join(eol),
        removed: [{ kind: 'quarantine', startLine: index + 1, endLine: index + 1 }],
        removedLines: [],
      }
    } catch {
      return null
    }
  }

  /** 校验 Agent 给出的 `{path, find, replace}`：`find` 必须**唯一存在**才算安全（R6）。 */
  async checkUndoHints(root, hints) {
    const safe = []
    for (const hint of hints ?? []) {
      if (!isSafeRelativePath(String(hint?.path ?? '').replace(/\\/g, '/'))) continue
      try {
        const text = await readFile(join(root, ...hint.path.split('/')), 'utf8')
        const first = text.indexOf(hint.find)
        if (first === -1) continue
        if (text.indexOf(hint.find, first + 1) !== -1) continue
        safe.push({ path: hint.path, replace: hint.replace })
      } catch {
        // 读不到就跳过
      }
    }
    return safe
  }

  /* ────────────────────────────── 欠账看板（R5） ────────────────────────────── */

  /**
   * R5：列出所有需要人处理的调试任务。只读，不删除任何东西——清理只发生在 `end` 里。
   *
   * 两类都在看板上：
   *   1. 未关闭的在途任务；
   *   2. **已关闭但收尾没清干净**的任务（有 `residual.json`）。不列出来的话，这类目录
   *      会永远躺在磁盘上：既不属于"在途"，也不会被任何流程再看到。
   *
   * 任务的陈旧程度只影响排序与措辞，不影响工具的可用性。
   *
   * @param {{ excludeSessionId?: string }} [options]
   * @returns {Promise<object>}
   */
  async debtBoard(options = {}) {
    const roots = this.boardRoots()
    const rows = []
    for (const root of roots) {
      const tasksRoot = join(root, 'tasks')
      let entries
      try {
        entries = await readdir(tasksRoot, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const state = await readJson(join(tasksRoot, entry.name, 'state.json'))
        const residual = await readJson(join(tasksRoot, entry.name, 'residual.json'))
        if (!state) continue
        const closed = state.status === STATUS.CLOSED
        if (closed && !residual) continue
        if (options.excludeSessionId && state.sessionId === options.excludeSessionId) continue
        rows.push({
          hash: String(state.hash ?? entry.name),
          sessionId: String(state.sessionId ?? ''),
          workspace: root,
          goal: String(state.goal ?? '').slice(0, 200),
          status: String(state.status ?? ''),
          round: Number(state.round ?? 1),
          updatedAt: Number(state.updatedAt ?? 0),
          ageDays: Math.max(0, Math.floor((Date.now() - Number(state.updatedAt ?? Date.now())) / 86_400_000)),
          // `unclean` = 已经关了但没清干净。它与"还没收尾"需要完全不同的处置。
          unclean: Boolean(closed && residual),
          residualReasons: residual?.reasons ?? null,
        })
      }
    }
    // 最陈旧的排在最前：这一档才是真正需要人去处理的。
    rows.sort((left, right) => left.updatedAt - right.updatedAt)
    return {
      tasks: rows,
      stale: rows.filter((row) => row.ageDays > 30),
      unclean: rows.filter((row) => row.unclean),
    }
  }

  /** 给 `/debug` 用的一句话欠账提醒（发现欠账时才有）。 */
  async debtNotice(sessionId) {
    try {
      const board = await this.debtBoard({ excludeSessionId: sessionId })
      if (board.tasks.length === 0) return ''
      const oldest = board.tasks[0]
      const head = `提醒：另有 ${board.tasks.length} 个未收尾的调试任务`
        + `（最旧的是 #${oldest.hash}，${oldest.ageDays} 天前，状态 ${oldest.status}）。`
      const unclean = board.unclean.length > 0
        ? `\n其中 ${board.unclean.length} 个是**已关闭但收尾没清干净**的（任务目录被保留）：`
          + `${board.unclean.map((row) => `#${row.hash}`).join('、')}。`
        : ''
      return `${head}${unclean}\n它们不会自动消失——用 dsh_debug_start 回到那个会话收尾，或让用户决定。`
    } catch {
      return ''
    }
  }

  /* ────────────────────────────── 面板 ────────────────────────────── */

  /**
   * 面板轮询的载荷（`GET /state`）。刻意**小**：每秒一次，不能把详情也塞进去。
   * 同时承担"失效必须可见"：`detector` 字段告诉用户收尾能力与这次清理的范围。
   */
  async panelState(sessionId) {
    const task = await this.findTask(sessionId)
    if (!task) return { task: null }
    const paths = this.pathsOf(task)
    const logInfo = await this.logStat(paths.log)
    const writeProbe = await this.resolveArtifactRoot(task.workspace)
    const debts = this.debts
      .filter((entry) => entry.key.startsWith('gate:')
        || entry.key === 'write-probe'
        // 回退到工作区也必须出现在面板上：产物悄悄回到仓库里是最不该静默的一件事。
        || entry.key === 'artifact-root')
      .map((entry) => entry.reason)
    return {
      task: {
        hash: task.hash,
        round: task.round,
        status: task.status,
        goal: task.goal,
        // 面板顶部那一句 + 复现清单：这是用户真正要读的两个字段。
        headline: task.headline ?? '',
        reproSteps: task.reproSteps ?? [],
        lastReport: task.lastReport ?? '',
        userNote: task.userNote ?? '',
        userVerdict: task.userVerdict ?? '',
        logBytes: logInfo.bytes,
        logLines: logInfo.lines,
        // 面板暂不渲染它（诊断与后续用）：产物根是临时目录还是工作区回退。
        artifactRootKind: task.artifactRootKind
          ?? (this.artifactRootOf(task) === this.legacyRoot(task.workspace) ? ARTIFACT_ROOT.WORKSPACE : ARTIFACT_ROOT.TEMP),
        probeFiles: task.probeFiles ?? [],
        changedFiles: task.changedFiles ?? [],
        notes: (task.notes ?? []).slice(-3),
        detector: {
          // 写不进任务目录时，收尾的备份与复核都不可靠——必须让面板知道。
          available: Boolean(writeProbe?.ok),
          writeProbe: writeProbe?.ok ?? null,
          writeProbeError: writeProbe?.error ?? null,
          // 改动检测来源：`git` = 还看了工作区改动；`ledger` = 只看 Agent 报备的文件。
          // 两者不是"有效/失效"的区别，而是**清理范围**的区别，面板要分开说。
          changeSource: task.changeSource ?? 'unknown',
          gitError: task.gitError ?? null,
          scanCoverage: task.scanCoverage ?? null,
        },
        debts,
      },
    }
  }

  /** 日志的行数/字节数。行数走缓存：每秒轮询不能每次都把大文件读一遍。 */
  async logStat(logAbsolute) {
    let bytes = 0
    try {
      bytes = (await stat(logAbsolute)).size
    } catch {
      bytes = 0
    }
    const cached = this.logLineCache.get(logAbsolute)
    if (cached && cached.bytes === bytes) return { bytes, lines: cached.lines }
    let lines = 0
    if (bytes > 0) {
      try {
        lines = countLines((await readLogTail(logAbsolute, LOG_READ_TAIL_BYTES)).text)
      } catch {
        lines = 0
      }
    }
    this.logLineCache.set(logAbsolute, { bytes, lines })
    return { bytes, lines }
  }

  /* ────────────────────────────── systemPrompt ────────────────────────────── */

  /**
   * 用户已表态、等 Agent 行动时的信号快照，供 `debugSignalGuidance()` 使用。
   *
   * 与 `guidanceFor()` 并列而不是并入：两者对应互斥的两段注入正文
   * （活跃期讲怎么埋点，表态后讲收尾还是先读日志），由 section thunk 按优先级选取。
   * 同步、只读、无副作用——它挂在每次模型调用都会求值的 thunk 上。
   *
   * @param {string} sessionId
   * @returns {{hash: string, round: number, verdict: 'resolved'|'reproduced', anytime: boolean} | null}
   */
  signalGuidanceFor(sessionId) {
    const task = this.tasks.get(sessionId)
    if (!task || task.status !== STATUS.AWAITING_AGENT) return null
    const signal = task.lastSignal
    if (!signal || (signal.verdict !== 'resolved' && signal.verdict !== 'reproduced')) return null
    return {
      hash: task.hash,
      round: task.round,
      verdict: signal.verdict,
      anytime: signal.anytime === true,
    }
  }

  /**
   * 任务活跃期的注入状态，供 `debugGuidance()` 渲染。
   *
   * 返回值必须带**全部具体地址**（端点、桩、日志、指南），不能只说"有任务"：
   * 这段文本是唯一每次模型调用都在的，而 `dsh_debug_start` 的返回值只在当轮出现，
   * 上下文压缩后就只剩这里。这些地址每任务稳定，不会让提示词逐轮抖动。
   *
   * @param {string} sessionId
   * @returns {object|null}
   */
  guidanceFor(sessionId) {
    const task = this.tasks.get(sessionId)
    if (!task || task.status === STATUS.CLOSED) return null
    const paths = this.pathsOf(task)
    const endpoint = this.probeEndpoint(task.hash)
    return {
      hash: task.hash,
      round: task.round,
      status: task.status,
      // null = 宿主地址未知 ⇒ 这一轮用不了 HTTP 通道（渲染时会明说，而不是继续推荐它）。
      endpoint,
      logPath: paths.log,
      probeStubPath: paths.stub,
      browserStubPath: paths.browserStub,
      browserStubUrl: this.browserStubUrl(task.hash),
      httpGuidePath: paths.httpGuide,
      guidePath: paths.guide,
      artifactRootKind: task.artifactRootKind
        ?? (this.artifactRootOf(task) === this.legacyRoot(task.workspace) ? ARTIFACT_ROOT.WORKSPACE : ARTIFACT_ROOT.TEMP),
    }
  }

  /* ────────────────────────────── 会话生命周期 ────────────────────────────── */

  /** 会话结束：清票据、解除绑定。**不删任务目录**——删除只发生在 `end` 里。 */
  onSessionDisposed(sessionId) {
    this.tickets.delete(sessionId)
    this.restoreAttempts.delete(sessionId)
    const task = this.tasks.get(sessionId)
    if (task) this.log('info', `会话结束，任务 #${task.hash} 仍留在磁盘上等待收尾`)
    this.tasks.delete(sessionId)
  }

  /**
   * 观察会话事件：`awaiting-user` 期间收到新的用户消息 ⇒ 状态回到 `active`。
   *
   * 只对齐状态，不参与内容——用户消息本身照常送达 Agent。
   */
  onSessionEvent(session, event) {
    if (!event || event.type !== 'user/message') return
    const sessionId = session?.header?.id ?? session?.id
    const task = this.tasks.get(sessionId)
    if (!task || task.status !== STATUS.AWAITING_USER) return
    transition(task, STATUS.ACTIVE)
    task.userVerdict = ''
    void this.persist(task)
  }

  /* ────────────────────────────── 前置校验 ────────────────────────────── */

  /**
   * 每个 `dsh_debug_*` 工具动手前的**宿主侧硬校验**。
   * 不依赖模型自觉：工具对所有会话可见，只有返回值拦得住。
   */
  async requireActive({ sessionId, workspace, expect }) {
    const task = await this.findTask(sessionId, workspace)
    if (!task) return { ok: false, hash: '', round: 0, status: '', text: NO_TASK_TEXT }
    if (task.status === STATUS.CLOSED) {
      return {
        ok: false,
        hash: task.hash,
        round: task.round,
        status: task.status,
        text: `任务 #${task.hash} 已经结束了。`,
      }
    }
    if (expect) {
      const allowed = Array.isArray(expect) ? expect : [expect]
      if (!allowed.includes(task.status)) {
        return {
          ok: false,
          hash: task.hash,
          round: task.round,
          status: task.status,
          text: `任务 #${task.hash} 现在是 ${task.status}，这个信号要求状态是 ${allowed.join(' 或 ')}。`
            + '顺序错了就按状态机重来：report → 用户复现/已解决 → continue/end。',
        }
      }
    }
    return { ok: true, task }
  }
}

/**
 * 用户表态那条用户消息的正文，只包含用户实际表达的内容。
 *
 * 取值优先级：`note` 里的原话（逐字，仅 trim 首尾空白）→ 按钮文案本身。
 * 宿主不替用户转述（例如"用户选择了已解决"），因为那是宿主的说法而非用户的话。
 *
 * 指令不在这里：收尾与续轮该做什么由 `debugSignalGuidance()` 经 systemPrompt 注入。
 *
 * @param {{ verdict: 'resolved'|'reproduced', note?: string }} input
 * @returns {string}
 */
export function userSignalText(input) {
  const note = String(input?.note ?? '').trim()
  if (note) return note
  return input?.verdict === 'resolved'
    ? USER_SIGNAL_LABEL.resolved
    : USER_SIGNAL_LABEL.reproduced
}

/**
 * 把请求体摊平成记录数组。
 *
 * 三种形态都接受，因为投递方的形态不可控：单个对象、对象数组、NDJSON。认不出时返回空数组
 * （调用方据此返回 400），不做猜测。
 * 认不出来就返回空数组（调用方据此返回 400），**绝不猜**。
 * @param {unknown} payload
 * @returns {object[]}
 */
export function normalizeProbePayload(payload) {
  if (payload === null || payload === undefined) return []
  if (typeof payload === 'string') {
    const text = payload.trim()
    if (!text) return []
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text)
        return Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        // 落到 NDJSON
      }
    }
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter((entry) => entry !== null)
  }
  if (Array.isArray(payload)) return payload
  if (typeof payload === 'object') return [payload]
  return []
}

/**
 * 从分析正文里搓一句能放在面板上的短句（Agent 没给 `headline` 时的兜底）。
 *
 * 取第一个非空行，剥掉 Markdown 的列表符号/编号/引用号，再按上限截断。
 * 刻意不"智能摘要"：这只是兜底，真正的结论该由 Agent 用 `headline` 一句话说清。
 * @param {string} analysis
 * @param {number} [limit]
 */
export function deriveHeadline(analysis, limit = 80) {
  const text = String(analysis ?? '').trim()
  if (!text) return ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[#>*+\-]|\d+[.、)])\s*/, '').trim()
    if (!line) continue
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
  }
  return ''
}

/**
 * 规范化复现步骤：一条一句、去掉换行、截断超长项、限制条数。
 *
 * 上限是有意的：面板是"输入框上方的一张卡片"，不是文档。步骤多到需要滚动时，
 * 该收敛的是埋点范围，不是把卡片撑成一面墙。
 * @param {unknown} list
 */
export function normalizeSteps(list, limit = 12, maxLength = 200) {
  if (!Array.isArray(list)) return []
  return list
    .map((item) => String(item ?? '').replace(/\s*\n+\s*/g, ' ').trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((item) => (item.length > maxLength ? `${item.slice(0, maxLength - 1)}…` : item))
}

/** 隔离区条目的同一性：按**文件**判定。
 *
 * 一个文件可能同时带着"残缺标记"和"陌生 hash"两种症状，但用户面对的是同一个文件、
 * 做的是同一个决定，所以这里以 path 为键；`line`/`hash` 只用来定位与执行删除。
 */
function sameQuarantine(decision, entry) {
  return String(decision?.path ?? '') === entry.path
}

function dedupeQuarantine(list) {
  const seen = new Set()
  return list.filter((entry) => {
    if (seen.has(entry.path)) return false
    seen.add(entry.path)
    return true
  })
}

/** 相对路径归一化：接受 POSIX/Windows 两种写法，去掉前导 `./`，拒绝越界路径。 */
function normalizePaths(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list
    .map((value) => String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(isSafeRelativePath))]
    .sort()
}

/** 工作区相对路径的安全形状：不接受绝对路径、盘符与 `..` 段。 */
function isSafeRelativePath(value) {
  return Boolean(value)
    && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value)
    && !value.split('/').includes('..')
}

/** 统计行数（不含结尾空行）。 */
export function countLines(text) {
  if (!text) return 0
  const trimmed = String(text).replace(/\n$/, '')
  if (!trimmed) return 0
  return trimmed.split('\n').length
}

/**
 * 把宿主绝对路径变成可 import 的说明符。
 *
 * 为什么不是裸路径：Windows 的 `D:\a\b.mjs` 在 ESM 里不是合法的 import 说明符；
 * `file://` URL 是两种平台都能直接 `import` 的形式（的桩引入方式）。
 */
export function toFileUrl(absolute) {
  const normalized = String(absolute).replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  // encodeURI 不会动 `#` 与 `?`，而它们在 URL 里是分隔符——路径里真的出现时必须转义，
  // 否则 import 说明符会在第一个 `#` 处被截断。
  return `file://${encodeURI(prefixed).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}
