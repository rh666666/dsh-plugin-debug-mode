/**
 * test/client-bundle.test.mjs —— 客户端产物的结构性守卫。
 *
 * 这里不测浏览器渲染（那要真浏览器），只测**能在这个环境里测、且坏了会白屏或误禁用**的事：
 *   1. `lib/client.js` 是一个合法的 Module Loader 注册脚本（`window.__ModuleLoader__.load`）；
 *   2. 它的工厂返回 `{ apply, inject }`，且 `inject` 含 `slots`；
 *   3. `apply(ctx)` 用**声明感知**的 `slots.inject` 注册到 `conversation.composer.dock`，
 * 而不是裸调 `register`（座位可能稍后才声明，裸调会静默丢面板）；
 *   4. 面板在没有任务时渲染空，在 `awaiting-user` 时给出两个可用的按钮，
 * 且**输入框有未发送内容时按钮被禁用**（的竞态防护）。
 *
 * 产物在 `node:vm` 的沙箱里执行：给它一个假的 `window` 与 `require`，
 * 这正是宿主加载它时所处的环境形状。
 *
 * 运行：node --test test/*.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const SRC = join(ROOT, 'src', 'client.js')
const BUILD = join(ROOT, 'scripts', 'build-client.mjs')
const NODE = process.execPath

/** 座位 key：改这里就会同时提醒改测试与。 */
const SLOT_KEY = 'conversation.input.dock'
const SLOT_ID = 'debug-mode-decision'
/**
 * 状态 tag 的座位：list 座位、当前零占用者。
 *
 * [!] 绝不能是 `conversation.input.plan`：那是 `kind: "single"`，在同一个 priority 上
 * 注册第二次会**抛错**（不是后者顶掉前者），于是首方 Plan 插件装配失败、web boot
 * 断言失败、**应用启动即崩**（2026-10-13 实测）。下面那条"座位冲突"测试守的就是这件事。
 */
const CHIP_KEY = 'conversation.input.left'
const CHIP_ID = 'debug-mode-chip'

/**
 * 迷你测试渲染器。
 *
 * 面板是个真组件（`useState` + `useEffect` + `fetch`），所以「渲染出来长什么样」这件事
 * 只能靠一个最小的 hooks 环境来验：状态按调用序缓存在实例上，effect 在渲染后执行，
 * 其内部触发的 `setState` 会触发一次重渲染。这不是 React，但足以守住
 * 「等待用户时给出两个可用按钮、有草稿时禁用」这条契约。
 */
const react = {
  /** 当前正在渲染的组件实例（无则为 null）。 */
  instance: null,
  /**
   * @param {() => unknown} render 一次渲染调用
   * @param {number} [rounds] 允许的重渲染轮数
   * @param {(tree: unknown) => void} [after] 每轮渲染之后、settle 之前调用——
   * 用来模拟"用户在面板上点了一下"：它触发的 setState 会让循环再跑一轮。
   * @returns {Promise<unknown>} 最后一次渲染的宿主树
   */
  async run(render, rounds = 3, after = null) {
    const instance = { state: [], cursor: 0, effects: [], scheduled: false }
    try {
      let value
      for (let round = 0; round < rounds; round += 1) {
        instance.cursor = 0
        instance.scheduled = false
        instance.effects = []
        react.instance = instance
        value = resolve(render())
        after?.(value)
        // effect 里的 fetch → then → setState 需要几个微任务才落定。
        await settle()
        for (const effect of instance.effects) effect.cleanup?.()
        if (!instance.scheduled) break
      }
      return value
    } finally {
      react.instance = null
    }
  },
}

/**
 * 把 `createElement(Fn, props)` 返回的元素「渲染」成宿主树：
 * 座位给的组件是 `(props) => createElement(DebugPanel, props)` 这种一层包装，
 * 必须真的把函数类型调起来，hook 才会跑（否则测到的只是外壳元素）。
 * @param {unknown} element
 * @returns {unknown}
 */
function resolve(element) {
  let node = element
  for (let depth = 0; depth < 8; depth += 1) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'function') return node
    node = node.type(node.props)
  }
  return node
}

/** 让挂起的微任务跑完（fetch → then → setState 这条链）。 */
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

/** 平台种子表里的 react 的最小替身（供产物在 vm 沙箱里 require）。 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const instance = react.instance
      if (!instance) return [initial, () => undefined]
      const index = instance.cursor
      instance.cursor += 1
      if (!(index in instance.state)) instance.state[index] = initial
      return [instance.state[index], (next) => {
        instance.state[index] = next
        instance.scheduled = true
      }]
    },
    useEffect(effect) {
      const instance = react.instance
      if (!instance) return undefined
      const cleanup = effect()
      instance.effects.push({ cleanup: typeof cleanup === 'function' ? cleanup : undefined })
      return undefined
    },
  }
}

/**
 * 在沙箱里执行产物，返回注册对象与它请求过的模块名。
 * @param {{ require?: (name: string) => unknown }} [options]
 */
async function loadBundle(options = {}) {
  const source = await readFile(BUNDLE, 'utf8')
  const requested = []
  const requireImpl = options.require ?? ((name) => {
    requested.push(name)
    if (name === 'react') return reactStub()
    throw new Error(`测试桩没有准备模块：${name}`)
  })

  let registration = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(candidate) {
          registration = candidate
        },
      },
    },
    require: requireImpl,
    console,
    Symbol,
    setInterval: () => 0,
    clearInterval: () => undefined,
    fetch: (...args) => globalThis.fetch(...args),
  }
  runInContext(source, createContext(sandbox), { filename: 'lib/client.js' })
  assert.ok(registration, '沙箱没有捕获到 __ModuleLoader__.load 调用')
  return { registration, requested }
}

/** 取回产物导出的 apply/inject（每次用全新的 react 替身，避免状态串味）。 */
async function loadExports() {
  const { registration, requested } = await loadBundle()
  const exportsObject = registration.factory((name) => {
    requested.push(name)
    if (name === 'react') return reactStub()
    throw new Error(`测试桩没有准备模块：${name}`)
  })
  return { registration, exportsObject, requested }
}

/**
 * 把 apply(ctx) 的自注册跑起来，返回**两个座位**各自注册下来的组件。
 *
 * 两个 cell（输入框上方的卡片 + Plan chip 那一格的状态 tag）都要在这里拿到：
 * 它们各自独立注册，任何一个漏注册都会让界面上少一块，而这类"少一块"在真机里
 * 往往表现为静默空白，只有这里能提前拦住。
 */
function mountPanel(exportsObject) {
  const injections = []
  const registers = []
  const ctx = {
    slots: {
      inject(seat, callback) {
        injections.push({ seat, callback })
        return () => undefined
      },
      register(options, component) {
        registers.push({ options, component })
        return () => undefined
      },
    },
  }
  exportsObject.apply(ctx)
  // 裸调 register 会在座位尚未声明时**静默丢掉**这一格，所以 apply 只能声明 inject。
  assert.equal(injections.length, 2, 'apply 必须声明两个座位：面板卡片与状态 tag')
  assert.equal(registers.length, 0, 'apply 自己不得裸调 register（座位可能尚未声明）')
  for (const injection of injections) injection.callback()
  assert.equal(registers.length, injections.length, '每个座位声明后回调都应完成注册')

  const bySeat = new Map(registers.map((entry) => [entry.options.name, entry]))
  assert.ok(bySeat.has(SLOT_KEY), `必须注册 ${SLOT_KEY} 上的面板卡片`)
  assert.ok(bySeat.has(CHIP_KEY), `必须注册 ${CHIP_KEY} 上的状态 tag`)

  return {
    injections,
    registers,
    panel: bySeat.get(SLOT_KEY).component,
    panelOptions: bySeat.get(SLOT_KEY).options,
    chip: bySeat.get(CHIP_KEY).component,
    chipOptions: bySeat.get(CHIP_KEY).options,
  }
}

/** 从 createElement 树里收集所有 button 元素（用于断言禁用态）。 */
function collectButtons(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (node.type === 'button') out.push(node)
  collectButtons(node.children ?? [], out)
  return out
}

test('产物是一个自洽的 Module Loader 注册脚本', async () => {
  const { registration, requested } = await loadBundle()
  assert.equal(registration.id, 'dsh-plugin-debug-mode', 'factory id 必须逐字等于包名')
  assert.equal(typeof registration.factory, 'function')

  const exportsObject = registration.factory((name) => {
    requested.push(name)
    if (name === 'react') return reactStub()
    throw new Error(`测试桩没有准备模块：${name}`)
  })

  assert.deepEqual(requested, ['react'])
  assert.equal(typeof exportsObject.apply, 'function', '工厂必须导出 apply')
  assert.ok(Array.isArray(exportsObject.inject), '工厂必须导出 inject 数组')
  assert.ok(exportsObject.inject.includes('slots'), 'inject 必须包含 slots')
})

test('apply(ctx) 用声明感知的 inject 注册到输入框**上方**的座位', async () => {
  const { exportsObject } = await loadExports()
  const { injections, panelOptions: options } = mountPanel(exportsObject)

  assert.equal(injections[0].seat, SLOT_KEY, `第一个座位必须是 ${SLOT_KEY}`)
  assert.equal(options.name, SLOT_KEY)
  assert.equal(SLOT_KEY, 'conversation.input.dock',
    '这张卡片必须在输入框**上方**：首方把 conversation.input.dock 在文档流里渲染在 inputBar 之前，'
    + '所以它贴近输入框又不可能遮挡它；旧座位 conversation.composer.dock 渲染在卡片下方，会把输入框往上挤')
  assert.equal(options.id, SLOT_ID, '用自己的 id 旁加一格，不覆盖别人在同一个 dock 里的 cell')
  assert.ok(Number.isFinite(options.order), 'order 必须显式给，否则会插到别人的前面去')
  assert.equal(typeof options.label, 'function', 'label 用 thunk，切语言时无需重注册')
})

test('状态 tag：挂在零占用者的 list 座位上，是一个带叉的 chip（叉 = 「问题已解决」）', async () => {
  const { exportsObject } = await loadExports()
  const { injections, chip, chipOptions } = mountPanel(exportsObject)

  const seat = injections.find((entry) => entry.seat === CHIP_KEY)
  assert.ok(seat, `必须声明座位 ${CHIP_KEY}`)
  assert.equal(chipOptions.name, CHIP_KEY)
  assert.equal(chipOptions.id, CHIP_ID, '用自己的 id 注册，不与别人争同一个 cell key')
  assert.equal(CHIP_KEY, 'conversation.input.left',
    'tag 必须挂在 conversation.input.left：它渲染在输入框工具行里的 + / 回形针之后；'
    + '换回 conversation.input.plan 会让首方 Plan 插件注册时抛错、整次 web boot 崩掉')
  assert.ok(Number.isFinite(chipOptions.order), 'order 必须显式给')

  const originalFetch = globalThis.fetch
  try {
    // 没有任务 → 渲染空（座位服务所有会话，无关会话里绝不能挂一个空 tag）。
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ task: null }) })
    assert.equal(await react.run(() => chip({ sessionId: 's1' })), null, '没有任务时 tag 必须渲染 null')

    // 有任务 → 一个写着「调试」的 chip，叉可点。
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      if (String(url).includes('/state')) {
        return { ok: true, json: async () => ({ task: { hash: 'deadbeef', round: 1, status: 'active' } }) }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const tree = await react.run(() => chip({ sessionId: 's1' }))
    assert.ok(tree, '有活跃任务时必须渲染 tag')
    assert.equal(tree.type, 'button', 'chip 是 button：那个叉要能点')
    assert.equal(collectText(tree).join(''), '调试', 'tag 上的文字就是「调试」')
    assert.equal(collectByType(tree, 'svg').length, 1, '关闭图标用内联 SVG，不用字符图标')
    assert.ok(String(tree.props['aria-label'] ?? '').length > 0,
      '按钮必须有无障碍名字：眼睛看到的是叉，屏幕阅读器要听到动作')
    assert.equal(tree.props['data-debug-status'], 'active', '状态放在 data 属性上，供面板/排查识别')

    // [!] 叉的语义与窗口：表态 = 「问题已解决」，且**不等 awaiting-user**。
    // 这正是"进了调试就出不来"那个反馈的修复点：POST /resolve 多带 anytime: true。
    calls.length = 0
    tree.props.onClick()
    await settle()
    const posts = calls.filter((call) => call.init?.method === 'POST')
    assert.equal(posts.length, 1, '点一次叉只发一次表态')
    assert.ok(posts[0].url.endsWith('/dsh-debug-mode/resolve'),
      '叉走既有的 /resolve（同一个 resolved 表态），不新开第二条语义')
    assert.deepEqual(JSON.parse(posts[0].init.body),
      { hash: 'deadbeef', sessionId: 's1', anytime: true },
      'anytime: true 是它能在任意状态表态的载体；面板按钮不带这个标记')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/**
 * `SlotCore.register` 对 `kind: "single"` 的真实语义（逐字抄自
 * `@deepseek-ai/dsh-web-frontend` 的 `SlotCore`）：
 *
 *     case "single": {
 *       const m = i.entries.find(g => (g.options.priority ?? 0) === c)
 *       if (m) throw new Error(`single slot "${t.name}" already has a registration ...`)
 *     }
 *
 * 它**抛错**（不是"后来者顶掉前者"）。这正是 2026-10-13 那次启动崩溃的根因：
 * 我们按 priority 0 进了 `conversation.input.plan`，轮到首方 Plan 插件注册时它抛错、
 * entry 起不来，web boot 直接断言失败。
 *
 * 这个替身实现的**唯一职责**就是照抄那一条判据：单占用座位 + 同 priority 第二次注册 = 抛。
 * 于是这里能证明一件真事——**把我们两个 cell 注册进去，不会让任何后续注册者抛错**。
 */
function singleKindGuard() {
  const entries = []
  return {
    registered: entries,
    register(options) {
      if (SINGLE_SEATS.has(options.name)) {
        const priority = options.priority ?? 0
        const occupied = entries.find(
          (entry) => entry.name === options.name && (entry.priority ?? 0) === priority)
        if (occupied) {
          throw new Error(`single slot "${options.name}" already has a registration `
            + `at priority ${priority} (registered by ${occupied.id})`)
        }
      }
      entries.push(options)
      return () => undefined
    },
  }
}

/** 首方声明为 `kind: "single"` 的输入行座位：在这些格子上注册第二个 occupant = 抛错。 */
const SINGLE_SEATS = new Set([
  'conversation.input.plan',
  'conversation.input.permission',
  'conversation.input.model',
  'conversation.input.activity',
  'conversation.input.attachments',
])

test('本插件不会占任何 single 座位：那会让首方插件注册时抛错、把启动打崩', async () => {
  const { exportsObject } = await loadExports()
  const { registers } = mountPanel(exportsObject)

  for (const { options } of registers) {
    assert.ok(!SINGLE_SEATS.has(options.name),
      `${options.name} 是 kind:"single" 座位：在同一个 priority 上注册第二次会抛错，`
      + '首方插件因此装配失败、web boot 崩掉（2026-10-13 实测事故）')
  }

  // 行为证明：用照抄了那条判据的替身，把我们两个 cell 注册进去，再让"首方"注册一次。
  const guard = singleKindGuard()
  for (const { options } of registers) guard.register(options)
  assert.doesNotThrow(() => {
    // 模拟首方 Plan chip 在同一 priority (0) 上注册它自己的 cell。
    guard.register({ name: 'conversation.input.plan', id: 'plan-mode-control', order: 0 })
  }, '本插件占过的座位必须经得起首方随后注册——否则崩的就是启动')
})

test('没有会话或没有任务时渲染空（不得在每会话挂空壳）', async () => {
  const { exportsObject } = await loadExports()
  const { panel } = mountPanel(exportsObject)

  const noSession = await react.run(() => panel({}))
  assert.equal(noSession, null, '没有 sessionId 应渲染 null')

  // fetch 返回「没有任务」时同样必须渲染空。
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ task: null }) })
  try {
    const noTask = await react.run(() => panel({ sessionId: 's1' }))
    assert.equal(noTask, null, '没有活跃任务时应渲染 null')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** 从 createElement 树里收集所有文本节点（用于断言面板文案）。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  collectText(node.children ?? [], out)
  return out
}

/** 按 className 取元素（头部折叠键与两个动作键都是 button，必须分得开）。 */
function collectByClass(node, className, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectByClass(child, className, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (String(node.props?.className ?? '').split(/\s+/).includes(className)) out.push(node)
  collectByClass(node.children ?? [], className, out)
  return out
}

/** 两个「做结论」的按钮（不含头部那个折叠键）。 */
const collectActionButtons = (node) => collectByClass(node, 'dsh-dbg-btn')
/** 头部的折叠键。 */
const collectHeadButton = (node) => collectByClass(node, 'dsh-dbg-head')[0]
/** 复现步骤清单项（`li` 要在 `ol` 里找；不去猜 children 的嵌套形状）。 */
const collectSteps = (node) => collectByType(node, 'li')

/** 按元素标签取节点。 */
function collectByType(node, type, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (node.type === type) out.push(node)
  collectByType(node.children ?? [], type, out)
  return out
}

test('awaiting-user 时给出两个可用按钮；有草稿时禁用（竞态防护）', async () => {
  const { exportsObject } = await loadExports()
  const { panel } = mountPanel(exportsObject)
  const task = {
    hash: 'deadbeef',
    round: 2,
    status: 'awaiting-user',
    headline: 'total 在 items 为空时算成了 null',
    reproSteps: ['打开保存对话框', '清空标题后点保存', '回到列表页'],
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ task }) })
  try {
    // InputState 的字段名是**实测**的（`SessionInputShell.compose()`）：`draft` + `attachmentIds`。
    const idle = await react.run(() => panel({ sessionId: 's1', useInput: () => ({ draft: '', attachmentIds: [] }) }))
    const buttons = collectActionButtons(idle)
    assert.equal(buttons.length, 2, 'awaiting-user 应给出两个按钮')
    assert.deepEqual(buttons.map((b) => b.children[0]), ['问题已解决', '问题复现，需要进一步修复'])
    assert.ok(buttons.every((b) => b.props.disabled === false), '草稿为空时两个按钮都应可用')

    const typing = await react.run(() =>
      panel({ sessionId: 's1', useInput: () => ({ draft: '只在切换标签页后复现', attachmentIds: [] }) }))
    const typingButtons = collectActionButtons(typing)
    assert.equal(typingButtons.length, 2)
    assert.ok(typingButtons.every((b) => b.props.disabled === true),
      '输入框有未发送内容时必须禁用两个按钮，避免同一条描述送两遍')

    // 「只挂了附件、没打字」同样是未发送内容：点按钮会把同一条信息送两遍。
    const attached = await react.run(() =>
      panel({ sessionId: 's1', useInput: () => ({ draft: '   ', attachmentIds: ['a1'] }) }))
    assert.ok(collectActionButtons(attached).every((b) => b.props.disabled === true),
      '只有附件（草稿为空白）时也必须禁用')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('面板内容 = 一句简短回复 + 可照做的复现步骤清单', async () => {
  const { exportsObject } = await loadExports()
  const { panel } = mountPanel(exportsObject)
  const task = {
    hash: 'deadbeef',
    round: 2,
    status: 'awaiting-user',
    headline: 'total 在 items 为空时算成了 null',
    reproSteps: ['打开保存对话框', '清空标题后点保存', '回到列表页'],
    lastReport: '很长很长的分析正文……',
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ task }) })
  try {
    const tree = await react.run(() => panel({ sessionId: 's1', useInput: () => ({ draft: '' }) }))

    // ① 一句简短的回复：就是 headline，不是整篇 analysis。
    const texts = collectText(tree)
    assert.ok(texts.includes('total 在 items 为空时算成了 null'), '标题句必须原样显示')
    assert.ok(!texts.includes(task.lastReport), '不能把整篇分析倒进面板——那正是"不简短"的来源')

    // ② 复现步骤做成编号清单（ol/li），用户照着做就能复现。
    const lists = collectByClass(tree, 'dsh-dbg-steps')
    assert.equal(lists.length, 1)
    assert.equal(lists[0].type, 'ol', '步骤必须是编号列表，不是一段散文')
    assert.deepEqual(collectSteps(tree).map((item) => item.children[0]), task.reproSteps)

    // ③ 没有步骤时不留白：说清该做什么，而不是给个按钮让用户发呆。
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ task: { ...task, reproSteps: [] } }),
    })
    const noSteps = await react.run(() => panel({ sessionId: 's1', useInput: () => ({ draft: '' }) }))
    assert.equal(collectByClass(noSteps, 'dsh-dbg-steps').length, 0)
    assert.match(collectText(noSteps).join('\n'), /再复现一次/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('折叠：只有轮到用户时自动展开；头部可手动折叠/展开；状态一变回到默认策略', async () => {
  const { exportsObject } = await loadExports()
  const { panel } = mountPanel(exportsObject)

  const originalFetch = globalThis.fetch
  /** 把宿主的 /state 换成"当前任务是这一个"。 */
  const serveTask = (task) => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ task }) })
  }
  const render = () => panel({ sessionId: 's1', useInput: () => ({ draft: '' }) })
  try {
    // ① 轮到用户 → 自动展开（这是唯一需要他动手的时刻）。
    serveTask({ hash: 'deadbeef', round: 1, status: 'awaiting-user', headline: '结论' })
    const waiting = await react.run(render)
    assert.equal(waiting.props['data-collapsed'], 'false', 'awaiting-user 必须自动展开')
    assert.equal(collectActionButtons(waiting).length, 2)

    // ② 其它状态 → 自动收起，只留一行状态；但那一行自己必须说清现在轮到谁。
    serveTask({ hash: 'deadbeef', round: 1, status: 'active', headline: '结论' })
    const running = await react.run(render)
    assert.equal(running.props['data-collapsed'], 'true', '不占输入框上方的地方')
    assert.equal(collectActionButtons(running).length, 0)
    const runningText = collectText(running).join('\n')
    assert.match(runningText, /Agent 正在埋点\/排查/, '折叠后仍要知道 Agent 在干嘛')
    assert.ok(!runningText.includes('结论'), '折叠时不该渲染正文')

    // ③ 头部可点：同一个实例里点一下，卡片就折起来；再点一下展开回来。
    serveTask({ hash: 'deadbeef', round: 1, status: 'awaiting-user', headline: '结论' })
    let folded = false
    const collapsedTree = await react.run(render, 6, (value) => {
      if (folded || value?.props?.['data-collapsed'] !== 'false') return
      folded = true
      collectHeadButton(value)?.props.onClick()
    })
    assert.equal(folded, true, '第一轮应该拿到了展开态')
    assert.equal(collapsedTree.props['data-collapsed'], 'true', '点一次头部应把卡片折起来')
    assert.equal(collectActionButtons(collapsedTree).length, 0)
    assert.match(collectText(collapsedTree).join('\n'), /轮到你复现并选择/, '折起来也还得看得见该你动手了')

    let unfolded = false
    const expandedTree = await react.run(render, 8, (value) => {
      // 先折起来，再展开——验证两个方向都有效。
      if (!unfolded && value?.props?.['data-collapsed'] === 'false') {
        collectHeadButton(value)?.props.onClick()
        return
      }
      if (!unfolded && value?.props?.['data-collapsed'] === 'true') {
        unfolded = true
        collectHeadButton(value)?.props.onClick()
      }
    })
    assert.equal(unfolded, true, '折起来之后应该能再展开')
    assert.equal(expandedTree.props['data-collapsed'], 'false')
    assert.equal(collectActionButtons(expandedTree).length, 2)

    // ④ awaiting-agent 两种收尾态：折叠态那一行也要能区分开。
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ task: { hash: 'deadbeef', round: 2, status: 'awaiting-agent', userVerdict: 'resolved' } }),
    })
    const resolved = await react.run(() => panel({ sessionId: 's1' }))
    assert.match(collectText(resolved).join('\n'), /已通知 Agent 清理探针/)
    assert.equal(collectActionButtons(resolved).length, 0, 'awaiting-agent 时不该再给按钮（防连点）')

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ task: { hash: 'deadbeef', round: 2, status: 'awaiting-agent', userVerdict: 'reproduced' } }),
    })
    const reproduced = await react.run(() => panel({ sessionId: 's1' }))
    assert.match(collectText(reproduced).join('\n'), /已通知 Agent 读日志/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('两个按钮把用户的二选一 POST 回宿主（的路由表）', async () => {
  const { exportsObject } = await loadExports()
  const { panel } = mountPanel(exportsObject)
  const task = { hash: 'deadbeef', round: 1, status: 'awaiting-user' }

  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (String(url).includes('/state')) return { ok: true, json: async () => ({ task }) }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    const tree = await react.run(() => panel({ sessionId: 's1', useInput: () => ({ draft: '' }) }))
    const buttons = collectActionButtons(tree)

    buttons[0].props.onClick()
    await settle()
    buttons[1].props.onClick()
    await settle()

    const posts = calls.filter((call) => call.init?.method === 'POST')
    assert.equal(posts.length, 2)
    assert.ok(posts[0].url.endsWith('/dsh-debug-mode/resolve'))
    assert.ok(posts[1].url.endsWith('/dsh-debug-mode/reproduce'))
    assert.deepEqual(JSON.parse(posts[0].init.body), { hash: 'deadbeef', sessionId: 's1' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('宿主说"残留检测未生效"时，面板必须把它显示出来（绝不假装保护着）', async () => {
  const { exportsObject } = await loadExports()
  const { panel } = mountPanel(exportsObject)
  const task = {
    hash: 'deadbeef',
    round: 1,
    status: 'awaiting-user',
    detector: { available: false, writeProbe: false, writeProbeError: 'EACCES' },
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ task }) })
  try {
    const tree = await react.run(() => panel({ sessionId: 's1', useInput: () => ({ draft: '' }) }))
    const text = collectText(tree).join('\n')
    assert.match(text, /残留检测未生效/)
    assert.match(text, /EACCES/)

    // 反例：检测可用时不该出现这条告警（否则用户会习惯性忽略它）。
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ task: { ...task, detector: { available: true, writeProbe: true } } }),
    })
    const healthy = await react.run(() => panel({
      sessionId: 's1',
      useInput: () => ({ draft: '' }),
    }))
    assert.ok(!/残留检测未生效/.test(collectText(healthy).join('\n')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('产物与源码同步（改了 src 忘了重新构建就会红）', async () => {
  const result = spawnSync(NODE, [BUILD], { encoding: 'utf8' })
  assert.equal(result.status, 0, `构建失败：${result.stderr}`)
  const after = await readFile(BUNDLE, 'utf8')
  const source = await readFile(SRC, 'utf8')

  assert.ok(source.includes('export function apply(ctx)'), '源码应声明 export function apply(ctx)')
  assert.ok(after.includes('exports.apply = apply;'), '产物应登记 exports.apply')
  assert.ok(after.includes('exports.inject = inject;'), '产物应登记 exports.inject')
  assert.ok(after.includes('require("react")'), '产物应把 import 改写成 require')
  assert.ok(!/^\s*import\s/m.test(after), '产物里不得残留 import 语句')
  assert.ok(!/^\s*export\s/m.test(after), '产物里不得残留 export 语句')
})

test('构建脚本维护平台模块白名单并且失败即非零退出', async () => {
  const script = await readFile(BUILD, 'utf8')
  assert.ok(script.includes('PLATFORM_MODULES'), '构建脚本应维护平台模块白名单')
  for (const name of ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-slots']) {
    assert.ok(script.includes(`'${name}'`), `白名单应包含 ${name}`)
  }
  assert.ok(script.includes('不允许的导入'), '构建脚本应对白名单外导入给出可读报错')
  assert.ok(script.includes('process.exit(1)'), '构建脚本失败时必须非零退出（否则 CI 看不出来）')
})

test('源码没有误用宿主别通道的 API', async () => {
  const raw = await readFile(SRC, 'utf8')
  // 注释里会提到这些名字（用来解释「没有它们」），所以先剥掉注释再查。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.ok(!code.includes('host.call'), '包通道没有 host.call（那是动态通道的 API）')
  assert.ok(!code.includes('styles.insert'), '包通道没有 styles.insert')
  // 只允许 import 'react'（平台种子表）。
  const imports = [...raw.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(imports, ['react'])
})
