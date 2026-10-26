/**
 * 残留标记的识别、配对、摘除与声明文件扫描。
 *
 * 两条边界：
 *   1. **只认注释里的标记**：`dsh-debug:` 出现在字符串或代码里不是标记，绝不能被删。
 *   2. **配对存在任何歧义都不自动删除**：只摘能证明的区间，说不清的进 quarantine。
 *
 * 扫描范围由调用方给定（Agent 账本 + git 改动文件），这里**不遍历仓库**。
 * 收尾必须无痕：`probe` / `temp` 整块删除，`fix` / `change` 等行级标记只删注释、
 * 保留它们标注的代码。
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'

/** 宽松识别：只要像本插件的标记就进候选，精确处理由下方严格规则决定。 */
const LOOSE_MARKER_RE = /dsh[\s\-_]*debug/i
/** 严格标记：`dsh-debug:<kind> [<hash>]`；kind 可缺省（`dsh-debug:` 本身也是标记）。 */
const MARKER_RE = /dsh[\s\-_]*debug\s*[:\-]\s*([A-Za-z]+)?[\s_:\-]*([0-9a-fA-F]{8})?/i
/** 块标记的 kind；`tmp` 是 Agent 常写错的别名。 */
const BLOCK_KINDS = new Set(['probe', 'temp'])
/** 桩路径字面量：探针桩已删除、import 残留时唯一的线索。hash 固定在第 1 组。 */
const STUB_REF_RE = /(?:\.dsh[\\/]debug-mode|dsh-debug-mode)[\\/]tasks[\\/]([0-9a-fA-F]{8})[\\/]/g

/**
 * 读一个**声明过**的文件。声明路径不受大小与目录跳过规则限制，读不到就是读不到。
 * @param {string} absolute
 */
async function readDeclaredFile(absolute) {
  const info = await stat(absolute)
  if (!info.isFile()) return { text: null }
  const raw = await readFile(absolute)
  if (raw.includes(0)) return { text: null, binary: true }
  return { text: raw.toString('utf8') }
}

/** 一行里的标记是否位于注释中；不在注释里的只是普通字符串/代码，不能当标记。 */
function markerIndexInComment(line, index) {
  const prefix = line.slice(0, index)
  if (isStandaloneComment(prefix)) return true
  return commentCutIndex(prefix) >= 0
}

function isStandaloneComment(prefix) {
  const trimmed = String(prefix ?? '').trim()
  if (trimmed === '') return true
  return /^(?:\/\/+|#+|--+|\/\*+|\*+|;+|<!--)$/.test(trimmed)
}

/**
 * 行内最后一个注释起点；没有注释返回 null。
 *
 * 优先找**标记所在的那个块注释**（在 prefix 里开了、但还没闭合）。否则一个出现在
 * 块注释里的 `//`（例如 URL）会把"块注释"误判成行注释，截掉注释之后的代码。
 */
function lastCommentOpener(prefix) {
  const text = String(prefix ?? '')
  let block = null
  for (const match of text.matchAll(/\/\*|<!--/g)) {
    const close = match[0] === '/*' ? '*/' : '-->'
    if (!text.includes(close, match.index + match[0].length)) {
      block = { index: match.index, text: match[0] }
    }
  }
  if (block) {
    return {
      ...block,
      block: true,
      close: block.text === '/*' ? '*/' : '-->',
    }
  }
  let found = null
  for (const match of text.matchAll(/\/\/|#|--|;/g)) {
    found = { index: match.index, text: match[0] }
  }
  if (!found) return null
  return { ...found, block: false, close: null }
}

/** 行内最后一个注释起点的下标；没有注释返回 -1。 */
function commentCutIndex(prefix) {
  return lastCommentOpener(prefix)?.index ?? -1
}

/** 块边只对 block kind 有意义；`fix` / `change` 是行级标记。 */
function edgeOf(line, matchEnd, kind) {
  if (!BLOCK_KINDS.has(kind)) return null
  const edge = /\b(start|end)\b/i.exec(line.slice(matchEnd))
  return edge ? edge[1].toLowerCase() : null
}

/**
 * 抽出一段文本里的所有标记（只含注释里的那些）。
 *
 * `kind` 已归一化（`tmp` → `temp`），`rawKind` 保留原文供诊断；`hash` 缺失为 null。
 * @param {string} text
 * @returns {Array<{line: number, kind: string, rawKind: string|null, hash: string|null,
 *   edge: 'start'|'end'|null, indent: number, text: string,
 *   tokenStart: number, tokenEnd: number}>}
 */
export function findMarkers(text) {
  const out = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = MARKER_RE.exec(line)
    if (!match) continue
    if (!markerIndexInComment(line, match.index)) continue
    const rawKind = match[1] ? match[1].toLowerCase() : null
    const kind = rawKind === 'tmp' ? 'temp' : rawKind
    const matchEnd = match.index + match[0].length
    out.push({
      line: index + 1,
      kind: kind ?? '',
      rawKind,
      hash: match[2] ? match[2].toLowerCase() : null,
      edge: edgeOf(line, matchEnd, kind),
      indent: (line.match(/^[ \t]*/) ?? [''])[0].length,
      text: line,
      tokenStart: match.index,
      tokenEnd: matchEnd,
    })
  }
  return out
}

/** 注释里的宽松标记行（没有严格 kind/hash 的 `dsh-debug...` 注释），收尾时一并清掉。 */
function findLooseMarkerLines(text) {
  const out = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const loose = LOOSE_MARKER_RE.exec(line)
    if (!loose) continue
    if (MARKER_RE.exec(line)) continue
    if (!markerIndexInComment(line, loose.index)) continue
    // 只认"整行就是 marker"的注释；`// dsh debug output` 这类普通说明不是标记。
    if (!isBareMarkerComment(line)) continue
    out.push({ line: index + 1, text: line, tokenStart: loose.index })
  }
  return out
}

/** 去掉注释壳之后只剩 `dsh-debug` / `dsh_debug` / `dsh debug`（可带一个分隔符）。 */
function isBareMarkerComment(line) {
  const body = String(line)
    .trim()
    .replace(/^(?:\/\/+|#+|--+|\/\*+|\*+|;+|<!--)\s*/, '')
    .replace(/\s*(?:\*\/|-->)\s*$/, '')
  return /^dsh[\s\-_]*debug\s*[:\-]?$/i.test(body)
}

/**
 * 栈式配对：只返回能证明的区间，任何歧义都进 `unresolved`。
 *
 * 一条 `end` 能闭合的条件：栈顶 kind 相同、hash 相同、缩进相同、两者之间没有其他标记行。
 * 任一不满足即作废该区间。
 *
 * @param {ReturnType<typeof findMarkers>} markers
 * @returns {{ blocks: Array<{kind: string, hash: string|null, startLine: number, endLine: number, indent: number}>, unresolved: Array<{line: number, reason: string, text: string}> }}
 */
export function pairBlocks(markers) {
  const blocks = []
  const unresolved = []
  const stack = []
  for (const marker of markers) {
    if (marker.edge === null) {
      // 块 kind 带着 hash 却没有 start/end：可能是 Agent 漏写了边，块体还在。
      // 没有 hash 的 `dsh-debug:tmp` 只是垃圾注释，交给行级清理。
      if (BLOCK_KINDS.has(marker.kind) && marker.hash !== null) {
        unresolved.push({ line: marker.line, reason: '标记缺少 start/end（格式残缺）', text: marker.text })
      }
      continue
    }
    if (marker.edge === 'start') {
      stack.push(marker)
      continue
    }
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
  }
  for (const open of stack) {
    unresolved.push({ line: open.line, reason: 'start 没有配对的 end', text: open.text })
  }
  return { blocks, unresolved }
}

/**
 * 从一段文本里摘除本任务的 `probe` / `temp` 块（保留所有行级标记）。
 *
 * 这是自检脚本使用的窄口径；收尾用 `removeMarkers()`，它会连 `fix` / `change`
 * 与无哈希垃圾注释一起清掉。
 *
 * @param {string} text
 * @param {string} hash
 */
export function removeBlocks(text, hash) {
  return removeInternal(text, hash, { lineMarkers: false })
}

/**
 * 收尾清理：摘除本任务的 `probe` / `temp` 块，并把所有行级标记与无哈希垃圾注释
 * 从注释里去掉。`fix` / `change` 标注的代码原样保留——只删标记本身。
 *
 * 别的任务哈希、或配对有歧义的块不会在这里被动到：它们由调用方送进隔离区。
 *
 * @param {string} text
 * @param {string} hash
 * @returns {{ text: string, removed: Array<{kind: string, startLine: number, endLine: number}>,
 *   removedLines: string[], collapsedBlankLines: number,
 *   unresolved: Array<{line: number, reason: string, text: string}> }}
 */
export function removeMarkers(text, hash) {
  return removeInternal(text, hash, { lineMarkers: true })
}

function removeInternal(text, hash, options) {
  const source = String(text)
  const lines = source.split(/\r?\n/)
  // 保留原文件的换行风格：收尾不该顺带把 CRLF 全改成 LF（那本身就是一道可见的 diff）。
  const eol = source.match(/\r?\n/)?.[0] ?? '\n'
  const target = String(hash ?? '').toLowerCase()
  const markers = findMarkers(source)
  const { blocks, unresolved } = pairBlocks(markers)

  // 别的任务的块与配对歧义的行都受保护：清理行级注释时不许把它们拆成半块。
  const protectedLines = new Set()
  for (const block of blocks) {
    if (block.hash === target) continue
    for (let line = block.startLine; line <= block.endLine; line += 1) protectedLines.add(line)
  }
  for (const entry of unresolved) protectedLines.add(entry.line)

  const drop = new Set()
  const replace = new Map()
  const removed = []
  const removedLines = []
  const seams = []

  // ① 本任务的块：整块摘除（标记 + 块内探针代码）。
  for (const block of blocks) {
    if (block.hash !== target) continue
    if (!BLOCK_KINDS.has(block.kind)) continue
    const startLine = lines[block.startLine - 1] ?? ''
    const token = LOOSE_MARKER_RE.exec(startLine)
    const prefix = token ? startLine.slice(0, token.index) : startLine
    if (prefix.trim() !== '' && !isStandaloneComment(prefix)) {
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

  // ② 行级标记与无哈希垃圾注释：只删注释，代码留下。
  if (options.lineMarkers) {
    const handled = new Set()
    for (const marker of markers) {
      if (marker.edge) continue
      if (drop.has(marker.line) || protectedLines.has(marker.line)) continue
      const line = lines[marker.line - 1] ?? ''
      const stripped = stripCommentMarker(line, marker.tokenStart)
      handled.add(marker.line)
      if (stripped === null) {
        drop.add(marker.line)
        seams.push({ before: marker.line - 1, after: marker.line + 1 })
        removed.push({ kind: marker.kind || 'marker', startLine: marker.line, endLine: marker.line })
      } else if (stripped !== line) {
        replace.set(marker.line, stripped)
        removed.push({ kind: marker.kind || 'marker', startLine: marker.line, endLine: marker.line })
      }
    }
    for (const loose of findLooseMarkerLines(source)) {
      if (handled.has(loose.line) || drop.has(loose.line) || protectedLines.has(loose.line)) continue
      const line = lines[loose.line - 1] ?? ''
      const stripped = stripCommentMarker(line, loose.tokenStart)
      if (stripped === null) {
        drop.add(loose.line)
        seams.push({ before: loose.line - 1, after: loose.line + 1 })
        removed.push({ kind: 'marker', startLine: loose.line, endLine: loose.line })
      } else if (stripped !== line) {
        replace.set(loose.line, stripped)
        removed.push({ kind: 'marker', startLine: loose.line, endLine: loose.line })
      }
    }
  }

  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1
    if (drop.has(lineNo)) continue
    kept.push(replace.has(lineNo) ? replace.get(lineNo) : lines[index])
  }
  const { text: collapsed, collapsedBlankLines } = collapseSeamBlanks(kept, seams, lines, drop, eol)
  return { text: collapsed, removed, removedLines, collapsedBlankLines, unresolved }
}

/**
 * 把一行里的标记注释去掉：整行只有注释时返回 null（整行删掉），行尾注释只截掉注释部分。
 *
 * 行注释（`//` / `#` / `--` / `;`）切到行尾；块注释（`/* … *\/` / `<!-- … -->`）
 * 只删注释区间，**保留它后面的代码**。找不到注释起点时原样返回——代码里的
 * `dsh-debug` 字符串不是标记。
 */
function stripCommentMarker(line, tokenStart) {
  const prefix = String(line).slice(0, tokenStart)
  const standalone = isStandaloneComment(prefix)
  const opener = lastCommentOpener(prefix)
  if (!opener) return standalone ? null : line
  if (opener.block) {
    const close = line.indexOf(opener.close, tokenStart)
    if (close === -1) {
      const kept = line.slice(0, opener.index).replace(/[ \t]+$/, '')
      return kept.trim() === '' ? null : kept
    }
    const after = line.slice(close + opener.close.length)
    if (standalone && after.trim() === '') return null
    const merged = `${line.slice(0, opener.index)}${after}`
    return merged.trim() === '' ? null : merged
  }
  if (standalone) return null
  const kept = line.slice(0, opener.index).replace(/[ \t]+$/, '')
  return kept.trim() === '' ? null : kept
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
function collapseSeamBlanks(kept, seams, original, drop, eol = '\n') {
  if (seams.length === 0) return { text: kept.join(eol), collapsedBlankLines: 0 }
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
  return { text: out.join(eol), collapsedBlankLines }
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
 * **这是分类口径的唯一实现**：`scanPaths()` 对每个声明文件都走它。
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
  const looseLines = findLooseMarkerLines(text)
  const changeMarkers = markers
    .filter((marker) => marker.kind === 'change' && (marker.hash === null || marker.hash === targetHash))
    .map((marker) => ({ line: marker.line, hash: marker.hash, text: marker.text }))
  const foreignHashes = [...new Set(markers
    .filter((marker) => marker.hash !== null && !known.has(marker.hash))
    // 行级标记（fix/change/垃圾注释）可以安全地只删注释，不因陌生 hash 卡住收尾；
    // 只有带 start/end 的块才需要用户决定归属。
    .filter((marker) => marker.edge !== null)
    .map((marker) => marker.hash))]

  // 别的任务（或配对歧义）的块会原样保留，块内的行级注释不算本次残留。
  const protectedLines = new Set()
  for (const block of blocks) {
    if (block.hash === targetHash) continue
    for (let line = block.startLine; line <= block.endLine; line += 1) protectedLines.add(line)
  }
  for (const entry of unresolved) protectedLines.add(entry.line)

  return {
    path: relPath,
    markers,
    blocks,
    unresolved,
    changeMarkers,
    foreignHashes,
    stubRefs: [...new Set(stubRefs)],
    hasTargetBlocks: blocks.some((block) => block.hash === targetHash
      && BLOCK_KINDS.has(block.kind)),
    hasTargetMarkers: markers.some((marker) => marker.hash === targetHash),
    // 无 hash 的裸注释、`dsh-debug:tmp` 这类行级垃圾：收尾会删，复扫据此判断干净。
    hasJunkMarkers: looseLines.some((entry) => !protectedLines.has(entry.line))
      || markers.some((marker) => marker.edge === null && marker.hash === null
        && !protectedLines.has(marker.line)),
  }
}

/**
 * 只扫**给定的一组文件**（Agent 账本 + git 改动文件），没有任何遍历与目录跳过。
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
      const read = await readDeclaredFile(absolute)
      if (read.text === null) {
        // 二进制不是"读不到"：它不可能承载标记，静默跳过即可。
        if (!read.binary) unreadable.push({ path: relPath, error: '不是普通文件' })
        continue
      }
      text = read.text
    } catch (error) {
      // 声明过的文件读不到 === 这次收尾**无法证明**它干净。必须上报，不能静默跳过。
      unreadable.push({ path: relPath, error: String(error?.message ?? error) })
      continue
    }
    scanned += 1
    const classified = classifyFile(relPath, text, options)
    if (classified) affected.push(classified)
  }
  return { affected, scanned, unreadable }
}

/**
 * 扫描声明清单并汇总成收尾需要的几本账。
 *
 * `complete` 只表示"清单里的文件都读到了"；它**不**表示全仓没有残留——那是本次
 * 设计刻意不再做的事（全仓遍历在超大仓库上不可接受）。
 *
 * @param {string} root
 * @param {string[]} paths
 * @param {{ hash: string, knownHashes?: string[], signal?: AbortSignal }} options
 */
export async function scanDeclared(root, paths, options) {
  const declared = await scanPaths(root, paths, options)
  const targetHash = String(options.hash ?? '').toLowerCase()
  const affected = [...declared.affected].sort((left, right) => left.path.localeCompare(right.path))
  const stale = affected.filter((file) => file.foreignHashes.length > 0
    || file.unresolved.length > 0
    || file.markers.some((marker) => marker.edge !== null && marker.hash === null))

  return {
    scanned: declared.scanned,
    unreadable: declared.unreadable,
    affected,
    complete: declared.unreadable.length === 0,
    targetFiles: affected.filter((file) => file.hasTargetBlocks).map((file) => file.path),
    // 复扫用：本任务标记或任何垃圾注释还在就算不干净。
    markerFiles: affected.filter((file) => file.hasTargetMarkers || file.hasJunkMarkers).map((file) => file.path),
    fixFiles: [...new Set(affected
      .filter((file) => file.markers.some((marker) => marker.kind === 'fix' && marker.hash === targetHash))
      .map((file) => file.path))],
    stubRefFiles: affected.filter((file) => file.stubRefs.length > 0).map((file) => file.path),
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
      if (marker.hash !== null || marker.edge === null) continue
      reasons.push('标记缺少 hash（格式残缺）')
      if (line === null) line = marker.line
      if (text === null) text = marker.text
    }
    for (const hash of file.foreignHashes) {
      reasons.push(`hash ${hash} 不属于任何已知任务`)
      const block = file.blocks.find((item) => item.hash === hash)
      const marker = block
        ? file.markers.find((item) => item.line === block.startLine)
        : file.markers.find((item) => item.hash === hash)
      if (line === null) line = block?.startLine ?? marker?.line ?? null
      if (text === null) text = marker?.text ?? null
    }
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
 * 把"要摘除哪些块的哪些行"算出来，并顺带做标识符反查。
 *
 * `files` 默认取 `scan.affected`；摘除计划只由这份列表决定，不做二次遍历。
 *
 * @param {string} root
 * @param {object} scan `scanDeclared` 的返回值
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
    const result = removeMarkers(text, hash)
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
        backup: toPosixRelative(root, backup),
      })
    } catch (error) {
      failed.push({ path: plan.path, error: String(error?.message ?? error) })
    }
  }
  return { cleaned, failed }
}

/** 规范化为 POSIX 相对路径（备份路径写进 journal 用）。 */
function toPosixRelative(root, absolute) {
  return relative(root, absolute).split(sep).join(posix.sep)
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
