/**
 * lib/tools.js —— 5 个 `dsh_debug_*` 信号工具。
 *
 * 三个必须照做的契约细节（都是实验核实过的，不是风格选择）：
 *
 *   1. **参数是普通 JSON Schema，不是 zod**；而且宿主只支持一个**子集**
 *      （`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解）。
 * 多写一个关键字，注册时就会抛 `JsonSchemaError`（`output.schema` 在 register
 * 时就被校验，`parameters` 在投影给模型时被校验）。
 *   2. **`output` 是必填的**，模型看到的文本由 `output.render(args, value)` 产出，
 * 不是 `execute` 的返回值。而且 `execute` 的返回值会被
 *      **对着 `output.schema` 校验**——返回值必须真的符合 schema，否则整次调用变成
 *      `ToolOutputError`。
 *   3. **必须在 agent 作用域注册**：工具对所有会话可见这件事无法按会话动态
 * 开关，所以「只有 /debug 能进入」只能靠宿主侧票据校验（`service.start`）。
 * 在 `apply(ctx)` 里裸注册就是全局可见，等于把这条约束作废。
 *
 * 返回值形状统一为 `{ ok, text, ...机器字段 }`：`text` 是给模型看的正文（由 service
 * 组装，那里才知道全部上下文），其余字段给面板与测试用。`render` 只做投影。
 */

const NO_AGENT_TEXT = '这个工具需要一个拥有会话身份的调用者（exec.agent 缺失）。'

/** 统一的 `parameters` 顶层形状。 */
function parameters(properties) {
  return { type: 'object', properties }
}

/**
 * 统一的 `output.schema`：**只声明可能出现的键，且不声明 required**。
 *
 * 为什么不声明 `required`：`output.schema` 会被宿主用来校验 `execute` 的返回值，
 * 失败即 `ToolOutputError`。把"失败"排除在外比多一条 `required` 有价值得多——
 * 工具的错误路径恰恰是最需要被模型读到的地方。
 */
function outputSchema(extraProperties = {}) {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: '信号是否被接受' },
      text: { type: 'string', description: '给模型看的正文（模型实际读到的就是它）' },
      hash: { type: 'string', description: '任务哈希' },
      round: { type: 'number', description: '当前轮次' },
      status: { type: 'string', description: '任务状态' },
      ...extraProperties,
    },
  }
}

/** 只做投影：正文由 service 组装，render 负责把它变成 ContentBlock[]。 */
function render(_args, value) {
  return [{ type: 'text', text: String(value?.text ?? '(无输出)') }]
}

/** 把 args 收窄成安全对象（原始注册不做参数校验，工具自己必须防）。 */
function asObject(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

/** 调用上下文里取出会话身份与工作区（与首方工具同一套取值方式）。 */
function contextOf(exec) {
  const agent = exec?.agent
  return {
    sessionId: agent?.id,
    workspace: agent?.session?.header?.cwd,
  }
}

/**
 * 造 5 个工具定义。
 *
 * @param {import('./debug-service.js').DebugService} service
 * @returns {object[]} 可直接交给 `ctx.tools.register()` 的定义
 */
export function toolDefinitions(service) {
  return [
    {
      name: 'dsh_debug_start',
      description: '进入调试模式：为本次调试任务分配哈希与日志文件，并返回埋点指南。'
        + '需要用户先用 /debug 授权（宿主会校验一次性票据），无票调用一律被拒。',
      parameters: parameters({
        goal: {
          type: 'string',
          description: '需求描述：现象、期望与复现路径。直接抄用户的说法，不要自己概括。',
        },
      }),
      output: {
        schema: outputSchema({
          probeStub: { type: 'string', description: '探针桩绝对路径' },
          probeImport: { type: 'string', description: '可直接 import 的说明符（file:// 形式）' },
          logPath: { type: 'string', description: '日志文件绝对路径' },
          reused: { type: 'boolean', description: '是否返回了既有任务而没有新建' },
          // 产物现在可能住在用户临时目录里，所以"落在哪儿"本身是模型要知道的信息：
          // 回退到工作区时必须能被看见（AGENTS.md §1.1 第 15 条）。
          artifactRoot: { type: 'string', description: '产物根绝对路径（临时目录，或回退后的工作区路径）' },
          artifactRootKind: { type: 'string', description: "产物根种类：'temp' 或 'workspace'" },
          taskDir: { type: 'string', description: '本次任务目录绝对路径' },
          browserStubUrl: { type: 'string', description: '浏览器桩的宿主 URL（拿不到宿主地址时为空）' },
        }),
        render,
      },
      async execute(args, exec) {
        const { sessionId, workspace } = contextOf(exec)
        if (!sessionId) return { ok: false, text: NO_AGENT_TEXT }
        const input = asObject(args)
        return service.start({
          sessionId,
          workspace,
          goal: String(input.goal ?? ''),
        })
      },
    },
    {
      name: 'dsh_debug_report',
      description: '汇报本轮埋点 = 交卷：记录分析结论与探针清单，然后把球交给用户复现。'
        + '调用它之后必须停手，不要在同一轮里既埋点又猜结论。',
      parameters: parameters({
        analysis: { type: 'string', description: '本轮的分析结论：验证/推翻了哪条假设，看到了什么。' },
        headline: {
          type: 'string',
          description: '一句话结论（尽量 ≤ 80 字），面板顶部就显示这一句。'
            + '省略时宿主拿 analysis 的第一行兜底，但第一行往往不是"一句话"，所以请显式给。',
        },
        reproSteps: {
          type: 'array',
          items: { type: 'string' },
          description: '让用户复现的具体步骤，**一条一个可执行动作**（"打开保存对话框"、"清空标题后点保存"）。'
            + '面板会把它做成编号清单，用户照着做就能把现象弄出来。'
            + '别写"请复现一下"这种话——那不是步骤，是愿望。',
        },
        probeFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '本轮**加了探针**的文件（仓库相对路径）。收尾时宿主据此核对探针是否摘干净。',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '本轮**改了行为**的文件。与探针账分开记：收尾时这些**不会**被回滚。',
        },
        probes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              probe: { type: 'string', description: '探针标识，与埋进代码里的那一个逐字一致' },
              why: { type: 'string', description: '这处探针是为了证实/证伪哪条假设' },
            },
          },
          description: '本轮埋下的探针清单；读日志时宿主会用它点名"计数为 0"的探针。',
        },
        undoHint: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              find: { type: 'string', description: '要替换掉的精确文本，必须在文件里唯一存在' },
              replace: { type: 'string' },
            },
          },
          description: '临时探索改动的精确还原点。宿主只校验并列出，**绝不自动应用**。',
        },
      }),
      output: {
        schema: outputSchema({
          changedFiles: { type: 'array', items: { type: 'string' } },
          probeFiles: { type: 'array', items: { type: 'string' } },
          strayArtifacts: { type: 'array', items: { type: 'string' } },
        }),
        render,
      },
      async execute(args, exec) {
        const { sessionId, workspace } = contextOf(exec)
        if (!sessionId) return { ok: false, text: NO_AGENT_TEXT }
        const input = asObject(args)
        return service.report({
          sessionId,
          workspace,
          analysis: String(input.analysis ?? ''),
          headline: input.headline,
          reproSteps: input.reproSteps,
          probeFiles: input.probeFiles,
          changedFiles: input.changedFiles,
          probes: input.probes,
          undoHint: input.undoHint,
        })
      },
    },
    {
      name: 'dsh_debug_continue',
      description: '进一步调试：开始下一轮（哈希与目录不变），并**清空上一轮的日志**。'
        + '清空是破坏性的，所以宿主会先检查日志里还有没有你没读过的内容——'
        + '顺序必须是先 `dsh_debug_read` 再 `dsh_debug_continue`。'
        + '第 2 轮起才可以"先按假设改代码、再埋点验证"。',
      parameters: parameters({
        nextPlan: { type: 'string', description: '下一轮的假设与计划；连续无新证据时它会被要求必填。' },
      }),
      output: {
        schema: outputSchema({ logPath: { type: 'string' } }),
        render,
      },
      async execute(args, exec) {
        const { sessionId, workspace } = contextOf(exec)
        if (!sessionId) return { ok: false, text: NO_AGENT_TEXT }
        const input = asObject(args)
        return service.continueDebug({ sessionId, workspace, nextPlan: input.nextPlan })
      },
    },
    {
      name: 'dsh_debug_read',
      description: '读取探针日志（摘要优先：分组计数、异常全量、省略量显式）。'
        + '不要自己去读日志文件——路径与分组信息在这里才有。',
      parameters: parameters({
        limit: { type: 'number', description: '时间序最多给多少条，默认 200。warn/error 不受它影响。' },
        level: { type: 'string', enum: ['trace', 'debug', 'info', 'warn', 'error'], description: '只看某一级别' },
        probe: { type: 'string', description: '只看匹配这个标识的探针（前缀或子串匹配）' },
      }),
      output: {
        schema: outputSchema({ lines: { type: 'number', description: '日志总行数' } }),
        render,
      },
      async execute(args, exec) {
        const { sessionId, workspace } = contextOf(exec)
        if (!sessionId) return { ok: false, text: NO_AGENT_TEXT }
        const input = asObject(args)
        return service.read({
          sessionId,
          workspace,
          limit: typeof input.limit === 'number' ? input.limit : undefined,
          level: typeof input.level === 'string' ? input.level : undefined,
          probe: typeof input.probe === 'string' ? input.probe : undefined,
        })
      },
    },
    {
      name: 'dsh_debug_end',
      description: '结束调试并收尾：宿主按 `dsh-debug:probe <hash>` 标记摘除本次任务的全部探针块，'
        + '删除任务目录；**不会**回滚你的修复。要求用户已经在面板上选择过「问题已解决」。',
      parameters: parameters({
        summary: { type: 'string', description: '本次调试的结论与修复说明（写给用户看）。' },
        cleanedFiles: { type: 'array', items: { type: 'string' }, description: '你期望被清理的文件清单' },
        verified: { type: 'boolean', description: '是否已经验证过修复（false 时宿主会在结果里点名）' },
        quarantine: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'number' },
              hash: { type: 'string' },
              decision: { type: 'string', enum: ['keep', 'delete', 'mine'] },
            },
          },
          description: '隔离区逐条决定：keep 保留 / delete 删除（先给用户看 diff）/ mine 用户自己处理。',
        },
      }),
      output: {
        schema: outputSchema({
          cleanedFiles: { type: 'array', items: { type: 'string' } },
          keptFiles: { type: 'array', items: { type: 'string' } },
          residualFiles: { type: 'array', items: { type: 'string' } },
          needsDecision: { type: 'boolean', description: '隔离区还有条目没决定，收尾被暂停' },
        }),
        render,
      },
      async execute(args, exec) {
        const { sessionId, workspace } = contextOf(exec)
        if (!sessionId) return { ok: false, text: NO_AGENT_TEXT }
        const input = asObject(args)
        return service.end({
          sessionId,
          workspace,
          summary: String(input.summary ?? ''),
          cleanedFiles: input.cleanedFiles,
          verified: input.verified,
          quarantine: input.quarantine,
        })
      },
    },
  ]
}

/**
 * 在**当前作用域**注册 5 个工具。
 *
 * 调用点必须是 agent 作用域（`agent.ctx.inject(['tools'], ctx => registerTools(ctx, service, id))`），
 * 这样注册随会话存活、随会话释放，且将来能用 `restrict()` 按会话收窄可见性。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 已注入 tools 的作用域上下文
 * @param {import('./debug-service.js').DebugService} service
 * @returns {Array<() => void>} disposers
 */
export function registerTools(ctx, service) {
  return toolDefinitions(service).map((definition) => ctx.tools.register(definition))
}
