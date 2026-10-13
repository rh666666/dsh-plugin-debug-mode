/**
 * test/tools.test.mjs —— 5 个信号工具的契约守卫。
 *
 * 这些断言不是"风格检查"，它们各自对应一个**在真宿主里会直接炸掉**的坑：
 *
 *   1. 宿主只支持 JSON Schema 的一个**子集**（`type/oneOf/properties/required/
 *      additionalProperties/items/enum/const` + 注解）。多写一个关键字，
 *      `tools.register()` 当场抛 `JsonSchemaError`（`output.schema` 在注册时校验）。
 *      尤其是把 `required` 写成属性上的 `required: true` —— 首方工具用 `defineTool`
 *      编译属性表，很容易让人以为那是合法写法，而**原始注册**下它是非法关键字。
 *   2. `execute` 的返回值会被**对着 `output.schema` 校验**，不符合就整次调用变成
 *      `ToolOutputError`——连错误路径的返回值也必须合规。
 *   3. 工具必须能容忍 `args` 是任意值（原始注册不做参数校验）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DebugService } from '../lib/debug-service.js'
import { registerTools, toolDefinitions } from '../lib/tools.js'
import { createArtifactBase, createFakeContext, createWorkspace } from './helpers.mjs'

/** 宿主支持的 JSON Schema 关键字（抄自 `@deepseek-ai/dsh-tools` 的 assertSupportedJsonSchema）。 */
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** 递归校验"这是宿主支持的 schema 子集"。 */
function assertSupportedSchema(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    assert.fail(`${path} 必须是 schema 对象`)
  }
  for (const key of Object.keys(node)) {
    assert.ok(CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key),
      `${path}.${key} 不是宿主支持的关键字（子集：type/oneOf/properties/required/additionalProperties/items/enum/const + 注解）`)
  }
  if ('type' in node) assert.ok(TYPES.has(node.type), `${path}.type 非法：${node.type}`)
  if ('required' in node) {
    assert.ok(Array.isArray(node.required) && node.required.every((entry) => typeof entry === 'string'),
      `${path}.required 必须是字符串数组（写成属性上的 required: true 会注册失败）`)
  }
  if ('additionalProperties' in node) {
    assert.equal(typeof node.additionalProperties, 'boolean', `${path}.additionalProperties 必须是布尔`)
  }
  if ('properties' in node) {
    for (const [name, child] of Object.entries(node.properties)) assertSupportedSchema(child, `${path}.properties.${name}`)
  }
  if ('items' in node) assertSupportedSchema(node.items, `${path}.items`)
  if ('oneOf' in node) {
    for (const [index, child] of node.oneOf.entries()) assertSupportedSchema(child, `${path}.oneOf[${index}]`)
  }
}

/** 极简值校验：够证明 `execute` 的返回值不会触发 ToolOutputError。 */
function validateValue(schema, value, path) {
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${path} 应该是对象`)
    assert.ok(value !== null && !Array.isArray(value), `${path} 应该是对象`)
    for (const key of schema.required ?? []) {
      assert.ok(key in value, `${path}.${key} 缺失（output.schema 声明了 required）`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!(key in value) || value[key] === undefined) continue
      validateValue(child, value[key], `${path}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} 应该是数组`)
    for (const [index, item] of value.entries()) validateValue(schema.items ?? {}, item, `${path}[${index}]`)
    return
  }
  if (!('type' in schema)) return
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  const expected = schema.type === 'integer' ? 'number' : schema.type
  assert.equal(actual, expected, `${path} 类型不符：声明 ${schema.type}，实际 ${actual}`)
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} 不在 enum 里：${value}`)
}

test('五个工具的名字、必填字段与 schema 都在宿主支持的子集里', () => {
  const definitions = toolDefinitions({ /* service 只被 execute 用到 */ })
  assert.deepEqual(definitions.map((tool) => tool.name), [
    'dsh_debug_start',
    'dsh_debug_report',
    'dsh_debug_continue',
    'dsh_debug_read',
    'dsh_debug_end',
  ])

  for (const tool of definitions) {
    assert.ok(tool.description && tool.description.length > 10, `${tool.name} 需要一句像样的描述`)
    assert.equal(typeof tool.execute, 'function')

    // 参数：原始注册下 `parameters` 必须是**完整 JSON Schema**（不是 defineTool 的属性表）。
    assert.equal(tool.parameters.type, 'object', `${tool.name}.parameters 必须是 object 根`)
    assert.ok(tool.parameters.properties && typeof tool.parameters.properties === 'object')
    assertSupportedSchema(tool.parameters, `${tool.name}.parameters`)

    // 输出：`output.schema` 在 register 时就被校验，`render` 必填。
    assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`)
    assert.equal(typeof tool.output.render, 'function')

    const rendered = tool.output.render({}, { ok: true, text: '正文' })
    assert.deepEqual(rendered, [{ type: 'text', text: '正文' }], '模型看到的文本必须来自 output.render')

    // 没有 tools 服务时 render 也不该抛；返回 undefined 时给一句占位而不是崩。
    assert.deepEqual(tool.output.render({}, null), [{ type: 'text', text: '(无输出)' }])
  }
})

test('registerTools 在给定作用域注册全部五个工具', async () => {
  const art = await createArtifactBase()
  const fake = createFakeContext()
  try {
    const disposers = registerTools(fake.ctx, new DebugService(fake.ctx, { logger: fake.ctx.logger, tempDir: art.base }))
    assert.equal(disposers.length, 5)
    assert.equal(fake.toolRegistrations.length, 5)
  } finally {
    await art.cleanup()
  }
})

test('每个工具的返回值都通得过自己的 output.schema（否则宿主会变成 ToolOutputError）', async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  const art = await createArtifactBase()
  const fake = createFakeContext({ cwd: workspace.root })
  // 产物根必须指到本次测试自己的目录：`node --test` 并行跑多个测试文件，
  // 共用真实 `%TEMP%/dsh-debug-mode` 会让"跨重启恢复"这类断言互相污染。
  const service = new DebugService(fake.ctx, { logger: fake.ctx.logger, tempDir: art.base })
  const definitions = Object.fromEntries(toolDefinitions(service).map((tool) => [tool.name, tool]))

  /** 造一个"活的"执行上下文。 */
  const exec = {
    agent: { id: 'session-x', session: { header: { id: 'session-x', cwd: workspace.root } } },
    signal: new AbortController().signal,
  }

  try {
    // ① 无票 start：走的是拒绝分支，返回值同样必须合规。
    const refused = await definitions.dsh_debug_start.execute({ goal: 'x' }, exec)
    assert.equal(refused.ok, false)
    validateValue(definitions.dsh_debug_start.output.schema, refused, 'start.refused')

    // ② 签票后 start + report + resolve + end 的每个返回值。
    await service.issueTicket({ sessionId: 'session-x', text: '现象', workspace: workspace.root })
    const started = await definitions.dsh_debug_start.execute({ goal: '现象' }, exec)
    assert.equal(started.ok, true)
    validateValue(definitions.dsh_debug_start.output.schema, started, 'start.ok')

    const reported = await definitions.dsh_debug_report.execute({ analysis: '结论' }, exec)
    validateValue(definitions.dsh_debug_report.output.schema, reported, 'report')

    const read = await definitions.dsh_debug_read.execute({ limit: 10 }, exec)
    validateValue(definitions.dsh_debug_read.output.schema, read, 'read')

    await service.resolve({ hash: started.hash, sessionId: 'session-x' })
    const ended = await definitions.dsh_debug_end.execute({ summary: '收工' }, exec)
    validateValue(definitions.dsh_debug_end.output.schema, ended, 'end')

    const continued = await definitions.dsh_debug_continue.execute({}, exec)
    validateValue(definitions.dsh_debug_continue.output.schema, continued, 'continue')
  } finally {
    await workspace.cleanup()
    await art.cleanup()
  }
})

test('工具在缺少 args / 缺少 agent 时给出可读返回值而不是抛异常', async () => {
  const art = await createArtifactBase()
  const fake = createFakeContext()
  try {
    const service = new DebugService(fake.ctx, { logger: fake.ctx.logger, tempDir: art.base })
    const definitions = toolDefinitions(service)

    for (const tool of definitions) {
      // args 是任意值（原始注册不做参数校验）。
      for (const args of [undefined, null, 'nonsense', 42, []]) {
        const value = await tool.execute(args, {})
        assert.equal(value.ok, false)
        assert.match(value.text, /exec\.agent/)
      }
    }
  } finally {
    await art.cleanup()
  }
})
