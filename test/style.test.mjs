/**
 * test/style.test.mjs —— 文本风格守卫：仓库里任何文本文件都不带 emoji。
 *
 * 为什么值得一条独立的测试：终端 / 编辑器 / CI 的编码与字形回退各不相同，emoji 在其中
 * 任何一环都可能变成乱码，甚至只剩半个代理对（复制、截断、换行各拆一次就够了）。排查一次
 * 乱码的代价远大于 emoji 换来的那点辨识度，所以纪律写死成"零 emoji"，并在这里机械地钉住：
 * 只要有一个字符落进禁用范围，就按"文件:行号 + 码点"报出来，便于机械修。
 *
 * 需要 4 字节 UTF-8 夹具时写 `String.fromCodePoint(0x1F600)`，不要写字面量——**这个文件自己
 * 也不许含任何字面 emoji**，所以下面所有禁用字符都写成转义序列。非 emoji 的排版字符
 * （`→` `▸` `·` `—` `≤` `…` 与中文标点）不在禁用范围内，它们到处都能正常渲染。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根：本文件住在 test/ 下，所以上一级就是根（不读 cwd —— 测试可能从任何目录跑）。 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 遍历时跳过的目录：版本库元数据与依赖都不属于"我们的文本"。 */
const SKIP_DIRS = new Set(['.git', 'node_modules'])

/**
 * 禁用字符的判定范围。分两条写，因为**代理对**必须按 UTF-16 码元匹配：
 * 一旦加上 `u` 标志，字符串里的代理对被当成一个码点，`[\uD83C]` 就再也匹配不到它的首元，
 * U+1F000–U+1FAFF 这一片会整个漏掉。
 */
const BANNED_PATTERNS = [
  /[\u2600-\u27BF\u2B00-\u2BFF\uFE0F]/g, // 杂项符号 / 装饰符号 / 变体选择符 FE0F
  /[\uD83C\uD83D\uD83E][\uDC00-\uDFFF]/g, // U+1F000–U+1FAFF（4 字节 UTF-8 的代理对形态）
]

/** 递归收集仓库里的文件（SKIP_DIRS 直接跳过；读不到的目录当作空，不因此变红）。 */
async function collectFiles(dir) {
  const found = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found // 权限 / 竞态删除 / 断链：风格守卫只对能读到的文本负责
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      found.push(...await collectFiles(absolute))
      continue
    }
    if (entry.isFile()) found.push(absolute)
  }
  return found
}

/** 逐行找出所有禁用字符，给出 1-based 行号与码点（一次报全，便于机械修）。 */
function findBannedCharacters(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of BANNED_PATTERNS) {
      for (const match of lines[index].matchAll(pattern)) {
        const code = match[0].codePointAt(0)
        hits.push({ line: index + 1, label: `U+${code.toString(16).toUpperCase().padStart(4, '0')}` })
      }
    }
  }
  return hits.sort((left, right) => left.line - right.line)
}

test('文本风格：仓库里任何文本文件都不带 emoji', async () => {
  const files = await collectFiles(REPO)
  const offenders = []
  let scanned = 0

  for (const absolute of files) {
    let buffer
    try {
      buffer = await readFile(absolute)
    } catch {
      continue // 读不到就跳过：守卫不该因为一个不可读文件把整轮判红
    }
    if (buffer.includes(0)) continue // 含 NUL 字节 = 二进制，不按文本判定
    scanned += 1
    const relPath = relative(REPO, absolute).split(sep).join('/')
    for (const hit of findBannedCharacters(buffer.toString('utf8'))) {
      offenders.push(`${relPath}:${hit.line} 出现 emoji ${hit.label}`)
    }
  }

  // 防假绿：遍历写坏（根目录找错、SKIP_DIRS 误伤、readdir 全失败）时 offenders 必然是空的，
  // 下面那条断言会"通过"——而它其实什么都没扫。本仓库的文本文件远不止 20 个。
  assert.ok(scanned > 20, `只扫到 ${scanned} 个文本文件（仓库根 ${REPO}）：遍历或根目录不对`)

  // 一次列出全部命中：逐条报错会逼人"修一个跑一次"，机械修需要一次看全。
  assert.deepEqual(offenders, [],
    `以下位置出现禁用字符（改成 ASCII 标记，如 [!] / [ok] / [x]）：\n${offenders.join('\n')}`)
})
