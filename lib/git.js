/**
 * 工作区改动清单：用 `git status` 代替全仓遍历。
 *
 * 为什么不能遍历：残留清理只需要"这次调试可能碰过的文件"，而超大仓库里通读每个文件
 * 既慢又没必要。git 已经知道哪些文件变了，直接问它。
 *
 * 没有 git（或工作区不在仓库里）不是错误：调用方退回"只按 Agent 报备的文件"，
 * 并在返回值里说清这次的范围，绝不假装全仓干净。
 *
 * 子进程的 stdout/stderr 走**文件描述符**而不是管道：受限环境里 `spawn` 的默认
 * 管道会以 EPERM 失败，而把输出重定向到临时文件在两种环境下都成立。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 单次 git 调用的墙钟预算。git status 在大仓库上也可能冷启动，给足但不无限等。 */
const GIT_TIMEOUT_MS = 10_000
/** git 输出单文件上限：状态清单不该比这个更大；超了按错误处理，不吞。 */
const GIT_OUTPUT_MAX_BYTES = 4 * 1024 * 1024

/** 改动种类；`deleted` 不进清理清单（文件已经不在了），但仍会被调用方看到。 */
export const CHANGE_STATUS = Object.freeze({
  MODIFIED: 'modified',
  ADDED: 'added',
  UNTRACKED: 'untracked',
  DELETED: 'deleted',
  CONFLICTED: 'conflicted',
})

function changeBase(extra) {
  return {
    ok: false,
    prefix: '',
    entries: [],
    files: [],
    untracked: [],
    deleted: [],
    reason: null,
    error: null,
    ...extra,
  }
}

function failure(reason, error) {
  return changeBase({ reason, error: String(error ?? '').trim() || null })
}

/**
 * 跑一次 git。stdout / stderr 各写一个临时文件，避免管道在受限环境里被拒。
 * @param {string} root
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [options]
 */
async function runGit(root, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  const dir = await mkdtemp(join(tmpdir(), 'dsh-debug-git-'))
  const outPath = join(dir, 'stdout')
  const errPath = join(dir, 'stderr')
  const stdoutHandle = await open(outPath, 'w+')
  const stderrHandle = await open(errPath, 'w+')
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false
      const child = spawn('git', ['-C', root, ...args], {
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        const error = new Error(`git ${args[0]} 超过 ${timeoutMs} ms 没有结束`)
        error.code = 'ETIMEDOUT'
        reject(error)
      }, timeoutMs)
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, signal })
      })
    })
    const [stdout, stderr] = await Promise.all([
      readFile(outPath, 'utf8'),
      readFile(errPath, 'utf8'),
    ])
    if (Buffer.byteLength(stdout) > GIT_OUTPUT_MAX_BYTES) {
      const error = new Error(`git 输出超过 ${GIT_OUTPUT_MAX_BYTES} 字节`)
      error.code = 'EOUTPUT'
      throw error
    }
    return { ...result, stdout, stderr }
  } finally {
    await stdoutHandle.close().catch(() => {})
    await stderrHandle.close().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** `show-prefix` 的输出（`sub/`）→ 统一成带结尾斜杠的 POSIX 前缀。 */
function normalizePrefix(text) {
  const value = String(text ?? '').trim().replace(/\\/g, '/')
  if (!value) return ''
  return value.endsWith('/') ? value : `${value}/`
}

function normalizeRelative(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/** porcelain 的 XY 两列 → 变更种类。冲突优先，删除只认确实不存在的文件。 */
function classifyStatus(index, worktree) {
  if (index === '?' && worktree === '?') return CHANGE_STATUS.UNTRACKED
  if (index === '!' && worktree === '!') return 'ignored'
  if (index === 'U' || worktree === 'U'
    || (index === 'A' && worktree === 'A')
    || (index === 'D' && worktree === 'D')) return CHANGE_STATUS.CONFLICTED
  if (index === 'D' || worktree === 'D') return CHANGE_STATUS.DELETED
  if (index === 'A' || worktree === 'A') return CHANGE_STATUS.ADDED
  return CHANGE_STATUS.MODIFIED
}

/**
 * 列出工作区里被 git 认为有改动的文件（含未跟踪文件）。
 *
 * 路径统一为**工作区相对**的 POSIX 路径。工作区是仓库的子目录时，用
 * `rev-parse --show-prefix` 剥掉仓库根前缀——git status 的 porcelain 路径
 * 始终相对仓库根，不能直接当成工作区相对路径。
 *
 * 失败不抛：返回 `{ ok: false, reason, error }`，由调用方决定怎么提示。
 *
 * @param {string} root 工作区根绝对路径
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, prefix: string,
 *   entries: Array<{path: string, status: string}>,
 *   files: string[], untracked: string[], deleted: string[],
 *   reason: 'no-git'|'not-repo'|'timeout'|'error'|null, error: string|null }>}
 */
export async function gitChangedFiles(root, options = {}) {
  const workspace = String(root ?? '')
  if (!workspace) return failure('error', '缺少工作区路径')

  let prefix = ''
  try {
    const rev = await runGit(workspace, ['rev-parse', '--show-prefix'], options)
    if (rev.code !== 0) {
      const message = String(rev.stderr || rev.stdout || `git 退出码 ${rev.code}`).trim()
      return /not a git repository|不是.*git.*仓库/i.test(message)
        ? failure('not-repo', message)
        : failure('error', message)
    }
    prefix = normalizePrefix(rev.stdout)
  } catch (error) {
    if (error?.code === 'ENOENT') return failure('no-git', '找不到 git 可执行文件')
    return failure(error?.code === 'ETIMEDOUT' ? 'timeout' : 'error', error?.message ?? error)
  }

  let status
  try {
    status = await runGit(workspace, [
      'status', '--porcelain=v1', '-z',
      '--untracked-files=all', '--no-renames', '--ignore-submodules=all',
    ], options)
  } catch (error) {
    if (error?.code === 'ENOENT') return failure('no-git', '找不到 git 可执行文件')
    return failure(error?.code === 'ETIMEDOUT' ? 'timeout' : 'error', error?.message ?? error)
  }
  if (status.code !== 0) {
    const message = String(status.stderr || status.stdout || `git 退出码 ${status.code}`).trim()
    return /not a git repository|不是.*git.*仓库/i.test(message)
      ? failure('not-repo', message)
      : failure('error', message)
  }

  /** @type {Map<string, {path: string, status: string}>} */
  const byPath = new Map()
  for (const record of String(status.stdout).split('\0')) {
    if (!record || record.length < 4) continue
    const kind = classifyStatus(record[0], record[1])
    if (kind === 'ignored') continue
    let path = normalizeRelative(record.slice(3))
    if (!path) continue
    if (prefix) {
      if (!path.startsWith(prefix)) continue
      path = path.slice(prefix.length)
    }
    if (!path) continue
    // git 不该产出越界路径；这里仍然挡一道，免得把工作区外的文件带进清理清单。
    if (path.startsWith('../') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) continue
    // 同一路径可能同时以两种状态出现（例如 `D ` 与 `??`）：保留更"存在"的那一条。
    const previous = byPath.get(path)
    if (previous && previous.status !== CHANGE_STATUS.DELETED) continue
    byPath.set(path, { path, status: kind })
  }

  // 状态里的 D 不一定代表文件真的不在了（`git rm --cached` 会留下工作区副本），
  // 所以以磁盘为准：文件存在就当可读清单，不存在才记为 deleted。
  for (const [path, entry] of byPath) {
    const absolute = join(workspace, ...path.split('/'))
    let exists = false
    try {
      const info = await stat(absolute)
      exists = info.isFile()
    } catch {
      exists = false
    }
    if (!exists) entry.status = CHANGE_STATUS.DELETED
  }

  const entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  return changeBase({
    ok: true,
    prefix,
    entries,
    files: entries.filter((entry) => entry.status !== CHANGE_STATUS.DELETED).map((entry) => entry.path),
    untracked: entries.filter((entry) => entry.status === CHANGE_STATUS.UNTRACKED).map((entry) => entry.path),
    deleted: entries.filter((entry) => entry.status === CHANGE_STATUS.DELETED).map((entry) => entry.path),
  })
}
