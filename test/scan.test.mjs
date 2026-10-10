/**
 * test/scan.test.mjs —— 防堆屎山那两台机器的守卫测试（DESIGN.md §16.3 R1/R2/R3）。
 *
 * 这里的每一条断言都对应一个**会造成不可逆损失**的具体错误：
 *   · 误删用户代码（所以配对歧义必须进 unresolved，而不是"大概是这样"）；
 *   · 误保临时改动（所以无标记的探针不能被当成"没有"）；
 *   · 静默失效（所以截断必须能被调用方看见）。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  applyCleanup,
  diffIndex,
  findChangeMarkers,
  indexWorkspace,
  introducedIdentifiers,
  pairBlocks,
  findMarkers,
  planCleanup,
  removeBlocks,
  scanResidue,
  verifySyntax,
} from '../lib/scan.js'
import { createWorkspace, probeBlock } from './helpers.mjs'

const HASH = 'deadbeef'
const OTHER = 'cafebabe'

test('removeBlocks 摘除本任务的 probe/temp 块，保留 fix 与用户代码', () => {
  const source = [
    'const a = 1',
    probeBlock(HASH, "probe('a', { a })"),
    'const b = 2',
    `// dsh-debug:fix ${HASH} 保留：这是修复`,
    'const c = 3',
    `// dsh-debug:temp ${HASH} start`,
    'const tmp = 4',
    `// dsh-debug:temp ${HASH} end`,
    'export default a + b + c',
  ].join('\n')

  const result = removeBlocks(source, HASH)
  assert.equal(result.removed.length, 2, 'probe 与 temp 都要摘')
  assert.deepEqual(result.removed.map((item) => item.kind), ['probe', 'temp'])
  assert.ok(!result.text.includes('dsh-debug:probe'), '探针块必须摘干净')
  assert.ok(!result.text.includes('const tmp = 4'), 'temp 块必须摘掉')
  assert.ok(result.text.includes('dsh-debug:fix'), 'fix 标记必须保留（那是用户的修复）')
  assert.ok(result.text.includes('const a = 1') && result.text.includes('const b = 2'))
  assert.deepEqual(result.unresolved, [])
})

test('removeBlocks 不碰别的任务哈希', () => {
  const source = [probeBlock(OTHER, "probe('x')"), 'const keep = 1'].join('\n')
  const result = removeBlocks(source, HASH)
  assert.deepEqual(result.removed, [])
  assert.equal(result.text, source)
})

test('配对歧义一律进 unresolved：缩进不一致 / 嵌套 / 缺 end / 同行标记', () => {
  const mismatchedIndent = [
    `// dsh-debug:probe ${HASH} start`,
    '  const a = 1',
    `  // dsh-debug:probe ${HASH} end`,
  ].join('\n')
  assert.ok(removeBlocks(mismatchedIndent, HASH).unresolved.length > 0,
    '缩进不一致说明配对不可判定，必须拒绝而不是猜')

  const nested = [
    `// dsh-debug:probe ${HASH} start`,
    `// dsh-debug:probe ${OTHER} start`,
    `// dsh-debug:probe ${OTHER} end`,
    `// dsh-debug:probe ${HASH} end`,
  ].join('\n')
  const nestedResult = removeBlocks(nested, HASH)
  assert.deepEqual(nestedResult.removed, [], '块内有别的标记行 ⇒ 不自动删')
  assert.ok(nestedResult.unresolved.length > 0)

  const danglingStart = [`// dsh-debug:probe ${HASH} start`, 'const a = 1'].join('\n')
  assert.equal(removeBlocks(danglingStart, HASH).removed.length, 0)
  assert.match(removeBlocks(danglingStart, HASH).unresolved[0].reason, /没有配对的 end/)

  const inline = `doThing(); // dsh-debug:probe ${HASH} start\n// dsh-debug:probe ${HASH} end`
  const inlineResult = removeBlocks(inline, HASH)
  assert.deepEqual(inlineResult.removed, [], '标记与代码同行时不能整块删（会删掉 doThing()）')
  assert.ok(inlineResult.unresolved.some((entry) => /同行/.test(entry.reason)))
})

test('pairBlocks 只在 start/end 的 kind、hash、缩进全一致时成交', () => {
  const text = [
    `// dsh-debug:probe ${HASH} start`,
    `// dsh-debug:probe ${HASH} end`,
    `// dsh-debug:temp ${HASH} start`,
    `// dsh-debug:fix ${HASH} end`,
  ].join('\n')
  const { blocks, unresolved } = pairBlocks(findMarkers(text))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'probe')
  assert.equal(unresolved.length, 2, 'kind 不匹配的那对必须报出来')
})

test('introducedIdentifiers 提取块里新引入的名字，并跳过桩自带的公开名', () => {
  const names = introducedIdentifiers([
    "import { probe, probeScope } from 'file:///x/probe.mjs'",
    "import { makeProbe } from './helper.mjs'",
    'const localHelper = 1',
  ])
  assert.ok(names.includes('makeProbe'), '自定义 helper 必须被抓到（那是最毒的残留形态）')
  assert.ok(names.includes('localHelper'))
  assert.ok(!names.includes('probe') && !names.includes('probeScope'))
})

test('findChangeMarkers 只认 change，不认 probe', () => {
  const text = [
    `// dsh-debug:probe ${HASH} start`,
    `// dsh-debug:change ${HASH} 修复：空数组`,
    'const a = 1',
  ].join('\n')
  const marks = findChangeMarkers(text)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].hash, HASH)
})

test('diffIndex 报新增/修改/删除，且以内容哈希为准而不是 mtime', () => {
  const before = { 'a.js': { size: 1, mtimeMs: 1, hash: 'h1' }, 'b.js': { size: 1, mtimeMs: 1, hash: 'h2' } }
  const after = { 'a.js': { size: 1, mtimeMs: 2, hash: 'h1' }, 'c.js': { size: 1, mtimeMs: 3, hash: 'h3' } }
  assert.deepEqual(diffIndex(before, after), { added: ['c.js'], changed: [], removed: ['b.js'] })
})

test('indexWorkspace 排除 .dsh/node_modules/.git，并返回截断标记而不是静默', async () => {
  const workspace = await createWorkspace({
    'src/app.js': 'export const a = 1\n',
    '.dsh/debug-mode/tasks/x/state.json': '{}',
    'node_modules/pkg/index.js': 'module.exports = 1\n',
    '.git/config': '[core]\n',
  })
  try {
    const index = await indexWorkspace(workspace.root)
    assert.deepEqual(Object.keys(index.entries), ['src/app.js'])
    assert.equal(index.truncated, false)
    assert.equal(index.error, null)

    const limited = await indexWorkspace(workspace.root, { maxFiles: 0 })
    assert.equal(limited.truncated, true, '截断必须能被调用方看见（§16.3.0 第 2 条）')
  } finally {
    await workspace.cleanup()
  }
})

test('scanResidue：宽松发现、严格分类、hash 不属于任何已知任务 ⇒ 进隔离区', async () => {
  const workspace = await createWorkspace({
    'src/own.js': `const a = 1\n${probeBlock(HASH, "probe('own')")}\nexport default a\n`,
    'src/stub-ref.js': "import { probe } from './.dsh/debug-mode/tasks/" + HASH + "/runtime/probe.mjs'\n",
    'src/foreign.js': `// dsh_debug:probe ${OTHER} start\nconst x = 1\n// dsh_debug:probe ${OTHER} end\n`,
    'src/broken.js': `// dsh-debug:probe not-a-hash start\nconst y = 1\n`,
    'src/clean.js': 'export const clean = true\n',
  })
  try {
    const scan = await scanResidue(workspace.root, { hash: HASH, knownHashes: [HASH] })
    assert.deepEqual(scan.targetFiles, ['src/own.js'])
    assert.deepEqual(scan.stubRefFiles, ['src/stub-ref.js'])
    assert.ok(scan.quarantine.some((entry) => entry.path === 'src/foreign.js' && entry.hash === OTHER),
      '别的 hash 属于"不属于任何已知任务"，必须进隔离区')
    assert.ok(scan.quarantine.some((entry) => entry.path === 'src/broken.js'),
      '格式残缺也必须进隔离区（下划线写法是真实现场）')
    assert.ok(!scan.affected.some((entry) => entry.path === 'src/clean.js'), '完全无标记的文件不该进候选集')
  } finally {
    await workspace.cleanup()
  }
})

test('planCleanup + applyCleanup：先备份再写，且 fix 块原样保留', async () => {
  const source = [
    'const a = 1',
    probeBlock(HASH, "probe('a')"),
    `// dsh-debug:fix ${HASH} 修复：保留我`,
    'const fixed = 2',
  ].join('\n')
  const workspace = await createWorkspace({ 'src/app.js': source })
  try {
    const scan = await scanResidue(workspace.root, { hash: HASH, knownHashes: [HASH] })
    const plan = await planCleanup(workspace.root, scan, HASH)
    const result = await applyCleanup(workspace.root, plan.plans, {
      backupsDir: join(workspace.root, '.dsh', 'debug-mode', 'tasks', HASH, 'backups'),
      journalFile: join(workspace.root, '.dsh', 'debug-mode', 'tasks', HASH, 'journal.jsonl'),
      hash: HASH,
    })
    assert.deepEqual(result.cleaned, ['src/app.js'])
    assert.deepEqual(result.failed, [])

    const after = await readFile(join(workspace.root, 'src', 'app.js'), 'utf8')
    assert.ok(!after.includes('dsh-debug:probe'))
    assert.ok(after.includes('dsh-debug:fix'), '用户的修复必须原样待在原地')
    assert.ok(after.includes('const fixed = 2'))

    // 备份必须存在（"绝不自动还原"，但要给用户查看 / diff 的入口）。
    const backup = await readFile(join(workspace.root, '.dsh', 'debug-mode', 'tasks', HASH, 'backups', 'src__app.js'), 'utf8')
    assert.equal(backup, source)

    const journal = await readFile(join(workspace.root, '.dsh', 'debug-mode', 'tasks', HASH, 'journal.jsonl'), 'utf8')
    assert.match(journal, /probe-remove/)
  } finally {
    await workspace.cleanup()
  }
})

test('verifySyntax 严格区分 failed 与 unverifiable（§16.4 的教训）', () => {
  const verdicts = verifySyntax({
    'ok.cjs': 'module.exports = 1\n',
    'broken.cjs': 'function ( { \n',
    'esm.mjs': 'import x from "y"\nexport default x\n',
    'types.ts': 'const a: number = 1\nexport default a\n',
    'tla.js': 'const x = await fetch("/")\n',
  })
  const byPath = Object.fromEntries(verdicts.map((entry) => [entry.path, entry.verdict]))
  assert.equal(byPath['ok.cjs'], 'ok')
  assert.equal(byPath['broken.cjs'], 'failed')
  assert.equal(byPath['esm.mjs'], 'unverifiable')
  assert.equal(byPath['types.ts'], 'unverifiable')
  assert.equal(byPath['tla.js'], 'unverifiable', '顶层 await 合法，宿主没有资格判它失败')
})
