# dsh-plugin-debug-mode · 设计文档

> 状态：**设计冻结稿（v0.1）**。本文只描述设计与契约，不描述实现进度；
> 实现进度见 §14 路线图与 §15 待验证清单；防堆屎山的机制见 §16。
> 任何与本文件冲突的实现，一律以本文件为准，或先改本文件再改代码。

---

## 1. 背景与目标

### 1.1 灵感的来源

Cursor Agent 的 Debug 模式解决的是一个非常具体的问题：**用户描述的现象发生在
自己的运行环境里，而 Agent 看不见那个环境**。用户说「点了保存之后列表偶尔不刷新」，
Agent 只能读代码猜；猜错一轮，用户再复述一遍现象，一轮一轮烧的都是人的耐心。

Debug 模式的答案是：**别猜，让 Agent 自己在代码里埋探针，把现场取回来。**

### 1.2 本插件要做什么

给 DSH 提供一个「调试任务」的一等公民概念：

1. Agent 按需求描述**主动分析并埋点**（不是用户手工加 print）；
2. 探针按**固定的行协议**把现场写进一个专属日志文件，位置可预期、格式可机读；
3. 日志内容由插件**主动喂给 Agent**（Agent 不需要自己找文件、读文件）；
4. 用户复现后，在一个**弹出的面板**上做二选一：
   「问题已解决」→ 收工清理；「问题复现，需要进一步修复」→ 清空日志、再来一轮；
5. 用户说「已解决」时，Agent 必须**删掉本次任务埋下的全部探针代码**——
   调试的产物不许留在代码库里。

### 1.3 非目标（明确不做）

| 不做 | 原因 |
| --- | --- |
| 不做断点/单步/变量监视 | 那是 IDE 的活；这里的「调试」= 结构化日志取证 |
| 不做日志的可视化分析面板（图表、时间轴） | MVP 只需要用户做一次二选一 |
| 不自动启动被调试程序 / 不代跑测试 | 怎么跑起来是项目的知识，由 Agent 决定 |
| 不长期保存调试日志 | 日志是取证材料，不是数据资产；任务关闭即删除 |
| 不替 Agent 决定在哪埋点 | 「分析」是 Agent 的核心价值，插件只提供协议与管道 |

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| **调试任务（task）** | 一次「从进入调试模式到问题解决」的全过程，跨任意多轮。由 `hash` 唯一标识 |
| **轮次（round）** | 任务内的一次「埋点 → 复现 → 读日志 → 改代码」循环，从 1 开始 |
| **信号（signal）** | 推动任务状态机前进的动作。分两类：**Agent 信号**（由工具调用触发）与**用户信号**（由面板按钮触发） |
| **探针（probe）** | 埋进业务代码里的一处可观测点，调用探针运行时按协议写一行日志 |
| **探针块（probe block）** | 探针代码 + `dsh-debug:probe <hash> start/end` 标记；结束调试时按块删除 |
| **探针桩（probe stub）** | 宿主生成的零依赖小模块，业务代码 import 它来写日志（默认 `runtime/probe.mjs`） |
| **取证件（artifact）** | 任务目录 `.dsh/debug-mode/tasks/<hash>/` 下的全部运行期文件 |

---

## 3. 入口：只有 `/debug` 命令

### 3.1 结论

用户侧进入调试模式的入口**有且只有一个**：斜杠命令 `/debug <现象描述>`。

不做对话意图识别，不做工具栏按钮，不做「Agent 自己判断该调试了」。理由：
**埋探针是在改用户的代码库**，这个动作必须由用户显式发起，而不是由模型推断出来。

### 3.2 三层结构（别混淆「入口」与「门槛」）

| 层 | 载体 | 谁能触发 |
| --- | --- | --- |
| **A. 用户侧入口** | `/debug <现象描述>` | 用户（唯一） |
| **B. Agent 侧门槛** | `dsh_debug_start` 工具 | Agent——但**必须持票**才能通过 |
| **C. 系统动作** | 分配哈希、建目录、生成探针桩 | 宿主 |

技术上唯一能翻转状态机的仍是 B（工具调用）；A 不是「绕过 Agent 直接开工」，
而是**给这个会话发一张一次性票**。

### 3.3 闸门票据（`ticket`）——防止 Agent 滥用的硬校验

**这是本节的核心机制，不是提示词约定。**

- `dsh_debug_*` 工具对所有会话**始终可见**（已核实：工具的可见性是注册作用域级，
  无法按会话动态开关）。因此「只有 `/debug` 能进入」**必须**在宿主侧强制执行，
  写进系统提示词是拦不住模型的。
- 会话无票时调用 `dsh_debug_start` → **直接拒绝**，返回：

```
未进入调试模式：本插件不允许 Agent 自行发起调试任务。
请让用户输入 `/debug <现象描述>` 后再调用本工具。
```

  这条文案是给**模型**看的纠正指令，也是给用户看的解释。
- 票据只有 `/debug` 命令的处理器能签发，宿主内部写，不接受任何工具参数伪造。

### 3.4 票据的生命周期

| 事件 | 行为 |
| --- | --- |
| `/debug <描述>` | 签发票据（记录 `sessionId` / `text` / `issuedAt`），并把一段指令文本作为**命令结果**投给 Agent |
| `dsh_debug_start` 成功 | **票据被消费**（一次性） |
| `dsh_debug_start` 被拒 | 票据**不消费**（用户不用重新敲一遍） |
| 会话已有活跃任务时再 `/debug` | 拒绝签发，明确提示：任务 `#hash` 仍在进行，先解决或用面板继续 |
| 票据超过 TTL（默认 30 分钟） | 失效（防止陈旧票据被后到的调用用掉） |
| 会话结束 | 票据清除 |

持久化位置：`.dsh/debug-mode/pending/<sessionId>.json`（小文件，删任务目录时一并清理）。

### 3.5 `/debug` 命令的契约（已核实 `ctx.commands`）

```ts
ctx.commands.register({
  name: 'debug',
  description: '进入调试模式：让 Agent 分析问题并主动在代码库里埋探针',
  input: { hint: '<现象描述：什么操作、什么预期、实际发生了什么>' },
  handler(invocation) {
    // invocation.agent.id —— 唯一可信的会话身份
    // invocation.rawInput —— 用户敲的描述原文
    return { kind: 'success', text: '…给 Agent 的指令…' }
  },
})
```

- `CommandDefinition = { definitionId?, name, description, input?: { hint, attachments? },
  recordInput?, handler }`；`handler` 返回
  `{ kind:'success', text? } | { kind:'error', text }`。
- **`kind:'success'` 的 `text` 就是投给 Agent 的指令正文**——命令是「被解析执行、
  不发给模型」的，所以这段文本是宿主放进去的固定内容，用户敲的描述作为数据附在后面。
  这正是闸门确定性的来源：指令长什么样由插件说了算。
- 命令注册的上下文决定可见性："Plain-context definitions are global"，
  通过 command-injected 的 agent 子上下文注册可只对那个 agent 生效。
  本插件注册**全局**命令（所有会话都能敲 `/debug`）。
- 命令不该干重活：`/debug` 只做三件事——检查有无活跃任务、签票、返回指令文本。
  任务创建仍然发生在 `dsh_debug_start` 里。

### 3.6 被这个决定顺带砍掉的复杂度

早先设计过一条「Agent 自行判断时，先进入 `awaiting-user` 让用户确认」的路径。
既然入口收束成 `/debug`，**用户敲命令这个动作本身就是同意**，
所以不再需要「待确认」状态：`dsh_debug_start` 持票通过即直接 `active`。

状态机因此仍然是四态（不含 `closed`）：
`active` / `awaiting-user` / `awaiting-agent` / `closed`，
`awaiting-user` 的语义收敛为**纯粹的「等用户复现后二选一」**。

### 3.7 Agent 可以拒绝进入调试（一眼能看出根因时）

`/debug` 是**用户发起**的，但不是命令，不是契约。如果 Agent 读完代码就看出根因
（空指针、明显拼写错误、缺一次 `await`、写死的常量……），它应当：

1. **不调用** `dsh_debug_start`；
2. 直接说明「这个问题不需要调试模式」+ 根因 + 给出验证方式，并**直接改代码**。

机制上什么都不用做：票据本来就是一次性且带 TTL 的，**放着不用就会自己过期**。
宿主不把「拒签」当成异常，也不写任何状态——所以也不存在「拒绝了要清理」的问题。

这条与 §3.3 的闸门并不冲突，反而互补：

| 闸门管的是 | 拒绝管的是 |
| --- | --- |
| Agent **不能自己发起**调试（必须用户 `/debug`） | 用户发起了，Agent **仍可判断不需要** |

代价对比很直接：一次调试要用户复现、要埋点、要读日志；一眼能看出的问题直接修完
更省用户时间。**不要为了走流程而走流程。**

### 3.8 调试期间的代码改动（**三条铁律 + 记账纪律**）

调试不只是「埋点 → 读日志」。**改代码本身也是调试手段**——尤其到了后面几轮，
你已经有日志在手，合理的做法往往是「先按假设改，再埋点验证」。

| 轮次 | 能不能改代码 | 规则 |
| --- | --- | --- |
| **第 1 轮** | **默认不能**（只取证） | 先改代码会**掩盖现场**：没看到数据之前猜的修法一旦改掉原始行为，后面的日志再也证不出真相 |
| **第 2 轮及以后** | **可以，鼓励** | 但改完**必须再埋点**，用日志证明「改之前复现、改之后不复现」或「现象变了」——不许改完就宣布修好 |

**记账纪律（收尾正确性的前提）**：

1. 探针用 `dsh-debug:probe <hash>` 包裹；**代码改动用 `dsh-debug:change <hash>` 标记**
   （前缀不同，收尾时才不会把用户的修复一起删掉）。
2. `dsh_debug_report` 除 `probeFiles` 外还要报 `changedFiles`（改过哪些文件）。
3. `dsh_debug_end` 的回复必须逐条列出三类账：
   **修复（保留）/ 探针（已删）/ 临时探索改动（已还原）**。
4. ⚠️ 收尾**只撤探针，不撤用户的修复**。用 `git checkout` / `git stash` 之类整体回滚
   是本设计**明令禁止**的收尾方式——它会连带 revert 掉用户要的修复。

因此 `lib/task.js` 的 `DebugTask` 需要多一个 `changedFiles` 字段（与 `probeFiles` 并列）：

- `probeFiles`：本次任务**加了探针**的文件 → 收尾时检查探针是否已摘干净；
- `changedFiles`：本次任务**改了行为**的文件 → 收尾时**不得**回滚，只做清单核对。

> 完整的 Agent 侧措辞在 `assets/AGENT-PROBE-GUIDE.md`（§一「三件事」、§三「改代码」、
> §四「拒绝进入」、§七「改动块写法」）。那里是**生成给 Agent 的正文**，
> 本节是宿主侧契约——两者必须同步改。

### 3.9 连带约束：调试准则只在调试模式下注入


⚠️ 系统提示词不能常驻「调试模式行为准则」（AGENTS.md §5）。否则
**没有进入调试模式的会话也会看到「你要埋点、用 dsh-debug:probe 标记」这类指令**，
那等于把入口约束从提示词层面又打开了一次。

正确做法：`systemPrompt.section` 的 `text` 用 thunk，**无活跃任务且无票据时返回空串**。

---

## 5. 设计原则与架构总览

```
┌──────────────────────────── 浏览器（lib/client.js）────────────────────────────┐
│  DebugPanel                                                                    │
│    · 显示：任务哈希 / 轮次 / 状态 / 日志行数 / Agent 的分析结论                 │
│    · 按钮：「问题已解决」「问题复现，需要进一步修复」                            │
│    · 通道：同源 fetch → /dsh-debug-mode/{state,resolve,reproduce}（**轮询**）   │
└───────────────────────────────────┬────────────────────────────────────────────┘
                    同源 HTTP（webServer 路由）│  面板每 1s 轮询 /state
┌───────────────────────────────────▼────────────────────────────────────────────┐
│                          宿主半（lib/index.js）                                 │
│                                                                                │
│  DebugService（唯一的真相持有者）                                               │
│    ├─ 任务表：sessionId → DebugTask（内存）+ state.json（跨重启恢复）           │
│    ├─ 信号处理：start / report / continue / read / end / (用户) resolve/reproduce│
│    ├─ 日志管道：建目录、清空、读取 + 归并摘要、限额                              │
│    └─ 唤醒通道：sessionController.prompt({ sessionId, mode:'queue', content })  │
│                                                                                │
│  注册面                                                                        │
│    ├─ ctx.commands.register  `/debug`（签票 + 投递指令文本，见 §3.5）            │
│    ├─ ctx.tools.register  × 5 个信号工具（**在 agent 作用域注册**，见 §6.2.1）   │
│    ├─ ctx.systemPrompt.section  调试准则（仅任务活跃时返回非空 text）            │
│    ├─ ctx.webServer.register  面板的 state / resolve / reproduce 路由           │
│    └─ ctx.on('session/event' | 'session/disposed')  任务表维护与清理            │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │ 文件系统（沙箱内）
┌───────────────────────────────────▼────────────────────────────────────────────┐
│  <repo>/.dsh/debug-mode/tasks/<hash>/                                          │
│    ├─ <hash>.log          探针日志（JSONL，一行一条）                           │
│    ├─ state.json          任务状态（跨进程重启可恢复）                          │
│    ├─ runtime/probe.mjs   探针桩（模板生成，零依赖）                            │
│    └─ AGENT-PROBE-GUIDE.md 本次任务的埋点指南（精简版）                         │
│                                                                                │
│  <repo>/**                探针块（Agent 写入业务代码，带 start/end 标记）        │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 三条设计原则

1. **宿主是唯一真相。** 浏览器面板不持有状态，只渲染 `GET /dsh-debug-mode/state`
   的返回；Agent 也不持有任务状态，只通过工具问宿主。任何一方的刷新/重连都不会丢状态。
2. **信号是幂等的、可重放的。** 同一个信号重复到达，必须落到同一个终态，
   不许产生第二份日志、第二个哈希、第二次清理。
3. **清理必须可证明。** 「已解决」意味着能列出被改动的文件、能验证探针块已归零；
   清不干净要说出来，而不是假装干净。

---

## 6. 信号协议

### 6.1 信号总表

| # | 信号 | 触发方 | 载体 | 前置状态 | 后置状态 | 哈希 | 日志文件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | **开门（签票）** | 用户 | `/debug <现象描述>` | 无活跃任务 | 不变（只签票） | 不分配 | 不创建 |
| S1 | **启动调试** | Agent（**须持票**） | `dsh_debug_start` | 有有效票据 | `active` (round=1) | **新建** | 新建（空） |
| S2 | **汇报埋点** | Agent | `dsh_debug_report` | `active` | `awaiting-user` | 不变 | 保留 |
| S3 | **进一步调试** | Agent | `dsh_debug_continue` | `active` / `awaiting-agent` | `active` (round+1) | **不变** | **清空** |
| S4 | **读取日志** | Agent | `dsh_debug_read` | 任意非 `closed` | 不变 | 不变 | 只读 |
| S4b | **用户打字描述现象** | 用户 | 原生输入框 | `awaiting-user` | `active`（宿主自动迁移，§9.3.2） | 不变 | 不变 |
| S5 | **用户：已解决** | 用户 | 面板按钮 | `awaiting-user` | `awaiting-agent` | 不变 | **保留待删** |
| S6 | **用户：复现** | 用户 | 面板按钮 | `awaiting-user` | `awaiting-agent` | 不变 | **清空** |
| S7 | **结束调试** | Agent（**须用户已表态**） | `dsh_debug_end` | `awaiting-agent` | `closed` | 不变 | **删除** |

> S0 是**闸门**而不是任务操作：它不分配哈希、不建目录、不生成桩，只在本会话签一张
> 一次性票（§3.3）。把闸门单独列出来，是为了让「谁有权进入调试模式」这件事在
> 信号表里一眼可见——只有 S0 能授权 S1。

> 关键取舍：S5/S6 是**用户信号**，但它们不直接删日志——它们只把 Agent 唤醒并
> 投递一条结构化指令。真正的删除动作在 S7（Agent 执行清理后确认）里发生。
> 理由：删除日志和删除探针代码必须一起发生才有意义；而探针代码只有 Agent 能删。
> 若由用户信号直接删日志，Agent 可能拿到一个「日志已消失但探针还在」的中间态。

### 6.2 工具契约

所有工具名固定前缀 `dsh_debug_`。**同一会话同时只允许一个活跃任务**：第二个 `start`
不新建任务，而是返回既有任务并提示改用 `continue`。

#### 6.2.1 工具注册的真实形状（已核实）

`ctx.tools.register(definition: ToolDefinition): () => void`，返回 disposer。要点：

- **参数是普通 JSON Schema 对象，不是 zod。**
  `ToolSchema.parameters: Record<string, unknown>`（`schema(scope?)` 与
  `host/Tool/listTools` 都证实是 `{"type":"object","properties":{...},"required":[...]}`）。
  zod 只用于 Config 与 storage domain，与工具参数无关。
- **`output` 是必填的**，模型看到的文本由它生成，不是 `execute` 的返回值：
  `output.render(args, value) => ContentBlock[]`，`output.schema` 描述结构化 `value`。
  `execute(args, exec)` 返回任意 JSON 值（`ToolExecutionSuccess.value`）。

#### 6.2.2 闸门：每个工具动手前都要先校验（**宿主侧硬校验**）

**每一个 `dsh_debug_*` 工具在动手前都要先做两件事**，这不是可选的礼貌检查：

```js
function requireActiveTask(sessionId) { /* 无任务 → 返回可读错误 */ }
```

- `dsh_debug_start` 额外要求 `tickets.consume(sessionId)` 成功；失败即拒绝（文案见 §3.3）。
- 其余四个工具要求该会话**已有活跃任务**；否则返回「本会话没有进行中的调试任务」。
- 两者都**不依赖模型自觉**：工具对所有会话可见（见 §6.2.1），提示词拦不住滥用，
  只有宿主侧的返回值能。
- 调用方身份：`exec.agent?.Agent → exec.agent.id` 就是当前 `SessionId`；
  兜底可用 `ctx.agents.currentInitiator()`。
- **按会话收窄可见性靠「注册作用域」，不是过滤参数**：`register` 在**调用方的
  agent 作用域**里注册；`restrict(filter)` 只能遮蔽**全局**工具。因此 5 个信号工具
  必须在 agent 作用域里注册（`agent/created` 是 serial 事件、`this: Scoped<Agent>`，
  是天然的挂载点），**不能**在插件自己的 `apply(ctx)` 里裸注册——那是全局可见。

```js
// 形状已核实（字段名与签名来自 cordis_inspect_query(host/Service)）；
// 具体数值与文案为本项目设计。
ctx.tools.register({
  name: 'dsh_debug_start',
  description: '进入调试模式：为本次调试任务分配哈希与日志文件，并返回埋点指南。',
  parameters: {
    type: 'object',
    properties: { goal: { type: 'string', description: '现象、期望与复现路径' } },
    required: ['goal'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        hash: { type: 'string' },
        round: { type: 'number' },
        logPath: { type: 'string' },
        probeStub: { type: 'string' },
      },
      required: ['hash', 'round'],
    },
    render: (_args, value) => [{ type: 'text', text: renderStartText(value) }],
  },
  async execute(args, exec) {
    const sessionId = exec.agent?.id
    return service.start({ sessionId, goal: args.goal })
  },
})
```

#### S1 `dsh_debug_start`

```
入参：{ goal: string }            // 需求描述：现象、期望、复现路径，直接抄用户的说法
前置：本会话必须持有 `/debug` 签发的有效票据（§3.3），否则拒绝
返回：
  状态行：已进入调试模式 · 任务 <hash> · 第 1 轮
  日志绝对路径 + 探针桩绝对路径 + import 写法
  埋点指南（assets/AGENT-PROBE-GUIDE.md 渲染后的正文）
  下一步要求：埋点 → dsh_debug_report（不要先猜结论）
副作用：createHash() → 建任务目录 → 生成探针桩 → 写 state.json → 注册会话绑定
  → **消费票据**
幂等：已有活跃任务时返回既有信息（此时不消费票据），不新建
```

#### S2 `dsh_debug_report`

```
入参：{ analysis: string, probeFiles?: string[], changedFiles?: string[],
       probes?: { probe: string, why: string }[] }
返回：状态行（已记录，等待用户复现）+ 一句提示：可以在输入框直接描述现象，
      面板在输入框下方
副作用：记录 analysis 到任务状态；面板据此显示「Agent 的分析结论」；
        status: active → awaiting-user
说明：这是 Agent 的**交卷动作**。调用它 = 「我这轮埋完了，请用户复现」。
     `changedFiles` 与 `probeFiles` 分开记（§3.8）：前者收尾时**不得**回滚。
```

#### S3 `dsh_debug_continue`

```
入参：{ nextPlan?: string }
返回：状态行（第 n 轮开始，日志已清空）、日志路径、剩余额度（字节/行数上限）
副作用：清空日志文件（truncate 为 0 字节，**不删文件**）、round+1、
        pendingReport 清空、status → active
前置：任务必须存在；不存在则返回「请先 start」
```

#### S4 `dsh_debug_read`

```
入参：{ limit?: number = 200, level?: 'trace'|'debug'|'info'|'warn'|'error', probe?: string }
返回：
  · 头部摘要：总行数 / 过滤后行数 / 时间跨度 / 按 probe 分组的计数（Top N）
  · warn|error 记录**全部**列出（这是最贵的信号，不许被 limit 截掉）
  · 其余按时间序给最近 limit 条；被省略的数量显式说明
  · 脏行计数（协议外的行）
  · 空日志时给出排查提示（探针是否真的执行了？桩路径对不对？）
副作用：只读；更新 task.lastRead 供面板显示
```

#### S5/S6/S7 与用户信号

**通道（已核实，勿再猜）**：浏览器 → 宿主走 **`ctx.webServer.register({ kind:'exact',
path, handler })` 的同源 HTTP 路由 + 浏览器 `fetch`**；这是两个已发布第三方插件
（whale-widget、wallpaper-engine）唯一在用的方案。**不存在 `host.call(...)`**——
那个名字是早先的猜测，已作废。宿主 → 浏览器目前只有客户端**轮询**（同样与两个
已发布插件一致；`@Remote({mode:'stream'})` 的推送是首方能力，第三方能否声明未验证）。

宿主唤醒 Agent（把「用户点了按钮」变成 Agent 的下一轮输入）用已核实的
`ctx.sessionController.prompt(request, signal)`：

```ts
// ctx.sessionController —— 硬依赖 inject = ['sessionController']
@Remote('prompt') prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
interface SessionPromptRequest {
  requestId: SessionRequestId
  sessionId: SessionId
  mode: 'queue' | 'steer'      // steer = 打断并重定向当前轮；queue = 排队等本轮结束
  content: readonly PromptContentPart[]
  clientTimeZone?: string
}
```

- 默认用 `mode: 'queue'`：用户点按钮时 Agent 通常已停下（`awaiting-user`），
  排队即可；只有在 Agent 仍在跑（用户抢答）时才可能需要 `steer`。
- `content` 的具体 part 形状（`PromptContentPart`）**未验证**，实现时先打印一次
  真实形状再定型。
- `SessionRequestId` 的铸造方式**未验证**（Branded 类型）。
- 备选通道：`ctx.userQuestions.answer(agent, callId, answer)`——如果将来改成
  「工具阻塞等用户答复」的形态，这是首方标准做法（`ask_user_question` 就是这么工作的）。

因此：面板按钮 → `POST /dsh-debug-mode/resolve`（同源 fetch，带 hash）→
宿主路由处理 → 清空/保留日志 + 状态迁移 → `sessionController.prompt(...)`
投递下面这条结构化指令。

投递给 Agent 的指令正文：

```
[debug-mode] 用户在面板上选择了「问题复现，需要进一步修复」。
任务：<hash> · 第 <n> 轮 · 本轮日志已清空。
请按信号序列执行：dsh_debug_read → 分析 → dsh_debug_continue（若需换假设）→ 埋点 → dsh_debug_report。
```

```
[debug-mode] 用户在面板上选择了「问题已解决」。
任务：<hash>。请执行收尾：
1) 调用 dsh_debug_end 声明清理清单；
2) 按 `dsh-debug:probe <hash>` 标记删除本次任务的全部探针块；
3) 删除探针桩与任务目录；
4) 在回复里给出改动文件清单与验证方式。
```

路由表（宿主半，前缀 `/dsh-debug-mode`）：

| 方法 + 路径 | 用途 |
| --- | --- |
| `GET /state?sessionId=<id>` | 面板轮询：状态、轮次、日志行数、`lastReport`、`userNote`；无任务时返回 `{ task: null }` |
| `POST /resolve` `{hash, note?}` | S5 用户信号（已解决） |
| `POST /reproduce` `{hash, note?}` | S6 用户信号（复现）；`note` 可选（§9.3.3） |
| （可选）`GET /panel.js` | 保留给「注入式面板」的退路（当前方案不用，见 §9.1.1） |

`hash` 不匹配、任务已关闭、重复点击 → 一律返回 `4xx` + 明确文案，且**幂等**：
同一信号重复到达只处理一次，不产生第二次 `prompt`。

`dsh_debug_end`：

```
入参：{ summary: string, cleanedFiles?: string[], verified?: boolean }
前置：本会话必须有活跃任务；且用户**确实选择过「问题已解决」**（§9.4）
返回：确认 + 三类账核对结果：
  · 修复（保留）：changedFiles 里的文件
  · 探针（已删）：probeFiles 里已无 `dsh-debug:probe <hash>` 标记的文件
  · 未清理项：probeFiles 里仍残留标记的文件（点名）
副作用：删任务目录（含日志）、解绑会话、status → closed
幂等：任务不存在时返回「无活跃任务」，不报错
明令禁止：用 `git checkout` / `git stash` 整体回滚——会连带 revert 掉用户的修复
```

### 6.3 状态机

```
                  S1 start
        ┌──────────────────────► active ◄──────────────┐
        │                          │                   │
        │                   S2 report                  │ S3 continue
        │                          ▼                   │ (清空日志, round+1)
        │                   awaiting-user ─────────────┘
        │                          │
        │             ┌────────────┴────────────┐
        │        S5 已解决               S6 复现（清空日志）
        │             ▼                        ▼
        │      awaiting-agent ◄────────────────┘
        │             │
        │        S7 end（删日志 + 验收清理）
        └────────────► closed
```

- `active`：Agent 正在改代码/埋点，此时面板**只展示不提供按钮**（避免用户在
  Agent 干到一半时下结论）。
- `awaiting-user`：面板开放两个按钮，这是**用户下结论的窗口**；但这个窗口
  **不禁用输入框**——用户随时可以打字描述现象，宿主观察到新的用户消息就自动
  回到 `active`（§9.3.2）。
- `awaiting-agent`：用户已表态，球在 Agent 脚下；面板显示「已通知 Agent…」。
- `closed`：任务目录已删除；面板消失。

---

## 7. 日志协议

### 7.1 位置

```
<repo>/.dsh/debug-mode/
├── tasks/
│   └── <hash>/
│       ├── <hash>.log               ← 探针日志（唯一被 Agent 间接消费的文件）
│       ├── state.json               ← 任务状态（可跨 DSH 重启恢复）
│       ├── runtime/probe.mjs        ← 探针桩（模板生成）
│       └── AGENT-PROBE-GUIDE.md     ← 本轮埋点指南
└── .gitignore                        ← 写入 `*`，保证 `.dsh/` 永不进版本库
```

- 为什么放在仓库内：探针桩要被业务代码 import，路径必须在项目可见范围内；
  同时用户能自己 `tail -f` 看一眼（但我们不鼓励 Agent 直接读文件）。
- 为什么按 hash 分目录而不是平铺 `.dsh/<hash>.log`：一个任务有 4 个文件，
  平铺会污染仓库根；目录形态也让「删任务」= 删一个目录，不可能删漏。
- 每个 workspace 各自一份 `.dsh/`；不同任务互不可见。

### 7.2 行格式（**冻结**）

一行一条 JSON 对象，UTF-8，`\n` 结束，追加写。字段顺序固定：

```json
{"ts":"2026-10-10T10:00:00.123+08:00","task":"deadbeef","probe":"src/order/service.ts:118:resolve-total","level":"info","msg":"计算总价","data":{"orderId":"A1","total":12800}}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ts` | string | 是 | ISO-8601，毫秒精度，带本地时区偏移。由写入端生成 |
| `task` | string | 是 | 任务哈希；桩里已烘死，所以读端可省略校验 |
| `probe` | string | 是 | 探针标识：`<仓库相对路径>:<行号>:<短标签>` 或自由标签 |
| `level` | string | 否 | `trace` / `debug` / `info`（默认）/ `warn` / `error` |
| `msg` | string | 否 | 人类可读描述 |
| `data` | any | 否 | 可 JSON 序列化的负载；对象优先，循环引用降级为 `"[circular]"` |

**演进规则**：只能新增**可选**字段；两个实现（`lib/protocol.js` 与探针桩模板）
必须同步；`test/protocol.test.mjs` 负责对账（含字段序漂移守卫）。任何破坏性改动都要升
`DESIGN.md` 的版本号并在变更记录里写明。

两条实现细节（已由测试固化）：

- `probe` **必填且非空**：没有 probe 的行在协议里不可解析，写入端宁可抛错，
  也不要写出一条读端永远看不见的日志。
- `ts` 缺失时**由写入端补当前时间**；`task` 只有探针桩会写（它来自桩里烘死的
  常量），协议模块没有任务上下文，因此不生成该字段。

### 7.3 为什么是 JSONL

- 追加写天然并发安全（O_APPEND 单行原子），多进程/多线程探针不用加锁；
- 崩溃时最多丢最后半行，前面的现场完好；
- 读端可以流式处理，不必整文件载入；
- 人眼 `grep deadbeef` 依然好使。

### 7.4 探针桩

模板 `assets/probe.template.mjs`（零依赖、可独立运行）在 `start` 时被复制到
`tasks/<hash>/runtime/probe.mjs`，并把两个常量烘死为任务真值：

```js
export const TASK = "deadbeef"
export const LOG = "/abs/path/to/repo/.dsh/debug-mode/tasks/deadbeef/deadbeef.log"
```

桩的硬约束：

| 约束 | 理由 |
| --- | --- |
| 零依赖（只用 `node:` 内置） | 桩要能直接在用户项目里跑，不许有安装步骤 |
| **永不抛异常** | 可观测性代码不许把被调试程序搞挂 |
| 同步 `appendFileSync`，每次 open→write→close | 崩溃前最后几条必须落盘；不持有 fd 则宿主删文件后不会「复活」它 |
| 单行 ≤ 8 KiB，超长截断并标 `truncated` | 防止把一张图 base64 写进日志 |
| 只写不读、不轮转、不清理 | 生命周期完全由宿主掌控 |

非 JS/TS 项目（Python 等）：**Agent 按同一行协议自写桩**，落点
`runtime/probe.<ext>`，同样受上表约束（`try/except` 全包、`open(..., "a")` 即写即关）。
宿主不试图为每种语言内置桩——协议足够简单，Agent 写对它是基本要求。

### 7.5 探针块（可摘除性）

```ts
// dsh-debug:probe deadbeef start
probe('src/order/service.ts:118:resolve-total', { orderId, total })
// dsh-debug:probe deadbeef end
```

- 标记前缀固定 `dsh-debug:probe`，后接 hash，便于多任务并存时区分归属；
- 结束调试 = 删除所有 `dsh-debug:probe <hash>` 块 + 删除任务目录；
- `dsh_debug_report` 的 `probeFiles` 记录「本次改过哪些文件」，
  `dsh_debug_end` 拿 `cleanedFiles` 对账，**对不上就在返回值里点名**。

---

## 8. 输出给 Agent 的形式

「读取日志信号」的输出必须是**摘要优先**的，因为原始日志很容易几千行：

```
调试日志 · 任务 deadbeef · 第 2 轮 · 312 行 / 48 KB / 时间跨度 12.4s · 脏行 0
按探针分组（Top 8）：
  84  src/order/service.ts:118:resolve-total
  61  src/order/service.ts:203:cache-hit
  40  src/api/route.ts:57:respond
  ...
异常与警告（全部 3 条）：
  [error] src/order/service.ts:140:throw  TypeError: total is not a number  {"orderId":"A9","total":null}
  ...
时间序（最近 200 条，已省略 109 条；用 level/probe 参数收窄）：
  {"ts":"…","probe":"…","msg":"…","data":{…}}
```

设计要点：

1. **异常不被裁掉**：`warn`/`error` 全量列举，永远不受 `limit` 影响。
2. **计数先于内容**：先给分组计数，Agent 一眼能看出「哪条路径根本没走到」——
   这往往比日志内容本身更有信息量（例如某个 probe 计数为 0 = 该分支未命中）。
3. **显式说明省略量**：绝不静默截断。
4. **空日志要解释**：区分「文件不存在」「存在但为空」「有脏行但无合法记录」，
   并给出三条排查建议。

---

## 9. 面板（用户侧）

### 9.1 面板怎么被加载（已核实：**必须打包**）

宿主**不做任何编译**：`dsh-client-modules` 把每个客户端的 `client.js` 原样快照并
按字节拼接脚本正文，经 `/plugins/<id>/client.js?rev=…` 下发；入口由
`clientExportOf(packageName, pkg.exports)` 解析，缺失即抛
`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。

⇒ **手写的 ESM 客户端半不会被加载**（`import`/`export` 语法在那种拼接模型下必死）。
客户端产物必须已经是一个 `window.__ModuleLoader__.load({ id, factory })` 注册脚本。
早先设计的「M3a 手写 ESM 实验 / M3b 注入退路」两条并行路都作废了——见 §9.1.1。

#### 9.1.1 定稿方案（零第三方依赖的「单文件包装」，不需要打包器）

不引入 esbuild/rollup，用**一个 30 行的构建脚本**把「插件自己的 ESM 源码」包进
`__ModuleLoader__` 外壳。理由：客户端半只有一两个文件，而引入打包链会带来
`node_modules`、锁文件与版本漂移——本项目的工程纪律是零运行时依赖（AGENTS.md §4.1）。

只允许导入**平台种子表里的模块**（`PLATFORM_MODULES`，实测清单）：

```
react · react/jsx-runtime · react-dom · react-dom/client · @deepseek-ai/cordis
@deepseek-ai/dsh-client-store · @deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives · @deepseek-ai/dsh-client-ui-dockkit
```

其中 `@deepseek-ai/dsh-client-ui-slots` 是**非依赖型导入**（`ctx.slots` 是注入进来
的服务，不需要 import 它），所以实际只用到 `react`。

```
src/client.jsx（.js，写 `import { useState } from 'react'` 与 `export function apply/inject`）
        │  node scripts/build-client.mjs
        ▼
lib/client.js   ← 必须是 window.__ModuleLoader__.load({ id:'dsh-plugin-debug-mode', factory })
```

`scripts/build-client.mjs` 的契约：

1. 读 `src/client.js`，把 `import ... from '<allowed>'` 改写成
   `const ... = require('<allowed>')`；遇到底座表外的导入**直接报错退出**
   （宁可构建失败，也不要运行时白屏）。
2. 把顶部 `export const inject = [...]` / `export function apply(ctx)` 改写成
   `const inject = [...]` / `function apply(ctx)`，末尾发射 `exports.apply` / `exports.inject`。
3. 套上 `window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { … } })`
   外壳，`id` **必须逐字等于包名**。
4. 在文件头写一行「本文件由 scripts/build-client.mjs 生成，勿手改」。

构建脚本必须**幂等**且可自检：同样的输入产出同样的字节（便于 diff 审阅）。

#### 9.1.2 两条客户端通道的区分（别再把它们搞混）

| | 包通道（`dsh.client` / 本插件走这条） | 动态通道（`cordis-client-runner`） |
| --- | --- | --- |
| 工厂参数 | 只有 `require` | `React` / `console` / `styles` / `host` |
| 能 `import` 吗 | 不能，必须走 `require` + 平台种子表 | 不能 import 任何东西 |
| `host.call()` | **不存在** | 有（宿主用 `harness.handle(method, fn)` 配对） |
| `styles.insert()` | **不存在** | 有 |
| 网络 | 浏览器 `fetch`（普通全局） | 不可用，必须 `host.call` 回宿主 |
| 宿主侧配对 | `ctx.webServer.register(...)` 路由 | `harness.handle(...)` |

本插件的浏览器↔宿主通道因此是**同源 HTTP 路由 + `fetch` + 轮询**（§6.2），
和两个已发布第三方插件的做法一致。

#### 9.1.3 面板座位（已核实）

定稿座位：**`conversation.composer.dock`**（`list`，**session 作用域**，
渲染在输入框卡片**正下方**）。

**为什么不是 turnTail（推翻了 v0.4 的选择）**：这个岗位的 props 里有
`useInput(selector)` 与 `inputActions`——**面板因此能看见用户正在输入什么**。
而 turnTail 没有这个能力，会导致一个没法优雅解决的竞态（见 §9.3.1）：
用户在输入框里打了半句话、又顺手点了「问题复现」，于是同一条现象描述被送了两遍。

已核实的座位字段（`Slots.listSubTree` 的 catalog）：

```
conversation.composer.dock   kind: list   scope: session
purpose: "Ambient entries below the composer card."
registration: { id (必填), order?, label? }
ownerProps: []   ← 没有专属 props
standardProps: useResource / useWorkspaces / usePanelInfo / useSessions / useSessionStatus /
               useSessionRetainInfo / useChat / useConversation / useInput / inputActions /
               useSession / sessionId / useProjection / useTrajectory
declaredBy: an entry in "conversation.composer.bar"
```

- `sessionId` 直接给到（不需要再从别处推），`useSession(selector)` 订阅会话状态切片，
  `useInput(selector)` 读输入框状态与草稿。
- 渲染位置在输入框下方：用户复现完，视线与手本来就在输入区，**不需要去别处找面板**。

注册形状：

```js
ctx.slots.inject('conversation.composer.dock', () =>
  ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'debug-mode-decision', order: 100, label: () => '调试模式' },
    (props) => React.createElement(DebugDecisionPanel, props),
  ),
)
```

- `ctx.slots.inject(seat, cb)` 是**声明感知**的：座位声明塌陷时回调的注册会随之释放、
  回来时重装。**永远不要**裸调 `ctx.slots.register`——座位可能稍后才声明。
  `register` 返回 disposer；`inject` 的回调本身可以返回 disposer（就是它的 effect）。
- 这个座位只注册一次却服务**所有会话**，所以必须按 `sessionId` 自过滤、
  与本会话无关时 `return null`；**绝不要**在模块级放「当前任务」这类全局状态。
- `conversation.composer.dock` 已被首方占用一个 cell（`mf` / `stats` / order 0）；
  用**自己的 id**（`debug-mode-decision`）就是旁加一格，不会覆盖别人的。

### 9.1.4 面板样式

用 `--dsw-alias-*` 主题令牌，**必须带 fallback**（如
`var(--dsw-alias-label-secondary, #6b7280)`），并且**不要**为实现浅/深色各写一份
覆盖块——alias 令牌本身就是按主题解析的（只有像壁纸插件那样强行改表面色时才需要
显式覆盖块）。常用令牌：`--dsw-alias-bg-layer-1/-2`、`--dsw-alias-border-l1/-l2`、
`--dsw-alias-label-primary/-secondary/-tertiary`、`--dsw-alias-button-primary-fill`、
`--dsw-alias-interactive-bg-hover`。

> 注意：这批令牌名来自一个已发布第三方插件的真实样式表，**不是**从 Theme provider
> 读到的（client inspect provider 当前超时）。首次实现时再核对一次。

### 9.1.5 面板位置与归属

- **面板常驻**于输入框下方，从任务创建到任务结束都在（这样你在调试期间随时看得到
  当前轮次与日志量）。只是**可交互性随状态变化**：
  `active` / `awaiting-agent` 时只显示状态（按钮禁用），`awaiting-user` 时才开放选择。
- 归属：按 **`sessionId` + hash** 判定，不允许出现「A 会话的调试面板在 B 会话里弹出」。

### 9.2 内容

```
┌────────────────────────────────────────────────────────────────┐
│ 调试模式 · 任务 deadbeef · 第 2 轮               312 行日志     │
│                                                                │
│ Agent 的分析结论：                                              │
│   total 在 items 为空时算成了 null，导致列表分支没命中…          │
│                                                                │
│ 复现后：可以直接在输入框描述现象，也可以在这里做个结论 →          │
│   [ 问题已解决 ]   [ 问题复现，需要进一步修复 ]                  │
└────────────────────────────────────────────────────────────────┘
```

### 9.3 交互（**三条输入路径**）

用户在调试模式里有三条表达途径，**它们互不排斥，也不需要互斥**：

| # | 路径 | 含义 | 走哪条链 |
| --- | --- | --- | --- |
| 1 | **在输入框打字**（原生 composer） | 描述现象、补充观察、提出新怀疑 | 普通用户消息 → Agent（会话状态由宿主自动迁移，见 §9.3.2） |
| 2 | **点「问题复现，需要进一步修复」** | 症状还在，继续查 | S6 → `awaiting-agent` → 唤醒 Agent |
| 3 | **点「问题已解决」** | 结案，清理探针 | S5 → `awaiting-agent` → 唤醒 Agent 执行 S7 |

路径 1 是**最重要的那条**：按钮只能表达「还在 / 好了」，而「它只在切换标签页之后才复现」
这种信息只有打字能传达。所以面板不能抢走或挡住输入框，也不该强迫用户先做选择。

#### 9.3.1 竞态：打字 + 顺手点按钮

真实场景：用户在输入框打了「只在切换标签页后复现」，然后**顺手点了**「问题复现」。
如果不处理，同一个信息会被送两遍（一次作为用户消息、一次作为按钮信号）。

处理方式（这是把面板放在 `composer.dock` 的全部理由）：

- 面板用 `useInput` 读**当前草稿**；**草稿非空时两个按钮禁用**，并给出一行提示：
  「输入框里有未发送的内容 —— 直接发送即可，它会被当成『问题复现』继续排查」。
- 草稿为空时按钮可用；此时点击**不带任何描述**，就是纯粹的「还在 / 好了」。
- 这样不存在「同一条描述发两遍」的窗口，也不需要去拦截或改写 composer 的提交。

#### 9.3.2 打字之后状态怎么走（**宿主自动迁移**）

用户打字发送时，Agent 收到的是普通用户消息；但如果宿主什么都不做，
任务会一直停在 `awaiting-user`，面板就会一直摆着两个按钮等着——语义已经不对了。

规则：**当任务处于 `awaiting-user` 且宿主观察到该会话出现新的用户消息时，
自动迁移到 `active`**（用户正在给新信息，Agent 该干活了）。

- 观察点：`ctx.on('session/event', (session, event) => …)`，看用户消息类事件。
- 为什么是「观察」而不是「拦截」：用户消息本身就该正常送达 Agent，
  宿主只是**顺带把状态对齐**，不参与内容、不改写、不延迟。
- 迁移仅对 `awaiting-user` 生效。`active` 收到用户消息是常态；
  `awaiting-agent` 收到用户消息说明用户抢答，状态保持由后续工具调用决定。

#### 9.3.3 按钮信号可以带描述（可选）

`POST /reproduce` 与 `POST /resolve` 都接受可选的 `note` 字段
（面板第一版不发它，留作以后在面板里直接输入时的扩展点）。收到时：
写入 `task.userNote`，并作为结构化指令的一部分投给 Agent。
`note` 本身**不触发** §9.3.2 的迁移，因为它已经绑在一个明确的信号上。

#### 9.3.4 交互与终态

| 用户动作 | 面板行为 | 宿主行为 |
| --- | --- | --- |
| 在输入框打字并发送 | 面板显示「已收到你的描述，Agent 正在处理」 | `awaiting-user` → `active`（§9.3.2） |
| 点「问题复现，需要进一步修复」 | 禁用两键，显示「已通知 Agent，本轮日志已清空」 | S6：清空日志 → `awaiting-agent` → 唤醒 Agent |
| 点「问题已解决」 | 禁用两键，显示「已通知 Agent 清理探针」，保留可见直到 `closed` | S5：`awaiting-agent` → 唤醒 Agent 执行 S7 |
| 任务已 `closed` | 面板消失（或收缩为「本次调试已结束」） | 删任务目录 |

防连点：按钮点击即禁用；宿主侧两个信号幂等（重复到达只处理一次）。

### 9.4 为什么不把「已解决」做成终态

用户点了「已解决」不等于代码干净了——探针还在。面板必须能显示
「正在清理 / 清理完成 / 清理中发现 N 个文件仍有探针」这三种收尾状态，
否则用户永远不知道代码库被留下了什么。

正因为如此，`dsh_debug_end` 还要求**用户确实表过态**：宿主在 `state.json` 里记录
「用户已选择已解决」；没有这个标记时调用 `dsh_debug_end` 一律拒绝
（Agent 不得自作主张收尾）。

---

## 10. 存储

| 数据 | 位置 | 生命周期 |
| --- | --- | --- |
| 任务状态 | `<repo>/.dsh/debug-mode/tasks/<hash>/state.json` | 任务关闭即删除 |
| 探针日志 | 同目录 `<hash>.log` | 同上 |
| 探针桩 | 同目录 `runtime/probe.mjs` | 同上 |
| 会话绑定 | 内存 `Map<sessionId, hash>` + `state.json.sessionId` | 会话结束或进程退出 |
| 插件配置 | DSH profile 的 config（可选：日志上限、是否自动 gitignore 等） | 用户掌控 |

`state.json` 存在的唯一理由是**跨进程重启恢复**：DSH 重启后，Agent 再次调用
`dsh_debug_read` 时应该还能找到任务（按 sessionId 或 caller 传入的 hash）。
它**不是**并发锁，也不是审计日志。

---

## 11. 并发、上限与安全

### 11.1 并发

- 同一会话：至多 1 个活跃任务（`start` 幂等返回既有任务）。
- 同一 workspace 的不同会话：可以各自有任务，哈希天然不冲突。
- 同一会话的多个子 Agent（subagent / workflow）：**继承**父会话任务，
  不新建——否则一个任务会裂成多个哈希，日志四分五裂。
- 多进程写同一日志：追加写 + 单行 ≤ 8 KiB，天然安全。

### 11.2 上限（默认值，可配置）

| 项 | 默认 | 超限行为 |
| --- | --- | --- |
| 单条日志行 | 8 KiB | 截断 + `truncated: true` |
| 单任务日志总字节 | 16 MiB | 写端停止追加，并在日志末尾写一条 `probe:"debug-mode:overflow"` |
| `dsh_debug_read` 返回行数 | 200 | 显式声明省略数量 |
| 单任务目录总字节 | 32 MiB | `read` 时警告，建议收窄埋点 |

### 11.3 安全

- **路径**：所有路径以 workspace 根为基准；`hash` 必须匹配 `^[0-9a-f]{8}$`
  （哈希由宿主生成，从不接受 Agent 传入的路径片段），杜绝路径穿越。
- **哈希不可猜**：哈希同时是日志文件名，必须用 CSPRNG
  （`crypto.getRandomValues`），不能用时间戳/自增。
- **沙箱**：写日志走宿主文件访问路径，受当前 DSH 文件策略约束；
  策略拒绝时工具返回**明确的失败说明**，而不是静默丢日志。
- **隐私**：日志可能含用户数据。任务关闭即删除；`.dsh/` 自动 gitignore；
  `read` 的输出会进入模型上下文——指南里明确要求 Agent 不要 dump 整对象。

---

## 12. 异常与边界

| 场景 | 设计行为 |
| --- | --- |
| 日志文件不存在（探针没生效/被删） | `read` 返回「无日志」+ 三条排查建议；不报错 |
| 日志为空但有脏行 | 报告脏行数并给出第一条脏行原文（便于发现协议写错） |
| 日志超大 | 摘要 + 显式省略；`error` 依旧全量 |
| 用户没复现就点「已解决」 | 允许（这是用户的权利）；面板不阻拦，`end` 时把「未收集到证据」写进返回值 |
| Agent 忘记调 `end` | 任务保持 `awaiting-agent`；下次会话开始/`start` 时提示存在未关闭任务 |
| 重复 `start` | 返回既有任务，提示用 `continue`，绝不新建第二个哈希 |
| DSH 重启 | `state.json` 恢复任务；日志文件在磁盘上，不丢 |
| 清理对账不一致 | `end` 返回值点名未清理文件；任务仍关闭，但面板/回复里显式提示 |
| 探针桩被用户删除 | `read` 仍能读历史日志；`report` 正常；`end` 无需恢复 |

---

## 13. 已冻结 vs 待验证

| 项 | 状态 |
| --- | --- |
| 四个信号 + S2 汇报的语义与顺序 | **冻结**（§6.1，改它要改版本号） |
| 日志行协议（字段名/顺序/JSONL） | **冻结**（§7.2，两处实现已由测试对账） |
| 任务目录布局与 `.dsh/debug-mode/tasks/<hash>/` | **冻结**（§7.1） |
| 探针块标记 `dsh-debug:probe <hash> start/end` | **冻结**（§7.5） |
| 状态机四态与迁移白名单 | **冻结**（§6.3，`lib/task.js` 已实现并测试） |
| 工具名 `dsh_debug_*` 与参数名 | 冻结（实现期若 API 受限可加参数，不改语义） |
| 工具参数是 JSON Schema、`output` 必填 | **已核实**（§6.2.1） |
| 工具在 agent 作用域注册以获得会话级可见性 | **已核实**（§6.2.1） |
| **每个工具动手前都要先过宿主侧校验** | **冻结**（§6.2.2） |
| 浏览器↔宿主走 `webServer` 路由 + fetch + 轮询 | **已核实**（§6.2；`host.call` 不存在，已作废） |
| 唤醒 Agent 用 `sessionController.prompt` | 已核实签名；`PromptContentPart` / `SessionRequestId` 待验证 |
| 探针桩默认生命周期与任务目录同生共死 | **冻结**（§7.1、§7.4） |
| 面板的具体 Slot | **已核实**：`conversation.composer.dock`（§9.1.3） |
| 客户端半是手写 ESM 还是必须打包 | **已核实**：必须打包成 `__ModuleLoader__` 产物（§9.1） |
| 客户端构建链 | **已定稿**：`scripts/build-client.mjs` 单文件包装，零第三方依赖 |
| **用户侧入口只有 `/debug`，且由宿主票据硬校验** | **冻结**（§3） |
| **Agent 可以拒绝进入（一眼看出根因时）** | **冻结**（§3.7） |
| **探针账 / 修复账分开记，收尾只撤探针** | **冻结**（§3.8、§9.4） |
| 第一轮不改代码、第二轮起允许先改后验 | **冻结**（§3.8） |
| **防堆屎山：成因分类 C1–C10 + 机制 R1–R6** | **已定稿**（§16；R1 最重要） |
| **闸门连续拒绝 3 次必须降级 + 失效必须可见** | **冻结**（§16.3.0） |
| **三色标记与四色处理（隔离区不允许静默保留）** | **冻结**（§16.3） |
| `TurnLocation` 的字段形状 | **待验证**（§15 第 1 项） |
| 沙箱策略下的文件写入路径 | **待验证**（§15 第 2 项） |
| 插件是否需要 Config | 暂无（全默认；用户设置走自己的 JSON 文件，与参考插件一致） |

---

## 14. 路线图

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| M0（已完成） | 项目初始化：包清单、patch、协议模块、任务状态机、探针桩模板、协议测试 | `node --test test/*.test.mjs` 全绿（17/17）；两份文档冻结 |
| M0b（已完成） | 客户端构建链与座位验证桩：`scripts/build-client.mjs` + `src/client.js` + 产物守卫测试 | 构建幂等、产物在 vm 沙箱里能被加载并注册座位（已测） |
| M1 入口与闸门 | `/debug` 命令（签票 + 投递指令文本）；票据的持久化、TTL、消费与幂等；`.dsh/debug-mode/pending/` | 无票调用 `dsh_debug_start` 被拒；敲一次 `/debug` 后能正常启动任务；重复 `/debug` 行为符合 §3.4 |
| M2 宿主骨架 | 5 个信号工具（agent 作用域注册、JSON Schema 参数、`output.render`）；任务落盘与恢复；日志读写与摘要；`.dsh/` 与 gitignore | 手工在会话里跑完 S1→S2 全程，Agent 能拿到摘要 |
| M3 唤醒闭环 | `webServer` 路由 + `sessionController.prompt` 投递；`systemPrompt.section`（thunk，仅调试模式下非空） | 不接面板，用 curl 打 `/resolve` 能真的让 Agent 开出下一轮 |
| M4 面板 | 把 `src/client.js` 的面板骨架接上真交互：两个按钮 POST 到 `/resolve` `/reproduce`、草稿禁用、收尾三态、样式令牌 | 浏览器里完成一次真实二选一 |
| M5 收尾与验收 | 清理对账；`end` 的点名机制；未关闭任务的提示 | 一次完整任务结束后 `git status` 归零（除 `.dsh/`） |
| M6 打磨 | 上限配置、错误文案、Python 桩示例、README | 文档与实现一致 |

---

## 15. 待验证清单（下一步必须先做实验的点）

> 这些是设计上留的「接口空位」。**不要在没做实验前照着猜的名字写代码**——
> 先 `cordis_inspect_query` 或读参考插件，再改本节状态。
> 已按 2026-10-10 的两轮契约核实更新；下列条目是**仍然未闭合**的部分。

1. **`TurnLocation` 的字段形状**（打包目录里只有类型引用，没有声明）。面板内部
   以 `seq`（`number`）作寻址键，`turn` 只做透传；若将来要用 `turn` 的内容，
   先在真实会话里打印一次。
2. **沙箱**：宿主写 `.dsh/debug-mode/**` 时是否需要额外权限、被拒绝时的错误形状
   （用于 §12 的文案）。当前会话是 `danger-full-access`，但这不代表其它用户。
3. **是否需要显式开关**：调试模式应由用户意图发起还是 Agent 自行判断？
   候选：`/debug` 命令 + Agent 自行判断两路并存。
4. **`PromptContentPart` 的形状与 `SessionRequestId` 的铸造方式**（未验证）：
   M2 动手前先打一次真实调用看形状。
5. **`systemPrompt.section` 的 `name`/`order` 取值**（未验证）：`SECTION_ORDERS` 的
   键名与数值不可读，先用靠后的 order（如 900）。
6. **`InputState` 的字段形状**（未验证）：草稿在哪个字段里。`src/client.js` 的
   `hasDraft` 目前按候选字段名探测（保守方向：读不到就当作没草稿），
   接真宿主后打印一次实际形状并写死。
7. **主题令牌的权威清单**（未验证）：§9.1.4 的 `--dsw-alias-*` 名字来自一个已发布
   第三方插件的真实样式表，不是 Theme provider。首次实现时核对一次。
8. **`/debug` 怎么被用户发现**（未验证）：注册成全局命令后是否自动出现在宿主的
   命令面板里。
9. **观察用户消息的确切事件类型**（未验证）：用于 §9.3.2 的自动迁移
   （`session/event` 的哪个 `event.type` 代表用户消息）。
10. **`ctx.remote.$on` 能否替代轮询**（未验证）：事件转发白名单属于宿主装配，
    不属于本插件；第一版一律用轮询，不要赌推送。

---

## 16. 防止多轮调试堆积临时代码（「防屎山」）

> 这一节的结论经过**外部资料调研 + 对同一方案的对抗性评审**（红队）两轮。
> 评审推翻了我最初的首选机制，理由记在 §16.4——**记录被推翻的过程比记录结论更重要**，
> 否则下一个人会再犯一次。

### 16.1 问题不是一个，是六个

「屎山」必须拆开看，不同成因要用不同机制，一个机制包打天下必漏：

| # | 成因 | 现场 | 现状为什么拦不住 |
| --- | --- | --- | --- |
| **C1** | 探针块留在代码里 | 任务关了，`dsh-debug:probe` 还在 12 个文件里 | `end` 只看 Agent 自报的 `cleanedFiles`，没有独立扫描 |
| **C2** | 探针加了没登记 | 边查边补探针，忘了更新 `probeFiles` | `probeFiles` 是 Agent 自报，无第三方校验 |
| **C3** | 改坏没还原 | 第 3 轮改了一半，代码编译不过 | 没有「交卷前必须能解析」的检查 |
| **C4** | 探索性改动被当成修复留下 | 排查用的 `if (x) return null` 留在了代码里 | 账目只有一种颜色，探索与修复不可区分 |
| **C5** | **方向错了但每轮都在加代码** | 假说全被证伪还继续埋点 | `round` 只是个计数器，没有停止规则 |
| **C6** | 同一假设反复重试 | 同一条探针埋了 5 轮，理由换了三次 | 没有「假说 × 证据增量」的键 |
| **C7** | 任务不关、目录长草 | 用户忘了点、Agent 忘了 `end` | 无 TTL、无跨任务看板 |
| **C8** | 临时文件泄漏到任务目录之外 | `scripts/tmp-dump.mjs`、根目录 `debug.json` | 只约定落任务目录，不检查 |
| **C9** | Agent 无视约束 / 用户狂点复现 | 提示词说了不许，模型照样干 | 约束必须在返回值层生效（既定事实） |
| **C10** | 「以后可能有用」心态 | 收尾时说「先留着这处探针」 | **无宿主侧抓手，只有弱约束** |

### 16.2 证据基础（**注意证据强度差别很大**）

调研取回的可用外部证据（详细来源见本节末）：

- **误提交是统计必然，不是懒。** MSR 2025 论文（arXiv:2501.09892）通过「误提交后又被删」
  这一现象收集到 **27 GB / 548,880 条** ad-hoc 日志，并指出开发者「通常会在提交前删掉，
  只是偶尔忘记」。→ 结论：**把「人手删干净」当默认假设是错的，必须有机器来扫。**
  局限：只覆盖 JS 与公开 GitHub 仓库，且只统计了「提交后又删」的样本，真实总量被低估。
- **休眠的可执行代码是致命的。** Knight Capital 事故（SEC 34-70694）：2003 年停用的
  "Power Peg" 代码既没删也没禁用，2012 年被复用的 flag 唤醒，45 分钟损失超 **4.6 亿美元**。
  → 结论：**删除优于休眠**；「可恢复 / 不可恢复」两种模式靠参数区分是危险的。
- **默认值的方向本身就是机制。** Shape Up 的 Circuit Breaker 原文：
  「Cancel projects that don't ship in one cycle **by default** instead of extending them
  by default」，以及「还有未解问题 ⇒ 不许延期；只有纯执行剩余 ⇒ 才可讨论延期」。
- **标记是弱机制，闸门才是强机制。** Fowler 的 Parallel Change 原文对「TODO / deprecation
  note」只给了 "might help" 级别的措辞，并明确警告「contract 阶段没做完会比不做更糟」。
  Hodgson 的 Feature Toggles 文里给了真正的到期机制形态：expiration date、
  「到日期就让测试失败甚至拒绝启动」的 time bomb、以及把 toggle 视为有 carrying cost 的
  **inventory**（可设数量上限）。
- **债务的利息不由时间产生，而由「下次改动」产生**（Fowler, Technical Debt）。
  → 所以**任何到期数字都是政策选择，不是理论推论**。这一条直接决定了 §16.5 的诚实程度。

**🔴 一处诚实的空白：实证数据这条线没查到。** 我起了一个专门检索「调试时间占比 /
返工废弃率 / 调试遗留物对维护成本的量化影响」的调研分支，**该分支检索失败，未取回任何
外部证据**。因此下面所有阈值都**没有**实证数据支撑，一律按「可配置默认值 + 给理由」处理。
如果将来需要说服别人接受某个阈值，这一块是需要补的功课。

### 16.3 机制（按投资回报排序）

#### 16.3.0 横切要求（**比任何阈值都重要**）
**闸门不能造成死锁，也不能 fail-open 而不告知。** 两条具体规定：

1. **连续拒绝降级**：任何硬闸门**连续拒绝同一原因 3 次**后，自动降级为
   warn-only 并把这次降级写进欠账。理由：如果用户不在场、Agent 反复
   `report → 被拒 → report`，一个卡死的闸门比它要防的屎山更危险。
2. **失效必须可见**：闸门依赖「宿主能写 workspace、能扫到文件」。只读沙箱、
   仓库外路径、软链接等情况会让扫描器返回空集，**所有闸门静默 fail-open**。
   因此启动时做一次**写探针自检**（写 `.dsh/debug-mode/.probe-write-test`），
   失败则在面板常驻显示「**残留检测未生效**」——绝不假装保护着。

#### R1 · 宿主侧工作区索引 + 窗口 diff（**最重要的一条**）

**这是唯一不依赖 Agent 诚实的机制**，也是「以扫描器为准」这句话能成立的前提。

- 在每轮开始（`start` / `continue`，即进入 `active` 之前）对 workspace 建一次轻量索引：
  `{ relPath → { size, mtimeMs, sha256 } }`，排除 `.dsh/`、`node_modules/`、`.git/`；
  小文件（< 256 KiB）读全文哈希，大文件读首尾各 4 KiB。
- 在 `report` / 面板轮询（节流）/ `end` 三处重新索引并 diff：
  **新增文件** → `strayArtifacts`（真检测，不靠自报，直接取代弱约束的「产物登记」）；
  **修改/删除文件** → 与 Agent 自报的 `changedFiles` 对账，**以 diff 为准**。
- 索引失败（权限、超限）必须变成显式状态 `indexUnavailable: true` + 面板常驻告警（见第 0 条）。

它能一次性覆盖标记法漏掉的一大片：格式化导致的标记损坏、标记与调用分离、
import 残留、生成物（`dist/`、`.d.ts`、sourcemap 里的内嵌源码）、跨 hash 伪造、
扩展名盲区、以及「轮询间隔之间写盘」的窗口盲区。

#### R2 · 残留扫描器：**宽松发现 + 严格分类 + 栈式配对**

- **发现要宽松**：不做精确匹配。任一行匹配 `dsh[\s\-_]*debug`（含全角冒号、大小写、
  连字符/下划线差异）或**包含本任务 hash** ⇒ 该行进入候选集。归一化后再取 8 位 hex 候选。
- **分类才严格**：精确匹配 `dsh-debug:(probe|temp|fix) <hash>` 用于决定「怎么处理」，
  不用于「发现」。
- **两条补充发现规则**（专治两个会崩代码的残留）：
  1. **桩路径字符串扫描**——任何文件里出现 `.dsh/debug-mode/tasks/<hash>/` 字面量
     ⇒ 标为「桩引用」。**这条直接解决探针桩 import 残留**（桩文件删了、import 留着 ⇒ 立刻编译不过）。
  2. **标识符反查**——从被删的探针块里提取新引入的标识符，在**全仓库** grep；
     出现在探针块之外的 ⇒ 标为「疑似分离调用点」。**这条解决「探针被重构成 helper、
     标记只盖住定义、调用点裸奔」**——那是最毒的一种，扫描器会报「干净」而代码会崩。
- **配对必须是栈式的**，且只删「同缩进、无中间标记行、`start`/`end` 成对」的区间；
  **配对有任何歧义一律进隔离区，绝不自动删**——宁可脏关闭，不可自动删用户代码。

#### R3 · 三色标记 + 四色处理（**铁律的正确实现**）

```
dsh-debug:probe <hash> start/end   → 探针      → 收尾必删
dsh-debug:temp  <hash> start/end   → 临时探索  → 收尾必删
dsh-debug:fix   <hash> ...         → 修复      → 永久保留
```

处理规则由**可判定性**决定，不由风险偏好决定：

| 块的状态 | 默认动作 |
| --- | --- |
| `probe` / `temp` 且 hash 属于**本任务** | **必删**（无需确认；`temp` 较大时展示 diff） |
| `fix` | **保留** |
| 有 `dsh-debug:` 但 hash **不属于任何已知任务**，或格式残缺 | **进隔离区**：`end` 时逐条让用户三选一（保留为 fix / 删除（展示 diff 二次确认）/ 我自己处理），**不允许静默保留** |
| 完全无标记的可疑产物 | 只提示，不删（这一档可以是弱约束） |

#### R4 · 停止规则（治 C5/C6）

- **L1（进入埋点前）**：第 1 轮是**只读取证轮**，**不设探针数量上限**——取证轮恰恰最需要宽埋点。
  真正该卡的闸门是「第 1 轮出现 `dsh-debug:change` 即拒绝」，这才是有意义的约束。
- **L2（继续下一轮前）**：**不要**把「本轮假说全部判定完毕」当成拒绝理由。
  多个成因叠加的真实 bug（内存泄漏 = 未解绑 listener + 循环引用 + 缓存无上限）在排除
  前两个成因后，现象仍复现**恰恰是最有信息量的时刻**。拒绝条件必须是三者同时成立：
  **无新证据 ∧ 无新增假说 ∧ 无可判定残留**；「现象仍复现」单独**永远**不构成拒绝理由。
- **L3（全局止损）**：轮次 / 存活时长超预算 ⇒ 标记为**内部诊断态**，`read`/`end` 可用，
  `report`/`continue` 需要用户显式确认。**不改变任何工具的可用性**（见 §16.4 的推翻记录）。
- **C6 的键用「证据增量」而不是「轮次」**：同一个探针连续挂 5 轮去观测一个周五晚上才出现的
  间歇性 bug 是**正确**做法。只有当「同一假说 + 日志分组计数无变化」时才累积重试计数；
  有新增证据即重置。

#### R5 · 欠账可见（治 C7，弱但便宜）

跨任务看板（`GET /state` 返回 `tasks/` 下全部未关任务的欠账汇总）、闲置告警。
**TTL 到期不自动删任务目录**——删除只发生在 `end` 里，这条不能破。

#### R6 · journal + backups（治 C3 + 给 R16 兜底）

宿主在**自己经手的写操作**（生成桩、`end` 删块）之前，把目标文件备份到
`tasks/<hash>/backups/`，并往 `journal.jsonl` 追加一行审计记录。

- **绝不自动还原**。`backups/` 只给用户「查看 / diff」入口。
- Agent 可在 `report` 里给 `undoHint`（一组 `{path, find, replace}` 的**精确文本替换**），
  宿主校验 `find` 在目标内容里**唯一存在**后才应用；校验失败即脏关闭并进隔离区。
  这样 C3「改坏没还原」有了机械出路，且永远只作用于已知的那几行。

### 16.4 被推翻的机制（**记录错误比记录正确更重要**）

| 我最初的选择 | 为什么错 |
| --- | --- |
| **「未标记默认当 fix（保留）」** | **方向换错了。** 「误删修复」已被结构性防住（探针必须有标记、删除可枚举可预览），而「漏删临时」**没有任何下游拦截**：代码进了 PR 就没人记得哪块是探针，它不报错、不告警，只是慢慢烂掉——这恰恰就是屎山的定义。更糟的是它与扫描器冲突：未登记的探针**扫描器扫得到、流程却不删**，等于把最贵的机制废掉 |
| **假说登记册 + 「零外溢原则」**（本轮新增探针数 ≤ 登记假说数 + 1） | 用**最不可信的输入**（Agent 自报的假说数组）去限制**最需要自由度的动作**（埋点）。三行 JSON 就能冲破（把 claim 全填「待确认」），却会误伤最勤勉的工作方式（12 个调用点埋对称探针是教科书式正确做法）。**砍掉**，把预算转给 R1/R2 |
| **「token 只有面板能种下，Agent 不能伪造」** | 架构上不成立：HTTP 路由是宿主自己开的，Agent 有 `fetch`。这是「安全戏剧」。降级为**审计 + 摩擦**，并在文档里如实这么写 |
| **面板硬档「默认出口是结束」** | 让插件替用户做放弃决定，**最伤信任**。用户找你是为了解决问题，不是为了被告知该结案了 |
| **用「文件数」做阈值**（探针文件 ≥ 3/6） | 最好的度量是**块数与行数**：一个文件里 20 处探针远比 6 个文件各 1 处严重。改用加权度量：`residueLines`（残留标记行数）、`unmatchedBlocks`（配对失败块数）、`staleRounds`（连续无新证据轮数）、`unclassifiedBlocks` |
| **M4 交卷闸门直接对 `.ts` 跑 `node --check`** | 宿主自己制造的假失败：`.ts`/`.tsx` 必然解析失败，于是要么全被判违规、要么被标「不可验证」而完全失效。限定「只查本轮被工具触碰过的文件」+ 按扩展名选解析器 + 严格区分 `failed` 与 `unverifiable` + 提供逃生口（记脏而不拒绝） |
| **把「任务超时」叫 `degraded` 并显示给用户** | 一个周六开始、周日继续的调试，一打开就是红字欠账，用户第一印象是插件在骂他。TTL 只影响**看板排序与提示语气**，不影响任何工具可用性 |

### 16.5 阈值（**全部是政策默认值，非理论推论**）

| 阈值 | 默认 | 依据 |
| --- | --- | --- |
| 闸门连续拒绝降级 | **3 次** | 见第 0 条；防死锁 |
| 同一假说无新证据重试上限 | **3 次** | 键是「证据增量」而非轮次，见 R4 |
| `staleRounds`（连续无新证据轮数）告警 | **3 轮** | 结构性指标，与屎山有因果链 |
| 陈旧欠账常驻提醒 | **> 30 天** | 参考 LaunchDarkly 的「健康归档周期 90–120 天」，但那是产品 flag 尺度；调试探针存活尺度是天/小时，故取 30 天为「必须清」线 |
| 大块 `temp` 删除前展示 diff | **> 40 行** | 拍脑袋，但与「一个函数的量级」对齐 |
| `unclassifiedBlocks` 需用户逐条判定 | **任意 > 0** | 可判定性原则：不确定就隔离，不静默 |

> ⚠️ **关于 Feature flag 厂商数值**（Unleash：release 类 40 天、ops 类 7 天）：
> **不采用**。那是厂商默认配置值、不是行业基准，且与调试探针的时间尺度差两个数量级。
> 只借用它的**结构**（按类型设寿命 + 到期触发清理 + 创建:归档 ≈ 1:1 的健康指标）。

### 16.6 出处（按可信度分级）

**A 级 · 已取回正文，可直接引用**

- [MSR 2025 · Learning from Mistakes: Understanding Ad-hoc Logs through Analyzing Accidental Commits](https://arxiv.org/abs/2501.09892)（548,880 条误提交后被删的 ad-hoc log）
- [Shape Up · The Betting Table（Circuit Breaker）](https://basecamp.com/shapeup/2.2-chapter-08#the-circuit-breaker) · [Decide When to Stop](https://basecamp.com/shapeup/3.5-chapter-14#when-to-extend-a-project)
- [Fowler · Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)（"might help" 的弱措辞 + 「contract 没做完更糟」）
- [Fowler · Technical Debt](https://www.martinfowler.com/bliki/TechnicalDebt.html)（利息由「下次改动」产生，不由时间产生）
- [Hodgson · Feature Toggles](https://martinfowler.com/articles/feature-toggles.html)（expiration date / time bomb / inventory 与 carrying cost）
- [LaunchDarkly · Reducing technical debt from feature flags](https://launchdarkly.com/docs/guides/flags/technical-debt)（90–120 天健康归档周期）
- [OpenTelemetry · Sampling](https://opentelemetry.io/docs/concepts/sampling/) · [Spec Overview](https://opentelemetry.io/docs/specs/otel/overview/)（插桩与业务逻辑分离、采样减少「临时加日志」的需求）
- [Datadog · Dynamic Instrumentation](https://docs.datadoghq.com/tracing/trace_collection/dynamic_instrumentation/) · [Lightrun · Dynamic logs](https://docs.lightrun.com/actions/dynamic-logs/)（探针不进 git；Lightrun 明确给了到期后保留 10 天即自动删除）
- [ESLint · no-console](https://eslint.org/docs/latest/rules/no-console) · [Ruff · print (T201)](https://docs.astral.sh/ruff/rules/print/)（把「记得删」变成合并前置条件）
- [Spring Boot · Loggers endpoint](https://docs.spring.io/spring-boot/reference/actuator/loggers.html)（运行时改日志级别 = 零代码改动的临时排查）
- [Knight Capital · SEC 34-70694 转述](https://www.jrvarma.in/blog/Y2013/Knight-Capital.html) · [一手 PDF](http://www.sec.gov/litigation/admin/2013/34-70694.pdf)（休眠代码被唤醒，4.6 亿美元）

**C 级 · 抓取失败，仅作线索，本文未据其立论**

Google SRE Book（Managing Incidents）、Zeller《Why Programs Fail》、Agans 的九条规则、
XP 的 Spike（c2.com / extremeprogramming.org）、`eslint-plugin-unicorn` 的
`expiring-todo-comments` 具体语法、Google C++ Style Guide 的 TODO 小节正文。

**🔴 未完成**：实证数据线（调试时间占比、返工废弃率、调试遗留物对维护成本的量化影响）——
需要补的功课，原因如实记录如下：

调研子代理**确实定位并下载了**几篇相关论文（Hailpern & Santhanam 的《Software
debugging, testing, and verification》、Sedano 等的《Software Development Waste》，
以及 community-smell / code-smell 方向的两篇），并落盘为 PDF 与自写脚本提取的纯文本。
但**提取质量不可用**：正文换行丢失、字符间距被破坏（`Software` → `Softw are`）、
连字错乱（`veri\336cation`）。从中摘出的任何数字都不可靠，**不能作为引用依据**。

这批残留文件已在初始化提交前删除（含 12 MB 级 PDF，共 17.85 MB），因此本节阈值仍然
**全部**是政策默认值，没有实证数字支撑。若将来要补上，需要**能正确解析的 PDF 提取**
（而不是自己写 zlib + 正则），以及 Hailpern & Santhanam 那篇的正式出处页码。

---

## 17. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-10-10 | 首稿：四信号协议、JSONL 行协议、任务目录布局、状态机、面板交互、路线图 |
| 0.2 | 2026-10-10 | 按宿主契约核实结果修正三处错误假设：① 工具参数是 JSON Schema 而非 zod，且 `output.render` 必填（§6.2.1）；② 删除不存在的 `host.call`，改为 `webServer` 路由 + fetch + 轮询 + `sessionController.prompt`；③ 工具必须在 agent 作用域注册才有会话级可见性 |
| 0.3 | 2026-10-10 | 按客户端契约核实结果**推翻 §7.1 的并行方案**：手写 ESM 客户端不会被加载，产物必须是 `__ModuleLoader__.load` 脚本 ⇒ 定稿「单文件包装」构建链（`scripts/build-client.mjs`，零第三方依赖）并落地 M0b；座位定稿为 `conversation.chat.turnTail`；补充两条客户端通道的区分（§9.1.2）、面板 props 与自过滤规则（§9.1.3）、主题令牌用法（§9.1.4） |
| 0.4 | 2026-10-10 | **入口收束为用户侧唯一的 `/debug` 命令**（新增 §3）：新增 S0 签票信号与宿主侧票据硬校验（§3.3–3.4、§6.2.2）；顺带砍掉「Agent 推断 + 用户确认」那条路径，`awaiting-user` 语义收敛为纯「等用户复现后二选一」（§3.6）；新增约束「调试准则只在调试模式下注入」（§3.7）；§5 之后章节整体后移一位 |
| 0.5 | 2026-10-10 | **支持调试期间随时用输入框描述现象**（§9.3）：新增 S4b 与「三条输入路径」；面板座位**从 `conversation.chat.turnTail` 改为 `conversation.composer.dock`**（该座位给到 `useInput`/`inputActions`，用它才能在有草稿时禁用按钮，消掉「同一条描述送两遍」的竞态，§9.1.3、§9.3.1）；新增 `awaiting-user` → `active` 的宿主自动迁移（§9.3.2）；`dsh_debug_end` 增加「用户已表态」前置；面板改为常驻 + 三态可交互性；客户端落地面板骨架与迷你 hooks 渲染器测试（18/18） |
| 0.6 | 2026-10-10 | **代码改动成为调试的第三条腿**（§3.8）：第 1 轮只取证、第 2 轮起允许「先改代码再埋点验证」；新增 `dsh-debug:change <hash>` 标记与 `changedFiles` 字段，把**探针账与修复账分开**，收尾只撤探针、明令禁止 `git checkout` 整体回滚；`dsh_debug_report` 增加 `changedFiles`、`dsh_debug_end` 返回三类账；新增 **§3.7「Agent 可以拒绝进入调试」**（票据放着即过期，宿主不需要任何清理路径）；同步更新 `assets/AGENT-PROBE-GUIDE.md`（新增 §一「三件事」、§三「改代码」、§四「拒绝进入」、§七「改动块」）与 `lib/task.js` 的 `changedFiles` |
| 0.7 | 2026-10-10 | **新增 §16「防止多轮调试堆积临时代码」**（外部资料调研 + 对抗性评审两轮）：把「屎山」拆成 C1–C10 十种成因并分派机制；定稿 **R1 宿主侧工作区索引 + 窗口 diff（最重要，唯一不依赖 Agent 诚实）**、R2 宽松发现 + 严格分类 + 栈式配对的残留扫描器、R3 三色标记 + 隔离区、R4 停止规则、R5 欠账看板、R6 journal + backups；新增横切要求「闸门连续拒绝 3 次须降级 + 失效必须可见」；**§16.4 记录了被推翻的 7 项最初选择**（尤其「未标记默认当 fix」方向换错、假说配额可被三行 JSON 冲破、「token 不可伪造」是安全戏剧）；§16.6 给出分级证据与**一处未完成的实证空白** |

