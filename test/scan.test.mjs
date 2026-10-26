/**
 * test/scan.test.mjs —— 标记识别、配对、摘除与声明文件扫描的守卫测试。
 *
 * 这里的每一条断言都对应一个**会造成不可逆损失**的具体错误：
 *   · 误删用户代码（所以配对歧义必须进 unresolved，而不是"大概是这样"）；
 *   · 误保临时改动（所以无标记的探针不能被当成"没有"）；
 *   · 留下调试记号（收尾必须连 fix/change/tmp 一起清）。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  applyCleanup,
  introducedIdentifiers,
  pairBlocks,
  findMarkers,
  planCleanup,
  removeBlocks,
  removeMarkers,
  scanDeclared,
  scanPaths,
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
  assert.ok(result.text.includes('dsh-debug:fix'), 'removeBlocks 是窄口径：fix 标记保留')
  assert.ok(result.text.includes('const a = 1') && result.text.includes('const b = 2'))
  assert.deepEqual(result.unresolved, [])
})

test('removeMarkers 清掉所有类型标记：probe/temp 整块删，fix/change/tmp 只删注释', () => {
  const source = [
    'const a = 1',
    probeBlock(HASH, "probe('a')"),
    `// dsh-debug:fix ${HASH} 修复：空数组`,
    'const b = 2',
    `// dsh-debug:change ${HASH} 修复备注`,
    'const c = 3',
    '// dsh-debug:tmp',
    'const d = 4',
    `// dsh-debug:tmp ${HASH} start`,
    'const tmp = 5',
    `// dsh-debug:tmp ${HASH} end`,
    '// dsh-debug',
    'export default a + b + c + d',
  ].join('\n')

  const result = removeMarkers(source, HASH)
  assert.ok(!result.text.includes('dsh-debug'), '收尾后一个 dsh-debug 记号都不许留')
  assert.ok(!result.text.includes("probe('a')"), '探针块要整块删')
  assert.ok(!result.text.includes('const tmp = 5'), 'temp/tmp 块要整块删')
  assert.ok(result.text.includes('const b = 2'), 'fix 标注的代码必须保留')
  assert.ok(result.text.includes('const c = 3'), 'change 标注的代码必须保留')
  assert.ok(result.text.includes('const d = 4'), 'tmp 标注的代码必须保留')
  assert.deepEqual(result.unresolved, [])
})

test('removeMarkers 保留别的任务的块（交给隔离区），但清掉行级标记', () => {
  const source = [
    `// dsh-debug:probe ${OTHER} start`,
    "probe('other')",
    `// dsh-debug:probe ${OTHER} end`,
    `// dsh-debug:change ${OTHER} 别的任务的备注`,
    'const keep = 1',
  ].join('\n')
  const result = removeMarkers(source, HASH)
  assert.ok(result.text.includes(`dsh-debug:probe ${OTHER} start`), '别的任务的块不许动')
  assert.ok(result.text.includes("probe('other')"), '别的任务的块体不许动')
  assert.ok(!result.text.includes('dsh-debug:change'), '行级注释可以安全清掉')
  assert.ok(result.text.includes('const keep = 1'))
})

test('removeMarkers 只删行尾标记注释，不删它前面的代码', () => {
  const source = [
    `const a = 1 // dsh-debug:fix ${HASH} 修复`,
    `const b = 2 # dsh-debug:change ${HASH} 备注`,
  ].join('\n')
  assert.equal(removeMarkers(source, HASH).text, 'const a = 1\nconst b = 2')
})

test('removeMarkers 对块注释只删注释区间，保留注释后面的代码', () => {
  const source = `const a = 1 /* dsh-debug:fix ${HASH} 修复 */ + 2\nconst b = 3 <!-- dsh-debug:tmp --> + 4\n`
  const result = removeMarkers(source, HASH)
  assert.equal(result.text, 'const a = 1  + 2\nconst b = 3  + 4\n')
  assert.ok(!result.text.includes('dsh-debug'))
})

test('removeMarkers 行首块注释后面跟代码时也只删注释，不删代码', () => {
  const source = `/* dsh-debug:fix ${HASH} 修复 */ const a = 1\n<!-- dsh-debug:tmp --> const b = 2\n`
  const result = removeMarkers(source, HASH)
  assert.equal(result.text, ' const a = 1\n const b = 2\n')
  assert.ok(!result.text.includes('dsh-debug'))
})

test('块注释里含 // 时仍按块注释处理，不把后面的代码当注释截掉', () => {
  const source = `foo(); /* see https://x dsh-debug:fix ${HASH} */ bar()\n`
  const result = removeMarkers(source, HASH)
  assert.equal(result.text, 'foo();  bar()\n')
  assert.ok(!result.text.includes('dsh-debug'))
})

test('removeMarkers 不把字符串里的 dsh-debug 当标记', () => {
  const source = `const s = 'dsh-debug:probe ${HASH} start'\nconst t = "dsh-debug:tmp"\n`
  const result = removeMarkers(source, HASH)
  assert.equal(result.text, source)
  assert.deepEqual(result.removed, [])
})

test('removeMarkers 不删提到 dsh debug 的普通注释（只认真正的 marker 行）', () => {
  const source = '// dsh debug output is noisy\nexport const a = 1\n'
  const result = removeMarkers(source, HASH)
  assert.equal(result.text, source)
  assert.deepEqual(result.removed, [])
})

test('块 kind 带 hash 却缺 start/end 时不静默删：进 unresolved，等隔离区决定', () => {
  const source = `// dsh-debug:probe ${HASH}\nprobe('x')\nexport const a = 1\n`
  const result = removeMarkers(source, HASH)
  assert.equal(result.text, source, '块体还在，不能只把 marker 行删掉就宣称结束')
  assert.ok(result.unresolved.some((entry) => /缺少 start\/end/.test(entry.reason)))
  assert.ok(pairBlocks(findMarkers(source)).unresolved.length > 0)
})

test('tmp 别名与下划线分隔也能识别成 temp 块（Agent 常写错的形态）', () => {
  const source = [
    `// dsh-debug:tmp_${HASH} start`,
    'const tmp = 1',
    `// dsh-debug:tmp_${HASH} end`,
    'const keep = 2',
  ].join('\n')
  assert.equal(removeMarkers(source, HASH).text, 'const keep = 2')
})

test('removeMarkers 保留原文件的 CRLF 换行，不把整份文件改成 LF', () => {
  const source = [
    'const a = 1',
    probeBlock(HASH, "probe('x')"),
    `// dsh-debug:fix ${HASH} 修复`,
    'const b = 2',
    '',
  ].join('\r\n')
  const result = removeMarkers(source, HASH)
  assert.equal(result.text, 'const a = 1\r\nconst b = 2\r\n')
  assert.ok(!/[^\r]\n/.test(result.text), '除了 CRLF 之外不该出现裸 LF')
})

test('removeBlocks 顺带收敛摘除缝上的多余空行（实测连续五轮同一模式）', () => {
  // 用户报的真实形状：Agent 为了跟代码分开，在块前后各留一个空行；
  // 那两个空行在标记**外面**，老实现只按标记删行，于是它们留了下来，
  // 文件里凭空多出一个空行（"import 区后"与"return 前"两处）。
  const pythonish = [
    'import json',
    '',
    '# dsh-debug:probe deadbeef start',
    "probe('ready')",
    '# dsh-debug:probe deadbeef end',
    '',
    'def compute_totals(rows):',
    '    total = 0',
    '',
    '# dsh-debug:probe deadbeef start',
    "probe('per-request', {'rows': len(rows)})",
    '# dsh-debug:probe deadbeef end',
    '',
    '    return total',
    '',
  ].join('\n')

  const result = removeBlocks(pythonish, 'deadbeef')
  assert.equal(result.removed.length, 2)
  assert.ok(result.collapsedBlankLines >= 1, '必须报告收敛了几行，不能静默')
  assert.deepEqual(result.unresolved, [])
  assert.ok(!/\n\n\n/.test(result.text), '任何位置都不许出现两个以上连续空行')
  // 收敛到"每处至多一个分隔空行"——这就是能被证明的上限：宿主**无法**区分
  // "原本这里有 0 个空行"与"原本有 1 个空行"（那要靠插入时的纪律，见指南 §七.2）。
  assert.equal(result.text, [
    'import json',
    '',
    'def compute_totals(rows):',
    '    total = 0',
    '',
    '    return total',
    '',
  ].join('\n'))
  assert.equal(result.text.endsWith('return total\n'), true, '文件尾的换行不许被吃掉')

  // 反面守卫：缝之外原本就有的连续空行是用户自己的排版，一个都不能动。
  const untouched = [
    'a',
    '',
    'b',
    '',
    '',
    'c',
    '# dsh-debug:probe deadbeef start',
    'probe(1)',
    '# dsh-debug:probe deadbeef end',
    'd',
  ].join('\n')
  assert.equal(removeBlocks(untouched, 'deadbeef').text, ['a', '', 'b', '', '', 'c', 'd'].join('\n'),
    '缝之外的连续空行不许折叠')

  // 块在文件开头/结尾时的填充也要收干净（文件不该以空行开头/结尾）。
  const headAndTail = [
    '',
    '# dsh-debug:probe deadbeef start',
    'probe(1)',
    '# dsh-debug:probe deadbeef end',
    '',
    'body()',
    '',
    '# dsh-debug:probe deadbeef start',
    'probe(2)',
    '# dsh-debug:probe deadbeef end',
    '',
  ].join('\n')
  assert.equal(removeBlocks(headAndTail, 'deadbeef').text, 'body()\n')

  // 块与代码紧贴（Agent 没加填充）时不许凭空造出空行，也不许误删。
  const tight = ['x = 1', '# dsh-debug:probe deadbeef start', 'probe(1)', '# dsh-debug:probe deadbeef end', 'y = 2'].join('\n')
  const tightResult = removeBlocks(tight, 'deadbeef')
  assert.equal(tightResult.text, 'x = 1\ny = 2')
  assert.equal(tightResult.collapsedBlankLines, 0)

  // `fix` 标记是行级标记：removeBlocks 不动它。
  const withFix = ['a', '', `# dsh-debug:fix ${HASH} 修好了空数组分支`, 'b = 1', '', 'c'].join('\n')
  const fixResult = removeBlocks(withFix, 'deadbeef')
  assert.equal(fixResult.removed.length, 0)
  assert.equal(fixResult.text, withFix, '没有摘除动作时不许动任何空白')
})

test('指南推荐的 [ok] 写法（[x] = 会产生多余空行）：既不留填充空行，也不吃掉原地已有的空行', () => {
  const pre = `# dsh-debug:probe ${HASH} start`
  const post = `# dsh-debug:probe ${HASH} end`
  // [ok] 写法 = 块前后**不加**填充；要视觉分隔就把空行放进块内（跟块一起消失）。
  // 反过来，[x] 写法（块外加填充）会在摘除后留下多余空行 —— 见本文件后面的对照组。
  const blockWithInnerBlank = [pre, '', "probe('x')", '', post]

  // 情形 1：原地**本来就有**一个空行 —— 必须原样保留（不许被"收敛"吃掉）
  const withExistingBlank = ['a = 1', '', ...blockWithInnerBlank, 'b = 2'].join('\n')
  const r1 = removeBlocks(withExistingBlank, HASH)
  assert.equal(r1.text, ['a = 1', '', 'b = 2'].join('\n'), '原地已有的那个空行必须还在')
  assert.equal(r1.collapsedBlankLines, 0, '本来就只有 1 个空行时不该动手')

  // 情形 2：原地**没有**空行 —— 摘完必须严丝合缝，一个空行都不许造出来
  const withoutBlank = ['a = 1', ...blockWithInnerBlank, 'b = 2'].join('\n')
  const r2 = removeBlocks(withoutBlank, HASH)
  assert.equal(r2.text, ['a = 1', 'b = 2'].join('\n'), '[ok] 写法必须做到"与插入前逐字相同"')
  assert.equal(r2.collapsedBlankLines, 0)

  // 情形 3：原地有 2 个空行 —— 在**缝上**会被收敛到 1（这是刻意的取舍，见下）。
  // 判据无法区分"用户自己写了 2 个空行"与"1 个原本 + 1 个 Agent 填充"，
  // 而"留 2 个"正是实测连续五轮的那个 bug，所以缝上统一收敛到 1。
  // 关键对比在下一个断言：**不在缝上**的 2 个空行一个字都不动。
  const withTwoBlanks = ['a = 1', '', '', ...blockWithInnerBlank, 'b = 2'].join('\n')
  const r3 = removeBlocks(withTwoBlanks, HASH)
  assert.equal(r3.text, ['a = 1', '', 'b = 2'].join('\n'), '缝上收敛到 1')
  assert.equal(r3.collapsedBlankLines, 1)

  const twoBlanksAwayFromSeam = ['a = 1', '', '', 'b = 2', ...blockWithInnerBlank, 'c = 3'].join('\n')
  assert.equal(
    removeBlocks(twoBlanksAwayFromSeam, HASH).text,
    ['a = 1', '', '', 'b = 2', 'c = 3'].join('\n'),
    '远离缝的双空行是用户排版，不许动',
)

  // 对照组：[x] 写法（块外加填充）在"原地没有空行"时会多留 1 个空行 ——
  // 这就是实测连续五轮的那个坑，也是指南 要求把空行放进块内的理由。
  // （注意：只在一侧加填充时留的是 1 个空行，收敛逻辑**不会**动它——
  // 因为 1 个空行与"原地本来就有 1 个"无法区分，只能靠插入纪律。）
  const paddedBoth = ['a = 1', '', pre, "probe('x')", post, '', 'b = 2'].join('\n')
  const r4 = removeBlocks(paddedBoth, HASH)
  assert.equal(r4.text, ['a = 1', '', 'b = 2'].join('\n'), '[x] 两侧都填充：修完后最多留 1 个空行（不再留 2 个）')
  assert.equal(r4.collapsedBlankLines, 1, '收敛了 1 行，且必须报出来')

  const paddedOneSide = ['a = 1', pre, "probe('x')", post, '', 'b = 2'].join('\n')
  const r5 = removeBlocks(paddedOneSide, HASH)
  assert.equal(r5.collapsedBlankLines, 0, '只在一侧填充时不动它（与"原地本来就有 1 个"无法区分）')
})

test('原有的空行被包进标记内 ⇒ 它跟块一起消失（清理逻辑兜不住，v0.18 实测）', () => {
  const pre = `# dsh-debug:probe ${HASH} start`
  const post = `# dsh-debug:probe ${HASH} end`

  // 这是**实测发生的**布局：Agent 把块插在原地空行的位置上，那个空行就落进了标记内。
  // 用户的报告就是这一种（站点 A，两次实测一致）。它必须和"空行在标记外"区分开——
  // v0.15 的文档把两者混为一谈，写成"原有的空行会被保留"，是错的。
  const blankInside = ['total = compute(rows)', pre, '', "probe('x')", post, 'return total'].join('\n')
  const result = removeBlocks(blankInside, HASH)
  assert.equal(result.text, ['total = compute(rows)', 'return total'].join('\n'),
    '空行在标记内 ⇒ 被连带删除（这是**已知代价**，不是实现 bug：那段区间是宿主被授权删的部分）')
  assert.equal(result.collapsedBlankLines, 0,
    '[!] 这不叫"收敛"，所以**不计入** collapsedBlankLines，收尾报告里也不会出现——别指望它兜底')

  // 对照：同一个文件、同一个位置，只要把空行留在标记**外**，它就活下来。
  const blankOutside = ['total = compute(rows)', '', pre, "probe('x')", post, 'return total'].join('\n')
  assert.equal(removeBlocks(blankOutside, HASH).text, ['total = compute(rows)', '', 'return total'].join('\n'),
    '空行在标记外 ⇒ 宿主不碰它')

  // 两个方向同时犯错时**总行数可能相抵**——这就是"不能只看行数"的原因。
  const swapped = [
    'a = 1', pre, '', "probe('x')", post, 'b = 2',
    '', pre, "probe('y')", post, 'c = 3',
  ].join('\n')
  const swappedResult = removeBlocks(swapped, HASH)
  assert.equal(swappedResult.text, ['a = 1', 'b = 2', '', 'c = 3'].join('\n'))
  const perfect = ['a = 1', '', 'b = 2', 'c = 3'].join('\n')
  assert.equal(swappedResult.text.split('\n').length, perfect.split('\n').length, '行数相同')
  assert.notEqual(swappedResult.text, perfect, '但位置不同 ⇒ 校验必须比位置')
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
  // `fix` 现在被识别为**行级**标记（没有 edge），不参与配对；temp 的 start 没配对。
  assert.equal(unresolved.length, 1)
  assert.match(unresolved[0].reason, /没有配对的 end/)
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

test('scanPaths：声明过但读不到的文件进 unreadable（收尾不得据此宣称干净）', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  try {
    const result = await scanPaths(workspace.root, ['src/app.js', 'src/missing.js'], { hash: HASH, knownHashes: [HASH] })
    assert.equal(result.scanned, 1)
    assert.deepEqual(result.unreadable.map((entry) => entry.path), ['src/missing.js'])
    assert.match(result.unreadable[0].error, /ENOENT/)
  } finally {
    await workspace.cleanup()
  }
})

test('scanDeclared 只扫给定清单：没报备、git 也没发现的文件一个都不看', async () => {
  const workspace = await createWorkspace({
    'src/own.js': `const a = 1\n${probeBlock(HASH, "probe('own')")}\nexport default a\n`,
    'src/unreported.js': `const b = 1\n${probeBlock(HASH, "probe('unreported')")}\nexport default b\n`,
  })
  try {
    const scan = await scanDeclared(workspace.root, ['src/own.js'], { hash: HASH, knownHashes: [HASH] })
    assert.deepEqual(scan.targetFiles, ['src/own.js'])
    assert.equal(scan.scanned, 1)
    assert.equal(scan.complete, true)
    assert.ok(!scan.affected.some((entry) => entry.path === 'src/unreported.js'),
      '不在清单里的文件绝不进入扫描结果')
    assert.deepEqual(scan.unreadable, [])
  } finally {
    await workspace.cleanup()
  }
})

test('scanDeclared：宽松发现、严格分类、hash 不属于任何已知任务 ⇒ 进隔离区', async () => {
  const workspace = await createWorkspace({
    'src/own.js': `const a = 1\n${probeBlock(HASH, "probe('own')")}\nexport default a\n`,
    'src/stub-ref.js': "import { probe } from './.dsh/debug-mode/tasks/" + HASH + "/runtime/probe.mjs'\n",
    'src/foreign.js': `// dsh_debug:probe ${OTHER} start\nconst x = 1\n// dsh_debug:probe ${OTHER} end\n`,
    'src/broken.js': `// dsh-debug:probe not-a-hash start\nconst y = 1\n`,
    'src/clean.js': 'export const clean = true\n',
  })
  try {
    const scan = await scanDeclared(
      workspace.root,
      ['src/own.js', 'src/stub-ref.js', 'src/foreign.js', 'src/broken.js', 'src/clean.js'],
      { hash: HASH, knownHashes: [HASH] },
    )
    assert.deepEqual(scan.targetFiles, ['src/own.js'])
    assert.deepEqual(scan.stubRefFiles, ['src/stub-ref.js'])
    assert.ok(scan.quarantine.some((entry) => entry.path === 'src/foreign.js' && entry.hash === OTHER),
      '别的 hash 属于"不属于任何已知任务"，必须进隔离区')
    assert.ok(scan.quarantine.some((entry) => entry.path === 'src/broken.js'),
      '格式残缺也必须进隔离区（下划线写法是真实现场）')
    assert.ok(!scan.affected.some((entry) => entry.path === 'src/clean.js'), '完全无标记的文件不该进候选集')
    assert.ok(scan.markerFiles.includes('src/own.js'))
  } finally {
    await workspace.cleanup()
  }
})

test('scanDeclared：桩引用**两形态**都能被抓到（临时根与工作区回退根）', async () => {
  // 产物默认落在**用户临时目录**里（`.../Temp/dsh-debug-mode/tasks/<hash>/runtime/probe.mjs`），
  // 临时根不可写时回退到工作区（`.dsh/debug-mode/tasks/<hash>/runtime/probe.mjs`）。
  // 两种引用形态的共同危险一样：桩会随任务目录删除，调用还在的话代码直接编译不过。
  const workspace = await createWorkspace({
    'src/temp-ref.js': `import { probe } from './dsh-debug-mode/tasks/${HASH}/runtime/probe.mjs'\n`,
    'src/legacy-ref.js': `// file:///${'C:/Users/x/AppData/Local/Temp'}/dsh-debug-mode/tasks/${HASH}/runtime/probe.mjs\n`,
  })
  try {
    const scan = await scanDeclared(workspace.root, ['src/temp-ref.js', 'src/legacy-ref.js'], {
      hash: HASH,
      knownHashes: [HASH],
    })
    assert.deepEqual(scan.stubRefFiles.slice().sort(), ['src/legacy-ref.js', 'src/temp-ref.js'],
      '两形态都必须被列出来——只认 `.dsh/` 那一形态会让临时根形态静默漏掉')
  } finally {
    await workspace.cleanup()
  }
})

test('scanDeclared：收尾后本任务标记与垃圾注释都在 markerFiles 里（复扫据此判不干净）', async () => {
  const workspace = await createWorkspace({
    'src/app.js': `const a = 1\n// dsh-debug:tmp\n${probeBlock(HASH, "probe('x')")}\n`,
  })
  try {
    const scan = await scanDeclared(workspace.root, ['src/app.js'], { hash: HASH, knownHashes: [HASH] })
    assert.deepEqual(scan.markerFiles, ['src/app.js'])
    assert.deepEqual(scan.targetFiles, ['src/app.js'])
  } finally {
    await workspace.cleanup()
  }
})

test('planCleanup + applyCleanup：先备份再写，所有标记清掉、修复代码保留', async () => {
  const source = [
    'const a = 1',
    probeBlock(HASH, "probe('a')"),
    `// dsh-debug:fix ${HASH} 修复：保留我`,
    'const fixed = 2',
    `// dsh-debug:change ${HASH} 备注`,
  ].join('\n')
  const workspace = await createWorkspace({ 'src/app.js': source })
  try {
    const scan = await scanDeclared(workspace.root, ['src/app.js'], { hash: HASH, knownHashes: [HASH] })
    const plan = await planCleanup(workspace.root, scan, HASH)
    const result = await applyCleanup(workspace.root, plan.plans, {
      backupsDir: join(workspace.root, '.dsh', 'debug-mode', 'tasks', HASH, 'backups'),
      journalFile: join(workspace.root, '.dsh', 'debug-mode', 'tasks', HASH, 'journal.jsonl'),
      hash: HASH,
    })
    assert.deepEqual(result.cleaned, ['src/app.js'])
    assert.deepEqual(result.failed, [])

    const after = await readFile(join(workspace.root, 'src', 'app.js'), 'utf8')
    assert.ok(!after.includes('dsh-debug'), '所有调试标记都必须清掉')
    assert.ok(!after.includes("probe('a')"), '探针块必须摘掉')
    assert.ok(after.includes('const fixed = 2'), '修复代码必须原样待在原地')

    // 备份必须存在（"绝不自动还原"，但要给用户查看 / diff 的入口）。
    const backup = await readFile(join(workspace.root, '.dsh', 'debug-mode', 'tasks', HASH, 'backups', 'src__app.js'), 'utf8')
    assert.equal(backup, source)

    const journal = await readFile(join(workspace.root, '.dsh', 'debug-mode', 'tasks', HASH, 'journal.jsonl'), 'utf8')
    assert.match(journal, /probe-remove/)
  } finally {
    await workspace.cleanup()
  }
})

test('verifySyntax 严格区分 failed 与 unverifiable', () => {
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
