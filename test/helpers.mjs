/**
 * test/helpers.mjs —— 测试用的宿主替身。
 *
 * 它存在的理由：`DebugService` 要的东西全部来自 Cordis 上下文（agents /
 * sessionController / webServer…），而这些东西在真实宿主里是活的。测试要的是
 * **可断言**的替身：能记下每一次 prompt、能列出注册了哪些工具。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 造一个最小可用的宿主上下文。
 * @param {{ cwd?: string }} [options]
 */
export function createFakeContext(options = {}) {
  /** @type {any[]} */
  const prompts = []
  /** @type {any[]} */
  const toolRegistrations = []
  /** @type {any[]} */
  const sections = []
  /** @type {any[]} */
  const routes = []
  /** @type {Map<string, any>} */
  const agents = new Map()
  /** @type {any[]} */
  const commands = []
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const warnings = []

  const ctx = {
    logger: {
      info: () => undefined,
      warn: (message) => warnings.push(String(message)),
    },
    /** Cordis 的事件订阅：测试里只需要"能注册、能手动触发"。 */
    on(name, listener) {
      const bucket = listeners.get(name) ?? []
      bucket.push(listener)
      listeners.set(name, bucket)
      return () => undefined
    },
    get(name) {
      if (name === 'agents') {
        return {
          get: (id) => agents.get(id),
          list: () => [...agents.values()],
        }
      }
      return undefined
    },
    sessionController: {
      async prompt(request) {
        prompts.push(request)
        return { accepted: true }
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => undefined
      },
    },
    tools: {
      register(definition) {
        toolRegistrations.push(definition)
        return () => undefined
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => undefined
      },
    },
    webServer: {
      // 真实宿主的 webServer 服务有个公开的 `port`（`dsh-host-webserver` 的
      // `get port()`）。默认**不给**，这样"两个来源都拿不到"的降级分支才测得到；
      // 要测端口来源的用 `options.webPort`。
      ...(options.webPort ? { port: options.webPort } : {}),
      register(route) {
        routes.push(route)
        return () => undefined
      },
    },
  }

  /** 手动派发一个事件（给 `ctx.on` 注册的监听器）。 */
  const emit = (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }

  return { ctx, emit, listeners, prompts, toolRegistrations, sections, routes, agents, commands, warnings, cwd: options.cwd }
}

/**
 * 造一个"活的" agent。
 *
 * `mountCtx` 是 `agent.ctx.inject` 会挂进去的上下文——真实宿主里那是这个会话的持久
 * 作用域；测试里给它一个可观察的替身，才能断言"工具确实注册到了这个会话上"。
 */
export function createAgent({ id, cwd, parentSession, mountCtx }) {
  return {
    id,
    session: { header: { id, cwd, ...(parentSession ? { parentSession } : {}) } },
    ctx: {
      inject(_keys, callback) {
        if (mountCtx) callback(mountCtx)
        return { dispose: async () => undefined }
      },
    },
  }
}

/** 建一个临时工作区，返回 { root, cleanup, write } 。 */
export async function createWorkspace(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-mode-test-'))
  const write = async (path, content) => {
    const parts = path.split('/')
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true })
    await writeFile(join(root, ...parts), content, 'utf8')
  }
  for (const [path, content] of Object.entries(files)) await write(path, content)
  return {
    root,
    write,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * 造一个**产物根父目录**（不会被别的东西碰到的 tempBase）。
 *
 * 为什么每个测试都要有自己的：产物根现在默认落在用户临时目录里
 * （`<tempBase>/dsh-debug-mode`），而 `node --test` 会**并行**跑多个测试文件——
 * 共用一个 `%TEMP%/dsh-debug-mode` 会让 `debtBoard` / 跨重启恢复这类
 * 「扫一遍所有任务目录」的断言互相污染（甲的任务出现在乙的看板上）。
 *
 * `root` 只是方便断言，**不预先创建**：「临时根写不进去」这条路要靠"同名文件占位"
 * 来复现，预创建反而会把那条路堵死。
 * @returns {Promise<{ base: string, root: string, cleanup: () => Promise<void> }>}
 */
export async function createArtifactBase() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-artifacts-'))
  return {
    base,
    root: join(base, 'dsh-debug-mode'),
    async cleanup() {
      await rm(base, { recursive: true, force: true })
    },
  }
}

/** 读文件；不存在返回 null。 */
export async function readIfExists(absolute) {
  const { readFile } = await import('node:fs/promises')
  try {
    return await readFile(absolute, 'utf8')
  } catch {
    return null
  }
}

/** 拼一个探针块（测试用）。 */
export function probeBlock(hash, body, indent = '') {
  return [
    `${indent}// dsh-debug:probe ${hash} start`,
    `${indent}${body}`,
    `${indent}// dsh-debug:probe ${hash} end`,
  ].join('\n')
}

/** 拼一个改动标记（测试用）。 */
export function changeMark(hash, body, indent = '') {
  return `${indent}// dsh-debug:change ${hash} 修复：测试用\n${indent}${body}`
}
