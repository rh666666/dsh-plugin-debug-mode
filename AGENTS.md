# AGENTS.md — 给 AI 协作者的项目手册

> 这是 `dsh-plugin-debug-mode` 的**唯一权威入口**。动手前请先读本文件，
> 再读 [DESIGN.md](./DESIGN.md)。两份文件冲突时以 DESIGN.md 的契约章节为准，
> 以本文件的工程纪律为准。

---

## 1. 这个项目是什么

一个 DSH（DeepSeek Harness）插件，灵感来自 **Cursor Agent 的 Debug 模式**。

一句话：**让 Agent 别猜，自己在代码里埋探针，把现场取回来；用户复现后二选一。**

完整流程：

```
用户：现象描述
  └─ Agent 分析代码 → 埋探针（带可摘除标记）→ 跑起来
       └─ 探针按固定协议写 <repo>/.dsh/debug-mode/tasks/<hash>/<hash>.log
            └─ Agent 通过「读取日志信号」拿到摘要（不自己去翻文件）
                 └─ 用户复现 → 弹出面板：
                      [ 问题已解决 ] → 删日志 + 删掉本次任务的全部探针代码
                      [ 问题复现，需要进一步修复 ] → 清空日志，同一任务再来一轮
```

包名：`dsh-plugin-debug-mode`（npm 与 DSH bundle 同名，不带 scope）。
对外标识：`/debug` 命令、`dsh_debug_*` 工具、`dsh-debug:probe <hash>` 探针块标记。

用户侧的进入方式**有且只有一个**：`/debug <现象描述>`。

### 1.1 核心不变量（**改代码前必须确认不破坏这几条**）

1. **入口唯一：只有 `/debug` 命令能进入调试模式。** 不做对话意图识别、不做按钮。
   `dsh_debug_start` **必须持票**（`/debug` 签发的会话级一次性票据）才放行；
   无票调用一律拒绝。这是**宿主侧硬校验**，不是提示词约定——工具对所有会话可见，
   模型永远能调用它，只有返回值拦得住（DESIGN.md §3.3、§6.2.2）。
2. **一个任务一个哈希。** 首次进入调试模式时生成，之后无论多少轮都不变。
   哈希用 CSPRNG 生成 8 位小写十六进制，且**只由宿主生成**，从不接受外部传入。
3. **进一步调试清空日志但保留哈希。** （truncate 为 0 字节，不删文件、不换目录。）
4. **用户信号不直接删日志。** 「已解决」只唤醒 Agent；删日志与删探针代码由
   `dsh_debug_end` 一并完成——两者必须同生共死。
5. **探针代码必须可机器摘除。** 每处探针都被 `dsh-debug:probe <hash> start/end`
   夹住；`dsh_debug_end` 要能凭标记把代码库恢复干净，并给出对账清单。
6. **Agent 不直接读日志文件。** 日志内容一律经 `dsh_debug_read` 输出；
   摘要优先、异常全量、省略量显式声明。
7. **调试准则只在调试模式下注入。** `systemPrompt.section` 的 `text` 必须是 thunk，
   无活跃任务且无票据时返回空串；否则没进调试模式的会话也会收到「去埋点」的指令，
   等于把入口约束从提示词层面又打开一次（DESIGN.md §3.9）。
8. **协议冻结。** 日志行格式与字段序见 DESIGN.md §7.2；只能新增可选字段，
   且必须同步 `lib/protocol.js`、`assets/probe.template.mjs` 与测试。
9. **输入框始终可用。** 调试模式下用户随时可以用原生输入框描述现象——按钮只是
   快捷方式，不是唯一出口。因此：① 面板**不得**抢走或挡住输入框；
   ② 输入框有未发送内容时**禁用**面板按钮（否则同一条描述会被送两遍）；
   ③ 宿主观察到 `awaiting-user` 状态下出现新的用户消息时，自动迁移到 `active`
   （DESIGN.md §9.3）。
10. **探针账与修复账分开记，收尾只撤探针。** 探针用 `dsh-debug:probe <hash>` 包裹、
   代码改动用 `dsh-debug:change <hash>` 标记；`probeFiles` 与 `changedFiles` 分别登记。
   收尾**只删探针、绝不回滚用户的修复**；用 `git checkout` / `git stash` 整体回滚是
   **明令禁止**的收尾方式（会连带 revert 掉用户要的修复）——DESIGN.md §3.8。
11. **Agent 可以不进调试。** `/debug` 是用户发起的，不是契约：一眼能看出根因时，
   Agent 应当**不调用** `dsh_debug_start`，说明根因并直接改代码（票据自己会过期，
   无需任何清理动作）——DESIGN.md §3.7。
12. **闸门不能造成死锁，也不能 fail-open 而不告知。** 任何硬闸门**连续拒绝同一原因 3 次**
   后必须降级为 warn-only 并把降级写进欠账；闸门依赖的扫描能力不可用时（只读沙箱、
   路径在仓库外等），必须在面板显示「残留检测未生效」，**绝不假装保护着**——DESIGN.md §16.3.0。
13. **残留处理由「可判定性」决定，不由风险偏好决定。** `probe`/`temp` 必删、
   `fix` 保留、**hash 不属于任何已知任务或格式残缺的一律进隔离区**（逐条让用户三选一），
   完全无标记的只提示不删。**不允许静默保留**——漏删的临时改动没有任何下游拦截，
   它不报错、不告警，只是慢慢烂掉，那正是「屎山」的定义——DESIGN.md §16.3、§16.4。

---

## 2. 当前状态

**M0 + M0b（初始化 + 客户端构建链）+ 面板骨架已完成，业务功能尚未实现。**

已落地：

| 文件 | 内容 |
| --- | --- |
| [DESIGN.md](./DESIGN.md) | 设计冻结稿（v0.7）：入口/信号协议、代码改动纪律、日志协议、状态机、面板、**防堆屎山机制（§16）**、路线图、待验证清单 |
| [package.json](./package.json) | 包清单：`dsh.bundle.patch` + `dsh.client` 双挂载声明 |
| [cordis.patch.yml](./cordis.patch.yml) | bundle 挂载声明（插入 `debug-mode` 行） |
| [lib/protocol.js](./lib/protocol.js) | 日志行协议的唯一真相：`formatRecord` / `parseRecord` / `parseLog` |
| [lib/task.js](./lib/task.js) | 任务哈希、路径约定、状态机与迁移白名单 |
| [lib/probe-template.js](./lib/probe-template.js) | 由模板生成探针桩（锚点校验，缺锚点即抛错） |
| [assets/probe.template.mjs](./assets/probe.template.mjs) | 零依赖探针运行时模板（宿主生成时烘死 TASK/LOG） |
| [assets/AGENT-PROBE-GUIDE.md](./assets/AGENT-PROBE-GUIDE.md) | 回给 Agent 的埋点指南模板（含 `{{HASH}}` 等变量） |
| [src/client.js](./src/client.js) | 浏览器半**源码**：composer dock 座位 + 三态面板 + 草稿协调 |
| [scripts/build-client.mjs](./scripts/build-client.mjs) | 把源码包成 `__ModuleLoader__` 产物（零第三方依赖） |
| [lib/client.js](./lib/client.js) | 【生成物】客户端产物，勿手改 |
| [lib/index.js](./lib/index.js) | 宿主半入口（当前只有 `name` / `inject` / `apply` 骨架） |
| [test/protocol.test.mjs](./test/protocol.test.mjs) · [test/client-bundle.test.mjs](./test/client-bundle.test.mjs) | 19 个守卫测试，全绿（含一个迷你 hooks 渲染器） |

未落地（按 DESIGN.md §14 路线图的 M1–M6）：`/debug` 命令与票据闸门、5 个信号工具、
日志读写与摘要、唤醒闭环、面板的按钮接线与样式、残留扫描器（R1/R2）。

---

## 3. 目录结构与职责

```
debug-mode/
├── AGENTS.md                  ← 本文件
├── DESIGN.md                  ← 设计冻结稿（契约以此为准）
├── README.md                  ← 面向用户的安装与简介
├── package.json               ← dsh.bundle.patch + dsh.client + exports
├── cordis.patch.yml           ← bundle 挂载声明
├── .gitattributes             ← 行尾锁 LF；lib/client.js 标为 generated
├── .gitignore                 ← 忽略 node_modules 与被调试项目产生的 .dsh/
├── lib/
│   ├── index.js               ← 宿主半入口：注册命令/工具/提示词/路由
│   ├── client.js              ← 【生成物】客户端产物，勿手改（由 scripts/build-client.mjs 生成）
│   ├── protocol.js            ← 日志行协议（唯一真相，冻结）
│   ├── task.js                ← 哈希/路径/状态机（冻结）
│   ├── probe-template.js      ← 探针桩生成器
│   ├── debug-service.js       ← 【待建】DebugService：信号处理 + 日志管道 + 票据闸门
│   ├── command.js             ← 【待建】`/debug` 命令（签票 + 投递指令文本）
│   ├── tools.js               ← 【待建】5 个 dsh_debug_* 工具的定义
│   ├── routes.js              ← 【待建】面板的 state/resolve/reproduce 路由
│   └── prompt.js              ← 【待建】systemPrompt section（仅调试模式下非空）
├── src/
│   └── client.js              ← 浏览器半**源码**（ESM，只能 import 平台种子表）
├── scripts/
│   └── build-client.mjs       ← 把 src/client.js 包成 __ModuleLoader__ 产物
├── assets/
│   ├── probe.template.mjs     ← 探针运行时模板（生成到任务目录）
│   └── AGENT-PROBE-GUIDE.md   ← 埋点指南模板
└── test/                      ← node --test，零外部依赖
```

**生成出来的运行期文件不在本仓库里**，它们落在*被调试的*项目下：
`<repo>/.dsh/debug-mode/tasks/<hash>/`。本仓库的 `.gitignore` 已忽略 `.dsh/`。

---

## 4. 工程纪律

### 4.1 依赖与运行

- 纯 ESM（`"type": "module"`），**不引入运行时依赖**；只用 Node 内置模块。
  （这不是洁癖：探针桩会被复制进用户项目，必须零依赖。）
- React / DSH 客户端包一律走 `peerDependencies` 且 `optional`，
  客户端半必须能容忍这些包不存在。
- 测试只用 `node --test`，不许引入测试框架依赖。

### 4.2 命令

```bash
node scripts/build-client.mjs      # 生成 lib/client.js（改了 src/client.js 必须重跑）
node --test test/*.test.mjs        # 跑全部单测（会先自动重新构建客户端产物）
```

> 注意：**不要**写 `node --test test/`。Node 24 会把目录参数当成模块名解析而报
> `Cannot find module ...\test`；必须用上面这个 glob 形式（或显式文件路径）。
>
> **判断行尾时不要把 `git show` 接进 PowerShell 管道。** PowerShell 的 `Out-String`
> 会把管道里的 LF 转成 CRLF，于是每个文件看起来都「含 CR」——这是假阳性，会让人
> 白改一轮。要按**字节**判断（`git show` 写进文件后数 `0x0D`）。
> 本仓库的 `.gitattributes` 已把行尾锁成 LF，正常情况不需要人工干预。

依赖安装（若将来需要）：使用 DSH 运行时自带的 Node 与 pnpm，
不要用系统里可能存在的其它版本（见 `load_workspace_dependencies` 返回的路径）。

### 4.3 客户端半的两条通道（**最容易搞错的地方**）

DSH 有两条互不相通的客户端通道，API 名一样、能力完全不同：

| | **包通道**（`dsh.client` / 本插件走这条） | 动态通道（`cordis-client-runner`） |
| --- | --- | --- |
| 工厂参数 | 只有 `require` | `React` / `console` / `styles` / `host` |
| 能 import 吗 | 不能，必须 `require` **平台种子表**里的模块 | 不能 import 任何东西 |
| `host.call()` | **不存在** | 有（宿主 `harness.handle` 配对） |
| `styles.insert()` | **不存在** | 有 |
| 网络 | 浏览器 `fetch`（普通全局） | 不可用，必须 `host.call` 回宿主 |
| 宿主侧配对 | `ctx.webServer.register(...)` 路由 | `harness.handle(...)` |

平台种子表（可 `require` 的全部模块）：`react`、`react/jsx-runtime`、`react-dom`、
`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
`@deepseek-ai/dsh-client-ui-dockkit`。

写客户端源码时的三条规矩：

1. **只写 `src/client.js`，不碰 `lib/client.js`**（后者是生成物，会被覆盖）。
2. 产物必须带 `window.__ModuleLoader__.load({ id, factory })` 外壳，`id` 逐字等于包名；
   宿主不做编译，直接原样下发，所以 ESM 语法上线必白屏。构建脚本负责套壳。
3. 面板座位只注册一次却服务**所有会话**——必须按 `sessionId` 自过滤，无关时
   `return null`；**绝不要**在模块级放「当前任务」这类全局状态。

### 4.4 代码风格

- 注释解释**为什么**，不解释**是什么**；每条不变量都值得一句「为什么」。
- 面向用户的文案（面板、工具返回值）用中文；标识符与协议字段用英文。
- 探针运行时的每一处写入都必须包在 `try/catch` 里并安静降级。
- 不为「将来可能需要」写抽象层；阶段到了再重构。

### 4.5 改动协议或状态机时

必须按顺序做三件事，缺一件都不算改完：

1. 改 DESIGN.md 的对应章节 + 在 §17 变更记录里加一行；
2. 改 `lib/protocol.js` / `lib/task.js`；
3. 若涉及桩，同步 `assets/probe.template.mjs`，并让 `test/protocol.test.mjs`
   能证明两处实现一致。

---

## 5. 给 Agent 的调试模式行为准则（M2 将作为 systemPrompt section 注入）

> 下面这段话是插件要注入给**被调试会话**的准则，本仓库自己也遵守它。
> 实现时把它放进 `lib/prompt.js`，**只在任务活跃时**注入。

- 进入调试模式 = 调用 `dsh_debug_start`，把用户的现象描述原样记进 `goal`。
- **一眼能看出根因就别进调试模式**：说明根因、直接改代码。用户敲了 `/debug` 不等于
  你必须埋点——票据会自己过期，不需要任何清理动作。
- 埋点前先分析：列出 2–5 条具体假设，每处探针必须能证实/证伪其中一条。
- **第 1 轮只取证，不改代码**（先改会掩盖现场）；**第 2 轮起可以按假设先改再验**，
  但改完必须再埋点，用日志证明「改前复现、改后不复现」。
- 每处探针用 `dsh-debug:probe <hash> start/end` 包裹；不得改变程序行为。
  代码改动用 `dsh-debug:change <hash>` 标记，**不要**混进探针块。
- 埋完立刻 `dsh_debug_report` 交卷（同时报 `probeFiles` 与 `changedFiles`），
  然后停手，等用户复现。
- 读日志只走 `dsh_debug_read`，不要 `read`/`cat` 日志文件。
- 日志分组计数为 0 的探针 = 该路径没走到，这通常是最有价值的信号。
- 用户说「已解决」后：`dsh_debug_end` → **只删探针块** → 删探针桩 →
  在回复里逐条列出「修复（保留）/ 探针（已删）/ 临时改动（已还原）」。
  绝不用 `git checkout` 整体回滚——那会把用户的修复一起 revert 掉。
- 永远不要留着探针代码当作「以后可能有用」——那是下一个 bug 的温床。

---

## 6. 待验证清单（写代码前必须做实验）

见 [DESIGN.md §15](./DESIGN.md)（已按两轮契约核实更新，状态在那边）。摘要：

**已核实（可以照着写）**

- 工具参数是**普通 JSON Schema**，不是 zod；`output.render(args, value)` 必填，
  模型看到的文本由它产出。
- `ctx.commands.register({ name, description, input?, handler })`；`handler` 返回
  `{kind:'success', text}` —— **这段 text 就是投给 Agent 的指令正文**，
  所以 `/debug` 的指令内容是插件写的，不是用户或模型写的（闸门确定性的来源）。
- 工具要在 **agent 作用域**注册才有会话级可见性（`'agent/created'`，serial 事件）；
  在 `apply(ctx)` 里裸注册是全局可见。**但可见性无法按会话动态开关**，
  所以「只有 `/debug` 能进入」必须靠宿主侧票据校验，不能指望提示词。
- 浏览器↔宿主走 **`ctx.webServer.register` 同源路由 + 浏览器 `fetch` + 轮询**；
  **`host.call(...)` 在包通道里并不存在**（那是动态通道的 API）。
- 唤醒 Agent 用 `ctx.sessionController.prompt({ requestId, sessionId, mode, content })`。
- 客户端入口是 `exports["./client"].default`（不是 `main`），且产物**必须**是
  `window.__ModuleLoader__.load({ id, factory })` 脚本——宿主不做编译（§4.3）。
- 面板座位是 **`conversation.composer.dock`**（list / session 作用域，输入框正下方），
  用 `ctx.slots.inject`（声明感知）注册。选它而不是 turnTail 的原因是它的
  standardProps 里有 **`useInput` / `inputActions`**——面板因此能看见用户正在打什么，
  从而避免「打了半句又顺手点按钮 ⇒ 同一条描述送两遍」的竞态（DESIGN.md §9.3.1）。

**仍未验证（先做实验，别猜）**

1. **`InputState` 的字段形状**（草稿在哪一个字段里）。`src/client.js` 的 `hasDraft`
   目前按候选字段名探测，接真宿主时打印一次实际形状，然后写死字段。
2. `PromptContentPart` 的形状与 `SessionRequestId` 的铸造方式。
3. `systemPrompt.section` 的 `name`/`order` 取值（`SECTION_ORDERS` 不可读，
   先用靠后的 order 如 900）。
4. 主题令牌的权威清单（现有名字来自第三方插件的样式表，不是 Theme provider；
   面板样式尚未落地）。
5. 沙箱写 `.dsh/debug-mode/**` 被拒绝时的错误形状（错误文案要用）。
6. **`/debug` 怎么被用户发现**：它注册成全局命令后，是否自动出现在宿主命令面板里
   （`ctx.commands` 的 descriptor 会被 UI 列出来）；若不会，需要在 README/文档里说明。
7. `ctx.remote.$on` 能否替代轮询（事件转发白名单属于宿主装配，第一版不赌它）。
8. 观察用户消息的确切事件类型（`session/event` 的哪个 `event.type`）用于 §9.3.2 的
   状态自动迁移。

**纪律：先实验，再写代码。** 本仓库里所有「猜出来的 API 调用」都会变成
下一个维护者的负担——拿不准就在 DESIGN.md §15 标 `待验证`。
