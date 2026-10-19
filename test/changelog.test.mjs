//  CHANGELOG.md 是**面向使用者的发布日志**，格式遵循 Keep a Changelog：
// 版本化的小节（`## [x.y] - YYYY-MM-DD`）+ 分类条目（新增/变更/移除/修复/安全）。
// 这里把它当数据来验，钉住四件事：版本连续、新版本在前、日期合法且不倒流、
// 以及每条记录足够短——超过约两行的条目通常在写实现细节，那属于代码注释。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Keep a Changelog 定义的分类；每条记录必须落在其中之一。 */
const SECTION_TYPES = new Set(['新增', '变更', '弃用', '移除', '修复', '安全'])

/** 单条记录的长度上限（字符）。上限的意义是"一句话说清改了什么"。 */
const MAX_ENTRY_CHARS = 120

/** 老小节写 `x.y`（等价于 `x.y.0`），补丁发版写 `x.y.z`。 */
function normalizeVersion(text) {
  return text.split('.').length === 2 ? `${text}.0` : text
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

async function readChangelog() {
  const text = await readFile(join(REPO, 'CHANGELOG.md'), 'utf8')
  const releases = []
  const entries = []
  let current = null
  let section = null
  for (const [index, line] of text.split('\n').entries()) {
    const heading = line.match(/^## \[(\d+\.\d+(?:\.\d+)?)\] - (\d{4}-\d{2}-\d{2})$/)
    if (heading) {
      current = { version: heading[1], date: heading[2], line: index + 1, sections: [] }
      releases.push(current)
      section = null
      continue
    }
    const sectionHeading = line.match(/^### (.+)$/)
    if (sectionHeading) {
      section = sectionHeading[1].trim()
      if (current) current.sections.push(section)
      continue
    }
    const bullet = line.match(/^- (.+)$/)
    if (bullet) {
      entries.push({ version: current?.version ?? null, section, body: bullet[1], line: index + 1 })
    }
  }
  return { text, releases, entries }
}

test(' 更新日志：每个版本一个二级标题，版本号连续且新版本在前', async () => {
  const { releases } = await readChangelog()
  assert.ok(releases.length >= 20, `只解析到 ${releases.length} 个版本，格式或位置不对`)

  const versions = releases.map((release) => normalizeVersion(release.version))
  assert.equal(new Set(versions).size, versions.length, `版本号有重复：${versions.join(',')}`)
  const descending = versions.slice().sort(compareVersions).reverse()
  assert.deepEqual(versions, descending, `版本必须严格从新到旧排列：${versions.join(',')}`)

  const minors = releases.map((release) => Number(release.version.split('.')[1]))
  const missing = []
  for (let n = 1; n <= Math.max(...minors); n += 1) {
    if (!minors.includes(n)) missing.push(`0.${n}`)
  }
  assert.deepEqual(missing, [], `缺这些版本的小节：${missing.join('、')}`)
})

test(' 更新日志：日期合法、不在未来、按版本顺序不倒流', async () => {
  const { releases } = await readChangelog()
  const today = new Date()
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  let previous = null
  for (const release of releases) {
    // `2026-02-31` 会被 Date 悄悄挪到 3 月，所以回读一遍比对。
    const parsed = new Date(`${release.date}T00:00:00`)
    const roundTrip = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
    assert.equal(roundTrip, release.date, `第 ${release.line} 行的日期不合法：${release.date}`)
    assert.ok(release.date <= todayText, `第 ${release.line} 行的日期在未来：${release.date}`)
    if (previous !== null) {
      assert.ok(release.date <= previous, `第 ${release.line} 行日期倒流：${release.date} 晚于上一版本 ${previous}`)
    }
    previous = release.date
  }
})

test(' 更新日志：每个版本都有条目，且只用 Keep a Changelog 的分类', async () => {
  const { releases, entries } = await readChangelog()
  for (const release of releases) {
    assert.ok(release.sections.length > 0, `v${release.version} 没有任何分类小节`)
    for (const section of release.sections) {
      assert.ok(SECTION_TYPES.has(section), `v${release.version} 用了未知分类「${section}」`)
    }
  }
  for (const entry of entries) {
    assert.ok(entry.version, `第 ${entry.line} 行的条目不属于任何版本`)
    assert.ok(entry.section, `第 ${entry.line} 行的条目不属于任何分类`)
  }
})

test(' 更新日志：条目只说改了什么，不写实现细节（有长度上限）', async () => {
  const { entries } = await readChangelog()
  const tooLong = entries
    .filter((entry) => entry.body.length > MAX_ENTRY_CHARS)
    .map((entry) => `第 ${entry.line} 行（v${entry.version}）${entry.body.length} 字符：${entry.body.slice(0, 40)}…`)
  assert.deepEqual(tooLong, [],
    `以下条目超过 ${MAX_ENTRY_CHARS} 字符，应压成一句话；实现细节属于代码注释与提交信息：\n${tooLong.join('\n')}`)
})

test(' 更新日志：不出现只有维护者能看懂的引用', async () => {
  const { entries } = await readChangelog()
  // `§` 指向已删除的设计稿、`lib/xxx.js` 是内部路径、`v0.x` 是自指版本号——
  // 使用者读发布日志时都不需要它们，出现即说明这条在写实现而不是写变更。
  const banned = /\u00a7|lib\/|test\/|scripts\/|assets\/|src\/|v0\.\d+/
  const offenders = entries
    .filter((entry) => banned.test(entry.body))
    .map((entry) => `第 ${entry.line} 行：${entry.body.slice(0, 60)}`)
  assert.deepEqual(offenders, [],
    `以下条目引用了内部路径、章节号或旧版本号：\n${offenders.join('\n')}`)
})

test(' 版本号纪律：package.json 的 version == 最新小节版本', async () => {
  const { releases } = await readChangelog()
  assert.ok(releases.length > 0, '没找到任何版本小节，无法与 package.json 对账')
  const newest = normalizeVersion(releases[0].version)
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  assert.equal(pkg.version, newest,
    `package.json 的 version 是 ${pkg.version}，最新小节是 ${releases[0].version}，应写作 ${newest}`)
})
