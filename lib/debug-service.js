/**
 * lib/debug-service.js —— 宿主半的**唯一真相**（DESIGN.md §5）。
 *
 * 这里同时住着四件事，它们的共同点是"必须由宿主说了算，不能交给模型自觉"：
 *
 *   1. **票据闸门**（§3.3–3.4）：`dsh_debug_start` 必须持 `/debug` 签发的会话级
 *      一次性票据；这是入口唯一性的**硬校验**，提示词拦不住模型。
 *   2. **任务表与日志管道**（§6、§10）：哈希、目录、state.json、清空与摘要。
 *   3. **唤醒通道**（§6.2）：把"用户点了按钮"变成 Agent 的下一轮输入。
 *   4. **防堆屎山的两台机器**（§16.3）：R1 工作区索引 + 窗口 diff、R2/R3 残留扫描
 *      与三色标记处理；以及 §16.3.0 的横切要求——**闸门连续拒绝 3 次必须降级**，
 *      **扫描能力不可用时必须说出来**。
 *
 * 两条纪律贯穿全文：
 *   · 任何失败都要变成**可读的中文返回值**，不是抛异常（工具返回值是模型唯一的纠正信号）；
 *   · 收尾**只撤探针**，绝不动用户的修复（§3.8）——这是最容易写错、代价最大的一条。
 */

import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { byteLength, encodeRecord, formatRecord } from './protocol.js'
import { createHash, createTask, logPath, probeStubPath, STATUS, taskDir, transition } from './task.js'
import { renderBrowserStub, renderHttpGuide, renderProbeStub } from './probe-template.js'
import { renderGuide, readGuideTemplate } from './prompt.js'
import { renderLogSummary } from './summary.js'
import { ROUTE_PREFIX } from './routes.js'
import {
  applyCleanup,
  appendJournal,
  diffIndex,
  indexWorkspace,
  planCleanup,
  scanResidue,
  verifySyntax,
} from './scan.js'

/** `/debug` 签发的票据存活时长（§3.4）。过期是**特性**：陈旧票据不该被后到的调用用掉。 */
export const TICKET_TTL_MS = 30 * 60 * 1000

/** 硬闸门连续拒绝同一原因多少次后降级为 warn-only（§16.3.0 第 1 条，防死锁）。 */
export const GATE_DEGRADE_AFTER = 3

/** 日志读取的字数上限：超了只读尾部（要的是现场，不是全部历史）。 */
const LOG_READ_TAIL_BYTES = 8 * 1024 * 1024

/** 单任务日志总字节的告警线（§11.2），同时也是写端与摄入端**共同的硬上限**。 */
export const LOG_WARN_BYTES = 16 * 1024 * 1024

/** 单条 HTTP 探针记录的行长上限（与 Node 桩的 8 KiB 一致）。 */
const PROBE_LINE_MAX_BYTES = 8 * 1024

/** 合法的日志级别；未知级别一律降级为 info，而不是写出一条读端看不懂的记录。 */
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error'])

/** 跨重启恢复的节流：面板每秒轮询，不能每秒扫一次目录。 */
const RESTORE_INTERVAL_MS = 15_000

/** 无活跃任务时的统一文案（§6.2.2）。 */
const NO_TASK_TEXT = '本会话没有进行中的调试任务。若用户确实要调试，请让 TA 先输入 `/debug <现象描述>`。'

/** `dsh_debug_start` 无票时的拒绝文案（§3.3，逐字冻结）。 */
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
    /** 欠账：降级与失效记录（面板常驻显示，§16.3.0） */
    this.debts = []
    /** 写探针自检结果：workspace -> { ok, error, at } */
    this.writeProbes = new Map()
    /** 跨重启恢复的节流表 */
    this.restoreAttempts = new Map()
    /** R1 基线索引：hash -> entries（大对象不进 state.json） */
    this.baselines = new Map()
    /** 日志行数缓存（面板每秒轮询，不能每次重读大文件） */
    this.logLineCache = new Map()
    /** 见过的工作区根：R5 的欠账看板只能在自己知道的仓库里找（插件是全局的，没有"当前仓库"） */
    this.workspaces = new Set()
    /** 指南模板只读一次 */
    this.guideTemplate = null
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

  rootDir(workspace) {
    return join(workspace, '.dsh', 'debug-mode')
  }

  /** 任务目录的绝对路径。 */
  taskAbsDir(workspace, hash) {
    return join(workspace, ...taskDir(hash).split('/'))
  }

  /**
   * 写探针自检（§16.3.0 第 2 条）：宿主能不能在这个 workspace 里写？
   * 不能的话所有闸门都会静默 fail-open，面板必须显示「残留检测未生效」。
   * 每个 workspace 只做一次（结果缓存，面板轮询不会反复写盘）。
   */
  async ensureWriteProbe(workspace) {
    this.workspaces.add(workspace)
    const cached = this.writeProbes.get(workspace)
    if (cached) return cached
    const probeFile = join(this.rootDir(workspace), '.probe-write-test')
    let result
    try {
      await mkdir(this.rootDir(workspace), { recursive: true })
      await writeFile(probeFile, String(Date.now()), 'utf8')
      await rm(probeFile, { force: true })
      result = { ok: true, error: null, at: Date.now() }
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error), at: Date.now() }
      this.recordDebt('write-probe', `无法写入 ${this.rootDir(workspace)}：${result.error}`)
    }
    this.writeProbes.set(workspace, result)
    return result
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
   * 过一道硬闸门。**连续拒绝同一原因 3 次即降级**为 warn-only 并记账——
   * 一个卡死的闸门比它要防的屎山更危险（§16.3.0 第 1 条）。
   *
   * `reason` 与 `detail` 必须分开传：`reason` 是"同一原因"的**比较键**，必须稳定；
   * `detail` 才是可以带数字与清单的正文。把数字写进 `reason` 会让每次比较都不相等，
   * 计数器永远归零，闸门再也不会降级——那是一道**没人察觉的死锁**。
   *
   * @param {string} key 闸门标识
   * @param {string} reason 稳定的拒绝原因（比较键）
   * @param {string} [detail] 给人看的补充正文（可含数字）
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
        note: `⚠️ 该闸门已连续拒绝 ${entry.count} 次，按防死锁规则降级为警告（本次放行）：\n\n${body}`,
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
   * （§3.3）。已有活跃任务时拒绝签发，并明确告知既有哈希（§3.4）。
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
      await writeJsonAtomic(this.ticketFile(workspace, sessionId), ticket)
    } catch (error) {
      // 磁盘上写不下不影响本次会话：内存里的票据照样有效。
      this.log('warn', `票据落盘失败（仅内存有效）：${String(error?.message ?? error)}`)
    }
    return { ok: true, hash: '', ticket }
  }

  ticketFile(workspace, sessionId) {
    return join(this.rootDir(workspace), 'pending', `${safeFileName(sessionId)}.json`)
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
    const stored = await readJson(this.ticketFile(root, sessionId))
    if (!stored) return null
    if (Date.now() - Number(stored.issuedAt ?? 0) > TICKET_TTL_MS) {
      await rm(this.ticketFile(root, sessionId), { force: true })
      return null
    }
    this.tickets.set(sessionId, stored)
    return stored
  }

  /** 消费票据（一次性，§3.4）。 */
  async consumeTicket(sessionId, workspace) {
    this.tickets.delete(sessionId)
    try {
      await rm(this.ticketFile(workspace ?? this.workspaceOf(sessionId), sessionId), { force: true })
    } catch {
      // 删不掉旧票据不是错误：TTL 会兜住它。
    }
  }

  /* ────────────────────────────── 任务表 ────────────────────────────── */

  /**
   * 内存任务；没有就尝试跨重启恢复（节流）。
   *
   * 子 Agent（subagent / workflow）**继承父会话的任务**而不是新建（§11.1）：否则
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
   * 跨重启恢复：`state.json` 存在的唯一理由（§10）。
   * 面板每秒轮询，所以这里必须节流，否则一个长会话能把磁盘打满。
   */
  async restoreForSession(sessionId, workspace) {
    const attempt = this.restoreAttempts.get(sessionId) ?? 0
    if (Date.now() - attempt < RESTORE_INTERVAL_MS) return null
    this.restoreAttempts.set(sessionId, Date.now())
    const root = workspace ?? this.workspaceOf(sessionId)
    const tasksRoot = join(this.rootDir(root), 'tasks')
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
      const baseline = await readJson(join(tasksRoot, entry.name, 'index.json'))
      if (baseline?.entries) this.baselines.set(state.hash, baseline.entries)
      this.tasks.set(sessionId, state)
      this.log('info', `恢复任务 #${state.hash}（${state.status}）`)
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
      await writeJsonAtomic(join(this.taskAbsDir(task.workspace, task.hash), 'state.json'), task)
    } catch (error) {
      this.log('warn', `state.json 写入失败：${String(error?.message ?? error)}`)
    }
  }

  /** 任务目录就绪（含 `.dsh/` 的 gitignore 与备份目录）。 */
  async ensureTaskDir(workspace, hash) {
    const dir = this.taskAbsDir(workspace, hash)
    await mkdir(join(dir, 'runtime'), { recursive: true })
    await mkdir(join(dir, 'backups'), { recursive: true })
    const dshRoot = join(workspace, '.dsh')
    await mkdir(dshRoot, { recursive: true })
    // `.dsh/` 永不进版本库（§7.1）。两处都写：一处保证 `.dsh/` 整体被忽略，
    // 一处是设计文档里写明的落点，避免下一个人以为漏了。
    await writeFile(join(dshRoot, '.gitignore'), '*\n', 'utf8')
    await writeFile(join(this.rootDir(workspace), '.gitignore'), '*\n', 'utf8')
    return dir
  }

  /** 任务的绝对路径组（工具返回值与指南都用它）。 */
  pathsOf(task) {
    const dir = this.taskAbsDir(task.workspace, task.hash)
    const log = join(task.workspace, ...logPath(task.hash).split('/'))
    const stub = join(task.workspace, ...probeStubPath(task.hash).split('/'))
    return {
      dir,
      log,
      stub,
      browserStub: join(dir, 'runtime', 'probe.browser.js'),
      httpGuide: join(dir, 'runtime', 'probe.http.md'),
    }
  }

  /**
   * 宿主的 Web 基地址（页面在 `file://` 下，相对路径到不了宿主，所以必须绝对）。
   *
   * 两个来源，**优先环境变量**：
   *   1. `DSH_WEB_URL`——宿主注入的"当前 Web GUI 的规范地址"，如果被部署改成
   *      代理/隧道地址，以它为准；
   *   2. `ctx.webServer.port`——**权威且总在手里**（webServer 是本插件的硬依赖）。
   *      已核实 `dsh-web-app` 的 `localWebUrl()` 就是
   *      `` `http://${LOOPBACK_HOST}:${port}` ``，也就是说 `DSH_WEB_URL` 本身就是
   *      从它算出来的，而且宿主已经把同一个地址注进了**模型自己的系统提示**
   *      （`dsh-web-app` 的 `app:web-surface` 段）。
   *
   * 为什么要有第 2 条：v0.13 及以前只认环境变量，拿不到就报"宿主地址未知、请让用户
   * 告诉你地址"。核实后发现那条路是多余的——端口就在手里。更糟的是它把一件插件自己
   * 就能回答的事推给了用户：Agent 于是知道 origin（从系统提示里读到的）、也知道哈希，
   * 唯独不知道**路由路径**是什么，只能反问你「这里的 <路径> 是什么」。
   *
   * 拿不到时仍然返回 null 并**明说**，绝不猜一个端口：猜错的后果是探针静默丢失。
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

  /* ────────────────────────────── HTTP 探针摄入（§7.6） ────────────────────────────── */

  /**
   * 接收来自"没有文件系统的运行时"的探针记录（浏览器页面、远端进程……）。
   *
   * 三件事必须由宿主做，不能让投递方做：
   *   1. **重新序列化**：用 `lib/protocol.js` 的 `formatRecord` 落盘，
   *      所以 HTTP 通道只是传输，不是协议的第二份实现（字段序只有一处真相）；
   *   2. **只认已知任务**：哈希必须属于一个活跃任务——否则任何本机进程都能往
   *      随便一个路径写东西。没有路径拼接，全部经任务表查；
   *   3. **限额**：单行 8 KiB、总量 16 MiB，到顶写一条 `debug-mode:overflow` 就停手。
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
        // ⚠️ **这里不许做静默预截断**（v0.16）。
        // 老代码是 `raw.probe.slice(0, 200)` 与 `String(raw.msg).slice(0, 2000)`，
        // 于是 10000 字符的 `msg` 被悄悄砍到 2000 —— **8000 字符无声消失，没有任何标记**，
        // 而那一行只有 ~2 KB、根本没碰到 8 KiB 上限，所以看起来一切正常。
        // 更糟的是 Node 桩**没有**这两条预截断，同一条记录走文件桩会正确地标 `truncated`：
        // 同一个协议在三处实现上给出不同结果，正是本仓库最防的那种漂移。
        //
        // 现在唯一的截断权威是 `encodeRecord()`：它省略超长值、重新序列化、
        // 并**永远**留下 `truncated: true` 与 `…<省略 N 字符>` 的痕迹。
        probe: raw.probe,
        level: LEVELS.has(raw.level) ? raw.level : 'info',
      }
      if (raw.msg !== undefined) record.msg = String(raw.msg)
      if (raw.data !== undefined) record.data = raw.data

      let line = formatRecord(record)
      // ⚠️ 超限时**不能切这一行**：切出来的是半个 JSON，读端只能算脏行
      // （详见 `encodeRecord()` 的注释与 §11.2）。改成"省略超长值 → 重新序列化"。
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
        await appendFile(paths.log, lines.join(''), 'utf8')
      } catch (error) {
        return {
          ok: false,
          code: 500,
          accepted: 0,
          rejected: records.length,
          reason: `写入日志失败：${String(error?.message ?? error)}`,
        }
      }
      task.probeWrites = (task.probeWrites ?? 0) + (lines.length - (overflowed ? 1 : 0))
      // 记下"这条通道真的送进来过东西"。它换来一个**可判定**的问题：
      // 「日志是空的」到底是**通道没通**，还是**埋点没被执行**——DESIGN.md §7.6。
      task.httpChannel = {
        at: Date.now(),
        records: (task.httpChannel?.records ?? 0) + (lines.length - (overflowed ? 1 : 0)),
      }
      this.logLineCache.delete(paths.log)
      await this.persist(task)
    }

    return {
      ok: true,
      // 200 而不是 204：那条响应体（accepted / rejected / bytes）是**给人看的自检信息**，
      // 而 204 按 HTTP 规范不允许带体——严格客户端（undici 等）会直接拒绝读取它。
      // 探针的失败是静默的，所以"我能告诉你我收下了几条、丢了几条"这件事不能省。
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
   * 为什么值得单独一个入口：探针投递是**尽力而为**的（发不出去就丢，见 §7.6），
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
   * 量一次工作区（**不动基线**）。
   *
   * 为什么"量"与"定基线"必须是两件事：基线代表**本轮开始时**的样子。如果每次
   * `report` 都把基线推进到当下，那么第二次 `report` 看到的 diff 永远是空的——
   * 窗口一收，R1 就退化成"Agent 自报"，最贵的机制当场作废。
   * @returns {Promise<{ ok: boolean, truncated: boolean, error: string|null, at: number, count: number }>}
   */
  async measureWorkspace(workspace) {
    const index = await indexWorkspace(workspace)
    if (index.error) this.recordDebt('index', `工作区索引不可用：${index.error}`)
    else this.clearDebt('index')
    return {
      entries: index.entries,
      ok: index.error === null,
      truncated: index.truncated,
      error: index.error,
      at: Date.now(),
      count: Object.keys(index.entries).length,
    }
  }

  /**
   * 进入 `active` 之前建/更新基线，并把索引落成 `index.json`。
   *
   * 索引**不进 state.json**（那是每秒都可能被读的小文件），而是单独一个文件，
   * 内存里再留一份给 diff 用。
   */
  async beginRoundIndex(task) {
    const measured = await this.measureWorkspace(task.workspace)
    this.baselines.set(task.hash, measured.entries)
    try {
      await writeJsonAtomic(join(this.taskAbsDir(task.workspace, task.hash), 'index.json'), {
        at: measured.at,
        truncated: measured.truncated,
        error: measured.error,
        entries: measured.entries,
      })
    } catch (error) {
      this.log('warn', `索引落盘失败：${String(error?.message ?? error)}`)
    }
    task.index = {
      ok: measured.ok,
      truncated: measured.truncated,
      error: measured.error,
      at: measured.at,
      count: measured.count,
    }
    return task.index
  }

  /** 取基线条目（内存优先，其次磁盘）。 */
  async baselineEntries(task) {
    const cached = this.baselines.get(task.hash)
    if (cached) return cached
    const stored = await readJson(join(this.taskAbsDir(task.workspace, task.hash), 'index.json'))
    const entries = stored?.entries ?? {}
    this.baselines.set(task.hash, entries)
    return entries
  }

  /* ────────────────────────────── S1 start ────────────────────────────── */

  /**
   * S1 启动调试。前置：本会话持有有效票据（§3.3）。
   * 幂等：已有活跃任务时返回既有信息，且**不消费票据**（§3.4）。
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

    const probe = await this.ensureWriteProbe(root)
    if (!probe.ok) {
      // 写不进去就不要假装能调试：先给一条可执行的解释（§12「沙箱拒绝」）。
      return {
        ok: false,
        hash: '',
        round: 0,
        status: '',
        text: [
          '无法创建调试任务目录：宿主对这个工作区没有写权限。',
          `目标：${this.rootDir(root)}`,
          `错误：${probe.error}`,
          '',
          '这不是模型能绕开的问题。请让用户改用有写权限的目录，或调整 DSH 的文件策略后重试。',
        ].join('\n'),
      }
    }

    const hash = createHash()
    const task = createTask({ hash, sessionId, workspace: root, goal })
    /** 宿主地址已知 ⇒ HTTP 通道的产物（浏览器桩 + 多语言片段）才生成。 */
    let channelReady = false
    try {
      await this.ensureTaskDir(root, hash)
      const { dir, log, stub, browserStub, httpGuide } = this.pathsOf(task)
      // 日志文件在 start 就建出来（空文件）：探针第一次写入时它已经存在，
      // 用户也能立刻 `tail -f` 上去；"文件不存在"与"文件为空"因此是两种不同的信号。
      await writeFile(log, '', 'utf8')
      await writeFile(stub, await renderProbeStub({ hash, logAbsolutePath: log }), 'utf8')

      // HTTP 通道（§7.6）：这是**语言无关的统一入口**——写日志这件事只有宿主一份实现。
      // 端口未知时**不写一个猜的地址**——探针的失败是静默的，那比没有更糟。
      const endpoint = this.probeEndpoint(hash)
      if (endpoint) {
        await writeFile(browserStub, await renderBrowserStub({ hash, endpoint }), 'utf8')
        await writeFile(httpGuide, await renderHttpGuide({
          hash,
          endpoint,
          logPath: log,
          probeStub: stub,
        }), 'utf8')
        channelReady = true
      }

      this.guideTemplate = this.guideTemplate ?? (await readGuideTemplate())
      const guide = renderGuide({
        template: this.guideTemplate,
        hash,
        logPath: log,
        probeStub: stub,
        probeImport: toFileUrl(stub),
        browserStub: channelReady ? browserStub : '（宿主地址未知，未生成——见下面「HTTP 探针通道」）',
        httpGuide: channelReady ? httpGuide : '（宿主地址未知，未生成）',
        probeEndpoint: endpoint ?? '（宿主地址未知：请让用户告诉你 DSH Web UI 的地址）',
        round: task.round,
        goal: task.goal,
        taskDir: dir,
      })
      await writeFile(join(dir, 'AGENT-PROBE-GUIDE.md'), guide, 'utf8')

      // R1：进入 active **之前**建基线索引，否则本轮改动会被算进基线，
      // "窗口 diff"当场失效。
      task.index = await this.beginRoundIndex(task)
      task.evidence = { lastReportLines: 0, staleRounds: 0 }
      await this.persist(task)
      this.tasks.set(sessionId, task)
      await appendJournal(join(dir, 'journal.jsonl'), {
        op: 'start',
        task: hash,
        workspace: root,
        goal: task.goal,
      })
    } catch (error) {
      // 建到一半失败：把残留目录清掉，绝不留下"半个任务"。
      await rm(this.taskAbsDir(root, hash), { recursive: true, force: true }).catch(() => {})
      this.log('warn', `任务创建失败：${String(error?.message ?? error)}`)
      return {
        ok: false,
        hash: '',
        round: 0,
        status: '',
        text: `创建调试任务失败（票据未消费，可重试）：${String(error?.message ?? error)}`,
      }
    }

    // 只有整条链都成功了才消费票据（§3.4：被拒不消费）。
    await this.consumeTicket(sessionId, root)
    const paths = this.pathsOf(task)
    const guide = await readFile(join(paths.dir, 'AGENT-PROBE-GUIDE.md'), 'utf8')

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
      text: [
        `已进入调试模式 · 任务 #${hash} · 第 1 轮`,
        `日志：${paths.log}`,
        '',
        '**埋点优先走 HTTP 通道**（语言无关：写日志这件事只有宿主一份实现，',
        '不需要为某种语言照协议再写一个文件桩）：',
        channelReady
          ? `  · 摄入端点：${this.probeEndpoint(hash)}`
          : '  · ⚠️ 宿主地址未知，没有生成 HTTP 通道的产物——请让用户告诉你 DSH Web UI 的地址',
        channelReady ? `  · 现成代码片段（curl/Python/Node/Ruby/Go/PHP/PowerShell/Java）：${paths.httpGuide}` : '',
        channelReady ? `  · 浏览器桩：${paths.browserStub}` : '',
        `  · 自检（**在让用户复现之前先 GET 一次**）：GET ${this.probeEndpoint(hash) ?? '<端点>'}`,
        '',
        '需要"崩溃前最后几条必须落盘"或热路径时，才改用 Node 文件桩：',
        `  · ${paths.stub}（import 写法 ${toFileUrl(paths.stub)}）`,
        `埋点指南：${join(paths.dir, 'AGENT-PROBE-GUIDE.md')}`,
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

    // ── R1：以 diff 为准，而不是以 Agent 自报为准（§16.3 R1 的全部意义）──
    // 注意这里**只量不定基线**：基线是本轮开始时的快照，report 不许推进它。
    const baseline = await this.baselineEntries(current)
    const index = await this.measureWorkspace(root)
    current.index = {
      ok: index.ok,
      truncated: index.truncated,
      error: index.error,
      at: index.at,
      count: index.count,
    }
    const diff = diffIndex(baseline, index.entries)
    const touched = [...new Set([...diff.changed, ...diff.removed])].sort()

    // ── R2：把"改过哪些文件"分成两类。这一步决定了收尾会不会误删用户的修复 ──
    const knownHashes = [...this.tasks.values()].map((item) => item.hash)
    const scan = await scanResidue(root, { hash: current.hash, knownHashes })
    const byPath = new Map(scan.affected.map((file) => [file.path, file]))
    const markedChanges = touched.filter((path) => (byPath.get(path)?.changeMarkers?.length ?? 0) > 0)
    const probeTouched = touched.filter((path) => byPath.get(path)?.hasTargetBlocks)
    const behaviorTouched = [...new Set([...markedChanges, ...reportedChanged])]
    // 既没有探针块、也没有改动标记、Agent 又没上报 ⇒ 归属不明。**不硬闸门，但必须出声**：
    // 宿主只能说"我看到它变了"，说不出"它是修复还是探针"，而猜错的代价是删用户代码。
    const unexplained = touched.filter((path) => !behaviorTouched.includes(path) && !probeTouched.includes(path))

    // ── 闸门 A（R4 L1）：第 1 轮出现「行为改动」即拒绝 ──
    // 判据必须是 `dsh-debug:change` 标记或自报的 changedFiles，**不能**是"文件被改过"——
    // 埋探针本身就是在改文件，那样写会把这个插件自己变成死锁（§16.3.0）。
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

    // ── 语法自检：**只是提示**，永远不做硬闸门（§16.4 推翻过它的硬闸门形态）──
    const syntax = await this.checkSyntax(root, [...new Set([...reportedChanged, ...touched])])

    // ── 记账：两本账分开存（§3.8），并用扫描的发现补全自报的遗漏 ──
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
    current.strayArtifacts = diff.added
    if (Array.isArray(undoHint)) {
      current.undoHint = undoHint
        .map((item) => ({ path: String(item?.path ?? ''), find: String(item?.find ?? ''), replace: String(item?.replace ?? '') }))
        .filter((item) => item.path && item.find)
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
      // 通道状态要摆出来：日志为空时，"通道没通"与"用户还没复现"是两件完全不同的事，
      // 而它们的现象一模一样。这两行让 Agent 不必靠猜（§7.6）。
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
    if (diff.added.length > 0) {
      lines.push('', `本轮新增文件 ${diff.added.length} 个（**宿主扫出来的**，不是自报）：`)
      for (const path of diff.added.slice(0, 12)) lines.push(`  + ${path}`)
      if (diff.added.length > 12) lines.push(`  …另有 ${diff.added.length - 12} 个`)
      lines.push('这些不是探针块能摘掉的东西。请确认它们要么是用户的正常产物、要么现在删掉。')
    }
    if (missingProbeReport.length > 0) {
      lines.push('', '宿主在这些文件里找到了本任务的探针块，已经替你记进**探针账**：')
      for (const path of missingProbeReport.slice(0, 12)) lines.push(`  · ${path}`)
      lines.push('（下次把它们写进 probeFiles：两本账分开记，收尾才不会误删你的修复。）')
    }
    if (unexplained.length > 0) {
      lines.push('', `⚠️ 这 ${unexplained.length} 个文件变了，但既没有探针块也没有 \`dsh-debug:change\` 标记：`)
      for (const path of unexplained.slice(0, 12)) lines.push(`  ? ${path}`)
      lines.push('宿主只能按"行为改动"记账（**收尾不会回滚它们**）。若它们其实是探针，请补上标记；')
      lines.push('若确实是修复，请补上 `dsh-debug:change <hash>` 备注——否则用户无从分辨哪块是修复、哪块是探针。')
    }
    const failedSyntax = syntax.filter((entry) => entry.verdict === 'failed')
    if (failedSyntax.length > 0) {
      lines.push('', `⚠️ 语法自检发现 ${failedSyntax.length} 个文件解析失败（仅提示，不阻断）：`)
      for (const entry of failedSyntax.slice(0, 6)) lines.push(`  ✗ ${entry.path}：${entry.message}`)
    }
    if (index.truncated) {
      lines.push('', '⚠️ 工作区索引被截断（文件太多），本轮的新增/改动检测不完整——详见面板的「残留检测」提示。')
    }
    if (evidence.staleRounds >= 3) {
      lines.push('', `⚠️ 已连续 ${evidence.staleRounds} 轮没有新增证据（日志行数没变且没有新探针）。`
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
      strayArtifacts: diff.added,
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
        // 读不到就不判定——"不可验证"与"失败"必须分开（§16.4）。
      }
    }
    return verifySyntax(sources)
  }

  /* ────────────────────────────── S3 continue ────────────────────────────── */

  /**
   * S3 进一步调试：**清空日志但保留哈希**（AGENTS.md §1.1 第 3 条），轮次 +1。
   * 前置：`active` 或 `awaiting-agent`。
   *
   * ⚠️ **这里是全流程里唯一清空日志的地方**，而且时机是有讲究的：它发生在
   * 「Agent 已经读过上一轮的现场、准备开始新一轮埋点」这一刻，也就是
   * **下一次用户复现之前**。
   *
   * 早先的设计让 S6（用户点「问题复现」）顺手清空日志——那是错的，而且错得很致命：
   * S6 发生在 Agent **还没读**的时候，清空等于把用户刚刚复现出来的现场当场扔掉，
   * 然后宿主还发一条指令让 Agent「去 dsh_debug_read」。用户看到的正是这个现象：
   * 一点「复现」，日志就空了。
   *
   * 现在多一道判据：**日志里只要还有没读过的字节，就不许清**（§16.3.0 的
   * 三振降级照旧适用，闸门不会把人卡死）。
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
    // 探针桩把日志"复活"到别处，宿主再也找不到它（与 §7.4「不持有 fd」同源考虑）。
    try {
      await mkdir(this.taskAbsDir(root, current.hash), { recursive: true })
      await writeFile(paths.log, '', 'utf8')
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
    // 新一轮 = 新窗口：重新建基线索引，diff 才只覆盖本轮（R1）。
    current.index = await this.beginRoundIndex(current)
    await this.persist(current)
    await appendJournal(join(this.taskAbsDir(root, current.hash), 'journal.jsonl'), {
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
   * S4 读日志。**只读**，但会更新 `task.lastRead` 供面板显示（§6.2 S4）。
   * 日志内容一律经这里输出给 Agent（AGENTS.md §1.1 第 6 条）。
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
   * S5 用户选择「问题已解决」。**不删日志**——删日志与删探针必须同生共死，
   * 而探针只有 Agent 能删（§6.1 的关键取舍）。这里只做三件事：
   * 记下用户表态、迁移状态、唤醒 Agent 去收尾。
   */
  async resolve({ hash, sessionId, note }) {
    return this.userSignal({ hash, sessionId, note, verdict: 'resolved' })
  }

  /**
   * S6 用户选择「问题复现」。
   *
   * ⚠️ **它不清空日志**——这一点曾经写错，而且是致命的那种错。
   *
   * S6 发生在 Agent **还没读**的时候：用户刚复现完，现场就在日志里等着。
   * 如果在这里清空，宿主要么真的把证据扔了，要么就得紧接着发一条
   * 「请 dsh_debug_read」的指令——让它去读一份自己刚清空的文件。
   * 用户看到的正是这个现象：一点「复现」，日志就空了。
   *
   * 清空只发生在 `dsh_debug_continue` 里，那时 Agent 已经读过现场、
   * 正要开始新一轮埋点——**也就是下一次用户复现之前**。
   */
  async reproduce({ hash, sessionId, note }) {
    return this.userSignal({ hash, sessionId, note, verdict: 'reproduced' })
  }

  async userSignal({ hash, sessionId, note, verdict }) {
    const task = await this.findByHash(hash, sessionId)
    if (!task) return { ok: false, code: 404, text: `没有哈希为 ${hash} 的任务（可能已经结束了）。` }
    if (task.status === STATUS.CLOSED) return { ok: false, code: 409, text: `任务 #${hash} 已经结束了。` }
    if (sessionId && task.sessionId !== sessionId) {
      return { ok: false, code: 403, text: '这个任务不属于当前会话。' }
    }
    if (note) task.userNote = String(note).slice(0, 2000)

    // 幂等：重复点击只处理一次，绝不产生第二次 prompt（§6.2 路由表）。
    if (task.status !== STATUS.AWAITING_USER) {
      if (task.userVerdict === verdict) {
        return { ok: true, duplicate: true, code: 200, hash, status: task.status, text: '该选择已经收到过了。' }
      }
      return {
        ok: false,
        code: 409,
        text: `任务 #${hash} 现在是 ${task.status}，不在"等用户下结论"的窗口里。`,
      }
    }

    task.userVerdict = verdict
    // **不碰日志**（见上面 reproduce 的注释）。用户信号只负责：记表态 + 迁移 + 唤醒。
    transition(task, STATUS.AWAITING_AGENT)
    await this.persist(task)

    const instruction = verdict === 'resolved'
      ? [
        '[debug-mode] 用户在面板上选择了「问题已解决」。',
        `任务：#${hash}。请执行收尾：`,
        '1) 调用 `dsh_debug_end` 声明清理清单（summary 必填）；',
        `2) 宿主会按 \`dsh-debug:probe ${hash}\` 标记摘除本次任务的全部探针块；`,
        '3) 在回复里逐条列出「修复（保留）/ 探针（已删）/ 临时探索改动（已还原）」。',
        '⚠️ 绝不要用 `git checkout` / `git stash` 整体回滚——那会把用户要的修复一起 revert 掉。',
        task.userNote ? `用户的补充说明：${task.userNote}` : '',
      ].filter(Boolean).join('\n')
      : [
        '[debug-mode] 用户在面板上选择了「问题复现，需要进一步修复」。',
        `任务：#${hash} · 第 ${task.round} 轮。**这一轮的日志完整保留着**——它就是你要的证据。`,
        '请按信号序列执行：`dsh_debug_read`（先看现场）→ 分析 → `dsh_debug_continue`（要开下一轮时才清空日志）→ 埋点 → `dsh_debug_report`。',
        '⚠️ `dsh_debug_continue` 会**清空**日志，所以它必须排在 `dsh_debug_read` 之后——顺序反了，用户刚刚复现出来的东西就再也看不到了。',
        task.userNote ? `用户的补充说明：${task.userNote}` : '',
      ].filter(Boolean).join('\n')

    const delivered = await this.wakeAgent(task.sessionId, instruction, hash)
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
   * 把一段**插件写死的文本**作为一轮对话投给 Agent（§6.2 的唤醒通道）。
   *
   * 为什么 `/debug` 也必须走这里，而不是靠命令的返回值：
   * **命令 handler 返回的 `text` 是给人看的，宿主不会把它发给模型。** 已核实
   * `@deepseek-ai/dsh-commands` 的 `execute()`——注释原文是
   * "Parse and execute a known command **without sending it to the model**"，
   * 且返回值只进 `command/done` 这个 log-only 事件（"no turn wraps them"）。
   * 所以"用户敲了 /debug，Agent 该开始干活"这件事，只能**再投一轮**来实现；
   * 否则用户敲完命令后会对着一个不动的会话发呆，还得自己补一句「开始」。
   *
   * @param {{ sessionId: string, text: string, tag?: string }} input
   *   `tag` 只用于让 requestId 可读（它是宿主的幂等键，必须每次都不同）。
   * @returns {Promise<boolean>} 是否成功投出。失败不抛：调用方必须能如实告诉用户。
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

  /** 宿主 → Agent 的唤醒通道（§6.2）。失败不抛：面板必须能显示"没叫醒"。 */
  async wakeAgent(sessionId, text, hash) {
    return this.deliverTurn({ sessionId, text, tag: hash })
  }

  /* ────────────────────────────── S7 end ────────────────────────────── */

  /**
   * S7 结束调试。前置：用户**确实选择过「已解决」**（§9.4）——Agent 不得自作主张收尾。
   *
   * 动作顺序是有意的，每一步都在为下一步提供证据：
   *   R1 再索引 → R2 扫描 → 备份并摘除 `probe`/`temp` 块 → 复扫验证 → 删任务目录。
   * **绝不回滚 `changedFiles`**（§3.8）。
   */
  async end({ sessionId, summary, cleanedFiles, verified, quarantine, workspace }) {
    const guard = await this.requireActive({ sessionId, workspace })
    if (!guard.ok) return guard
    const current = guard.task
    const root = current.workspace
    const paths = this.pathsOf(current)

    if (current.userVerdict !== 'resolved') {
      return {
        ok: false,
        hash: current.hash,
        round: current.round,
        status: current.status,
        text: [
          '被拒绝：结束调试要求用户**确实在面板上选择过「问题已解决」**。',
          '现在还没有这个表态（Agent 不得自作主张收尾，见 DESIGN.md §9.4）。',
          '请把工作停下来，让用户在输入框上方的面板上做一次选择。',
          '若用户只是在输入框里说了"解决了"，也请让 TA 用面板确认——面板之外的表述宿主无法验证。',
        ].join('\n'),
      }
    }

    const writeProbe = await this.ensureWriteProbe(root)

    // ── R1：收尾前再量一次（**不以它推进基线**），新增文件是"真检测"，不靠自报 ──
    const baseline = await this.baselineEntries(current)
    const measured = await this.measureWorkspace(root)
    const diff = diffIndex(baseline, measured.entries)

    // ── R2/R3：扫描 + 分类 ──
    const knownHashes = [...this.tasks.values()].map((item) => item.hash)
    const scan = await scanResidue(root, { hash: current.hash, knownHashes })
    const quarantineList = dedupeQuarantine(scan.quarantine)
    const decisions = Array.isArray(quarantine) ? quarantine : []
    const undecided = quarantineList.filter((entry) => !decisions.some((decision) => sameQuarantine(decision, entry)))

    if (undecided.length > 0) {
      // 不允许静默保留（AGENTS.md §1.1 第 13 条）：先把清单交出去，逐条让用户三选一。
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
            `   原因：${entry.reason}`,
            entry.text ? `   原文：${String(entry.text).trim().slice(0, 160)}` : '',
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
    // `delete` 的隔离项：并入本次摘除计划（仍然先备份）。
    for (const decision of decisions.filter((item) => item?.decision === 'delete')) {
      const target = quarantineList.find((entry) => sameQuarantine(decision, entry))
      if (!target?.line) continue
      const staged = await this.stageQuarantineDeletion(root, target)
      if (staged) plan.plans.push(staged)
    }

    // ── R6：先备份再写；**绝不自动还原**（backups 只给用户"查看 / diff"的入口）──
    const applied = await applyCleanup(root, plan.plans, {
      backupsDir: join(paths.dir, 'backups'),
      journalFile: join(paths.dir, 'journal.jsonl'),
      hash: current.hash,
    })

    // ── 复扫验证：清不干净要说出来，而不是假装干净（§5.1 第 3 条）──
    const verify = await scanResidue(root, { hash: current.hash, knownHashes })
    const residual = verify.targetFiles

    const keptFixes = [...new Set([...(current.changedFiles ?? []), ...scan.fixFiles])].sort()
    const cleaned = [...new Set([...(cleanedFiles ?? []), ...applied.cleaned])].sort()
    const safeUndo = await this.checkUndoHints(root, current.undoHint)

    // journal 必须在删目录**之前**写：appendJournal 会按需 mkdir，
    // 写到已删除的任务目录上等于把目录又"复活"成半个。
    await appendJournal(join(paths.dir, 'journal.jsonl'), {
      op: 'end',
      task: current.hash,
      summary: String(summary ?? '').slice(0, 2000),
      cleaned: applied.cleaned,
      kept: keptFixes,
      residual,
      stray: diff.added,
    })

    // ── 最后一步：任务目录随任务一起消失（§6.2 S7）──
    let removed = true
    let removeError = null
    try {
      await rm(paths.dir, { recursive: true, force: true })
    } catch (error) {
      removed = false
      removeError = String(error?.message ?? error)
    }
    current.status = STATUS.CLOSED
    this.tasks.delete(current.sessionId)
    this.restoreAttempts.delete(current.sessionId)
    this.baselines.delete(current.hash)
    this.logLineCache.delete(paths.log)
    for (const key of [...this.gates.keys()]) {
      if (key.endsWith(`:${current.hash}`)) this.gates.delete(key)
    }

    // 摘除时顺带收掉的空白行：**要记账**。用户已经连续五轮看到"摘完留下多余空行"，
    // 所以这件事不能悄悄做，也不能悄悄不做——报告里必须出现。
    const blankCollapsed = (plan.plans ?? []).reduce((sum, item) => sum + (item.collapsedBlankLines ?? 0), 0)
    const lines = [
      `调试任务 #${current.hash} 已结束。`,
      summary ? `结论：${String(summary).trim()}` : '',
      '',
      `修复（保留）：${keptFixes.length} 个文件${keptFixes.length ? ' —— 收尾**没有**动它们' : ''}`,
      ...keptFixes.slice(0, 20).map((path) => `  · ${path}`),
      '',
      `探针（已删）：${applied.cleaned.length} 个文件`,
      ...applied.cleaned.slice(0, 20).map((path) => `  · ${path}`),
      blankCollapsed > 0
        ? `  · 顺带收敛了 ${blankCollapsed} 行摘除缝上的多余空行（只删纯空白行，不碰任何代码）`
        : '',
      applied.failed.length
        ? `  ✗ 删除失败 ${applied.failed.length} 个：${applied.failed.map((item) => `${item.path}（${item.error}）`).join('、')}`
        : '',
      '',
      `任务目录：${removed ? '已删除' : `**删除失败**（${removeError}）`}`,
    ].filter(Boolean)

    if (residual.length > 0) {
      lines.push('', `⚠️ 复扫仍然发现 ${residual.length} 个文件里有本任务标记，收尾**不算干净**：`)
      for (const path of residual.slice(0, 20)) lines.push(`  ! ${path}`)
      lines.push('这通常是"标记与调用分离"或"配对有歧义"造成的。请逐个人工确认。')
    }
    if (plan.separated.length > 0) {
      lines.push('', '⚠️ 疑似分离调用点（探针块里的标识符在块外还出现）：')
      for (const item of plan.separated.slice(0, 12)) lines.push(`  ? ${item.path} → ${item.name}`)
      lines.push('这类残留会让代码**编译不过**（桩已随任务目录删除，调用还在）。请逐个确认。')
    }
    if (scan.stubRefFiles.length > 0) {
      lines.push('', '⚠️ 仍有文件引用探针桩路径（桩已随任务目录删除）：')
      for (const path of scan.stubRefFiles.slice(0, 12)) lines.push(`  ! ${path}`)
    }
    if (diff.added.length > 0) {
      lines.push('', `本轮新增文件 ${diff.added.length} 个（宿主扫出来的）：`)
      for (const path of diff.added.slice(0, 12)) lines.push(`  + ${path}`)
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
    if (!writeProbe.ok || scan.error || scan.truncated || (scan.skipped ?? 0) > 0) {
      lines.push('', '⚠️ 残留检测未完全生效（扫描能力受限），上面的"干净"结论按此折扣看待：',
        `  · 工作区可写：${writeProbe.ok ? '是' : `否（${writeProbe.error}）`}`,
        `  · 扫描截断：${scan.truncated ? '是' : '否'}`,
        `  · 跳过的大文件：${scan.skipped ?? 0}`,
        `  · 读取错误：${scan.error ?? '无'}`)
    }

    lines.push('',
      `清理清单核对：你自报 ${(cleanedFiles ?? []).length} 个，宿主实际摘除 ${applied.cleaned.length} 个。`,
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
      text: lines.filter(Boolean).join('\n'),
    }
  }

  /** 把一个隔离区条目变成"整行删除"的计划（仍然先备份）。 */
  async stageQuarantineDeletion(root, target) {
    const absolute = join(root, ...String(target.path).split('/'))
    try {
      const text = await readFile(absolute, 'utf8')
      const lines = text.split(/\r?\n/)
      const index = Number(target.line) - 1
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) return null
      lines.splice(index, 1)
      return {
        path: target.path,
        text: lines.join('\n'),
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
   * R5：把所有**未关闭**的任务列出来（治 C7「任务不关、目录长草」）。
   *
   * 两条纪律：
   *   · **TTL 到期不自动删任务目录**——删除只发生在 `end` 里（§16.3 R5）；
   *     所以这里只做"看得见"，绝不替用户做决定。
   *   · 语气不指责：一个周六开始、周日继续的调试，不该一打开就是红字。
   *     陈旧只影响**排序与措辞**，不影响任何工具的可用性（§16.4 的教训）。
   *
   * @param {{ excludeSessionId?: string }} [options]
   */
  async debtBoard(options = {}) {
    const roots = new Set([...this.workspaces, process.cwd()])
    const rows = []
    for (const root of roots) {
      const tasksRoot = join(this.rootDir(root), 'tasks')
      let entries
      try {
        entries = await readdir(tasksRoot, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const state = await readJson(join(tasksRoot, entry.name, 'state.json'))
        if (!state || state.status === STATUS.CLOSED) continue
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
        })
      }
    }
    // 最陈旧的排在最前：这一档才是真正需要人去处理的。
    rows.sort((left, right) => left.updatedAt - right.updatedAt)
    return { tasks: rows, stale: rows.filter((row) => row.ageDays > 30) }
  }

  /** 给 `/debug` 用的一句话欠账提醒（发现欠账时才有）。 */
  async debtNotice(sessionId) {
    try {
      const board = await this.debtBoard({ excludeSessionId: sessionId })
      if (board.tasks.length === 0) return ''
      const oldest = board.tasks[0]
      const head = `提醒：另有 ${board.tasks.length} 个未收尾的调试任务`
        + `（最旧的是 #${oldest.hash}，${oldest.ageDays} 天前，状态 ${oldest.status}）。`
      return `${head}\n它们不会自动消失——用 dsh_debug_start 回到那个会话收尾，或让用户决定。`
    } catch {
      return ''
    }
  }

  /* ────────────────────────────── 面板 ────────────────────────────── */

  /**
   * 面板轮询的载荷（`GET /state`）。刻意**小**：每秒一次，不能把详情也塞进去。
   * 同时承担 §16.3.0 的"失效必须可见"：`detector` 字段告诉用户闸门到底在不在工作。
   */
  async panelState(sessionId) {
    const task = await this.findTask(sessionId)
    if (!task) return { task: null }
    const paths = this.pathsOf(task)
    const logInfo = await this.logStat(paths.log)
    const writeProbe = await this.ensureWriteProbe(task.workspace)
    const debts = this.debts
      .filter((entry) => entry.key.startsWith('gate:') || entry.key === 'index' || entry.key === 'write-probe')
      .map((entry) => entry.reason)
    return {
      task: {
        hash: task.hash,
        round: task.round,
        status: task.status,
        goal: task.goal,
        // 面板顶部那一句 + 复现清单：这是用户真正要读的两个字段（§9.2）。
        headline: task.headline ?? '',
        reproSteps: task.reproSteps ?? [],
        lastReport: task.lastReport ?? '',
        userNote: task.userNote ?? '',
        userVerdict: task.userVerdict ?? '',
        logBytes: logInfo.bytes,
        logLines: logInfo.lines,
        probeFiles: task.probeFiles ?? [],
        changedFiles: task.changedFiles ?? [],
        notes: (task.notes ?? []).slice(-3),
        detector: {
          // 只要写探针或索引有一项不可用，闸门就**不可能**可靠工作——必须说出来。
          available: Boolean(writeProbe?.ok) && !(task.index?.error),
          writeProbe: writeProbe?.ok ?? null,
          writeProbeError: writeProbe?.error ?? null,
          indexError: task.index?.error ?? null,
          truncated: Boolean(task.index?.truncated),
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
   * 给 `systemPrompt.section` 的 thunk 用：**只有任务活跃时**才有值
   * （AGENTS.md §1.1 第 7 条）。同步函数——提示词装配不会 await 我们。
   * @returns {{hash: string, round: number, status: string} | null}
   */
  /**
   * 交给 `debugGuidance()` 渲染的当前状态。
   *
   * ⚠️ **这里必须带上具体地址，不能只带"有任务"这件事。**
   * 这一段的特殊性在于：它是唯一**每次模型调用都在**的文本（systemPrompt 的 thunk，
   * 逐请求求值）。而 `dsh_debug_start` 的返回值只在那一轮出现——上下文一压缩、
   * 或者进入下一轮，Agent 就只剩下注入段里那句「优先走 HTTP 端点」，
   * 而地址没了：它既不知道端点是什么，也不知道该去哪个文件里找。
   * 实测到的现象就是 Agent 反问「摄入路径是什么」。
   *
   * 所以：任务期间 Agent 需要的**全部地址**都放这里。它们是每任务稳定的，
   * 不会让每轮提示词抖动。
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
      httpGuidePath: paths.httpGuide,
      guidePath: join(paths.dir, 'AGENT-PROBE-GUIDE.md'),
    }
  }

  /* ────────────────────────────── 会话生命周期 ────────────────────────────── */

  /** 会话结束：清票据、解除绑定。**不删任务目录**——删除只发生在 `end` 里（R5）。 */
  onSessionDisposed(sessionId) {
    this.tickets.delete(sessionId)
    this.restoreAttempts.delete(sessionId)
    const task = this.tasks.get(sessionId)
    if (task) this.log('info', `会话结束，任务 #${task.hash} 仍留在磁盘上等待收尾`)
    this.tasks.delete(sessionId)
  }

  /**
   * §9.3.2 的宿主自动迁移：`awaiting-user` 时收到新的用户消息 ⇒ 回到 `active`。
   *
   * 为什么是"观察"而不是"拦截"：用户消息本身就该正常送达 Agent，宿主只是顺带
   * 把状态对齐，不参与内容、不改写、不延迟。
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
   * 每个 `dsh_debug_*` 工具动手前的**宿主侧硬校验**（§6.2.2）。
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
 * 把请求体摊平成记录数组。
 *
 * 三种形态都认，因为投递方的形态不受我们控制：单个对象、对象数组、NDJSON。
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

/** 相对路径归一化：接受 POSIX/Windows 两种写法，去掉前导 `./`。 */
function normalizePaths(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list
    .map((value) => String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean))]
    .sort()
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
 * `file://` URL 是两种平台都能直接 `import` 的形式（DESIGN.md §7.4 的桩引入方式）。
 */
export function toFileUrl(absolute) {
  const normalized = String(absolute).replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  // encodeURI 不会动 `#` 与 `?`，而它们在 URL 里是分隔符——路径里真的出现时必须转义，
  // 否则 import 说明符会在第一个 `#` 处被截断。
  return `file://${encodeURI(prefixed).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}
