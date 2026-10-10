# dsh-plugin-debug-mode · 设计文档

> 状态：**设计冻结稿（v0.18）**。本文只描述设计与契约，不描述实现进度；
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
   「问题已解决」→ 收工清理；「问题复现，需要进一步修复」→ 日志**保留**，Agent 读完再开下一轮；
5. 用户说「已解决」时，Agent 必须**删掉本次任务埋下的全部探针代码**——
   调试的产物不许留在代码库里。

### 1.3 非目标（明确不做）

| 不做 | 原因 |
| --- | --- |
| 不做断点/单步/变量监视 | 那是 IDE 的活；这里的「调试」= 结构化日志取证 |
| 不做日志的可视化分析面板（图表、时间轴） | MVP 只需要用户做一次二选一 |
| 不自动启动被调试程序 / 不代跑测试 | 见 §3.10：**Agent 在这个流程里不运行任何命令**，复现是用户的事 |
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
| `/debug <描述>` | 签发票据（记录 `sessionId` / `text` / `issuedAt`），并**开一轮对话**把插件指令 + 用户描述原文交给 Agent（§3.5.1） |
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
  async handler(invocation) {
    // invocation.agent.id —— 唯一可信的会话身份
    // invocation.rawInput —— 用户敲的描述原文
    await service.issueTicket({ … })                 // ① 签票
    const delivered = await service.deliverTurn({    // ② 开一轮对话（§3.5.1）
      sessionId, text: instruction, tag: 'debug-command',
    })
    return { kind: 'success', text: '已进入调试模式 · 本轮已开始…' }   // ③ 给人看的短句
  },
})
```

- `CommandDefinition = { definitionId?, name, description, input?: { hint, attachments? },
  recordInput?, handler }`；`handler` 返回
  `{ kind:'success', text? } | { kind:'error', text }`。
- 命令注册的上下文决定可见性："Plain-context definitions are global"，
  通过 command-injected 的 agent 子上下文注册可只对那个 agent 生效。
  本插件注册**全局**命令（所有会话都能敲 `/debug`）。
- 命令不该干重活：`/debug` 只做四件事——检查有无活跃任务、签票、开一轮对话、返回一句结果说明。

#### 3.5.1 ⚠️ 命令的返回值**不会**送给模型（已核实，本次修复的原因）

`@deepseek-ai/dsh-commands` 的 `execute()` 上写着（原文）：

> Parse and execute a known command **without sending it to the model**.

返回值只落到 `command/run` 与 `command/done` 两个 **log-only** 事件上（同一段注释：
"no turn wraps them"）。也就是说：

- **命令的 `text` 是给人看的结果说明**（首方 `/compact` 返回的就是
  "Compacted 12 history items" 这种回执）；
- 它**不会**被投给模型，也**不会**开启一轮。

v0.13 之前的设计把 `text` 当成"投给 Agent 的指令正文"，于是
`/debug <描述>` 的实际效果是：票据签了、面板上出现一段文字，**但模型什么都没收到**，
用户得自己再补一句「开始」——而那一句里也没有他的描述。这是设计文档与宿主行为不符
导致的 bug，不是实现疏漏。

**修法**：签完票之后显式调用 `ctx.sessionController.prompt({ mode:'queue', … })`
（`queue` 就是 `agent.followup(message)`：空闲时开一轮、忙时排队；`steer` 只在运行中有效），
把**插件写死的指令 + 用户描述原文**作为这一轮的内容投出去。因此：

| 阶段 | 指令从哪来 | 为什么 |
| --- | --- | --- |
| 持票（还没有任务） | **这一轮的内容**（`deliverTurn`） | 命令返回值不进模型，只能自己投一轮 |
| 有活跃任务 | `systemPrompt.section` 的注入段（§3.9） | 这一阶段每次模型调用都该知道埋点纪律 |

投递失败时命令必须返回 `kind:'error'` 并给出下一步（"直接把描述发送，票据已签好"）——
绝不能报"已开始"然后让用户干等，那正是本次要修掉的现象。
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

正确做法：`systemPrompt.section` 的 `text` 用 thunk，**没有活跃任务时返回空串**。

⚠️ 措辞要精确：条件是「没有活跃任务」，**不是**「没有任务且没有票据」。
持票阶段（敲了 `/debug`、还没调 `dsh_debug_start`）的指令不走这一段，而是由
`/debug` 自己开的那一轮带过去（§3.5.1）——命令的返回值不进模型，投递才是唯一出口，
所以这一段在持票阶段为空是对的，不是缺口。写错这个条件会让人以为"持票时模型什么都
没收到"是个 bug，从而在这里重复注入一份和那一轮完全相同的指令。

⚠️ 反过来，**有活跃任务时这一段必须自给自足**：它是唯一每次模型调用都在的文本，
所以本任务的**具体地址**（摄入端点、路由路径、桩与日志路径）都必须写在这里，
不能只留一句"优先走 HTTP 端点"（§7.6.7 记的那次事故：Agent 知道 origin 与哈希、
却不知道路径，只能反问用户）。

---

## 3.10 Agent 不运行任何命令（**这条不是建议，是流程的形状**）

调试模式是宿主侧的一个**独立服务**：Agent 在这个流程里的动作只有两种——

1. **给服务发信号**：`dsh_debug_start` / `report` / `continue` / `read` / `end`；
2. **在源代码里埋探针 / 改代码**：走编辑工具。

**"跑起来看现象"是用户的事，不是 Agent 的事。** 这条不是风格偏好，它来自一个
实测到的事故：

> 一次真实的调试里，工作区所在的 `D:\` 根目录属于 `SYSTEM`，当前账号在它上面
> 缺少「更改权限」这一项。DSH 在执行 **shell 命令**前的授权阶段调用
> `SetNamedSecurityInfoW` 失败（`Win32 5`），于是本会话内**所有** `pwsh` 调用全被拒。
> 但同一时刻 `edit` / `write` 工具**完全正常**——那三处修复就是用它们落下去的。

也就是说：**能挡住整个调试流程的，恰恰是这个流程本来就不需要的那一步。**
现在把这条写死进流程：

| 动作 | 需要命令吗 | 由谁做 |
| --- | --- | --- |
| 发信号（起任务/交卷/读日志/收尾） | 不需要 | Agent（工具调用） |
| 埋探针、改代码 | 不需要 | Agent（编辑工具） |
| **把被调试程序跑起来、复现现象** | 需要 | **用户** |
| 把探针记录送到宿主 | 不需要（Node 桩走文件系统；其它运行时走 §7.6 的 HTTP 端点） | 探针自己 |

由此产生的两条硬要求：

1. **准则必须说出来**（§3.9 的 section + `assets/AGENT-PROBE-GUIDE.md` 的 §零）：
   Agent 不会"顺手跑一下看看"，所以必须明确告诉它不需要跑；被沙箱挡住时也不要
   去找替代命令，直接埋点交卷。
2. **不能让任何一条必需的通道依赖命令**：这是 §7.6 存在的理由。浏览器页面
   既不能 import Node 桩也没有文件系统，过去唯一的出路是"起个本地服务器把页面
   伺服出来"——**那要跑命令**，于是整个流程在第一步就死了。宿主自己开一条
   HTTP 摄入端点，就把这条依赖彻底删掉了。

> 与 §3.7 的关系：那条说"一眼看出根因就别进调试"；这条说"进了调试就别跑命令"。
> 两者是同一个取向——**别为了走流程去走流程**。

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
| S3 | **进一步调试** | Agent | `dsh_debug_continue` | `active` / `awaiting-agent` | `active` (round+1) | **不变** | **清空**（流程里**唯一**的清空时机） |
| S4 | **读取日志** | Agent | `dsh_debug_read` | 任意非 `closed` | 不变 | 不变 | 只读 |
| S4b | **用户打字描述现象** | 用户 | 原生输入框 | `awaiting-user` | `active`（宿主自动迁移，§9.3.2） | 不变 | 不变 |
| S5 | **用户：已解决** | 用户 | 面板按钮 | `awaiting-user` | `awaiting-agent` | 不变 | **保留待删** |
| S6 | **用户：复现** | 用户 | 面板按钮 | `awaiting-user` | `awaiting-agent` | 不变 | **保留**（Agent 还没读它） |
| S7 | **结束调试** | Agent（**须用户已表态**） | `dsh_debug_end` | `awaiting-agent` | `closed` | 不变 | **删除** |

> S0 是**闸门**而不是任务操作：它不分配哈希、不建目录、不生成桩，只在本会话签一张
> 一次性票（§3.3）。把闸门单独列出来，是为了让「谁有权进入调试模式」这件事在
> 信号表里一眼可见——只有 S0 能授权 S1。

> 关键取舍：S5/S6 是**用户信号**，但它们不直接删日志——它们只把 Agent 唤醒并
> 投递一条结构化指令。真正的删除动作在 S7（Agent 执行清理后确认）里发生。
> 理由：删除日志和删除探针代码必须一起发生才有意义；而探针代码只有 Agent 能删。
> 若由用户信号直接删日志，Agent 可能拿到一个「日志已消失但探针还在」的中间态。

> 🔴 **S6 曾经被写成「清空」，那是个致命错误**（§17 v0.10 有完整记录）。
> S6 发生在 Agent **还没读**的时候：用户刚复现完，现场就在日志里等着，此时清空
> 等于把证据当场扔掉——然后宿主还发一条指令让 Agent「去 `dsh_debug_read`」，
> 让它读一份自己刚清空的文件。用户看到的现象是：**一点「复现」，日志就空了。**
>
> **清空的唯一时机是 S3**：那一刻 Agent 已经读过现场、正要开始新一轮埋点，
> 也就是**下一次用户复现之前**。这条边界由两道机器保证：
> ① `dsh_debug_continue` 是全流程唯一执行 truncate 的地方（S6 一行代码都不碰日志）；
> ② 它有**闸门 C**：日志里还有没读过的字节就拒绝清空（三振降级，§16.3.0）。

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
入参：{ analysis: string, headline?: string, reproSteps?: string[],
       probeFiles?: string[], changedFiles?: string[], probes?: {probe,why}[],
       undoHint?: {path,find,replace}[] }
返回：状态行（已记录，等待用户复现）+ 一句提示：可以在输入框直接描述现象，
      面板就在输入框上方
副作用：记录 analysis / headline / reproSteps 到任务状态；面板据此渲染
        「一句简短的回复 + 复现步骤清单」（§9.2）；status: active → awaiting-user
说明：这是 Agent 的**交卷动作**。调用它 = 「我这轮埋完了，请用户复现」。
     `headline` 与 `reproSteps` 是**给用户看的**两样东西（§9.2.1）：
     前者是一句话结论，后者是"照着做就能复现"的步骤清单；
     缺省时有兜底，但兜底只是不让人看到空白，不能替代 Agent 说清楚。
     `changedFiles` 与 `probeFiles` 分开记（§3.8）：前者收尾时**不得**回滚。
```

#### S3 `dsh_debug_continue`

```
入参：{ nextPlan?: string }
返回：状态行（第 n 轮开始，日志已清空）、日志路径、剩余额度（字节/行数上限）
副作用：清空日志文件（truncate 为 0 字节，**不删文件**）、round+1、
        lastRead 归零、status → active、重设 R1 基线索引
前置：任务必须存在；状态为 active / awaiting-agent
闸门 C（**本插件最重要的一道，见 §6.1 的 S6 说明**）：
  日志里还有「上次读取之后新增的字节」时**拒绝清空**，要求先 dsh_debug_read；
  同一原因连续拒绝 3 次后降级为 warn-only（§16.3.0）。
  ——清空是破坏性的，而"还有没读过的现场"是一个可以用数字判定的问题：
    `当前字节数 > (task.lastRead?.bytes ?? 0)`。
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
宿主路由处理 → **状态迁移 + 唤醒**（**S5/S6 都不清空日志**，见 §6.1 的 S6 说明）→
`sessionController.prompt(...)` 投递下面这条结构化指令。

投递给 Agent 的指令正文：

```
[debug-mode] 用户在面板上选择了「问题复现，需要进一步修复」。
任务：<hash> · 第 <n> 轮。**这一轮的日志完整保留着**——它就是你要的证据。
请按信号序列执行：dsh_debug_read（先看现场）→ 分析 → dsh_debug_continue（要开下一轮时才清空日志）→ 埋点 → dsh_debug_report。
⚠️ dsh_debug_continue 会**清空**日志，所以它必须排在 dsh_debug_read 之后——
   顺序反了，用户刚刚复现出来的东西就再也看不到了。
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
| `GET /state?sessionId=<id>` | 面板轮询：状态、轮次、日志行数、`lastReport`、`userNote`、`detector`（残留检测是否真的在工作）、`debts`；无任务时返回 `{ task: null }`（200，不是 404——面板要靠状态码区分"空"与"故障"） |
| `GET /board` | R5 欠账看板：所有未关闭的任务（跨工作区，限于宿主见过的仓库） |
| `POST /probe?h=<hash>` | §7.6 的 HTTP 探针摄入（**语言无关的统一入口**）。**只追加日志，不做任何状态迁移** |
| `GET /probe?h=<hash>` | §7.6.2 的**通道自检**：`{ok, round, status, logBytes, logLines, httpRecords, hint}` |
| `POST /resolve` `{hash, sessionId?, note?}` | S5 用户信号（已解决） |
| `POST /reproduce` `{hash, sessionId?, note?}` | S6 用户信号（复现）；`note` 可选（§9.3.3） |
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
        │                          ▼                   │ (清空日志, round+1) ← 唯一的清空时机
        │                   awaiting-user ─────────────┘
        │                        │  │
        │        S5 已解决 ───────┘  └─────── S6 复现（**日志保留**）
        │             ▼                        ▼
        │      awaiting-agent ◄────────────────┘
        │             │
        │        S7 end（删日志 + 验收清理）
        └────────────► closed
```

另有两条边：

| 边 | 触发 | 语义 |
| --- | --- | --- |
| `awaiting-user → active` | §9.3.2 宿主自动迁移（S4b） | 用户没点按钮，而是在输入框里补充了现象 ⇒ 球回到 Agent 脚下，面板收起按钮；但它**不是**用户表态，所以 `userVerdict` 清空、`end` 仍然被拒 |
| `active → closed` | 异常路径 | 只由 `end` 在任务不存在/已关闭时走到；正常收尾一律经 `awaiting-agent` |

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
| 单行 ≤ 8 KiB（整行），超限时**省略超长值后重新序列化**并标 `truncated` | 防止把一张图 base64 写进日志。**绝不是切整行**：那会切出半个 JSON，读端只能算脏行（§11.2 的教训）。超长值裁到刚好放得下，**不是**固定长度 |
| 只写不读、不轮转、不清理 | 生命周期完全由宿主掌控 |

非 JS/TS 项目（Python 等）：**首选 §7.6 的 HTTP 端点**（写日志这件事只有宿主一份实现，
语言无关）；只有当目标没有网络栈时才按同一行协议自写文件桩，落点 `runtime/probe.<ext>`，
同样受上表约束（`try/except` 全包、`open(..., "a")` 即写即关）。

### 7.6 HTTP 探针通道（**语言无关的统一入口**）

#### 7.6.1 为什么它是首选，而不是"给浏览器的补丁"

写日志这件事包含一堆**容易写错、且必须逐字一致**的细节：字段序、带时区偏移的 ISO 时间戳、
单行 8 KiB 截断、总量 16 MiB 上限、并发追加、目录与权限、脏行处理。

如果让每种语言各自照着文档实现一遍，就等于把**冻结协议复制成 N 份**——而它们必然漂移，
`lib/protocol.js` 与 `assets/probe.template.mjs` 之间的那份"两处实现对账"测试就是前车之鉴
（那还只是两种语言）。所以：**协议只留一份实现，就在宿主里**；其它一切运行时都只是
"把一条 JSON POST 过去"。

由此得到的能力，是文件桩结构上做不到的：**任何能发 HTTP 的语言都是一等公民。**
curl、Python、Node、Ruby、Go、PHP、PowerShell、Java、一个 WASM 沙箱、一个容器、
一台能连到宿主的小设备——同一个入口。

```
POST /dsh-debug-mode/probe?h=<hash>      写一条（或一批）记录
GET  /dsh-debug-mode/probe?h=<hash>      通道自检：这条通道活着吗
Content-Type: text/plain;charset=utf-8   ← CORS 简单请求，不触发预检
体：单条 JSON 对象 / 对象数组 / NDJSON；**只有 `probe` 是必填**
```

最小调用就是一行（下面所有语言片段都由宿主生成到 `runtime/probe.http.md`，
端点与哈希**已烘死**）：

```bash
curl -s -X POST '<端点>' -H 'content-type: text/plain' --data-binary '{"probe":"app.py:42:enter"}'
```

**投递方不需要做的**（宿主全接管）：省略 `ts`（宿主补当前时间，带时区偏移）；
写 `task`（URL 里的 `h` 就是真值，投递方说啥都不算数）；截断；限额；并发；路径。

#### 7.6.2 自检：让"通道死了"与"埋点没执行"不再长得一样

投递是**尽力而为**的（见 §7.6.3 第 4 条），于是通道一旦是死的，现象与"用户还没复现"
**一模一样**：日志一片空白。这是这条通道最容易浪费一整轮的地方，所以有两道机器：

1. **`GET` 自检**：返回 `{ok, hash, round, status, logBytes, logLines, httpRecords, hint}`。
   `httpRecords` 是宿主**已经通过这条通道收到过多少条**（任务的累计值）。
   Agent 被要求在**让用户复现之前**先 GET 一次——一次自检 5 秒，抵得上一轮白等。
2. **加载即报到**：两个生成的桩都在**模块加载期**写一条 `debug-mode:ready`。
   看得到它 ⇒ 桩是通的（去查调用点）；看不到它 ⇒ 桩没被加载（去查 import 路径 /
   `<script src>` / 进程是否重启过）。这一条把"日志为空"从一个谜变成**一个事实**。

`report` 与 `start` 的返回值都会把通道状态摆出来，并且**措辞上把两件事分开说**：
HTTP 计数是任务的累计值（衡量通道健康度），日志行数是**本轮**的（`continue` 会清空）；
宿主**只知道**自己经 HTTP 收到了几条（文件桩直接写文件，宿主看不见），
所以它绝不把日志行数冒充成"文件桩写入条数"——报一个自己其实不知道的数字比不报更糟。

#### 7.6.3 四条纪律（每一条都对应一次会静默丢数据的失败）

1. **传输，不是第二份实现。** 记录到达宿主后由 `lib/protocol.js` 的 `formatRecord`
   重新序列化落盘；`task` 由宿主**写死**（投递方说什么都不算数）；`ts` **省略则宿主补到达
   时刻、提供则原样采纳**——后者是必需的，不是漏洞：浏览器桩**批量发送**（200 ms 一批、
   卸载时冲刷），一条排队 200 ms 的记录必须保住**事件时刻**，否则整个时间序会错位
   （v0.17 的自检脚本第一版把这条写成了"投递方伪造无效"，是错的，已纠正）。
   协议的唯一真相仍然只有 `lib/protocol.js` 一处，所以"浏览器 / Python / Go 各写一遍协议"
   这件事根本不存在。
2. **只认已知任务。** `h` 必须匹配 `^[0-9a-f]{8}$` **且**属于一个活跃任务，
   否则 400/404。没有任何路径拼接，因此不存在路径穿越的可能。
3. **限额与 §11.2 同一套**：请求体 ≤ 64 KiB、单行 8 KiB 截断、总量 16 MiB 到顶后写一条
   `debug-mode:overflow` 就停手。**这是集中收口的最大好处**：限额只有一处实现，
   不依赖每种语言的桩都记得去数。
   **成功回 `200` + JSON 体，不回 `204`**：`accepted` / `rejected` / `bytes` 是投递方
   **唯一**的自检依据，而 `204` 按 HTTP 规范不许带响应体——严格客户端会直接拒绝读取它
   （实测 undici 抛 `Unexpected end of JSON input`）。只有 `OPTIONS` 预检用 204，
   它本来就不带体。
4. **投递是尽力而为，所以失败必须能看出来**：发不出去就静默丢弃（探针永远不许拖慢
   被调试的程序），因此诊断的第一顺位是**通道**而不是埋点位置——这就是 §7.6.2 存在的理由。

#### 7.6.4 什么时候**不**走 HTTP（诚实列出，否则"首选"会变成教条）

| 场合 | 用什么 | 为什么 |
| --- | --- | --- |
| 热路径（每帧 / 每请求上千次） | HTTP + 调用方聚合（每 N 次或每 X ms 一条） | HTTP 有往返开销 |
| 进程可能**硬崩**，要求"崩溃前最后几条必须落盘" | Node 文件桩 `runtime/probe.mjs` | HTTP 是先发后到，崩在半途的记录会丢；文件桩同步追加、不缓冲 |
| 运行时没有网络栈 | 自写文件桩（§7.4 的协议表） | 没有别的选择 |

#### 7.6.5 浏览器页面

页面既不能 `import` 一个 `file://` 模块（CORS 拦掉 module），也没有文件系统。
宿主因此额外生成一个**经典脚本**桩 `runtime/probe.browser.js`（零依赖、`window.dshProbe`、
批量发送、页面隐藏/卸载时冲刷）：

```html
<!-- dsh-debug:probe <hash> start -->
<script src=".dsh/debug-mode/tasks/<hash>/runtime/probe.browser.js"></script>
<!-- dsh-debug:probe <hash> end -->
```

**不要**为了"能 import 文件桩"而起一个本地服务器把页面伺服出来——那正是 §3.10 要消灭的
命令依赖，也是**这份文档存在的起点**（§17 v0.9 记录的那次事故）。

#### 7.6.6 安全姿态（如实写，不粉饰）

CORS 开 `*`，因为被调试页面多半是 `file://`（源是 `null`）或另一个端口的 dev server；
没有这些头，浏览器的 POST 会被直接挡掉，而**探针的失败是静默的**——用户只会看到
"日志是空的"。这里没有凭据、没有 cookie，端点唯一能做的事是往一个已知活跃任务的
日志里追加一条协议记录。§16.4 已经记过一次教训："只有面板能种下的 token"在宿主自己
开路由的前提下是**安全戏剧**——所以这里如实按「审计 + 摩擦」来设计，而不是假装有授权。

#### 7.6.7 端点地址从哪来（**别问用户，插件自己有**）

两个来源，**环境变量优先**：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `DSH_WEB_URL` | 宿主注入的"当前 Web GUI 的规范地址"；部署可能把它改成代理/隧道地址，所以让它优先 |
| 2 | `ctx.webServer.port` | **权威且总在手里**（webServer 是本插件的硬依赖） |

已核实 `dsh-web-app` 的 `localWebUrl()` 就是 `` `http://${LOOPBACK_HOST}:${port}` ``——
`DSH_WEB_URL` 本身就是从 `webServer.port` 算出来的；而且宿主已经把**同一个地址**注进了
**模型自己的系统提示**（`dsh-web-app` 的 `app:web-surface` 段：
"You are interacting with the user through the DeepSeek Harness Web GUI at …"）。

**为什么必须补上第 2 条（v0.13 的一个真 bug）**：v0.13 及以前只认环境变量，拿不到就写
"宿主地址未知、请让用户告诉你地址"，于是 Agent 手上的信息变成**半截 URL**——它知道 origin
（从自己的系统提示里读到的）、也知道任务哈希，**唯独不知道中间那段路由路径**，
只能反问用户「这里的 `<路径>` 是什么」。而这件事插件自己就能回答：端口在手里，路径是常量。

两个结论：

1. **路由路径必须当成"常量知识"写进注入段**——`POST <宿主地址>/dsh-debug-mode/probe?h=<hash>`，
   哈希走**查询串**而不是路径段。只给一个拼好的 URL 不够：URL 会随上下文压缩而丢，路径不会。
2. 拿不到端口时才降级，且降级也要**给出路径形状**让 Agent 自己拼，而不是把问题推给用户。

拿不到时仍然返回 null 并**明说**，绝不猜一个端口：猜错的后果是探针静默丢失，
那正是这个插件最不能接受的失败方式。

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

定稿座位：**`conversation.input.dock`**（`list`，**session 作用域**，
渲染在输入框卡片**正上方**）。

**为什么是"上方"（推翻了 v0.9 及以前的 `conversation.composer.dock`）**：
`composer.dock` 渲染在输入框卡片**下方**，于是这张卡片会把输入框整体往上挤——
用户的原话是「**挤兑了原有的提示词输入框的位置**」。这不是审美问题：
输入框是会话里唯一一直在用的东西，任何常驻面板都不该动它的位置。

首方在 `composerStack` 里的渲染顺序把这件事说得很清楚（`ui-conversation` 的产物）：

```js
const composerBar = div({ className: composerStack }, [
  hero && HeroShell,
  hero && heroWorkspaceRow,
  zone !== void 0 && renderSlot("conversation.input.dock", zone),   // ← 本插件在这里
  inputBar,                                                        // ← 输入框卡片
])
```

`input.dock` 是**文档流里的兄弟节点**、紧挨在 `inputBar` 之前，所以：

- 它**贴近**输入框（视线与手本来就在输入区，不需要去别处找）；
- 它**不可能遮挡**输入框（不是 overlay；`conversation.input.overlay` 才是"浮在卡片里"，
  那个座位**绝对不能用**）；
- 它**不会挪动**输入框的位置（它在上面，把上面撑开，而不是把下面顶起来）。

**为什么不是 turnTail（v0.4 被推翻的选择）**：这个岗位的 props 里有
`useInput(selector)`——**面板因此能看见用户正在输入什么**。turnTail 没有这个能力，
会导致一个没法优雅解决的竞态（见 §9.3.1）：用户在输入框里打了半句话、又顺手点了
「问题复现」，于是同一条现象描述被送了两遍。

已核实的座位字段（`Slots.listSubTree` 的 catalog）：

```
conversation.input.dock   kind: list   scope: session
purpose: "Full-width entries above the composer card."
registration: { id (必填), order?, label? }
ownerProps: InputZone { session: SessionSnapshot; input: InputState }   ← 直接给到 InputState
standardProps: useResource / useWorkspaces / usePanelInfo / useSessions / useSessionStatus /
               useSessionRetainInfo / useChat / useConversation / useInput / inputActions /
               useSession / sessionId / useProjection / useTrajectory
declaredBy: factory "conversation.content" (mf)
现占用者: todo(order 0) · goal(order 10) · queue(order 20)
```

- `sessionId` 直接给到（不需要再从别处推）；`useInput(selector)` 读输入框状态与草稿；
  ownerProps 里的 `input` 是同一份 `InputState` 的快照，作为**兜底**（旧宿主没有
  `useInput` 时仍然能判断草稿）。
- 取 `order: 30`：排在那三个占用者之后 = **紧贴输入框的那一格**——需要用户动手的东西
  应该离手最近。
- 注册形状：

```js
ctx.slots.inject('conversation.input.dock', () =>
  ctx.slots.register(
    { name: 'conversation.input.dock', id: 'debug-mode-decision', order: 30, label: () => '调试模式' },
    (props) => React.createElement(DebugDecisionPanel, props),
  ),
)
```

- `ctx.slots.inject(seat, cb)` 是**声明感知**的：座位声明塌陷时回调的注册会随之释放、
  回来时重装。**永远不要**裸调 `ctx.slots.register`——座位可能稍后才声明。
  `register` 返回 disposer；`inject` 的回调本身可以返回 disposer（就是它的 effect）。
- 这个座位只注册一次却服务**所有会话**，所以必须按 `sessionId` 自过滤、
  与本会话无关时 `return null`；**绝不要**在模块级放「当前任务」这类全局状态。
- 用**自己的 id**（`debug-mode-decision`）就是旁加一格，不会覆盖别人的 cell。

#### 9.1.3.1 折叠（面板不许常驻占地）

卡片**默认收起**，只在"轮到用户"时自动展开。规则：

| 任务状态 | 默认 | 理由 |
| --- | --- | --- |
| `awaiting-user` | **展开** | 这是唯一需要用户动手的时刻，藏起来等于让他找不到 |
| `active` / `awaiting-agent` | **收起** | 只剩一行状态；Agent 在干活时它不该占着输入框上方 |

- 头部整行是一个 `<button>`（键盘可达、`aria-expanded` 正确），点它手动折叠/展开。
- 手动选择**只对当时那个状态有效**：状态一变就回到默认策略（否则用户折过一次之后，
  下一次轮到他复现时卡片会一直藏着）。
- 折叠态的那一行必须**自己说清楚现在轮到谁**（"轮到你复现并选择" / "已通知 Agent 读日志"
  / "Agent 正在埋点/排查"）——收起不等于信息量为零，用户很可能就靠这一行决定要不要展开。
- `awaiting-user` 时卡片左侧加一道品牌色边：折成一个色条也仍然"在说话"。

#### 9.1.4 面板样式

用 `--dsw-alias-*` 主题令牌，**必须带 fallback**（如
`var(--dsw-alias-label-secondary, #6b7280)`），并且**不要**为实现浅/深色各写一份
覆盖块——alias 令牌本身就是按主题解析的。

**令牌来源（v0.10 起已核实，不再是猜的）**：`client/Theme` inspect provider 的
`listTokens` 给出的权威清单是——`--dsw-alias-bg-base` / `-bg-layer-1` / `-bg-layer-2` /
`-bg-overlay` / `-border-l1` / `-border-l2` / `-brand-primary` / `-label-primary` /
`-label-secondary` / `-state-error-primary` / `-state-idle-primary` /
`-state-success-primary` / `-state-warn-primary` / `--dsw-specific-sidebar-fill`。
本插件只用了这一批里的名字。首方样式表里还实际出现过 `--dsw-radius-lg`、
`--dsw-elevation-panel`、`--dsh-composer-card-max-width` 等**非别名**令牌，
面板用它们做圆角/阴影/与输入框对齐，**每一个都带 fallback**——
名字万一变了，最坏结果是回到朴素外观，而不是整块面板变透明或不可读。

**不做"主按钮"**：「问题已解决」与「问题复现」是一个二选一，把其中一个做成填充色
等于替用户表态。两个按钮同权重（描边样式），强调留给清单与标题句。

### 9.1.5 面板位置与归属

- **面板常驻于输入框上方**（不折叠时占一行头 + 正文，折叠时只占一行），
  从任务创建到任务结束都在——调试期间随时看得到当前轮次与日志量。
  可交互性与展开状态随状态变化（§9.1.3.1）。
- 归属：按 **`sessionId` + hash** 判定，不允许出现「A 会话的调试面板在 B 会话里弹出」。

### 9.2 内容：**一句回复 + 一份清单**（v0.11 重做）

面板只说两件事，而且顺序固定：**结论一句话**，然后**用户要做什么**。

展开态：

```
┌────────────────────────────────────────────────────────────────┐
│ ▾ 调试模式 · #deadbeef · 第 2 轮 · 轮到你复现并选择   312 行 48KB │  ← 整行可点，折叠/展开
│                                                                │
│ total 在 items 为空时算成了 null                                 │  ← ① 一句简短的回复
│                                                                │
│ 请按这个顺序复现：                                              │
│   1. 打开保存对话框                                             │  ← ② 用户要操作的步骤清单
│   2. 清空标题后点保存                                            │     （Agent 给的 reproSteps）
│   3. 回到列表页                                                 │
│                                                                │
│ 也可以不用按钮：直接在输入框里描述现象，同样算「还在」。          │
│   [ 问题已解决 ]   [ 问题复现，需要进一步修复 ]                  │
└────────────────────────────────────────────────────────────────┘
```

折叠态（**默认**，除 `awaiting-user` 外）：

```
│ ▸ 调试模式 · #deadbeef · 第 2 轮 · Agent 正在埋点/排查   312 行 48KB │
```

两条硬要求：

1. **短**。面板读的是 `task.headline`，不是 `task.lastReport`——整篇分析永远不进面板
   （旧版把 `lastReport` 塞进去，长到要把卡片撑成半屏，那正是"内容也需要修改"的来源）。
   步骤区另有 `max-height` + 滚动：清单再长也不许把输入框顶出视野。
2. **可照做**。清单项是**一条一个可执行动作**（"清空标题后点保存"），不是
   "请复现一下"这种愿望。这两样东西只有 Agent 能提供，所以它们是
   `dsh_debug_report` 的入参（§6.2 S2）；缺了有兜底（标题句取 `analysis` 第一行、
   步骤为空时给一句"请再复现一次"），但兜底只是不让人看到空白，不能替代 Agent 说清楚。

### 9.2.1 面板数据的来源（为什么必须加这两个入参）

| 面板上的东西 | 来源 | 缺省时 |
| --- | --- | --- |
| 一句简短的回复 | `dsh_debug_report` 的 `headline` | 取 `analysis` 第一行（剥掉 Markdown 标记、截断 80 字） |
| 复现步骤清单 | `dsh_debug_report` 的 `reproSteps` | 空数组 → 面板显示"请按你印象里的操作再复现一次" |
| 轮次 / 状态 / 日志量 | 宿主自己（`state.json` + `stat`） | —— |

"复现步骤"这件事**过去没人负责**：任务只记了用户的原始描述（`goal`），那是现象，
不是步骤；用户面对"请复现"只能凭记忆猜一遍当初怎么触发的。而 Agent 恰恰是唯一
知道"这次该按什么顺序操作才能命中那段代码"的角色——所以它必须说出来。

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

处理方式（这是必须选一个**给到 `useInput`** 的座位的全部理由——`input.dock` 与
被它取代的 `composer.dock` 都有这个能力，`turnTail` 没有）：

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
| 点「问题复现，需要进一步修复」 | 禁用两键，显示「已通知 Agent。这一轮的日志保留着，等它读完再开下一轮」 | S6：**保留日志** → `awaiting-agent` → 唤醒 Agent 去读 |
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
| 探针桩（Node） | 同目录 `runtime/probe.mjs` | 同上 |
| 探针桩（浏览器/远程） | 同目录 `runtime/probe.browser.js` | 同上（§7.6；只有连端口都拿不到时才不生成） |
| 探针代码片段（多语言） | 同目录 `runtime/probe.http.md` | 同上（§7.6.1；端点与哈希已烘死） |
| R1 基线索引 | 同目录 `index.json` | 同上 |
| 收尾备份与审计 | 同目录 `backups/`、`journal.jsonl` | 同上（**绝不自动还原**，只给用户查） |
| 会话绑定 | 内存 `Map<sessionId, hash>` + `state.json.sessionId` | 会话结束或进程退出 |
| 票据 | `.dsh/debug-mode/pending/<sessionId>.json` | 消费 / TTL / 会话结束 |
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
| 单条日志行 | 8 KiB（**整行**） | **省略超长值 → 重新序列化 → parse 往返校验**；通过才写盘，标 `truncated: true`。超长**字符串**裁到刚好放得下（记录贴近但绝不越过上限，v0.18：旧实现只用掉约四分之一预算）；**键/项数量**另有固定上限（50），两者独立——所以"4000 个小键"的记录只有几百字节，它是被数量截断的。绝不切整行（切整行 = 脏行，v0.15 修） |
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
| **面板的具体 Slot** | **已核实**：`conversation.input.dock`（输入框卡片**正上方**、文档流内、不可能遮挡输入框；§9.1.3） |
| **面板折叠策略与内容形状** | **冻结**（§9.1.3.1 / §9.2：默认折叠、只在 `awaiting-user` 自动展开；内容 = 一句 `headline` + `reproSteps` 编号清单） |
| 客户端半是手写 ESM 还是必须打包 | **已核实**：必须打包成 `__ModuleLoader__` 产物（§9.1） |
| 客户端构建链 | **已定稿**：`scripts/build-client.mjs` 单文件包装，零第三方依赖 |
| **用户侧入口只有 `/debug`，且由宿主票据硬校验** | **冻结**（§3） |
| **Agent 可以拒绝进入（一眼看出根因时）** | **冻结**（§3.7） |
| **Agent 在调试流程里不运行任何命令** | **冻结**（§3.10；实测事故驱动） |
| **日志清空的唯一时机是 S3（`dsh_debug_continue`）** | **冻结**（§6.1；S6 只保留不删，且 `continue` 有"没读过就不许清"的闸门 C） |
| **HTTP 探针通道（页面/远程运行时的唯一出路）** | **冻结**（§7.6；CORS + 只认活跃任务 + 同一套限额） |
| **HTTP 是**首选**埋点入口，文件桩是特例** | **冻结**（§7.6.1：写日志只能有**一份实现**，否则冻结协议会被复制成 N 份并漂移；热路径/崩溃前落盘/无网络栈三种场合例外，见 §7.6.4） |
| **桩加载即写一条 `debug-mode:ready`** | **冻结**（§7.6.2：它是"桩没加载"与"埋点没执行"的唯一区分手段） |
| **`GET /probe` 通道自检 + `report` 报通道状态** | **冻结**（§7.6.2：投递是尽力而为的，"通道死了"与"用户还没复现"必须可区分） |
| **探针账 / 修复账分开记，收尾只撤探针** | **冻结**（§3.8、§9.4） |
| 第一轮不改代码、第二轮起允许先改后验 | **冻结**（§3.8）；**闸门判据已收窄**为"出现 `dsh-debug:change` 或自报 `changedFiles`"——埋探针本身不算改代码（§16.3 R4） |
| **防堆屎山：成因分类 C1–C10 + 机制 R1–R6** | **已定稿**（§16；R1 最重要）；R1–R6 均已落地，R5 的跨任务看板走 `GET /board` |
| **闸门连续拒绝 3 次必须降级 + 失效必须可见** | **冻结**（§16.3.0）；已实现（`GATE_DEGRADE_AFTER`、写探针自检、面板 `detector` 字段） |
| **三色标记与四色处理（隔离区不允许静默保留）** | **冻结**（§16.3）；已实现（`probe`/`temp`/`fix` + `change`，`dsh_debug_end` 的 `quarantine` 三选一） |
| `TurnLocation` 的字段形状 | **不影响本插件**（面板改用轮询 + `sessionId`，不再依赖 turn 坐标） |
| 沙箱策略下的文件写入路径 | **实测**：`start` 前做写探针自检（`.dsh/debug-mode/.probe-write-test`），失败即拒绝并把「残留检测未生效」写进面板（§16.3.0） |
| 插件是否需要 Config | 暂无（全默认；用户设置走自己的 JSON 文件，与参考插件一致） |
| **`InputState` 的形状** | **已核实**：`{ draft, attachmentIds, draftRev, phase, occurrences, queue }`（`SessionInputShell.compose()`）；面板只读 `draft` + `attachmentIds` |
| **`PromptContentPart` / `SessionRequestId`** | **已核实**：`{type:'text',text}` 即为合法 part；`SessionRequestId` 是运行时字符串（充当幂等键），由宿主自己铸造 |
| **`systemPrompt.section` 的 order 取值** | **已核实**：`SECTION_ORDERS` 中 `TOOLS_SDK: 5000`，本插件取 **5050** |
| **`/debug` 是否出现在宿主命令面板** | **已核实**：`commands.register` 的 descriptor 会被 `@Remote list` 列给 UI（首方命令面板即由此渲染） |
| **宿主的 Web 基地址从哪来** | **已核实**：DSH 注入 `DSH_WEB_URL`（就是当前 Web UI 的地址）；拿不到时宿主**不生成**浏览器桩并明说，绝不猜端口 |

---

## 14. 路线图

| 阶段 | 内容 | 完成判据 | 状态 |
| --- | --- | --- | --- |
| M0 | 项目初始化：包清单、patch、协议模块、任务状态机、探针桩模板、协议测试 | `node --test test/*.test.mjs` 全绿；两份文档冻结 | **完成** |
| M0b | 客户端构建链与座位验证桩：`scripts/build-client.mjs` + `src/client.js` + 产物守卫测试 | 构建幂等、产物在 vm 沙箱里能被加载并注册座位 | **完成** |
| M1 入口与闸门 | `/debug` 命令（签票 + 投递指令文本）；票据的持久化、TTL、消费与幂等；`.dsh/debug-mode/pending/` | 无票调用 `dsh_debug_start` 被拒；敲一次 `/debug` 后能正常启动任务；重复 `/debug` 行为符合 §3.4 | **完成** |
| M2 宿主骨架 | 5 个信号工具（agent 作用域注册、JSON Schema 参数、`output.render`）；任务落盘与恢复；日志读写与摘要；`.dsh/` 与 gitignore | 手工在会话里跑完 S1→S2 全程，Agent 能拿到摘要 | **完成** |
| M3 唤醒闭环 | `webServer` 路由 + `sessionController.prompt` 投递；`systemPrompt.section`（thunk，仅调试模式下非空） | 不接面板，用 curl 打 `/resolve` 能真的让 Agent 开出下一轮 | **完成** |
| M4 面板 | 两个按钮 POST 到 `/resolve` `/reproduce`、草稿禁用、收尾三态、样式令牌 | 浏览器里完成一次真实二选一 | **完成**（代码与守卫测试就位；真浏览器验收仍待用户在 GUI 里走一遍） |
| M5 收尾与验收 | 清理对账；`end` 的点名机制；未关闭任务的提示 | 一次完整任务结束后 `git status` 归零（除 `.dsh/`） | **完成** |
| M6 打磨 | 上限配置、错误文案、Python 桩示例、README | 文档与实现一致 | **完成** |
| §16 R1–R6 | 工作区索引 + 窗口 diff、残留扫描器、三色标记 + 隔离区、停止规则、欠账看板、journal + backups | 见 §16.3 各自定义 | **完成** |

---

## 15. 待验证清单（下一步必须先做实验的点）

> 这些是设计上留的「接口空位」。**不要在没做实验前照着猜的名字写代码**——
> 先 `cordis_inspect_query` 或读参考插件，再改本节状态。
>
> **2026-10-10 第二轮核实（M1–M6 实现期）**：下面 10 项里 9 项已闭合，核实方式记在
> 每一项后面——**这是执行纪律的一部分：结论要能被人复核**。

1. ~~**`TurnLocation` 的字段形状**~~ → **不再需要**。面板改用 `sessionId` + 轮询，
   不再用 turn 坐标寻址（`conversation.input.dock` 直接给 `sessionId`）。
2. **沙箱**：已落地为**运行期自检**而不是静态结论——`start` 前写
   `.dsh/debug-mode/.probe-write-test`，失败即拒绝启动任务、并在面板常驻
   「残留检测未生效」。这比"查一次文档"更可靠：它反映的是**这台机器此刻**的事实。
3. ~~**是否需要显式开关**~~ → **已冻结**：只有 `/debug`（§3）。
4. **`PromptContentPart` / `SessionRequestId`** → **已核实**。依据：
   `@deepseek-ai/dsh-api-session-controller` 的 typert 声明
   `PromptContentPart = {type:'text',text} | {type:'image',…} | {type:'file',…}`；
   `SessionRequestId = Branded<'session-request-id'>`（运行时即字符串，被宿主当幂等键：
   `hasPromptRequest(agent, request.requestId)`）。
5. **`systemPrompt.section` 的 `name`/`order`** → **已核实**：
   `@deepseek-ai/dsh-system-prompt` 的 `SECTION_ORDERS` 里 `TOOLS_SDK: 5000`、
   下一段是 `DELIVERABLE_FILE_REFERENCES: 9000`；本插件取 **5050**（紧跟工具文档）。
6. **`InputState` 的字段形状** → **已核实**：`SessionInputShell.compose()` 返回
   `{ draft, attachmentIds, draftRev, phase, occurrences, queue }`，宿主自己比较草稿用的是
   `inputState.draft === ""`。`src/client.js` 的 `hasDraft` 因此**写死** `draft` +
   `attachmentIds`（按候选字段名探测的写法已删除：它会静默失效，写死会在字段改名时立刻红）。
7. **主题令牌** → **已核实来源**：首方客户端（`ui-conversation` 等的 CSS 产物）确实使用
   `--dsw-alias-*` 令牌。面板每一处都带 fallback，因此即使令牌改名也只是"回到默认色"。
8. ~~**`/debug` 怎么被用户发现**~~ → **已核实**：`commands.register` 的
   `CommandDescriptor` 会被 `ctx.commands` 的 `@Remote list(agent)` 列给 UI 渲染命令面板。
9. **观察用户消息的确切事件类型** → **已核实**：`session/event` 的 `event.type ===
   'user/message'`（`SessionEventMap` 里有定义），§9.3.2 的自动迁移据此实现。
10. **`ctx.remote.$on` 能否替代轮询** → 仍然**不赌**：第一版一律轮询（与两个已发布的
    第三方插件一致）。这是取舍不是未知。

**仍未闭合的一项**：真浏览器里走完一次完整二选一（M4 的验收判据）。代码路径已由
`node:vm` 沙箱里的产物测试覆盖（按钮 POST、草稿禁用、收尾三态、失效告警），
但"**在真实 GUI 里点一下**"这件事只能由人在 GUI 里做。

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
| 0.8 | 2026-10-10 | **M1–M6 全部落地**（实现期变更，逐条都有测试钉住）：① §15 的 10 项待验证里 9 项闭合，核实依据写回该节；② **R4 L1 的闸门判据收窄**为「出现 `dsh-debug:change` 或自报 `changedFiles`」——原措辞"文件被改过就拒绝"会把埋探针本身判成违规，是这个插件自己给自己制造的死锁（§16.3.0 要防的正是这个）；③ **R1 基线语义修正**：`report` 只量不推进基线，否则第二次交卷看到的 diff 永远是空的，R1 会退化成"Agent 自报"；④ 状态机新增 `awaiting-user → active`（§9.3.2 的宿主自动迁移，见 §6.3）；⑤ 路由表新增 `GET /board`（R5 跨任务欠账看板）；⑥ 探针桩新增 **16 MiB 总量上限**（§11.2）与 `debug-mode:overflow` 说明行，且尺寸**每次 stat 不缓存**——否则宿主清空日志后探针会以为还满着而永久停写；⑦ 隔离区按**文件**归并（同一文件的多个症状让用户回答一次）；⑧ `dsh_debug_end` 新增 `quarantine` 参数作为三选一的回填通道，`summary` 写进返回值与 journal；⑨ 工具返回值统一为 `{ok,text,…}` 并由 `output.render` 投影，错误路径与成功路径共用同一 schema（避免 `ToolOutputError` 把最需要被读到的错误吞掉）；⑩ 新增 `lib/scan.js`·`lib/summary.js`·`lib/prompt.js`·`lib/debug-service.js`·`lib/command.js`·`lib/tools.js`·`lib/routes.js` 与 5 个测试文件（69 个断言全绿）；⑪ 面板接上真交互与收尾三态，`InputState` 字段写死为实测值 |
| 0.9 | 2026-02-19 | **按一次真实事故（`D:\` 缺 WRITE_DAC ⇒ 所有 shell 命令被拒）收口「不需要任何命令」**：① 新增 **§3.10「Agent 不运行任何命令」**，把"发信号 + 埋点/改代码"写死为 Agent 的全部动作，复现归用户；② 新增 **§7.6 HTTP 探针通道**与 `assets/probe.browser.js`——宿主开一条 `POST /probe?h=<hash>` 的只追加写端点（CORS 简单请求、NDJSON、`task` 由宿主写死、限额与桩同一套），浏览器页面因此**不需要起本地服务器**（那要跑命令）就能埋点；③ `dsh_debug_start` 现在生成第二个桩并返回端点，宿主地址取自 `DSH_WEB_URL`，拿不到时**不生成也不猜端口**；④ 注入准则、`/debug` 指令正文、`assets/AGENT-PROBE-GUIDE.md`（新增 §零）三处都明确写出"不要运行任何命令"，并明说 shell 被环境挡掉不影响本流程；⑤ §1.3 非目标里"怎么跑起来由 Agent 决定"这句被本事故证伪，改为指向 §3.10；⑥ §10 存储表补齐 `index.json` / `backups/` / `journal.jsonl` / 浏览器桩 / 票据；⑦ 新增 `test/ingest.test.mjs`（8 条：协议一致、`task` 不可伪造、只认活跃任务、限额、CORS/预检、浏览器桩在 vm 里真的发出记录、端点未知时的行为） |
| 0.10 | 2026-02-19 | **修掉一个"用户一点「复现」，证据就没了"的致命错误**：① **S6 不再清空日志**（§6.1 的信号表从「清空」改为「保留」）——S6 发生在 Agent **还没读**的时候，清空等于把用户刚复现出来的现场当场扔掉，随后宿主还发一条指令让 Agent 去 `dsh_debug_read`（§6.2 原文自己就写着"本轮日志已清空…请按信号序列执行 dsh_debug_read"，前后矛盾）；② **清空的唯一时机收敛到 S3**，也就是"Agent 已读过现场、正要开始新一轮埋点"= **下一次用户复现之前**；③ 新增**闸门 C**：`当前日志字节数 > task.lastRead.bytes` 时拒绝清空并要求先读（三振降级）；`continue` 之后 `lastRead` 归零，否则闸门 C 会永久失效；④ **`gate()` 的签名改为 `gate(key, reason, detail)`**：`reason` 作为"同一原因"的比较键必须稳定，数字与清单挪到 `detail`——原先把 `检测到 N 个文件` 拼进 reason，会让每次比较都不相等、计数器永远归零，**所有闸门的降级机制其实都不会触发**（这是本次顺带发现的隐蔽死锁）；⑤ 三处顺序写反的文案一并改掉：`assets/AGENT-PROBE-GUIDE.md` 的「`continue`（清空）→ 读日志」、DESIGN §6.2 S6 的指令正文、`dsh_debug_continue` 的工具描述；⑥ 面板 `awaiting-agent` 文案从「本轮日志已清空」改为「日志保留着，等它读完再开下一轮」；⑦ 新增/改写测试：S6 之后日志必须还在、`continue` 之前必须有 `read`、闸门 C 三振后放行 |
| 0.11 | 2026-02-19 | **面板重做：从"挤在输入框下面"改成"贴在输入框上面的一张可折叠卡片"**（用户反馈"挤兑了原有的提示词输入框的位置"）：① 座位从 `conversation.composer.dock`（渲染在卡片**下方**）改为 **`conversation.input.dock`**（首方在 `composerStack` 里把它渲染在 `inputBar` **之前**，是文档流兄弟节点 ⇒ 贴近输入框、**不可能遮挡**、也**不会挪动**输入框），`order: 30` 排在 todo/goal/queue 之后紧贴输入框；② 新增**折叠**（§9.1.3.1）：默认收起，只在 `awaiting-user` 自动展开；头部整行是 `<button>`（含 `aria-expanded`），手动折叠只对当时那个状态有效；折叠态的**那一行必须自己说清轮到谁**；③ 面板内容重做为「**一句简短的回复 + 需要用户操作的复现步骤清单**」（§9.2）：`dsh_debug_report` 新增可选入参 `headline` 与 `reproSteps`（§9.2.1）——"复现步骤"过去没人负责（任务只记了 `goal` 这个**现象**，用户面对"请复现"只能凭记忆猜），现在由唯一知道该按什么顺序操作命中的角色（Agent）说出来；漏给时标题句取 `analysis` 第一行、步骤为空时给一句提示，但兜底只保证"不空白"；④ 面板不再渲染整篇 `lastReport`（长到把卡片撑成半屏），步骤区限高 + 滚动，面板再长也不许把输入框顶出视野；⑤ 样式令牌换用 `client/Theme` provider 的权威清单（§9.1.4），非别名令牌（圆角/阴影/对齐）一律带 fallback；⑥ 去掉填充色"主按钮"——「已解决 / 复现」是二选一，把其中一个做成主按钮等于替用户表态；⑦ 测试：座位断言钉死为 `conversation.input.dock`、折叠两个方向都测、内容必须是 `ol/li` 清单且不得包含整篇分析、`headline`/`reproSteps` 的兜底与规范化（去换行、截断、封顶 12 条） |
| 0.18 | 2026-02-19 | **一次真实收尾的第三轮反馈：我的 §7.2 表有一行是错的，而且指南示例正好教 Agent 走进那个失败布局**（用户实测，站点 A 两次一致）：① 我原先写"✅（空行在块内）+ 原地有 1 个空行 ⇒ 那 1 个空行原样保留"——**错**。真相是**空行的命运只取决于它落在标记的哪一侧**：标记**外**宿主不碰（活下来），标记**内**跟块一起消失。所以有一种清理逻辑**兜不住**的错误：**把原有的空行包进标记里** ⇒ 它被连带删除（吃掉用户的空行，`collapsedBlankLines` 甚至是 0，因为它在删除区间里，不叫"收敛"）。而我的 ✅ 示例恰好把块插在原空行的位置上，**照抄就会吃掉一个空行**——示例旁边的注释还写着"逐字相同"。修法来自用户的一句话：**原来就有的空行留在标记外，只有自己为好看加的空行才放进标记内**；机械做法是"`start` 插在原有空行的后面"。指南 §7.2 重写为四象限表（含两个错误方向的代价）、示例改成两种子情形各一份、注入准则同步；② 用户还指出**行数会骗人**：实测出现过「一处少 1 行 + 一处多 1 行 ⇒ 总行数与基线相同」，只看总数会判成"全对"，实际是一个空行从 `import` 区搬到了 `create_order` 里。校验必须比**位置**——`scripts/probe-selfcheck.mjs` 因此新增**空白演练**（第四节）：5 个布局（含专门的"行数相同、位置不同"用例）按位置打出 before/after，并进退出码；③ **截断只写了触发条件、没写结果**（用户实测：触发线是**整行** 8 KiB，但旧实现裁完只占约 2.3 KB——**只用掉约四分之一预算**，10 KB 的值白扔四分之三的证据）。这不只是文档缺口，是**行为不值得**：`encodeRecord()` 改为**把预算用足**（先按固定档位找可行解，再二分找最大的能放下的 clip 长度；二分是确定性的，所以三处实现仍逐字一致）。实测：10000 字符的 msg → 整行 8192 字节、值保留 8100 字符（旧：2153 字节 / 2061 字符）。`MAX_RECORD_BYTES` 的文档补上"触发线 vs 结果"两件事；④ 自检脚本的**三处一致性**用例暴露出一个测试自身的坑并已修：`ts` **参与 8 KiB 预算**，宿主侧若给个 7 字符的 `'FIXED'`、桩侧是 29 字符的 ISO 时间，两者会二分出不同的 clip 长度而"不一致"——而事后归一化 `ts` 补不回来。测试改用等长 `ts` 并断言长度；⑤ `probe.http.md` 新增 §七：**要读回一个数字，就把它放进一条独立的小记录**（`read` 的显示层会对 >240 字符的 `data` 缩写，把数字塞进大记录会被吃掉——用户上一轮就这么失手过） |
| 0.17 | 2026-02-19 | **新增 `scripts/probe-selfcheck.mjs`（探针边界自检）**：把"构造边界值 → 逐条 POST → 读日志 → 对脏行/标记/字节"这套被人工做过好几轮的动作固化成一条命令、退出码可进 CI。两种模式：**本地**（临时工作区 + 真实 `DebugService`，不需要 DSH 在跑）与 **`--endpoint`**（打活的 DSH，验证路由/CORS/真实宿主）。三道判据：边界矩阵（值是否完整 / 是否有 truncated 标记 / 值里是否说清省略多少 / 行字节是否越线 / 是否新增脏行）、协议不变量、三处实现（宿主摄入 / Node 桩 / 浏览器桩）逐字一致。**它第一次跑就抓到一个真 bug**：`encodeRecord()` 的**骨架兜底分支**里写着 `probe: String(out.probe).slice(0, 200)`——9000 字符的 probe 走到那条路时值被砍了、`truncated: true` 也有，但**值里没有任何省略说明**，与 v0.16 那个静默预截断是同一类缺陷，只是藏在更深的兜底分支里；修法是让 `probe` 也参与逐档降级（`clipValue`），并把骨架里的裸切换成 `clipValue(…, 200, 0)`（三处实现同步）。② 同时纠正一处**被我自己写错的契约**：自检脚本第一版断言"投递方伪造 ts 无效"，实测发现宿主**原样采纳**投递方给的 `ts`——而这**是必需的**：浏览器桩批量发送（200 ms 一批），排队中的记录必须保住**事件时刻**，否则整个时间序错位。真相是"省略 ⇒ 宿主补到达时刻；提供 ⇒ 采纳"，已写进 §7.6.3 与 `probe.http.md`。③ 自检脚本还会**自检矩阵**：每条用例的请求体必须 ≤ HTTP 的 64 KiB 上限，否则活模式 400、本地通过（实测踩过：9000 个小键），矩阵写错会直接指出来而不是误导人去查被测代码。④ 新增测试：`test/wiring.test.mjs` 会真的跑这个脚本并断言退出码 0 + 矩阵没被削薄 + 三处一致性真的比过——自检脚本本身不会腐烂 |
| 0.16 | 2026-02-19 | **「顶层 msg 10000 没被标 ⚠️截断」的真相：既不是没截、也不是 8 KiB 那条路漏标，而是两条没人知道的静默预截断**（用户实测反馈，并已自己排除了两个假设）：`ingestProbe` 里写着 `probe.slice(0, 200)` 与 `String(raw.msg).slice(0, 2000)`——10000 字符的 `msg` 被悄悄砍到 2000，**8000 字符无声消失且没有任何标记**；而那一行只有 ~2 KB、**根本没碰到 8 KiB 上限**，所以从"行是否超限"这个角度看一切正常，它能藏住的原因正在这里。更糟的是 **Node 桩没有这两条预截断**：同一条记录走文件桩会正确地标 `truncated`，走 HTTP 却不会 ⇒ 同一协议在三处实现给出不同结果（正是本仓库最防的漂移）。修法：**删掉两条静默预截断**，把截断权威收敛到唯一一处 `encodeRecord()`（它省略超长值、重新序列化、永远留 `truncated: true` 与 `…<省略 N 字符>`）。现在 10000 字符的 msg 走 HTTP：2061 字符落盘、2184 字节、`truncated: true`、0 脏行；② 新增守卫测试 **"宿主摄入路径不许有任何静默截断"**：对长 `msg`（10000/30000/中文）与长 `data` 逐个断言"要么值完整、要么带标记且值里写清省略了多少"，并单独断言长 `probe` 标识不被砍（它是分组计数的键，砍了会让两组悄悄合并）；超限矩阵补上中文 `msg` 与 `msg@30000`，三处实现继续逐字比对；③ **空白收敛的策略边界实测并写死**：缝上**收敛到 ≤1**、"远离缝的双空行一个字都不动"、"✅ 写法（空行放进块内）在原地本来就有空行时**不会**把它吃掉，且原地没有空行时能逐字还原"——三条都进了 `test/scan.test.mjs`。诚实记下两条能力边界：(a) 缝上"原本 0 个空行"与"原本 1 个"无法区分，所以 ❌ 写法（块外加填充）在原无空行处会留 1 个空行（比修前的 2 个少，但不是 0）；(b) 缝上出现 2 个以上空行时**一律收敛到 1**，包括用户自己写的双空行——代价是可能动到用户的排版，收益是"不再留 2 个"，这正是连续五轮的 bug。要改成"❌ 站点也收敛到 0"只需把 `collapseSeamBlanks()` 的 `keepOne` 在"块内没有空行"时置 false，属于策略选择，留给用户定 |
| 0.15 | 2026-02-19 | **一次真实收尾暴露的三个 bug（用户报告）+ 一个被它解开的悬案**：① **超限截断写出半个 JSON ⇒ 脏行**：老实现是 `line.slice(0, 8*1024-32) + '…","truncated":true}'`，它只在切点**恰好落在顶层字符串字段**（如 `msg`）里时才成立——补上的 `"` 与 `}` 正好闭合字符串和对象，所以能解析；切点落在 `data`（嵌套对象/数组/数组元素）里时那些 `[`/`{` 永远合不上，读端只能算脏行。实测因此呈现"坏点在 8000–8200 之间、与嵌套深度和容器类型都无关、只与值在不在顶层有关、顶层 msg 10000 反而可解析"的诡异形状。改为 **`encodeRecord()`：省略超长值 → 重新序列化 → 实测字节 → parse 往返校验**（`lib/protocol.js` + 两个桩**三处逐字同构**，`test/protocol.test.mjs` 喂同一批负载比对字节）；顺带把"按字符数算长度"改成真正的 UTF-8 `byteLength()`（中文 3 字节、代理对 4 字节）；② **摘除探针块留下多余空行**（用户说连续五轮同一模式）：Agent 为视觉分隔在块**外部**前后各留一个空行，而宿主只删标记之间的行 ⇒ 空行留下、文件里凭空多一处空白。`removeBlocks()` 现在在**每一处摘除缝**上收敛空白：只删纯空白行、只在缝上删、至多留一行（文件首行折叠成 0），并返回 `collapsedBlankLines` 供收尾报告如实说明；同时把**预防**写进指南 §7.2（要分隔就把空行放进块内）。诚实记下能力边界：宿主**无法区分**"这里原本 0 个空行"与"原本 1 个"，所以"与插入前逐字相同"只能靠插入纪律；③ **`…` 同时表示"宿主真的截断了"与"只是显示层缩短了"**——用户为此设计了整组实验去区分。查代码后确认：`summary.js` 对任何渲染后超过 **240 字符**的 `data` 都加 `…`，所以那是纯显示层行为，**并不存在**"正常的整值省略路径"。现在两者长得完全不同：记录里带 `truncated:true` 的显示 `⚠️截断`（不可恢复），显示层缩短的显示 `…（显示省略 N 字符，日志里是完整的）`；④ `probe.http.md` 的 Python 片段把响应 `close()` 掉了——而在"shell 被沙箱挡、`web_fetch` 拒绝 `127.0.0.1`"的环境里，**读回执是唯一的自检手段**。改成 `with` 块读完并返回回执，新增 `echo=True`，并写明"把回执再发一条探针进日志"这一招；⑤ 摄入响应新增 `degraded` 计数（降级了几条），与 `accepted`/`rejected` 一起构成可自检的回执；⑥ 测试 92 条（新增：超限矩阵 vs 三处实现逐字一致 + 脏行反例守卫、缝上空白收敛的四种形状 + 不动 `fix` 周围空白、`⚠️截断` 与 `显示省略` 必须可区分、`byteLength` 的 UTF-8 语义） |
| 0.14 | 2026-02-19 | **修掉「Agent 知道 origin 和哈希、却不知道路径」——注入段必须自带本任务的具体地址**（用户反馈原话："Agent 明确 http://127.0.0.1:19387/<路径>/5d0341c9，但插件没有告诉它这里的 <路径> 是什么"）：① 核实了地址的**两个**来源——`dsh-web-app` 的 `localWebUrl()` 就是 ``http://${LOOPBACK_HOST}:${webServer.port}``，也就是说 `DSH_WEB_URL` 本身是从 `webServer.port` 算出来的，**而且宿主已经把同一个地址注进了模型自己的系统提示**（`app:web-surface` 段）。所以 Agent 手里一直有 origin，缺的只是**路由路径**；② `endpointBase()` 增加 `ctx.webServer.port` 作为来源（环境变量优先，部署可能改成代理/隧道地址）——端口就在本插件的硬依赖里，"宿主地址未知、请让用户告诉你地址"那条路本来就是多余的，它把插件自己能回答的事推给了用户；③ **注入段（`debugGuidance`）改为自给自足**：它是唯一每次模型调用都在的文本，现在带上本任务的**全部地址**——摄入端点、**固定的路由路径形状**（`POST <宿主地址>/dsh-debug-mode/probe?h=<hash>`，并点明哈希走**查询串**而不是路径段、宿主地址就是它系统提示里那一段）、文件桩路径、日志路径、指南路径。只给一个拼好的 URL 不够：URL 会随上下文压缩而丢，路径不会；④ 拿不到端口时才降级，且**降级也要给路径形状**让 Agent 自己拼，而不是反问你；⑤ `assets/probe.http.md` 顶部补一句"路径固定、只有目标不在本机时才换前半截"（容器/异地场景）；⑥ 修掉上一版引入的一个渲染 bug：把条件块当**单个元素**塞进数组，`.join('\n')` 会用 `Array.prototype.toString()` 把它变成"A,B"，逗号就留在正文里了——必须 `...` 展开；⑦ 测试 87 条：端点来源两种顺序 + 非法端口不猜、注入段在**两种**情况下都含路径形状（这是本次修复的核心回归守卫）、注入段含端点/桩/日志/指南路径、逗号粘连的回归守卫；⑧ 净效果：Agent 不再需要问任何人地址，`dsh_debug_start` 的返回值也不再是唯一的信息来源 |`n| 0.13 | 2026-02-19 | **修掉「敲了 `/debug` 还得再补一句『开始』」——命令的返回值根本不进模型**（用户反馈）：① 已核实 `@deepseek-ai/dsh-commands` 的 `execute()`，注释原文 "Parse and execute a known command **without sending it to the model**"，`result` 只落进 `command/run` / `command/done` 两个 log-only 事件（同一段注释："no turn wraps them"）——也就是说 v0.12 及以前 DESIGN 里写的「`kind:'success'` 的 `text` 就是投给 Agent 的指令正文」**是错的**：`/debug <描述>` 的实际效果是签了票、UI 上出现一段文字，而**模型什么都没收到**，用户不补一句「开始」流程就不动，而且那一句里没有他的描述；② 新增 **§3.5.1** 记录这个契约（含原文证据）与修法：签完票后显式 `ctx.sessionController.prompt({ mode:'queue' })`（`queue` = `agent.followup`：空闲开一轮、忙时排队），把**插件写死的指令 + 用户描述原文**作为这一轮的内容投出去；③ 对应地把「持票阶段的指令从哪来」写成一张表：持票期走这一轮、有活跃任务时走 `systemPrompt.section`（§3.9 的措辞一并精确化：条件是**没有活跃任务**，不是"没任务且没票"——写错会让人以为持票期为空是缺口，然后在系统提示里重复注入一份完全相同的指令）；④ `DebugService.wakeAgent` 泛化为 **`deliverTurn({sessionId, text, tag})`**，命令与面板唤醒共用同一条通道；⑤ 指令正文加入"**这一轮就是完整的请求**，不要回复『好的，请描述一下现象』、也不要等用户再说一句『开始』"；⑥ 命令的返回值改为**给人看的短句**（"已进入调试模式 · 本轮已开始"），投递失败时返回 `kind:'error'` 并给出下一步（"直接把描述发送，票据已签好"）——绝不报"已开始"然后让用户干等；⑦ 测试：`/debug` 必须开出一轮且内容含描述原文与"不要等「开始」"、命令返回值必须是短句、投递失败要如实说且票据仍有效、没写描述时也要开一轮让 Agent 主动问；⑧ AGENTS.md §6 的核实清单同步纠正（这条错误认知正是 bug 的来源） |`n| 0.12 | 2026-02-19 | **HTTP 探针通道从"给浏览器的补丁"升为「语言无关的统一埋点入口」**（用户指出：写日志应该是 fetch 本机调试服务，而不是在源码里为每种语言手写写文件的代码）：① §7.6 重写为七个小节——**写日志只能有一份实现**（字段序/时间戳/8 KiB 截断/16 MiB 上限/并发追加全归宿主管），否则冻结协议会被复制成 N 份并必然漂移（`lib/protocol.js` ↔ 探针桩之间那份"两处实现对账"测试就是前车之鉴，那还只是两种语言）；② 新增 **`GET /probe` 通道自检**（§7.6.2）与 **`report` 的通道状态行**——投递是尽力而为的，"通道死了"与"用户还没复现"的现象一模一样（日志一片空白），现在这个问题可判定；③ 新增 **桩加载即写 `debug-mode:ready`**（两个桩都写），它把"日志为空"从一个谜变成**一个事实**：看得到=桩通了去查调用点，看不到=桩没加载去查 import；④ 宿主生成第三份产物 **`runtime/probe.http.md`**（§7.6.1）：curl/Python/Node/Ruby/Go/PHP/PowerShell/Java 八份**端点与哈希已烘死**的现成片段，Agent 不再需要为任何语言照协议写桩；⑤ 指南重写 §五/§六：HTTP 是首选，**自写文件桩降级为"最后手段"**并明确列出三种例外（热路径 / 崩溃前落盘 / 无网络栈），§零 补一条"不要为了能 import 文件桩而起本地服务器"；⑥ 注入准则同步；⑦ **措辞纠正**：`report` 报"本轮日志 N 行"而不是把它冒充成"文件桩写入条数"（文件桩直接写文件，宿主看不见——报一个自己不知道的数字比不报更糟），并把 HTTP 累计计数与**本轮**日志行数分开表述；⑧ 顺带修掉三处仍写着"输入框下方"的面板文案（v0.11 已把面板移到上方）；⑨ 新增/改写测试 8 条：多语言片段占位符与语言覆盖、`probeStatus` 的累计计数与提示、`report` 的通道状态两种分支（通道已验证/未验证给的是**不同**建议）、浏览器桩的加载即报到与 NDJSON 批量、`task` 不可伪造与最小调用（只有 `probe` 一个字段）；⑩ **用真 HTTP 客户端（undici）跑了一遍全链路，当场抓到一个 bug**：摄入成功原先是 `204` + JSON 体，而 204 按规范不许带体——严格客户端直接拒绝读取这段自检信息（`Unexpected end of JSON input`），浏览器桩因为不看响应所以一直没暴露。改为 **200 + JSON 体**（`OPTIONS` 预检仍是 204） |

