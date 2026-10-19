/**
 * 工作区索引与残留扫描：R1（索引 + 窗口 diff）、R2/R3（扫描、栈式配对、隔离）。
 *
 * 这两部分是唯一不依赖 Agent 自报的判定，因此实现为**纯函数 + 一层薄 IO**，便于单测。
 *
 * 两条约束：
 *   1. 发现宽松、分类严格：任一行只要像本插件的产物就进候选集，但如何处理只由精确标记决定。
 *   2. 配对存在任何歧义都不自动删除：`removeBlocks()` 只返回能证明的区间，说不清的进 quarantine。
 *
 * 大仓库上还有第三条，它决定收尾能不能宣称干净：
 *   3. **声明优先于发现**。发现遍历有预算、会被截断；而"Agent 报备过的文件"没有预算。
 *      收尾的正确性绑在前者上，扫描覆盖不足只体现为 `complete: false`，绝不体现为"干净"。
 */

import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, posix, relative, sep } from 'node:path'

/**
 * 索引与扫描共同排除的目录：插件的运行期产物、依赖、版本库元数据、工具链缓存与生成物。
 *
 * 排除是有代价的（里面真有源码就会漏检），所以只收"几乎不可能埋探针"的名字，
 * 并且把被跳过的目录**记账**（`walkSourceFiles().skippedDirs`）让调用方可以如实上报。
 * 另外这不是安全边界：**被记账的文件不受它约束**（见 `scanResidue` 的 `priority`）。
 */
export const SKIP_DIRS = Object.freeze([
  '.dsh', 'node_modules', '.git',
  'dist', 'coverage', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.next', '.nuxt', '.output', '.turbo', '.cache', '.parcel-cache', '.svelte-kit',
  'bower_components', '.gradle',
])

/** 只有这些扩展名会被当作"可能被埋了探针的源码"读进来。 */
export const TEXT_EXTENSIONS = Object.freeze([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.php', '.swift',
  '.scala', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.sql', '.lua', '.pl', '.r',
  '.dart', '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.fs',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env', '.gradle',
  '.md', '.mdx', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.xml',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm',
])

/** 发现路径上单文件参与扫描的上限；超过就跳过并记账（不静默）。被记账的文件不受它约束。 */
const MAX_SCAN_FILE_BYTES = 512 * 1024
/** 发现路径单次遍历的文件数上限；超过就把 truncated 置真（第 2 条：失效必须可见）。 */
export const DEFAULT_SCAN_MAX_FILES = 20_000
/** 发现路径的墙钟预算：文件数没到顶、但仓库太慢时同样要停止并如实报告。 */
export const DEFAULT_SCAN_BUDGET_MS = 8_000

/**
 * 读文件内容。发现路径按大小跳过；**被记账的路径**（`scanPaths`）无条件读，
 * 因为"它被声明过"比任何启发式都可靠。
 */
async function readCandidate(absolute, { skipLarge }) {
  const info = await stat(absolute)
  if (!info.isFile()) return { text: null, skipped: false }
  if (skipLarge && info.size > MAX_SCAN_FILE_BYTES) return { text: null, skipped: true }
  const raw = await readFile(absolute)
  return { text: raw.toString('utf8'), skipped: false, bytes: raw.length }
}

/** 宽松发现：`dsh-debug` / `dsh_debug` / `dsh debug`，冒号可有可无，大小写不敏感。 */
const LOOSE_MARKER_RE = /dsh[\s\-_]*debug/i
/** 严格分类：只有它能决定"怎么处理"。hash 缺失时保留原文供隔离区展示。 */
const STRICT_MARKER_RE = /dsh[\s\-_]*debug\s*[:\-]\s*(probe|temp|fix)\b[:\-]?\s*([0-9a-fA-F]{8})?/i
/** 块边标记：必须同时给出 kind、hash 与 start/end，缺一即视为"格式残缺"。 */
const BLOCK_EDGE_RE = /dsh[\s\-_]*debug\s*[:\-]\s*(probe|temp|fix)\s+([0-9a-fA-F]{8})\s+(start|end)\b/i
/**
 * 改动标记 `dsh-debug:change <hash>`。
 *
 * 不参与三色块配对，也永不被自动删除——它标的是行为改动，即用户要保留的修复。
 * 唯一的机器用途是第 1 轮的改动闸门：判据不能写成"任何文件被改过"，因为埋探针本身就在改文件。
 */
const CHANGE_MARKER_RE = /dsh[\s\-_]*debug\s*[:\-]\s*change\b[:\-]?\s*([0-9a-fA-F]{8})?/i
/**
 * 桩路径字面量，覆盖两种产物根：临时目录的 `<tmp>/dsh-debug-mode/tasks/<hash>/`
 * 与回退根的 `<repo>/.dsh/debug-mode/tasks/<hash>/`——这是探针桩已删除、import 残留
 * 时唯一的线索。
 *
 * 两种形态必须都认：默认落点是临时目录，只认 `.dsh/` 形态会漏掉全部残留。
 * hash 固定在第 1 组（调用方按组取值，改顺序会静默改变语义）。
 */
const STUB_REF_RE = /(?:\.dsh[\\/]debug-mode|dsh-debug-mode)[\\/]tasks[\\/]([0-9a-fA-F]{8})[\\/]/g

/** 规范化为 POSIX 相对路径：任务目录布局按 POSIX 约定写，Windows 下不能混进反斜杠。 */
export function toPosixPath(root, absolute) {
  return relative(root, absolute).split(sep).join(posix.sep)
}

function isTextCandidate(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return TEXT_EXTENSIONS.includes(name.slice(dot).toLowerCase())
}

/**
 * 遍历工作区里的候选源码文件（**发现路径**，允许被预算截断）。
 *
 * 返回 `truncated` 与 `truncatedReason` 而非静默停下：范围受限时调用方必须在面板上
 * 说明「残留检测未生效」，并且**不许**把它当成"没有残留"。
 *
 * 预算有两道：文件数（大仓库）与墙钟（网络盘/冷缓存）。任一触发都置 `truncated`。
 *
 * @param {string} root 仓库根绝对路径
 * @param {{ maxFiles?: number, budgetMs?: number, skipDirs?: string[], signal?: AbortSignal }} [options]
 * @returns {Promise<{ files: string[], truncated: boolean, truncatedReason: string|null,
 *                     elapsedMs: number, skippedDirs: string[] }>}
 */
export async function walkSourceFiles(root, options = {}) {
  const maxFiles = options.maxFiles ?? DEFAULT_SCAN_MAX_FILES
  const budgetMs = options.budgetMs ?? DEFAULT_SCAN_BUDGET_MS
  const skipDirs = options.skipDirs ?? SKIP_DIRS
  const startedAt = Date.now()
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const skippedDirs = []
  let truncated = false
  let truncatedReason = null

  /** 显式队列而不是递归：深仓库不该把调用栈打穿。 */
  const queue = [root]
  while (queue.length > 0) {
    if (options.signal?.aborted) {
      truncated = true
      truncatedReason = '调用方中止'
      break
    }
    if (Date.now() - startedAt > budgetMs) {
      truncated = true
      truncatedReason = `时间预算 ${budgetMs} ms 到顶`
      break
    }
    const dir = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        truncatedReason = `文件数预算 ${maxFiles} 到顶`
        break
      }
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) {
          skippedDirs.push(toPosixPath(root, absolute))
          continue
        }
        queue.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (!isTextCandidate(entry.name)) continue
      files.push(absolute)
    }
    if (truncated) break
  }
  return { files, truncated, truncatedReason, elapsedMs: Date.now() - startedAt, skippedDirs }
}

/** 全文指纹。只在"确有必要"时调用：大仓库里每多读一遍全文都是真金白银。 */
async function fingerprintOf(absolute) {
  return createHash('sha256').update(await readFile(absolute)).digest('hex')
}

/**
 * 对工作区建一次**stat 快照**索引：`{ relPath -> { size, mtimeMs, hash } }`。
 *
 * 为什么不是"每次全量算内容哈希"：那要在 start / report / continue / end 各读一遍全仓库
 * 全文。五万文件的仓库上，一次就是几百 MB 的读取，而它唯一的用途是"找出没被 Agent
 * 报备的改动"——收尾的**正确性**早已改为依赖账本（见 `scanResidue` 的 `priority`），
 * 这里可以只做便宜的判定：stat 没变就复用上一份哈希，变了才去读内容。
 *
 * `hash` 为 `null` 表示"这个文件的指纹没有算"（超过单文件上限的大文件）。
 * 调用方必须按 `size`/`mtimeMs` 判它是否变了——`diffIndex` 已经这么做。
 *
 * 失败不抛，而是返回 `error` 由调用方转成 `indexUnavailable` 并显示在面板上。
 *
 * @param {string} root 仓库根绝对路径
 * @param {{ maxFiles?: number, budgetMs?: number, previous?: Record<string, object>,
 *           signal?: AbortSignal }} [options]
 * @returns {Promise<{ entries: Record<string, {size: number, mtimeMs: number, hash: string|null}>,
 *                     truncated: boolean, truncatedReason: string|null, error: string|null,
 *                     count: number }>}
 */
export async function indexWorkspace(root, options = {}) {
  const walked = await walkSourceFiles(root, options)
  const previous = options.previous ?? {}
  /** @type {Record<string, {size: number, mtimeMs: number, hash: string|null}>} */
  const entries = {}
  try {
    for (const absolute of walked.files) {
      const relPath = toPosixPath(root, absolute)
      try {
        const info = await stat(absolute)
        const before = previous[relPath]
        const unchanged = before && before.size === info.size && before.mtimeMs === info.mtimeMs
        let hash = unchanged ? before.hash ?? null : null
        if (!unchanged && info.size <= MAX_SCAN_FILE_BYTES) hash = await fingerprintOf(absolute)
        entries[relPath] = { size: info.size, mtimeMs: info.mtimeMs, hash }
      } catch {
        // 单个文件读不到不该让整次索引失败：跳过后 diff 会把它算作"缺失"，
        // 这比"整体不可用"更保守，也不会误报。
      }
    }
  } catch (error) {
    return {
      entries,
      truncated: walked.truncated,
      truncatedReason: walked.truncatedReason,
      error: String(error?.message ?? error),
      count: Object.keys(entries).length,
    }
  }
  return {
    entries,
    truncated: walked.truncated,
    truncatedReason: walked.truncatedReason,
    error: null,
    count: Object.keys(entries).length,
  }
}

/**
 * 两份索引的窗口 diff（R1 的核心：**以 diff 为准**，不靠 Agent 自报）。
 *
 * 判据分两档：两边都有内容哈希就比哈希；否则比 stat（那个文件的指纹没算）。
 * 只有 stat 变化也能判 changed —— 这正是大文件不再被漏检的原因。
 * @param {Record<string, {size: number, mtimeMs: number, hash: string|null}>} before
 * @param {Record<string, {size: number, mtimeMs: number, hash: string|null}>} after
 * @returns {{ added: string[], changed: string[], removed: string[] }}
 */
export function diffIndex(before, after) {
  const added = []
  const changed = []
  const removed = []
  for (const [path, next] of Object.entries(after ?? {})) {
    const previous = before?.[path]
    if (previous === undefined) {
      added.push(path)
      continue
    }
    if (previous.hash && next.hash) {
      if (previous.hash !== next.hash) changed.push(path)
      continue
    }
    if (previous.size !== next.size || previous.mtimeMs !== next.mtimeMs) changed.push(path)
  }
  for (const path of Object.keys(before ?? {})) {
    if (after?.[path] === undefined) removed.push(path)
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

/** 从一段文本里抽出所有严格标记（分类用）。 */
export function findMarkers(text) {
  const out = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const strict = STRICT_MARKER_RE.exec(line)
    if (!strict) continue
    const edge = BLOCK_EDGE_RE.exec(line)
    out.push({
      line: index + 1,
      kind: String(strict[1]).toLowerCase(),
      hash: strict[2] ? String(strict[2]).toLowerCase() : null,
      edge: edge ? String(edge[3]).toLowerCase() : null,
      indent: (line.match(/^[ \t]*/) ?? [''])[0].length,
      text: line,
    })
  }
  return out
}

/**
 * 抽出改动标记（`dsh-debug:change <hash>`）。只用于 R4 L1 的判据与收尾清单，
 * **绝不参与删除**。
 * @param {string} text
 */
export function findChangeMarkers(text) {
  const out = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = CHANGE_MARKER_RE.exec(lines[index])
    if (!match) continue
    out.push({
      line: index + 1,
      hash: match[1] ? String(match[1]).toLowerCase() : null,
      text: lines[index],
    })
  }
  return out
}

/**
 * 栈式配对：只返回能证明的区间，任何歧义都进 `unresolved`。
 *
 * 一条 `end` 能闭合的条件：栈顶 kind 相同、hash 相同、缩进相同、两者之间没有其他标记行。
 * 任一不满足即作废该区间。
 *
 * @param {ReturnType<typeof findMarkers>} markers
 * @returns {{ blocks: Array<{kind: string, hash: string, startLine: number, endLine: number, indent: number}>, unresolved: Array<{line: number, reason: string, text: string}> }}
 */
export function pairBlocks(markers) {
  const blocks = []
  const unresolved = []
  const stack = []
  for (const marker of markers) {
    if (marker.edge === 'start') {
      stack.push(marker)
      continue
    }
    if (marker.edge === 'end') {
      const open = stack.pop()
      if (open === undefined) {
        unresolved.push({ line: marker.line, reason: 'end 没有配对的 start', text: marker.text })
        continue
      }
      if (open.kind !== marker.kind || open.hash !== marker.hash || open.indent !== marker.indent) {
        unresolved.push({ line: open.line, reason: 'start/end 的 kind、hash 或缩进不一致', text: open.text })
        unresolved.push({ line: marker.line, reason: 'start/end 的 kind、hash 或缩进不一致', text: marker.text })
        continue
      }
      const nested = markers.some((other) => other.line > open.line && other.line < marker.line)
      if (nested) {
        unresolved.push({ line: open.line, reason: '块内还有别的标记行，配对有歧义', text: open.text })
        continue
      }
      blocks.push({
        kind: marker.kind,
        hash: marker.hash,
        startLine: open.line,
        endLine: marker.line,
        indent: open.indent,
      })
      continue
    }
    // `fix` 是**行级**标记（R3 的三色表里它不需要 start/end，也不该被删），
    // 所以"没有 start/end"对它不是残缺。只有块状的 probe/temp 缺边才算残缺。
    if (marker.kind === 'fix') continue
    // 有严格标记但没有 start/end：格式残缺，进隔离区而不是猜。
    unresolved.push({ line: marker.line, reason: '标记缺少 start/end（格式残缺）', text: marker.text })
  }
  for (const open of stack) {
    unresolved.push({ line: open.line, reason: 'start 没有配对的 end', text: open.text })
  }
  return { blocks, unresolved }
}

/**
 * 从一段文本里摘除本任务的 `probe` / `temp` 块，并收敛摘除处残留的空白行。
 *
 * 只删除这两类：`fix` 标记的是用户要保留的修复。纯函数，便于先算后写。
 *
 * Agent 插块时通常会在块前后各留一个空行，而这些空行位于标记**外面**，按标记删行
 * 无法带走它们。因此每个摘除缝上做一次收敛：只删纯空白行、只删自己刚制造的缝、
 * 最多留 1 行（文件首尾留 0）。不碰任何非空行，也不跨过非空行合并。
 *
 * @param {string} text
 * @param {string} hash 本次任务哈希
 * @returns {{ text: string, removed: Array<{kind: string, startLine: number, endLine: number}>, removedLines: string[], collapsedBlankLines: number, unresolved: Array<{line: number, reason: string, text: string}> }}
 */
export function removeBlocks(text, hash) {
  const source = String(text)
  const lines = source.split(/\r?\n/)
  const markers = findMarkers(source)
  const { blocks, unresolved } = pairBlocks(markers)
  const targets = blocks
    .filter((block) => block.hash === hash && (block.kind === 'probe' || block.kind === 'temp'))
    .sort((left, right) => left.startLine - right.startLine)

  const drop = new Set()
  const removed = []
  const removedLines = []
  /** 每一处摘除的**接缝**：删完之后这两行会变成相邻（或其中之一不存在）。 */
  const seams = []
  for (const block of targets) {
    // 行尾残留：块被摘掉后，若 start 行之前有内容（例如 `foo(); // dsh-debug:probe … start`），
    // 说明标记和代码同一行 —— 这种"半行块"配对本身就没有意义，直接判为歧义。
    const startLine = lines[block.startLine - 1] ?? ''
    const prefix = startLine.slice(0, startLine.search(/dsh[\s\-_]*debug/i))
    if (prefix.trim() !== '' && !/^\s*(\/\/|#|--|\/\*|\*|;|<!--)/.test(prefix)) {
      unresolved.push({ line: block.startLine, reason: '标记与代码同行，无法整块摘除', text: startLine })
      continue
    }
    for (let line = block.startLine; line <= block.endLine; line += 1) {
      drop.add(line)
      removedLines.push(lines[line - 1] ?? '')
    }
    removed.push({ kind: block.kind, startLine: block.startLine, endLine: block.endLine })
    seams.push({ before: block.startLine - 1, after: block.endLine + 1 })
  }

  const kept = lines.filter((_, index) => !drop.has(index + 1))
  const { text: collapsed, collapsedBlankLines } = collapseSeamBlanks(kept, seams, lines, drop)
  return { text: collapsed, removed, removedLines, collapsedBlankLines, unresolved }
}

/**
 * 在摘除缝上收敛空白行。
 *
 * 做法是把缝所在的整段连续空白折叠成 1 行（文件首尾折叠成 0 行）。摘除本身不创造空白，
 * 能被观察到的多余空白一定是围绕块加进来的填充。
 *
 * @param {string[]} kept 已删掉标记行的文本行
 * @param {{before: number, after: number}[]} seams 1-based 原始行号
 * @param {string[]} original 原始行
 * @param {Set<number>} drop 被删掉的原始行号
 */
function collapseSeamBlanks(kept, seams, original, drop) {
  if (seams.length === 0) return { text: kept.join('\n'), collapsedBlankLines: 0 }
  const isBlank = (line) => String(line ?? '').trim() === ''

  // 把缝映射到 kept 里的位置：缝 = "被删区域之前那一行的索引"。
  // kept 中，位于 seam 之前的行数 = 原始 before 行里没被删掉的行数。
  const anchors = new Set()
  for (const seam of seams) {
    let count = 0
    for (let line = 1; line <= seam.before && line <= original.length; line += 1) {
      if (!drop.has(line)) count += 1
    }
    anchors.add(count) // kept 的**切点**：kept[count-1] 是缝左边的最后一行，kept[count] 是右边的第一行
  }

  const out = []
  let collapsedBlankLines = 0
  let index = 0
  while (index < kept.length) {
    if (!isBlank(kept[index])) {
      out.push(kept[index])
      index += 1
      continue
    }
    // 一段连续空白：找到它的结束位置，判断它是否**跨过**某个缝。
    let end = index
    while (end < kept.length && isBlank(kept[end])) end += 1
    const spansSeam = [...anchors].some((anchor) => anchor > index && anchor <= end)
    const leadingOfFile = index === 0
    const run = end - index
    if (spansSeam && (run > 1 || leadingOfFile)) {
      // 文件**开头**的空白折叠成 0（文件不该以空行开头）；
      // 其余一律折叠成 1 —— 注意结尾那个 `''` 代表的是"最后一行的换行符"，
      // 不是空行，所以它必须留（否则会把文件尾的换行也吃掉）。
      const keepOne = !leadingOfFile
      if (keepOne) out.push('')
      collapsedBlankLines += run - (keepOne ? 1 : 0)
    } else {
      for (let cursor = index; cursor < end; cursor += 1) out.push(kept[cursor])
    }
    index = end
  }
  return { text: out.join('\n'), collapsedBlankLines }
}

/**
 * 从被摘除的块里提取"新引入的标识符"，用于标识符反查。
 *
 * 覆盖一种扫描器无法直接看到的残留：探针被重构成 helper、标记只盖住定义、调用点留在别处。
 * 桩自带的公开名字（`probe` / `probeScope`）过于常见，不参与反查。
 *
 * @param {string[]} lines 被摘除的块的行
 * @returns {string[]}
 */
export function introducedIdentifiers(lines) {
  const ignored = new Set(['probe', 'probeScope', 'default', 'from', 'const', 'let', 'var', 'function'])
  const found = new Set()
  for (const raw of lines) {
    const line = String(raw).replace(/\/\/.*$/, '')
    for (const match of line.matchAll(/\bimport\s*(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))(?:\s*,\s*\{([^}]*)\})?/g)) {
      for (const group of [match[1], match[2], match[3]]) {
        if (!group) continue
        for (const piece of group.split(',')) {
          const name = piece.trim().split(/\s+as\s+/).pop()?.trim()
          if (name && /^[A-Za-z_$][\w$]*$/.test(name)) found.add(name)
        }
      }
    }
    for (const match of line.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      found.add(match[1])
    }
  }
  for (const name of ignored) found.delete(name)
  return [...found]
}

/**
 * 把一个文件的正文分类成"是否像本插件产物、属于哪一类"。
 *
 * **这是分类口径的唯一实现**：发现路径（`scanResidue`）与声明路径（`scanPaths`）都走它，
 * 否则两条路径会各自漂移，而它们的结论要被并在一起做删除决策。
 *
 * @param {string} relPath 仓库相对路径（POSIX）
 * @param {string} text 文件全文
 * @param {{ hash: string, knownHashes: Iterable<string> }} options
 * @returns {object|null} 不像本插件产物时返回 null
 */
export function classifyFile(relPath, text, options) {
  const targetHash = String(options.hash ?? '').toLowerCase()
  const known = new Set([...options.knownHashes ?? []].map((value) => String(value).toLowerCase()))
  known.add(targetHash)

  const loose = text.split(/\r?\n/).some((line) => LOOSE_MARKER_RE.test(line))
  const stubRefs = [...text.matchAll(STUB_REF_RE)].map((match) => match[0])
  const containsHash = targetHash.length === 8 && text.toLowerCase().includes(targetHash)
  if (!loose && stubRefs.length === 0 && !containsHash) return null

  const markers = findMarkers(text)
  const { blocks, unresolved } = pairBlocks(markers)
  const changeMarkers = findChangeMarkers(text)
    .filter((marker) => marker.hash === null || marker.hash === targetHash)
  const foreignHashes = [...new Set(markers
    .map((marker) => marker.hash)
    .filter((hash) => hash !== null && !known.has(hash)))]

  return {
    path: relPath,
    markers,
    blocks,
    unresolved,
    changeMarkers,
    foreignHashes,
    stubRefs: [...new Set(stubRefs)],
    // 标识符反查在"摘除之后"才有意义，所以这里先记录将要摘除的块覆盖的行，
    // 由 planCleanup 用 removeBlocks 的结果去反查。
    hasTargetBlocks: blocks.some((block) => block.hash === targetHash
      && (block.kind === 'probe' || block.kind === 'temp')),
  }
}

/**
 * 只扫**给定的一组文件**，没有任何预算、跳过目录与大小上限（R2 的声明路径）。
 *
 * 为什么它必须存在：发现遍历在大仓库上必然被截断，而被截断的遍历无法证明"没有残留"。
 * 收尾的正确性因此只能靠"Agent 说过它碰过哪些文件"这份账本——账本里的文件一个都不能漏，
 * 哪怕它 5 MB、哪怕它住在 `dist/` 里。
 *
 * @param {string} root
 * @param {string[]} paths 仓库相对路径（POSIX）
 * @param {{ hash: string, knownHashes?: string[], signal?: AbortSignal }} options
 * @returns {Promise<{ affected: object[], scanned: number, unreadable: Array<{path: string, error: string}> }>}
 */
export async function scanPaths(root, paths, options) {
  const affected = []
  /** @type {Array<{path: string, error: string}>} */
  const unreadable = []
  let scanned = 0
  for (const relPath of [...new Set(paths ?? [])]) {
    if (options.signal?.aborted) break
    const absolute = join(root, ...String(relPath).split(posix.sep))
    let text
    try {
      const read = await readCandidate(absolute, { skipLarge: false })
      if (read.text === null) continue
      text = read.text
    } catch (error) {
      // 声明过的文件读不到 === 这次收尾**无法证明**它干净。必须上报，不能静默跳过。
      unreadable.push({ path: relPath, error: String(error?.message ?? error) })
      continue
    }
    if (text.includes('\u0000')) {
      unreadable.push({ path: relPath, error: '文件含 NUL 字节，按二进制跳过' })
      continue
    }
    scanned += 1
    const classified = classifyFile(relPath, text, options)
    if (classified) affected.push(classified)
  }
  return { affected, scanned, unreadable }
}

/**
 * 扫工作区，把"像本插件产物"的东西全部找出来并分类（R2）。
 *
 * 两条路径合起来的结果：
 *   1. **声明路径**（`priority`）—— 账本里的文件，无预算、不被跳过，读不到就进 `unreadable`；
 *   2. **发现路径** —— 遍历整个工作区，找没被记账的残留；允许被预算截断。
 *
 * `complete` 是收尾能否宣称"干净"的唯一依据：只要有预算截断、读取错误、跳过的大文件或
 * 读不到的声明文件，它就为假。第 2 条纪律（失效必须可见）在这里落成机器可判定的布尔值。
 *
 * @param {string} root 仓库根绝对路径
 * @param {{ hash: string, knownHashes?: string[], priority?: string[], maxFiles?: number,
 *           budgetMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<object>} 见下方返回值构造
 */
export async function scanResidue(root, options) {
  const base = {
    hash: options.hash,
    knownHashes: options.knownHashes ?? [],
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const priority = (options.priority ?? []).map((path) => String(path).replace(/\\/g, '/'))
  const declared = priority.length > 0
    ? await scanPaths(root, priority, base)
    // 声明路径可能指向二进制/非文本文件，那些不是残留也不再参与发现遍历。
    : { affected: [], scanned: 0, unreadable: [] }
  const declaredSet = new Set(priority)

  const { files, truncated, truncatedReason, elapsedMs, skippedDirs } = await walkSourceFiles(root, {
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const byPath = new Map(declared.affected.map((file) => [file.path, file]))
  let scanned = declared.scanned
  let skipped = 0
  let readError = null

  for (const absolute of files) {
    if (options.signal?.aborted) break
    const relPath = toPosixPath(root, absolute)
    // 声明路径已经分类过：发现路径不许覆盖它的结论（那会让"读不到"变回"没发现"）。
    if (declaredSet.has(relPath)) continue
    let text
    try {
      const read = await readCandidate(absolute, { skipLarge: true })
      if (read.skipped) {
        skipped += 1
        continue
      }
      if (read.text === null) continue
      text = read.text
    } catch (error) {
      readError = readError ?? String(error?.message ?? error)
      continue
    }
    if (text.includes('\u0000')) continue
    scanned += 1
    const classified = classifyFile(relPath, text, base)
    if (classified) byPath.set(relPath, classified)
  }

  const affected = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  const stale = affected.filter((file) => file.foreignHashes.length > 0
    || file.unresolved.length > 0
    || file.markers.some((marker) => marker.hash === null && marker.kind !== 'fix'))
  const stubRefFiles = affected.filter((file) => file.stubRefs.length > 0).map((file) => file.path)

  return {
    scanned,
    skipped,
    truncated,
    truncatedReason,
    elapsedMs,
    skippedDirs,
    error: readError,
    affected,
    priorityScanned: declared.scanned,
    unreadable: declared.unreadable,
    // "这次扫描能不能证明没有残留"：四道口子任何一道开着都不行。
    complete: !truncated && readError === null && skipped === 0 && declared.unreadable.length === 0,
    targetFiles: affected.filter((file) => file.hasTargetBlocks).map((file) => file.path),
    // `fix` 是行级标记，不出现在 blocks 里，但必须进"修复（保留）"清单，
    // 否则收尾报告会漏掉用户最关心的一项。
    fixFiles: [...new Set(affected
      .filter((file) => file.markers.some((marker) => marker.kind === 'fix' && marker.hash === String(options.hash ?? '').toLowerCase()))
      .map((file) => file.path))],
    stubRefFiles,
    // 「hash 不属于任何已知任务，或格式残缺」——一律进隔离区，逐条让用户三选一（R3）。
    // 按**文件**归并：同一个文件既可能有残缺标记、又可能带着陌生 hash，
    // 拆成两条会让用户对同一个文件回答两次，那不是"逐条决定"，那是折磨。
    quarantine: buildQuarantine(stale),
  }
}

/** 把隔离区候选按文件归并成一个条目（逐条 = 逐文件，不是一个症状一条）。 */
function buildQuarantine(files) {
  const out = []
  for (const file of files) {
    const reasons = []
    let line = null
    let text = null
    for (const entry of file.unresolved) {
      reasons.push(entry.reason)
      if (line === null) line = entry.line
      if (text === null) text = entry.text
    }
    for (const marker of file.markers) {
      if (marker.hash !== null || marker.kind === 'fix') continue
      reasons.push('标记缺少 hash（格式残缺）')
      if (line === null) line = marker.line
      if (text === null) text = marker.text
    }
    for (const hash of file.foreignHashes) reasons.push(`hash ${hash} 不属于任何已知任务`)
    if (reasons.length === 0) continue
    out.push({
      path: file.path,
      line,
      text,
      hash: file.foreignHashes[0] ?? null,
      reasons: [...new Set(reasons)],
      reason: [...new Set(reasons)].join('；'),
    })
  }
  return out
}

/**
 * 把"要摘除哪些块的哪些行"算出来，并顺带做标识符反查（R2 补充规则 2）。
 *
 * `files` 默认取 `scan.affected`；调用方要覆盖更多文件（例如 `cleanedFiles` 里报了、
 * 但发现路径没扫到的）时显式传入——摘除计划只由这份列表决定，不做二次遍历。
 *
 * @param {string} root
 * @param {object} scan `scanResidue` 的返回值
 * @param {string} hash
 * @param {Array<{path: string}>} [files]
 * @returns {Promise<{ plans: Array<{path: string, text: string, removed: object[], removedLines: string[]}>, unresolved: object[], separated: Array<{path: string, name: string}>, unreadable: Array<{path: string, error: string}> }>}
 */
export async function planCleanup(root, scan, hash, files) {
  const plans = []
  const unresolved = []
  const separated = []
  /** @type {Array<{path: string, error: string}>} */
  const unreadable = []
  for (const file of files ?? scan.affected) {
    const absolute = join(root, ...file.path.split(posix.sep))
    let text
    try {
      text = await readFile(absolute, 'utf8')
    } catch (error) {
      // 声明过要清、却读不到：这是"无法证明干净"，不是"没什么可清"。
      unreadable.push({ path: file.path, error: String(error?.message ?? error) })
      continue
    }
    const result = removeBlocks(text, hash)
    for (const entry of result.unresolved) unresolved.push({ path: file.path, ...entry })
    if (result.removed.length === 0) continue
    plans.push({
      path: file.path,
      text: result.text,
      removed: result.removed,
      removedLines: result.removedLines,
      // 摘除时顺带收掉的空行数：收尾报告会把它写出来，空白被改动这件事不能是静默的。
      collapsedBlankLines: result.collapsedBlankLines,
    })

    const names = introducedIdentifiers(result.removedLines)
    for (const name of names) {
      const body = result.text
      const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      if (pattern.test(body)) separated.push({ path: file.path, name })
    }
  }
  return { plans, unresolved, separated, unreadable }
}

/**
 * 落盘：先把原文件备份到 `tasks/<hash>/backups/`，再写入摘除后的内容，并追加 journal 行。
 *
 * 备份只供查看与 diff，**绝不自动还原**。
 *
 * @param {string} root
 * @param {Array<{path: string, text: string}>} plans
 * @param {{ backupsDir: string, journalFile: string, hash: string }} options
 * @returns {Promise<{ cleaned: string[], failed: Array<{path: string, error: string}> }>}
 */
export async function applyCleanup(root, plans, options) {
  const cleaned = []
  const failed = []
  for (const plan of plans) {
    const absolute = join(root, ...plan.path.split(posix.sep))
    const backup = join(options.backupsDir, plan.path.split(posix.sep).join('__'))
    try {
      await mkdir(options.backupsDir, { recursive: true })
      await mkdir(dirname(backup), { recursive: true })
      await writeFile(backup, await readFile(absolute), 'utf8')
      // 先写临时文件再 rename：摘除到一半崩掉时，磁盘上要么是原文要么是结果，
      // 不会出现"被删了一半的源文件"这种最难收拾的中间态。
      const staged = `${absolute}.dsh-debug-mode.tmp`
      await writeFile(staged, plan.text, 'utf8')
      await rename(staged, absolute)
      cleaned.push(plan.path)
      await appendJournal(options.journalFile, {
        op: 'probe-remove',
        task: options.hash,
        path: plan.path,
        backup: toPosixPath(root, backup),
      })
    } catch (error) {
      failed.push({ path: plan.path, error: String(error?.message ?? error) })
    }
  }
  return { cleaned, failed }
}

/** 追加一行审计记录（journal.jsonl）。失败不抛：审计不该把收尾弄崩。 */
export async function appendJournal(file, record) {
  try {
    await mkdir(dirname(file), { recursive: true })
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
    await appendFile(file, line, 'utf8')
  } catch {
    // 安静降级：journal 是给用户查的，不是流程的一部分。
  }
}

/**
 * 语法自检：只判定能证明的，其余一律标为 unverifiable。
 *
 * 三态：
 *   · `ok`           解析通过
 *   · `failed`       确认语法错误（只 warn，不作硬闸门）
 *   · `unverifiable` ESM / TS / 非 JS，宿主不判定
 *
 * 它是提示而非闸门：宿主自己制造的假失败比不做检查更糟。
 *
 * @param {Record<string, string>} sources path -> 源码
 * @returns {Array<{path: string, verdict: 'ok'|'failed'|'unverifiable', message?: string}>}
 */
export function verifySyntax(sources) {
  const out = []
  for (const [path, source] of Object.entries(sources ?? {})) {
    if (!/\.(c|m)?js$/.test(path)) {
      out.push({ path, verdict: 'unverifiable', message: '非 JS 文件，宿主不判定其语法' })
      continue
    }
    if (/^\s*(import|export)\s/m.test(source)) {
      out.push({ path, verdict: 'unverifiable', message: 'ESM 源（含 import/export），宿主不判定其语法' })
      continue
    }
    if (/\bawait\b/.test(source)) {
      // 顶层 await 在 `new Function` 的包装里必然失败，而它完全合法（ESM / 顶层 await）。
      // 宁可放弃覆盖，也不把合法的代码报成语法错误。
      out.push({ path, verdict: 'unverifiable', message: '含 await，无法用同步编译器判定' })
      continue
    }
    try {
      // 只编译不执行：这一步不产生任何副作用。
      // eslint-disable-next-line no-new-func
      new Function(source)
      out.push({ path, verdict: 'ok' })
    } catch (error) {
      out.push({ path, verdict: 'failed', message: String(error?.message ?? error) })
    }
  }
  return out
}
