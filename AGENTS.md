# AGENTS.md — 给 AI 协作者的项目手册

> 这是 `dsh-plugin-debug-mode` 的项目手册。动手前请先读本文件——**这是本插件唯一的
> 权威入口；契约以代码与本文为准**。判据、阈值、被推翻过的机制都写在本文里，
> 不留任何"另一份设计稿里才有答案"的空位。

---

## 1. 这个项目是什么

一个 DSH（DeepSeek Harness）插件，灵感来自 **Cursor Agent 的 Debug 模式**。

一句话：**让 Agent 别猜，自己在代码里埋探针，把现场取回来；用户复现后二选一。**

完整流程：

```
用户：现象描述
  └─ Agent 分析代码 → 埋探针（带可摘除标记）  ← 不运行任何命令（§1.1 第 14 条）
       └─ 探针把记录交给宿主，落进 <用户临时目录>/dsh-debug-mode/tasks/<hash>/<hash>.log
            （**首选**：POST 宿主的 HTTP 入口——语言无关，写日志只有宿主一份实现；
              只在热路径 / 需要"崩溃前落盘" / 没有网络栈时才用文件桩；
              临时根不可写时回退 <repo>/.dsh/debug-mode/，回退必须出声——见 §1.1 第 15 条）
            └─ Agent 通过「读取日志信号」拿到摘要（不自己去翻文件）
                 └─ 用户复现 → 弹出面板：
                      [ 问题已解决 ] → 删日志 + 删掉本次任务的全部探针代码
                      [ 问题复现，需要进一步修复 ] → 日志**保留**，Agent 读完再开下一轮
```

包名：`dsh-plugin-debug-mode`（npm 与 DSH bundle 同名，不带 scope）。
对外标识：`/debug` 命令、`dsh_debug_*` 工具、`dsh-debug:probe <hash>` 探针块标记。

用户侧的进入方式**有且只有一个**：`/debug <现象描述>`。

### 1.1 核心不变量（**改代码前必须确认不破坏这几条**）

1. **入口唯一：只有 `/debug` 命令能进入调试模式。** 不做对话意图识别、不做按钮。
   `dsh_debug_start` **必须持票**（`/debug` 签发的会话级一次性票据）才放行；
   无票调用一律拒绝。这是**宿主侧硬校验**，不是提示词约定——工具对所有会话可见，
   模型永远能调用它，只有返回值拦得住。
2. **一个任务一个哈希。** 首次进入调试模式时生成，之后无论多少轮都不变。
   哈希用 CSPRNG 生成 8 位小写十六进制，且**只由宿主生成**，从不接受外部传入。
3. **清空日志只有一个时机：`dsh_debug_continue`。** （truncate 为 0 字节，不删文件、
   不换目录。）**用户点「问题复现」不清空任何东西**——那一刻 Agent 还没读，
   清空就是把用户刚复现出来的现场当场扔掉。清空发生在「Agent 已读过现场、正要开始
   新一轮埋点」= **下一次用户复现之前**；`continue` 还有**闸门 C**：
   日志里还有 `> task.lastRead.bytes` 的未读内容时拒绝清空（三振降级）。
4. **用户信号不直接删日志。** 「已解决」只唤醒 Agent；删日志与删探针代码由
   `dsh_debug_end` 一并完成——两者必须同生共死。
5. **探针代码必须可机器摘除。** 每处探针都被 `dsh-debug:probe <hash> start/end`
   夹住；`dsh_debug_end` 要能凭标记把代码库恢复干净，并给出对账清单。
6. **Agent 不直接读日志文件。** 日志内容一律经 `dsh_debug_read` 输出；
   摘要优先、异常全量、省略量显式声明。
7. **调试准则只在调试模式下注入。** `systemPrompt.section` 的 `text` 必须是 thunk，
   无活跃任务时返回空串；否则没进调试模式的会话也会收到「去埋点」的指令，
   等于把入口约束从提示词层面又打开一次。
8. **协议冻结。** 日志行格式与字段序的唯一真相是 `lib/protocol.js`
   （`formatRecord` / `parseRecord` / `parseLog`）；只能新增**可选**字段，
   且必须同步 `assets/probe.template.mjs` 与测试。冻结项要改就得走 §4.5 的三步、
   并按 §4.6 升版本号——"悄悄改一个字段序"是这份文件里最贵的一类事故。
9. **输入框始终可用。** 调试模式下用户随时可以用原生输入框描述现象——按钮只是
   快捷方式，不是唯一出口。因此：① 面板**不得**抢走或挡住输入框；
   ② 输入框有未发送内容时**禁用**面板按钮（否则同一条描述会被送两遍）；
   ③ 宿主观察到 `awaiting-user` 状态下出现新的用户消息时，自动迁移到 `active`。
10. **探针账与修复账分开记，收尾只撤探针。** 探针用 `dsh-debug:probe <hash>` 包裹、
   代码改动用 `dsh-debug:change <hash>` 标记；`probeFiles` 与 `changedFiles` 分别登记。
   收尾**只删探针、绝不回滚用户的修复**；用 `git checkout` / `git stash` 整体回滚是
   **明令禁止**的收尾方式（会连带 revert 掉用户要的修复）。
11. **Agent 可以不进调试。** `/debug` 是用户发起的，不是契约：一眼能看出根因时，
   Agent 应当**不调用** `dsh_debug_start`，说明根因并直接改代码（票据自己会过期，
   无需任何清理动作）。
12. **闸门不能造成死锁，也不能 fail-open 而不告知。** 任何硬闸门**连续拒绝同一原因 3 次**
   后必须降级为 warn-only 并把降级写进欠账；闸门依赖的扫描能力不可用时（只读沙箱、
   路径在仓库外等），必须在面板显示「残留检测未生效」，**绝不假装保护着**。
13. **残留处理由「可判定性」决定，不由风险偏好决定。** `probe`/`temp` 必删、
   `fix` 保留、**hash 不属于任何已知任务或格式残缺的一律进隔离区**（逐条让用户三选一），
   完全无标记的只提示不删。**不允许静默保留**——漏删的临时改动没有任何下游拦截，
   它不报错、不告警，只是慢慢烂掉，那正是「屎山」的定义。为什么不能反过来把
   未标记的改动默认当「要保留」，见 §7。
14. **Agent 在调试流程里不运行任何命令。** 它的全部动作只有两种：给调试服务发信号
   （`dsh_debug_*` 工具）+ 用编辑工具在源代码里埋点/改代码。**复现是被调试程序的
   使用者的事。** 这条是实测事故驱动的：某次调试里 `D:\` 归属 `SYSTEM`，当前账号缺
   WRITE_DAC，于是 **所有 shell 命令**在授权阶段就被拒（`SetNamedSecurityInfoW`
   `Win32 5`），而同一时刻 `edit`/`write` 完全正常——**能挡住整个流程的，恰恰是
   流程本来就不需要的那一步**。连带约束：任何**必需**的通道都不许依赖命令
   （页面类目标走 HTTP 摄入端点，而不是"起个本地服务器"）。
15. **产物不进工作区。** 调试产物落**用户临时目录**：`join(tempBase, 'dsh-debug-mode')`，
   `tempBase` 依次取工具参数 `tempDir` → 环境变量 `DSH_DEBUG_MODE_TMP` → `os.tmpdir()`。
   临时根不可写时**回退**到 `<workspace>/.dsh/debug-mode/`，且回退必须**出声**——
   同一句说明要同时出现在任务的 `notes`、待办清单 `debts` 与 `dsh_debug_start` 的返回正文里；
   两个根都不可写时 `start` 直接拒绝。任务里用 `artifactRoot`（绝对路径）与
   `artifactRootKind`（`'temp'` / `'workspace'`）记住这次落在哪儿，缺省按 `workspace`
   解释 = 旧版本留下的任务。理由：产物一旦落进工作区，它就会跟着 `git status`、
   被编辑器索引、被残留扫描器当成项目文件；而一次静默回退只会让下一个人看到"日志不见了"。

---

## 2. 当前状态

**M0 – M6 + 防堆屎山机制 R1–R6 + HTTP 统一埋点入口全部落地，面板已重做为「输入框上方的可折叠卡片」，`/debug` 会直接开一轮、注入段自带本任务地址：
全部测试全绿（`node --test test/*.test.mjs`）。** 剩下的一件事是**人在真实 GUI 里点一次面板**（M4 的验收判据）——
代码路径已被产物测试覆盖，但那一步只能由人做。

已落地：

| 文件 | 内容 |
| --- | --- |
| [CHANGELOG.md](./CHANGELOG.md) | 只追加的变更记录（**版本号纪律见 §4.6**）：最新版本 v0.20，行序新→旧、版本号连续无缺口 |
| [package.json](./package.json) | 包清单：`dsh.bundle.patch` + `dsh.client` 双挂载声明 |
| [cordis.patch.yml](./cordis.patch.yml) | bundle 挂载声明（插入 `debug-mode` 行） |
| [lib/protocol.js](./lib/protocol.js) | 日志行协议的唯一真相：`formatRecord` / `parseRecord` / `parseLog` |
| [lib/task.js](./lib/task.js) | 任务哈希、产物根与相对路径形状、状态机与迁移白名单 |
| [lib/probe-template.js](./lib/probe-template.js) | 由模板生成三种产物（Node 桩 / 浏览器桩 / 多语言 HTTP 片段），锚点校验，缺锚点即抛错 |
| [lib/debug-service.js](./lib/debug-service.js) | **DebugService**：票据闸门、任务表、日志管道、**产物根解析与回退（临时目录优先）**、**HTTP 摄入与通道自检、浏览器桩由宿主路由伺服、端点来源**、唤醒通道、收尾对账、闸门降级、欠账看板 |
| [lib/scan.js](./lib/scan.js) | **防堆屎山的两台机器**：R1 工作区索引 + 窗口 diff、R2/R3 残留扫描与栈式配对、语法自检；桩引用扫描认**两形态**（临时根的 `dsh-debug-mode/tasks/<hash>/` 与回退根的 `.dsh/debug-mode/tasks/<hash>/`） |
| [lib/summary.js](./lib/summary.js) | `dsh_debug_read` 的摘要渲染（异常全量、计数先行、省略显式） |
| [lib/prompt.js](./lib/prompt.js) | 埋点指南渲染 + 调试准则正文（含"不运行任何命令"）+ `/debug` 指令正文 |
| [lib/command.js](./lib/command.js) | `/debug` 命令（签票 + **开一轮对话**把指令交给 Agent + 一句给人看的结果说明） |
| [lib/tools.js](./lib/tools.js) | 5 个 `dsh_debug_*` 工具定义与 agent 作用域注册 |
| [lib/routes.js](./lib/routes.js) | 面板的 `state` / `board` / `probe` / `resolve` / `reproduce` 同源路由 + 浏览器桩的 `GET /dsh-debug-mode/stub.js?h=<hash>`（即时渲染 `runtime/probe.browser.js`，`Content-Type: application/javascript`） |
| [lib/index.js](./lib/index.js) | 宿主半入口：装配命令、工具、提示词段落、路由与会话观察 |
| [assets/probe.template.mjs](./assets/probe.template.mjs) | 零依赖 Node 探针桩模板（生成到任务产物根的 `runtime/probe.mjs`；烘死 TASK/LOG；16 MiB 上限） |
| [assets/probe.browser.js](./assets/probe.browser.js) | 零依赖**浏览器**探针桩模板（经典脚本，`dshProbe` → HTTP 摄入；批量 + 卸载冲刷）；页面用 `<script src="http://127.0.0.1:<端口>/dsh-debug-mode/stub.js?h=<hash>">` 引它，不必让页面去读文件系统 |
| [assets/AGENT-PROBE-GUIDE.md](./assets/AGENT-PROBE-GUIDE.md) | 回给 Agent 的埋点指南模板（含 `{{HASH}}` 等变量；§零「不要运行任何命令」、§五 HTTP 统一入口、§六 文件桩是最后手段） |
| [src/client.js](./src/client.js) | 浏览器半**源码**：输入框上方的可折叠卡片 + **工具行里的状态 tag（chip，带叉）** + 三态渲染 + 按钮接线 + 草稿协调 + 样式令牌 |
| [scripts/build-client.mjs](./scripts/build-client.mjs) | 把源码包成 `__ModuleLoader__` 产物（零第三方依赖） |
| [scripts/probe-selfcheck.mjs](./scripts/probe-selfcheck.mjs) | **探针边界自检**：边界矩阵 + 协议不变量 + 三处实现一致性；本地/活两种模式；退出码可进 CI |
| [lib/client.js](./lib/client.js) | 【生成物】客户端产物，勿手改 |
| `test/*.test.mjs` + [test/helpers.mjs](./test/helpers.mjs) | 全部守卫测试，全绿（协议/扫描/摘要/服务端到端/工具契约/装配/**HTTP 入口与端点来源**/客户端产物与面板/文本风格） |

**仍未落地（明确记录，不假装完成）**：`ctx.remote.$on` 推送（第一版一律轮询，这是取舍
不是未知）、面板的真浏览器人工验收。注意"其它语言的探针桩"**不再是缺口**：任何能发 HTTP 的
运行时都直接 POST 宿主的 HTTP 摄入端点，宿主生成的多语言片段（`runtime/probe.http.md`）里端点与哈希
已经烘死。

---

## 3. 目录结构与职责

```
debug-mode/
├── AGENTS.md                  ← 本文件
├── CHANGELOG.md               ← 只追加的变更记录（版本号唯一权威，见 §4.6）
├── README.md                  ← 面向用户的安装与简介
├── package.json               ← dsh.bundle.patch + dsh.client + exports
├── cordis.patch.yml           ← bundle 挂载声明
├── .gitattributes             ← 行尾锁 LF；lib/client.js 标为 generated
├── .gitignore                 ← 忽略 node_modules 与被调试项目产生的 .dsh/
├── lib/
│   ├── index.js               ← 宿主半入口：装配命令/工具/提示词/路由/会话观察
│   ├── client.js              ← 【生成物】客户端产物，勿手改（由 scripts/build-client.mjs 生成）
│   ├── protocol.js            ← 日志行协议（唯一真相，冻结）
│   ├── task.js                ← 哈希/产物根与路径/状态机（冻结）
│   ├── probe-template.js      ← 探针桩生成器
│   ├── debug-service.js       ← DebugService：票据 + 任务表 + 日志管道 + 产物根解析与回退 + 唤醒 + 收尾对账 + 闸门降级 + 欠账看板
│   ├── scan.js                ← 防堆屎山：R1 工作区索引 + 窗口 diff、R2/R3 残留扫描与栈式配对、语法自检
│   ├── summary.js             ← dsh_debug_read 的摘要渲染
│   ├── command.js             ← `/debug` 命令（签票 + 开一轮对话投递指令 + 结果说明）
│   ├── tools.js               ← 5 个 dsh_debug_* 工具的定义与 agent 作用域注册
│   ├── routes.js              ← 面板的 state/board/probe/resolve/reproduce 路由 + 浏览器桩的 GET /stub.js
│   └── prompt.js              ← 指南渲染 + systemPrompt section 正文（仅调试模式下非空）
├── src/
│   └── client.js              ← 浏览器半**源码**（ESM，只能 import 平台种子表）
├── scripts/
│   ├── build-client.mjs       ← 把 src/client.js 包成 __ModuleLoader__ 产物
│   └── probe-selfcheck.mjs    ← 探针边界自检（矩阵 + 不变量 + 三处一致性）
├── assets/
│   ├── probe.template.mjs     ← Node 探针桩模板（生成到任务产物根的 runtime/ 下；16 MiB 上限）
│   ├── probe.browser.js       ← 浏览器探针桩模板（经典脚本；POST 给宿主；由宿主路由 GET /stub.js 按 hash 伺服）
│   ├── probe.http.md          ← 多语言 HTTP 片段模板（端点/哈希烘死；写日志只有宿主一份实现）
│   └── AGENT-PROBE-GUIDE.md   ← 埋点指南模板
└── test/                      ← node --test，零外部依赖
    ├── helpers.mjs            ← 宿主替身（fake ctx / 临时工作区 / 块构造器）
    ├── protocol.test.mjs      ← 协议、桩生成、16 MiB 上限
    ├── scan.test.mjs          ← R1/R2/R3 的纯函数与落盘行为
    ├── summary.test.mjs       ← 摘要输出的四条契约（异常全量 / 计数先行 / 省略显式 / 空日志要解释）
    ├── service.test.mjs       ← S1→S7 端到端 + 核心不变量
    ├── tools.test.mjs         ← 工具 schema 子集与返回值合规
    ├── ingest.test.mjs        ← HTTP 统一入口：协议一致、不可伪造、限额、CORS、GET 自检、浏览器桩、多语言片段
    ├── wiring.test.mjs        ← 命令 / 路由 / 提示词段落 / apply 装配
    ├── changelog.test.mjs     ← CHANGELOG.md 自身的守卫（版本连续无缺口 / 最新行一致 / 日期合法不倒流）
    ├── client-bundle.test.mjs ← 产物结构 + 迷你 hooks 渲染器
    └── style.test.mjs         ← 文本风格守卫（仓库里任何文本文件都不带 emoji）
```

**生成出来的运行期文件默认不在本仓库里**：它们落在用户临时目录
`os.tmpdir()/dsh-debug-mode/tasks/<hash>/`；临时目录不可写时才回退到
`<repo>/.dsh/debug-mode/tasks/<hash>/`（回退会同时写进任务 `notes`、待办 `debts`
与 `start` 的返回正文）。一个任务目录里放 `<hash>.log`、`state.json`、`index.json`、
`runtime/`（`probe.mjs` / `probe.browser.js` / `probe.http.md`）、`AGENT-PROBE-GUIDE.md`、
`backups/` 与 `journal.jsonl`；票据单独放 `<root>/pending/<sessionId>.json`。
本仓库的 `.gitignore` 已忽略 `.dsh/`。

---

## 4. 工程纪律

### 4.0 动作边界（**最高优先级**，来自 `~/.dsh/AGENTS.md`）

本仓库的日常动作还受一份**常驻硬规则**约束（每次会话都会加载）；它和本文件冲突时，**以它为准**：

- **验证只走本项目已有的测试入口**：跑 `test/*.test.mjs` 里与改动相关的那几条（本项目已定义的单测目标），或者本文件 §4.2 列出的既有脚本。**不许自己造验证脚手架**——不写冒烟测试、临时脚本、临时目录、渲染核对脚本来"验证一下"（哪怕一次性的、事后删掉）。要批量机械改动就用编辑工具逐个改。
- **子代理只在复杂场景用，且必须与任务相称**：一两个文件的改动、一次能读完的上下文、没有可切分的独立块，一律自己做。只有工作量大且能切成互不重叠的独立块时才用，数量按块数给（能 1 个就不要 2 个），**动手前先用一句话说清切法与预期收益，等用户点头**。并行改同一个仓库会互相踩，所以"能并行"本身不是理由。
- **除相关单测外，不主动跑任何命令**：不跑 build / dev / 启动 / 全量套件 / 探针自检脚本；用户点名几条就只跑那几条、**各跑一次**，不追加"顺便再验一下"、不重复跑。

这三条是实测成本事故换来的：一次本来几毛钱的小改动，因为"开一堆子代理 + 造冒烟脚本 + 反复验证"花掉了十几倍的钱。判断一个动作该不该做，只看一句：**用户在这条消息里点名了吗？（相关单测除外，它默认可跑。）**

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
node scripts/probe-selfcheck.mjs   # 探针边界自检（退出码可进 CI；加 --endpoint 打活的 DSH）
```

> 注意：**不要**写 `node --test test/`。Node 24 会把目录参数当成模块名解析而报
> `Cannot find module ...\test`；必须用上面这个 glob 形式（或显式文件路径）。
>
> **判断行尾时不要把 `git show` 接进 PowerShell 管道。** PowerShell 的 `Out-String`
> 会把管道里的 LF 转成 CRLF，于是每个文件看起来都「含 CR」——这是假阳性，会让人
> 白改一轮。要按**字节**判断（`git show` 写进文件后数 `0x0D`）。
> 本仓库的 `.gitattributes` 已把行尾锁成 LF，正常情况不需要人工干预。
>
> **改文档时不要拿"我要写的那一行"当锚点。** PowerShell 的 `String.Replace` 在锚点
> 不存在时是**静默 no-op**（不报错、不失败、什么都不做）。实测因此**丢过两行
> `CHANGELOG.md` 变更记录**：版本号从 `0.11` 直接跳到 `0.18`，而顶部的最新版本已经是新值
> ——看顶部以为记录齐了。改文档的脚本必须**先断言锚点出现且仅出现一次**再替换；
> `test/changelog.test.mjs` 现在把 `CHANGELOG.md` 当数据来验（版本连续无缺口、
> 最新版本 == 表里最新那一行、日期合法且不倒流）。
>
> **这次的真正形态比"丢了两行"更阴**：那两行其实写了，只是换行被写成了**字面量 `n**，
> 于是它们整段躺在 v0.14 那一行的正文里，**从来没有成为表格行**。而所有检查都用
> `^| 0\.\d+ |`（锚定行首）⇒ 三轮都没看见；顶部最新版本也已经是 v0.18、"0.1 连续到 0.18"在
> 解析结果里成立，表面上一切正常。**教训：验证表格要数"每行有几个标记"，不能只问
> "行首有没有标记"**——`test/changelog.test.mjs` 现在就是这么验的。
>
> **日期以系统时钟为准，不要沿用相邻行的。** 实测把 `2026-10-11` 的多次改动全写成了
> `2026-02-19`——因为每加一行都复制了上一行的日期。要查真实时间用
> `git log --date=format:'%Y-%m-%d %H:%M'`，或直接 `Get-Date`。

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
3. 组件服务**所有会话**——必须按 `sessionId` 自过滤，无关时 `return null`；
   **绝不要**在模块级放「当前任务」这类全局状态。

### 4.4 代码风格

- 注释解释**为什么**，不解释**是什么**；每条不变量都值得一句「为什么」。
- 面向用户的文案（面板、工具返回值）用中文；标识符与协议字段用英文。
- 探针运行时的每一处写入都必须包在 `try/catch` 里并安静降级。
- 不为「将来可能需要」写抽象层；阶段到了再重构。
- **仓库里任何文本文件都不带 emoji**：代码、注释、文档、测试、工具返回值、面板与终端
  输出、提交信息，一律如此。判定范围是 `U+FE0F`、`U+2600–U+27BF`、`U+2B00–U+2BFF`、
  `U+1F000–U+1FAFF` 及其组合，由新增的 `test/style.test.mjs` 守卫。
  理由不是审美：终端 / 编辑器 / CI 的编码与字形回退各不相同，emoji 会变成乱码或半个
  代理对，排查一次乱码的代价远大于它换来的辨识度。需要 4 字节 UTF-8 夹具时写
  `String.fromCodePoint(0x1F600)`，不要写字面量；非 emoji 的排版字符（`→` `·` `—`
  `≤` `≥` `…` 与中文标点）保留，它们到处都能正常渲染。
- **需要图标时用内联 SVG，不要字符图标**（`U+25B8`/`U+25BE` 箭头、`U+2713` 勾、`U+2605`
  星号这类都不算）：字形由字体决定，回退到哪个字体是平台的事——实测 `U+25B8` 在等宽字体下
  会渲染成方框。**这条规则本身也只能用码点举例**：把 `U+2713`/`U+2605` 这类字符写进文档，
  就会让 `test/style.test.mjs` 把文档自己判违规（写这一节时真踩过）。规则按**通道**分：
  · **浏览器里**（面板 `src/client.js`）画 SVG：`createElement('svg', …)`，线条自己定；
    图标一律 `aria-hidden="true"` + `focusable="false"`，语义由旁边的文字承担，
    屏幕阅读器不该读出"三角形"；状态变化（比如折叠/展开）用 CSS `transform` 表现，
    不要换成另一个字符。
  · **纯文本通道**（工具返回值、日志、指南、CLI 输出、`CHANGELOG.md`）没有 SVG 可用，
    用 ASCII 标记 `[!]` / `[ok]` / `[x]`，**绝不退回字符图标或 emoji**。
  · 同一件事在两处出现时：宿主在文本通道里写 `[!]`，面板把它渲染成 SVG 图标
    （`stripTextMarker()` 负责剥掉前缀），不许在界面里把标记原样印一遍。

### 4.5 改动协议或状态机时

必须按顺序做三件事，缺一件都不算改完：

1. 按 §4.6 在 `CHANGELOG.md` 加一行（行序新→旧）；协议的真相在 `lib/protocol.js` /
   `lib/task.js` 的注释里，改协议就改那里，没有第二份需要同步的设计稿；
2. 改 `lib/protocol.js` / `lib/task.js`；
3. 若涉及桩，同步 `assets/probe.template.mjs`，并让 `test/protocol.test.mjs`
   能证明两处实现一致。

**`CHANGELOG.md` 的表格形态是硬约束**（`test/changelog.test.mjs` 会验）：行序**新→旧**、
版本号从 0.1 **连续无缺口**、顶部 `> 最新版本：vX.Y` 必须等于表里最新那一行、日期合法
且不倒流（也不在未来）。"改了版本号却没留一行"正是这个测试要抓的历史事故。

### 4.6 版本号纪律（**提交前必做**）

版本号只有**一处权威**：`CHANGELOG.md` 顶部的 `> 最新版本：vX.Y`。它必须**同时**等于
该文件表格里最新那一行、以及 `package.json` 的 `version`（写作 `X.Y.0`）——这三处的
相等关系由 `test/changelog.test.mjs` 守卫，只改其中一处必红。

**触发时机只有两个**，别的一概不算：

1. 一个新功能**确认实现完成**——代码 + 测试都已落地，且用户已确认；
2. 一个问题**确认修复完成**——修复经用户或复现确认，**并且准备提交**。

中途进度、写了但还没确认的改动**不占**版本号。触发之后，三步动作必须**同一次编辑**
做完，缺一件都不算完：

1. 在 `CHANGELOG.md` 表格的**表头之后、旧行之前**插入一行
   `| X.Y | <今天日期> | <这一版改了什么 + 为什么，≥20 字符> |`；
2. 把顶部 `最新版本：vX.Y` 改成同一个值（末位 +1，如 `0.19` → `0.20`；
   不引入三位版本号，除非用户明确要求）；
3. `package.json` 的 `version` 同步为 `X.Y.0`。

日期用 `Get-Date` **现取**，绝不复用相邻行的日期——实测把 `2026-10-11` 的多次改动
全写成了 `2026-02-19`，因为每加一行都复制了上一行的日期。改文档的脚本**必须先断言
锚点出现且仅出现一次再替换**（PowerShell 的 `String.Replace` 在锚点不存在时是静默
no-op，实测因此丢过两行版本记录）；验证表格要数"每行有几个版本行标记"，不能只问
"行首有没有标记"。只改注释 / 文案 / 测试细节、不构成「功能完成或修复完成」的提交
**不升版本**。

---

## 5. 给 Agent 的调试模式行为准则（已落地在 `lib/prompt.js`）

> 下面这段话是插件要注入给**被调试会话**的准则，本仓库自己也遵守它。
> 它已经实现为 `lib/prompt.js` 的 `debugGuidance()`，由 `lib/index.js` 在
> **agent 作用域**注册的 `systemPrompt.section` 注入，**只在任务活跃时**返回非空正文
> （thunk：**无活跃任务就返回空串**）。改这里的措辞，就要同步改 `lib/prompt.js`，反之亦然。

- 进入调试模式 = 调用 `dsh_debug_start`，把用户的现象描述原样记进 `goal`。
- **一眼能看出根因就别进调试模式**：说明根因、直接改代码。用户敲了 `/debug` 不等于
  你必须埋点——票据会自己过期，不需要任何清理动作。
- **不要运行任何命令。** 你的动作只有两种：发信号 + 用编辑工具埋点/改代码。
  "跑起来复现"是用户的事；`bash`/`pwsh` 被环境挡掉也不影响这条流程
  （页面类目标走 HTTP 探针通道）。
- 埋点前先分析：列出 2–5 条具体假设，每处探针必须能证实/证伪其中一条。
- **第 1 轮只取证，不改代码**（先改会掩盖现场）；**第 2 轮起可以按假设先改再验**，
  但改完必须再埋点，用日志证明「改前复现、改后不复现」。
  注意闸门的判据是**出现 `dsh-debug:change` 标记或自报 `changedFiles`**——
  埋探针本身不算改行为，不会被拒（写成"文件被改过就拒绝"是这个插件自己制造死锁）。
- 每处探针用 `dsh-debug:probe <hash> start/end` 包裹；临时探索用
  `dsh-debug:temp <hash> start/end`（收尾必删）；修复用 `dsh-debug:change <hash>`。
  三色不许混，`probe`/`temp` 的成对标记必须**同缩进、中间不夹别的标记行**。
- 埋完立刻 `dsh_debug_report` 交卷（同时报 `probeFiles` 与 `changedFiles`），
  然后停手，等用户复现。
- 读日志只走 `dsh_debug_read`，不要 `read`/`cat` 日志文件。
- 用户点「问题复现」后**日志还在**：顺序是 `dsh_debug_read`（看现场）→ 分析 →
  `dsh_debug_continue`（**这一步才清空日志**、轮次 +1）。
  反了就等于把用户刚复现出来的东西扔掉；宿主会拦住"还有没读过的字节就想清空"的调用。
- 日志分组计数为 0 的探针 = 该路径没走到，这通常是最有价值的信号。
- 用户说「已解决」后：`dsh_debug_end` → **只删探针块与临时块** → 删探针桩 →
  在回复里逐条列出「修复（保留）/ 探针（已删）/ 临时改动（已还原）」。
  绝不用 `git checkout` 整体回滚——那会把用户的修复一起 revert 掉。
- 收尾若被暂停（隔离区有无法判定归属的残留），用 `ask_user_question` 逐条问用户
  三选一（`keep` / `delete` / `mine`），把决定回填进 `quarantine` 再收尾。
- 永远不要留着探针代码当作「以后可能有用」——那是下一个 bug 的温床。

---

## 6. 契约核实清单（**写代码前必须先做实验**）

每一项结论都要写清**核实依据**（"我读过哪个包、哪一行"）——拿不准就先做实验，并把
依据写下来，否则下一个人还得再查一遍。这一节只留**结论与纪律**。

**已核实（可以照着写）**

- 工具参数是**普通 JSON Schema**，但宿主只支持一个**子集**
  （`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解）。
  多一个关键字，`tools.register()` 当场抛 `JsonSchemaError`——尤其别把 `required`
  写成属性上的 `required: true`（那是首方 `defineTool` 的属性表写法，**原始注册下非法**）。
- `output.render(args, value)` 必填；**`execute` 的返回值还会被对着 `output.schema`
  校验**，不符合就整次调用变成 `ToolOutputError`。所以错误路径的返回值也必须合规。
- `ctx.commands.register({ name, description, input?, handler })`；`handler` 返回
  `{kind:'success', text}` —— [!] **这段 text 是给人看的，不会送到模型那里。**
  已核实 `@deepseek-ai/dsh-commands` 的 `execute()`，注释原文是
  "Parse and execute a known command **without sending it to the model**"，
  返回值只落进 `command/run` / `command/done` 两个 log-only 事件（同一段注释：
  "no turn wraps them"）。所以「敲了命令之后 Agent 就开始干活」这件事必须靠
  **显式开一轮**（`ctx.sessionController.prompt({ mode:'queue', … })`），
  不能靠返回值——v0.13 之前这里写反了，导致 `/debug <描述>` 签完票之后模型什么都没收到，
  用户还得自己补一句「开始」。
  命令的 `CommandDescriptor` 会被 `@Remote list(agent)` 列给 UI，所以 `/debug`
  会自动出现在宿主的命令面板里。
- 工具要在 **agent 作用域**注册（`'agent/created'`，serial 事件）。**注意**：用事件
  回调里的 `this` 注册会随这次派发一起释放——要注册到 **`agent.ctx`** 上
  （`agent.ctx.inject(['tools','systemPrompt'], runtimeCtx => …)`），首方
  `dsh-tool-subagent` 用的就是这一招。在 `apply(ctx)` 里裸注册 = 全局可见。
  **工具可见性无法按会话动态开关**，所以「只有 `/debug` 能进入」必须靠宿主侧票据校验。
- 浏览器↔宿主走 **`ctx.webServer.register({kind,path,handler})` 同源路由 + 浏览器
  `fetch` + 轮询**；**`host.call(...)` 在包通道里并不存在**（那是动态通道的 API）。
  路由 handler 的 `res` 是 **Node 的 `ServerResponse`**（`statusCode` / `setHeader` / `end`）。
- **端点地址插件自己有，不要问用户**（v0.14 核实）：`dsh-web-app` 的 `localWebUrl()`
  就是 `` `http://127.0.0.1:${ctx.webServer.port}` ``——`DSH_WEB_URL` 本身就是从
  `webServer.port` 算出来的，**而且宿主已经把同一个地址注进了模型自己的系统提示**
  （`app:web-surface` 段）。所以 `endpointBase()` 是「`DSH_WEB_URL` 优先，其次
  `webServer.port`」。推论有两条，都很容易踩：
  ① **只把拼好的 URL 给 Agent 是不够的**——它知道 origin、也知道哈希，但 URL 会随
     上下文压缩而丢，于是它只能反问「这里的 `<路径>` 是什么」。所以
     `/dsh-debug-mode/probe?h=<hash>` 这个**路径形状**必须当成常量写进注入段
     （哈希走查询串，不是路径段）；
  ② 注入段是唯一每次模型调用都在的文本，所以本任务的**全部地址**（端点、桩、日志、
     指南）都必须在那儿，不能只留一句"优先走 HTTP 端点"。
- **单行超限只能"省略值再重新序列化"，绝不能切已经序列化好的整行**（v0.15，实测写出脏行）：
  老实现 `line.slice(0, 8*1024-32) + '…","truncated":true}'` 只在切点落在**顶层字符串字段**
  里时才恰好闭合成功（所以顶层 `msg` 10000 字符反而能解析），切在 `data` 里必然留下没闭合的
  `[`/`{` ⇒ 读端算脏行。三处实现（`lib/protocol.js` / Node 桩 / 浏览器桩）必须**逐字同构**，
  `test/protocol.test.mjs` 会把同一批负载喂给三处并比对字节。长度一律按 **UTF-8 字节**算
  （`byteLength()`：中文 3、代理对 4），不是字符数。
- **摘除探针块会留下"块外空行"**（v0.15 发现现象；纪律见下面 v0.18 那条）：Agent 习惯在块
  前后各留一个空行做视觉分隔，那些空行在标记**外面**，只按标记删行就会把它们留在用户文件里。
  `removeBlocks()` 因此会在每处摘除缝上收敛纯空白行（至多留 1 行，文件首行折叠成 0）并回报
  `collapsedBlankLines`。宿主**无法**区分"原本 0 个空行"与"原本 1 个"，所以"与插入前逐字
  相同"要靠插入纪律——但那句纪律的**正确**说法在下面那条（v0.15 这里曾写成"要分隔就把空行
  放进块内"，是**错的**：那样会把原有的空行一起吃掉）。
- **`ingestProbe` 里不许有静默预截断**（v0.16，实测藏了一整轮）：曾有 `probe.slice(0, 200)`
  与 `String(raw.msg).slice(0, 2000)`，于是 10000 字符的 `msg` 被悄悄砍到 2000——**8000 字符
  无声消失、没有任何标记**，而那一行只有 ~2 KB、**根本没碰到 8 KiB 上限**（这就是它能藏住的
  原因：从"行是否超限"的角度看一切正常）。且 Node 桩没有这两条，同一记录走文件桩会正确标
  `truncated` ⇒ 三处实现结果不同。**截断权威只有 `encodeRecord()` 一处**。
  回归守卫：`test/ingest.test.mjs` 的"宿主摄入路径不许有任何静默截断"。
- **空行的命运只看它落在标记的哪一侧**（v0.18 纠正 v0.15 的说法，那一版写错过一行）：
  标记**外** ⇒ 宿主不碰它（活下来）；标记**内** ⇒ 跟块一起消失。所以有**两种**错误方向，
  而清理逻辑只兜得住一种：
  ① **把原有的空行包进标记里** ⇒ 被连带删除（吃掉用户的空行）。**兜不住**——
     它落在删除区间里，连 `collapsedBlankLines` 都不会记（那不叫收敛）。
     指南示例一度正好踩在这里（把块插在原空行的位置上），照抄就会吃一个空行；
  ② 在标记**外**加填充 ⇒ 留下 1 个空行（缝上收敛把 2 个降到 1 个，降不到 0）。
  纪律（写进指南 §7.2 与注入准则）：**原有的空行留在标记外，只有自加的空行才放进标记内**；
  机械做法 = "把 `start` 插在原有空行的**后面**"。
- **校验空白要看位置，不能看行数**（v0.18）：实测出现过「一处少 1 行 + 一处多 1 行 ⇒
  总行数与基线相同」，只看总数会判成"全对"，实际是一个空行从 A 处搬到了 B 处。
  `scripts/probe-selfcheck.mjs` 的**空白演练**（第四节）按位置打 before/after，
  并专门留了"行数相同、位置不同"的用例。
- **`ts` 参与 8 KiB 预算**（v0.18，测试自身踩过）：让宿主侧用 7 字符的 `'FIXED'`、
  桩侧用 29 字符的 ISO 时间，两者会二分出**不同的** clip 长度而"三处不一致"——
  事后归一化 `ts` 补不回来，因为预算已经按不同的输入算过了。比对三处实现时必须给**等长** `ts`。
- **自检脚本的矩阵要跟着 HTTP 契约走**（v0.17）：本地模式直接调 `ingestProbe`、活模式走
  HTTP 路由（**请求体 ≤ 64 KiB**），矩阵里一旦有用例超过 64 KiB，活模式 400、本地通过
  ——同一个矩阵两个结论（实测踩过：9000 个小键）。脚本启动时会自检矩阵并明确指出
  "修 MATRIX，不是修被测代码"。`scripts/probe-selfcheck.mjs` 还有一条纪律：
  **第一条不变量曾经写错过**——它断言"投递方伪造 ts 无效"，而真相是宿主**原样采纳**
  投递方给的 `ts`（批量投递必须靠它保住事件时刻）。**写不变量前先读实现**，
  别把"我以为的契约"烧进检查器。
- **`…` 不许同时表示两件事**：`[!]截断`（记录带 `truncated:true`，不可恢复）与
  `…（显示省略 N 字符）`（只是显示层缩写，日志里完整）。老的单一 `…` 让一次真实排查整轮
  都在猜是哪个——`summary.js` 的显示阈值是 **240 字符**，与 8 KiB 上限无关。
- 唤醒 Agent 用 `ctx.sessionController.prompt(request, signal)`；
  `content` 用 `[{type:'text', text}]` 即可，`requestId` 只当幂等键用（运行时是字符串）。
- `systemPrompt.section({name, order, text})` 的 `text` 可以是 thunk；order 取自
  `SECTION_ORDERS`（本插件用 `TOOLS_SDK=5000` 之后的 **5050**）。
- 客户端入口是 `exports["./client"].default`（不是 `main`），且产物**必须**是
  `window.__ModuleLoader__.load({ id, factory })` 脚本——宿主不做编译（§4.3）。
- 客户端半的两个座位：`conversation.input.dock`（面板卡片，输入框卡片**正上方**）与
  `conversation.input.left`（状态 tag，工具行左侧）。**都别换成 `conversation.composer.dock`**
  （渲染在卡片下方、会挤走输入框的高度）。座位能不能动，见 §6 那条座位与 `single` 的规矩。
- **座位选型只看 `kind` / `scope` / 现有 `occupants`，别只看 `purpose` 描述。**
  `list` 座位要自己的 `id`（按 id 去重、天然可共存）；**`kind: "single"` 一定不能碰**——
  `SlotCore.register` 在同一个 priority 上第二次注册是**抛错**（不是后来者顶掉前者），
  而注册发生在**同步的装配期**，于是对方的 entry 起不来、Web 启动直接失败。
  推论：① "两个模式不共存所以可以抢"**不成立**（不共存的是运行时，抛错在装配期）；
  ② inspect 的 `replaceRisk: "shadows-shipped-ui"` 只说"会遮住首方 UI"，没说到会抛错。
  要跟别人的 chip 并排就**换一个 list 座位**（或请首方把那一格改成 list），
  不是换 priority——那只会把崩溃从对方转到自己身上。
- **状态 tag 上的叉 = 「问题已解决」这个表态本身**，不是第二套"取消"：走同一个
  `/resolve`，只多带 `anytime: true`（面板按钮不带，窗口语义原样保留）。要它是为了
  别把用户**锁在调试里**（否则必须等 Agent 交卷才能表态）。两处实现约束：
  状态迁移走两步（`active → awaiting-user → awaiting-agent`，`TRANSITIONS` 白名单里
  `active` 只能去 `awaiting-user` / `closed`）；该轮给 Agent 的指令必须点明
  "没验证就填 `verified: false`，不要假装验证过"。
- 面板**默认折叠**，只在 `awaiting-user` 自动展开；折叠态的那一行必须自己说清"轮到谁"。
  这是"不占输入框地方"的另一半——只在上面是不够的。
- 面板内容只有两样：`dsh_debug_report` 的 **`headline`**（一句话结论）与
  **`reproSteps`**（让用户照着做的步骤清单）。**不要把整篇 `analysis` 塞进面板**：
  那是给模型的分析，给用户看的只有那两句。
- `InputState` = `{ draft, attachmentIds, draftRev, phase, occurrences, queue }`；
  面板只看 `draft`（字符串）与 `attachmentIds`（数组）。同座位的 ownerProps 里还有一份
  `input` 快照，作为旧宿主的兜底。
- 用户消息事件是 `session/event` 的 `event.type === 'user/message'`——这就是
  `awaiting-user → active` 自动迁移的依据。
- **沙箱策略下的文件写入路径**（实测）：`start` 前做**写探针自检**——在临时产物根写一个
  `.probe-write-test` 再删掉；失败则**回退**工作区 `.dsh/debug-mode/`，两个都不可写就
  拒绝启动。同一条结论还有后半句：扫描能力不可用时必须把「残留检测未生效」写进面板——
  闸门**失效**与闸门**放行**在现象上一模一样，不说出来就等于假装保护着。

**仍未闭合**

- **`ctx.remote.$on` 能否替代轮询**：不赌。事件转发白名单属于宿主装配，不属于本插件；
  第一版一律轮询（与两个已发布的第三方插件一致）。这是取舍，不是未知。
- **真浏览器验收**：面板的代码路径已被 `node:vm` 沙箱测试覆盖，但"在真实 GUI 里点
  一次"只能由人做。

**纪律：先实验，再写代码。** 本仓库里所有「猜出来的 API 调用」都会变成
下一个维护者的负担——拿不准就在本节「仍未闭合」里标 `待验证`，并把**核实依据**写下来
（"我读过哪个包、哪一行"），否则下一个人还得再查一遍。

### 6.1 上限（政策默认值）

| 项 | 默认 | 触发线看什么 / 结果是什么 |
| --- | --- | --- |
| 单条日志行 | **8 KiB** | 看**整行**（UTF-8 字节，不是字符数）。结果不是"切掉尾巴"，而是**把预算用足地省略超长值**——先按档位试、再二分找能放下的最大 clip 长度，重排后标 `truncated:true`。绝不切已经序列化好的整行：那会留下没闭合的 `[`/`{`，读端只能把它算成脏行 |
| 单任务日志总字节 | **16 MiB** | 写端**停止追加**，并往日志里写一条 `probe:"debug-mode:overflow"` 说明。有了这一条，读端看到的"没有更多记录"才是事实，而不是"探针没跑到"的猜测 |
| `dsh_debug_read` 默认返回 | **200 行** | 只是默认值，`limit` 可覆盖。被省掉的部分必须**显式声明省略量**，绝不静默少给 |
| 单任务目录总字节 | **32 MiB** | 目标值。当前实现只有 `read` 时按 `LOG_WARN_BYTES` 提示日志过大，**没有**单独校验任务目录总字节——这一行是政策意图，不是已实现的闸门 |

> 这几个数字都是**政策默认值**，不是理论推论，也没有实证数据支撑。实现上的真相在代码
> 常量里：`lib/protocol.js` 的 `MAX_RECORD_BYTES`、`lib/debug-service.js` 的
> `LOG_WARN_BYTES`（默认条数在 `lib/summary.js`）。改了代码常量就要回来改这张表，
> 否则文档会开始骗人。

---

## 7. 已推翻的机制（**不要重新引入**）

这些是设计过程中被推翻或实测证伪的选择，每一条都对应一次真实的返工。"看起来更保守"
恰恰是它们最容易复活的原因，所以逐条记下**为什么错**：

| 被推翻的选择 | 为什么错 |
| --- | --- |
| **「未标记的改动默认当 fix（保留）」** | **方向换错了。** 「误删修复」已被结构性防住（探针必须有标记、删除可枚举可预览），而「漏删临时」没有任何下游拦截：代码进了 PR 就没人记得哪块是探针，它不报错、不告警，只是慢慢烂掉——这恰恰是屎山的定义。更糟的是它与扫描器冲突：未登记的探针**扫得到、流程却不删**，等于把最贵的机制废掉 |
| **假说登记册 + 「零外溢原则」**（本轮新增探针数 ≤ 登记假说数 + 1） | 用**最不可信的输入**（Agent 自报的假说数组）去限制**最需要自由度的动作**（埋点）。三行 JSON 就能冲破（把 claim 全填「待确认」），却会误伤最勤勉的工作方式（12 个调用点埋对称探针是教科书式正确做法）。砍掉，把预算转给工作区索引与残留扫描 |
| **「token 只有面板能种下，Agent 不能伪造」** | 架构上不成立：HTTP 路由是宿主自己开的，Agent 有 `fetch`。这是**安全戏剧**，只能降级为审计 + 摩擦，并在文档里如实这么写 |
| **把「轮次 / 存活时长超预算」做成工具可用性**（超时即 `degraded`、动 `report`/`continue` 要先确认） | 任务寿命只该影响**看板排序与提示语气**。一个周六开始、周日继续的调试，一打开就是红字欠账，用户第一印象是插件在骂他；而在"最需要证据"的那一刻把工具锁上，是拿可用性去换一个没人要求的纪律 |
| **`host.call(...)`** | 包通道（`dsh.client`）里**根本没有这个 API**，它是动态通道的；照着写只会拿到 undefined。包通道里回宿主只有一条路：`ctx.webServer.register(...)` 路由 + 浏览器 `fetch` |
| **手写 ESM 客户端半** | 宿主不做编译，客户端产物按字节拼接后原样下发，所以 `import`/`export` 上线必白屏。必须打成 `window.__ModuleLoader__.load({ id, factory })` 产物，`id` 逐字等于包名 |
| **面板座位 `conversation.composer.dock`** | 它渲染在输入框卡片**下方**，会把输入框往上挤（用户实测原话：「挤兑了原有的提示词输入框的位置」）。`conversation.input.dock` 是文档流里 `inputBar` 之前的兄弟节点，贴近而不挪动、也不可能遮挡 |
| **状态 tag 坐 `conversation.input.plan`**（首方 Plan chip 那一格，为了"和它一样"） | **代价是启动崩溃，不是观感差异。** 那是 `kind: "single"` 座位，`SlotCore.register` 在同 priority 上第二次注册会**抛错**，于是首方 Plan 插件装配失败、web boot 断言失败、应用起不来。选它时的理由"两个模式不共存所以可以抢"混淆了**运行时**与**装配期**：不共存的是前者，抛错发生在后者。改用零占用者的 `conversation.input.left`（list），代价只是位置在工具行左侧 |
| **「文件被改过就拒绝」** | 这条闸门会把**埋探针本身**判成违规，于是插件的正常流程被自己锁死。判据必须收窄为「出现 `dsh-debug:change` 标记或自报 `changedFiles`」 |
| **用「文件数」做残留阈值**（探针文件 ≥ 3 / 6） | 最好的度量是**块数与行数**：一个文件里 20 处探针远比 6 个文件各 1 处严重。改用加权度量：残留标记行数、配对失败块数、连续无新证据轮数、无法判定归属的块数 |
| **交卷闸门直接对 `.ts` 跑 `node --check`** | 宿主自己制造的假失败：`.ts`/`.tsx` 必然解析失败，于是要么全被判违规、要么被标「不可验证」而完全失效。限定"只查本轮被工具触碰过的文件" + 按扩展名选解析器 + 严格区分 `failed` 与 `unverifiable` + 留逃生口（记脏而不拒绝） |
| **「临时产物根不可写就直接拒绝启动」** | 临时目录与工作区是两个独立位置，一个不可写不等于没地方写。现在是先在临时根写探针自检（`.probe-write-test`），失败即**回退** `<repo>/.dsh/debug-mode/`（回退必须出声：`notes` + `debts` + `start` 返回正文），两个都不可写才拒绝 |
