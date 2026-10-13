//  CHANGELOG.md 变更记录（版本号纪律见 AGENTS.md §4.6）是**契约产物**：
// 每次改协议/状态机都要在这里留一行。而这一节自己出过两次错，都瞒过了一轮：
//   ① 日期沿用了相邻行的错误值（2026-02-19，而真实是 2026-10-11）；
//   ② **两行根本没写**——我用 `String.Replace` 拿"要写的那一行"当锚点，
//      锚点不存在时它是**静默 no-op**，于是版本号从 0.11 直接跳到 0.18。
//   ③ 那两行真正的形态更阴：换行被写成了字面量 `n，两行整段躺在 v0.14 的正文里，
//      而 `^\| 0\.\d+ \|` 这类锚定行首的检查完全看不见它们。
// 所以这里把它当数据来验：连续、无重复、表头与最新一行一致、日期合法且不倒流、
// 一行只能有一个版本行标记；另外它还要与 package.json 的 version 对齐（AGENTS.md §4.6）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

async function readChangelog() {
  const text = await readFile(join(REPO, 'CHANGELOG.md'), 'utf8')
  const rows = []
  for (const [index, line] of text.split('\n').entries()) {
    const match = line.match(/^\| (0\.\d+) \| (\d{4}-\d{2}-\d{2}) \| (.*)$/)
    if (match) rows.push({ version: match[1], date: match[2], body: match[3], line: index + 1 })
  }
  const header = text.match(/最新版本：v(0\.\d+)/)?.[1] ?? null
  return { rows, header }
}

test(' 变更记录：版本号连续无缺口（"改了版本号却没写记录"必须被抓住）', async () => {
  const { rows } = await readChangelog()
  assert.ok(rows.length >= 10, `只解析到 ${rows.length} 行，格式或位置不对`)

  const numbers = rows.map((row) => Number(row.version.split('.')[1])).sort((a, b) => a - b)
  assert.equal(new Set(numbers).size, numbers.length, `版本号有重复：${numbers.join(',')}`)
  assert.equal(numbers[0], 1, `最老的记录应是 0.1，实际 0.${numbers[0]}`)

  // 逐个查缺口 —— 这条就是为 v0.12/v0.13 那次遗漏写的。
  const missing = []
  for (let n = 1; n <= numbers[numbers.length - 1]; n += 1) {
    if (!numbers.includes(n)) missing.push(`0.${n}`)
  }
  assert.deepEqual(missing, [], ` 缺这些版本的行：${missing.join('、')}（改了版本号就必须留一行）`)
})

test(' 变更记录：没有"被粘在别人行里"的版本行（一行只能有一个版本行标记）', async () => {
  // 实测事故：两条记录被写成了**字面量 `n**（反引号 + n）而不是真换行，于是它们
  // 整段躺在 v0.14 那一行的正文里——`^\| 0\.\d+ \|` 这类锚定行首的检查**完全看不见它们**，
  // 表面上"版本连续"，实际那两版从来没成为表格行。所以这里数的是**每行有几个**版本行标记。
  const text = await readFile(join(REPO, 'CHANGELOG.md'), 'utf8')
  const offenders = []
  for (const [index, line] of text.split('\n').entries()) {
    const markers = line.match(/\| 0\.\d+ \|/g) ?? []
    if (markers.length > 1) offenders.push(`第 ${index + 1} 行有 ${markers.length} 个：${markers.join(' ')}`)
    if (line.includes('`n| 0.')) offenders.push(`第 ${index + 1} 行出现字面量 \`n 紧接版本行标记`)
  }
  assert.deepEqual(offenders, [], `版本行被粘住了：\n${offenders.join('\n')}`)
})

test(' 变更记录：表头到表尾之间不许夹非表格行（否则中间的行不会被当成记录）', async () => {
  const text = await readFile(join(REPO, 'CHANGELOG.md'), 'utf8')
  const lines = text.split('\n')
  const first = lines.findIndex((line) => /^\| 0\.\d+ \| \d{4}-\d{2}-\d{2} \|/.test(line))
  const last = lines.map((line) => /^\| 0\.\d+ \| \d{4}-\d{2}-\d{2} \|/.test(line)).lastIndexOf(true)
  assert.ok(first >= 0 && last > first, '没找到 CHANGELOG.md 的版本行区间')
  for (let index = first; index <= last; index += 1) {
    assert.ok(lines[index].startsWith('|'), `第 ${index + 1} 行夹在版本行之间却不是表格行：${lines[index].slice(0, 60)}`)
  }
})

test(' 表头的版本号 == 表里最新那一行（否则表头是空头支票）', async () => {
  const { rows, header } = await readChangelog()
  assert.ok(header, '没找到「最新版本：vX.Y」表头')
  const newest = rows
    .map((row) => row.version)
    .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
    .pop()
  assert.equal(header, newest, `表头写的是 v${header}，最后一行却是 v${newest}`)
})

test(' 日期：合法、不在未来、新旧不倒流（按表内顺序：新→旧）', async () => {
  const { rows } = await readChangelog()
  const today = new Date()
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  let previous = null
  for (const row of rows) {
    // 合法日期：`2026-02-31` 这种能被 Date 悄悄挪到 3 月，所以回读一遍比对。
    const parsed = new Date(`${row.date}T00:00:00`)
    const roundTrip = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
    assert.equal(roundTrip, row.date, `第 ${row.line} 行的日期不合法：${row.date}`)

    // 未来日期一定是写错了（实测踩过：把 10-11 写成 02-19 是过去，但反过来的错也存在）。
    assert.ok(row.date <= todayText, `第 ${row.line} 行的日期在未来：${row.date} > 今天 ${todayText}`)

    // 表是"新→旧"，所以日期应当单调不增。
    if (previous !== null) {
      assert.ok(row.date <= previous.date, `第 ${row.line} 行日期倒流：${row.date} 晚于上一行 ${previous.date}`)
    }
    previous = row
  }
})

test(' 每一行都有实质内容（不是占位符）', async () => {
  const { rows } = await readChangelog()
  for (const row of rows) {
    assert.ok(row.body.length >= 20, `第 ${row.line} 行（v${row.version}）太短，像是占位：${row.body}`)
  }
})

test(' 版本号纪律：package.json 的 version == 表头版本 + ".0"（只改一处必红）', async () => {
  // AGENTS.md §4.6：版本号只有一处权威（CHANGELOG.md 顶部的 `最新版本：vX.Y`），
  // 它必须同时等于表里最新那一行与 package.json 的 version（写作 X.Y.0）。
  const { header } = await readChangelog()
  assert.ok(header, '没找到「最新版本：vX.Y」表头，无法与 package.json 对账')
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  assert.equal(pkg.version, `${header}.0`, `package.json 的 version 是 ${pkg.version}，表头是 v${header}，应写作 ${header}.0`)
})
