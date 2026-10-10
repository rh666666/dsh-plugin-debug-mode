/**
 * test/summary.test.mjs —— `dsh_debug_read` 输出形状的守卫（DESIGN.md §8）。
 *
 * 四条契约，每一条都对应一种"Agent 被误导"的真实后果：
 *   1. warn/error 全量 —— 被 limit 裁掉的那条可能正是根因；
 *   2. 分组计数先于内容 —— 计数 0 的路径通常比日志内容更有信息量；
 *   3. 省略量显式 —— 静默截断会让模型以为"就这么多"；
 *   4. 空日志解释清楚 —— 区分"文件不存在/为空/全脏行"，否则模型会继续瞎猜。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatRecord } from '../lib/protocol.js'
import { renderLogSummary } from '../lib/summary.js'

/** 造一段符合协议的日志文本。 */
function logText(records) {
  return records.map((record) => formatRecord(record).trimEnd()).join('\n')
}

test('两种"看不见完整值"必须长得不一样：⚠️截断（真的被省略）vs 显示省略（日志里完整）', () => {
  const big = 'x'.repeat(1000)
  const text = renderLogSummary({
    hash: 'deadbeef',
    round: 1,
    exists: true,
    text: [
      // 这条**真的**被降级过（协议里带 truncated:true）
      JSON.stringify({ ts: '2026-10-10T10:00:00.000+08:00', task: 'deadbeef', probe: 'a:1', level: 'info', data: { v: big }, truncated: true }),
      // 这条是完整的，只是显示层会缩短它
      JSON.stringify({ ts: '2026-10-10T10:00:01.000+08:00', task: 'deadbeef', probe: 'b:2', level: 'info', data: { v: big } }),
    ].join('\n'),
  })
  assert.match(text, /⚠️截断/, '真的被省略的必须点名')
  assert.match(text, /显示省略/, '只是显示缩短的必须说清"日志里是完整的"')
  assert.match(text, /日志里是完整的/)
  // 关键回归守卫：两者不能都只呈现为一个 `…`（那正是害人查一轮的歧义）。
  // 取**时间序**那一节的行（带时间戳），别被上面的分组行骗到。
  const timeline = text.split('\n').filter((line) => /^\s+\d{4}-\d{2}-\d{2}T/.test(line))
  const truncatedLine = timeline.find((line) => line.includes('a:1'))
  const completeLine = timeline.find((line) => line.includes('b:2'))
  assert.ok(truncatedLine && completeLine, '两条都该出现在时间序里')
  assert.match(truncatedLine, /⚠️截断/)
  assert.ok(!/⚠️截断/.test(completeLine), '没被降级的记录不许被标成截断')
  assert.match(completeLine, /显示省略/, '完整记录要说明是显示层缩短')
})

test('日志文件不存在时给排查建议，而不是空表', () => {
  const text = renderLogSummary({ hash: 'deadbeef', round: 1, exists: false })
  assert.match(text, /日志文件不存在/)
  assert.match(text, /探针桩路径/)
  assert.match(text, /写权限/)
})

test('文件存在但为空 / 全脏行 分别给不同解释', () => {
  const empty = renderLogSummary({ hash: 'deadbeef', round: 1, exists: true, text: '' })
  assert.match(empty, /存在但为空/)
  assert.match(empty, /被调试的进程还没重启|分支|不会执行的路径/)

  const dirty = renderLogSummary({
    hash: 'deadbeef',
    round: 1,
    exists: true,
    text: 'hello\n{"broken":\n',
  })
  assert.match(dirty, /没有一行符合协议/)
  assert.match(dirty, /hello/, '必须给出第一条脏行原文')
})

test('warn/error 全量列出，不受 limit 影响', () => {
  const records = []
  for (let index = 0; index < 50; index += 1) {
    records.push({ probe: 'src/a.ts:1:loop', level: 'info', msg: `#${index}` })
  }
  records.push({ probe: 'src/a.ts:9:boom', level: 'error', msg: '炸了' })
  records.push({ probe: 'src/a.ts:10:odd', level: 'warn', msg: '怪' })

  const text = renderLogSummary({
    hash: 'deadbeef',
    round: 2,
    exists: true,
    text: logText(records),
    bytes: 4096,
    limit: 5,
  })
  assert.match(text, /异常与警告（全部 2 条，不受 limit 影响）/)
  assert.match(text, /炸了/)
  assert.match(text, /怪/)
  assert.match(text, /已省略 \d+ 条/, '必须显式说明省略量')
})

test('分组计数先于内容，并点名计数为 0 的自报探针', () => {
  const text = renderLogSummary({
    hash: 'deadbeef',
    round: 2,
    exists: true,
    text: logText([
      { probe: 'src/a.ts:1:hot', level: 'info' },
      { probe: 'src/a.ts:1:hot', level: 'info' },
      { probe: 'src/a.ts:2:cold', level: 'info' },
    ]),
    declared: [
      { probe: 'src/a.ts:1:hot', why: '期望命中' },
      { probe: 'src/a.ts:3:never', why: '这条路径根本没走到' },
    ],
  })
  assert.match(text, /按探针分组/)
  assert.ok(text.indexOf('2  src/a.ts:1:hot') > -1)
  assert.match(text, /声明过但没有命中的探针/)
  assert.ok(text.includes('0  src/a.ts:3:never'), '计数 0 的探针必须被点名')
  assert.ok(!text.includes('0  src/a.ts:1:hot'))
})

test('level / probe 参数会收窄，且收窄本身被说出来', () => {
  const text = renderLogSummary({
    hash: 'deadbeef',
    round: 2,
    exists: true,
    text: logText([
      { probe: 'a:1:x', level: 'info' },
      { probe: 'b:1:y', level: 'warn' },
    ]),
    level: 'warn',
  })
  assert.match(text, /已按 level=warn 收窄到 1 行/)
  assert.match(text, /b:1:y/)
  assert.ok(!text.includes('a:1:x'))
})

test('脏行计数出现在头部（协议写错要一眼看见）', () => {
  const text = renderLogSummary({
    hash: 'deadbeef',
    round: 1,
    exists: true,
    text: `${formatRecord({ probe: 'a', level: 'info' }).trimEnd()}\n这不是 JSON\n`,
  })
  assert.match(text, /脏行 1/)
})
