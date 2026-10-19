# AGENTS.md — 项目开发边界

> 常驻给 AI 的约束：边界、不变量、硬契约、踩过的坑。**不是项目说明书**——进度、文件清单、
> 里程碑、每版改了什么一律不写（看 `git log` 与 [CHANGELOG.md](./CHANGELOG.md)）。
>
> 纯 Markdown、无 frontmatter，Codex / Cursor / Copilot / Gemini CLI / Claude Code 都能读。
> 命令在 §4.2，**但先看 §3：默认都不许自己跑**。
>
> **优先级**：用户当前消息 > `~/.dsh/AGENTS.md`（常驻硬规则）> 本文件 > 代码注释与测试。

---

## 1. 这是什么

一个 DSH（DeepSeek Harness）插件，灵感来自 Cursor Agent 的 Debug 模式：
**让 Agent 别猜，自己在代码里埋探针，把现场取回来；用户复现后二选一。**

```
/debug <现象描述> → Agent 埋带可摘除标记的探针（不运行任何命令）
  → 探针把记录交给宿主（首选 HTTP 摄入）→ <临时目录>/dsh-debug-mode/tasks/<hash>/<hash>.log
  → Agent 经 dsh_debug_read 拿摘要（不自己翻文件）→ 用户复现 → 面板：
      已解决 → 删日志 + 删本次全部探针       需要继续 → 日志保留，读完再开下一轮
```

包名 `dsh-plugin-debug-mode`；对外标识 `/debug`、`dsh_debug_*` 工具、
`dsh-debug:probe <hash>` 标记。**进入调试模式的方式有且只有一个**：`/debug <现象描述>`。

### 1.1 核心不变量（破坏任何一条都算事故）

1. **入口唯一。** 只有 `/debug` 能进入；`dsh_debug_start` 必须持票（会话级一次性）才放行，
   无票一律拒绝。这是宿主侧硬校验，不是提示词约定：工具对所有会话可见，只有返回值拦得住。
2. **一个任务一个哈希。** 首次进入由宿主用 CSPRNG 生成 8 位小写十六进制，之后永不变，从不接受
   外部传入（可猜的哈希等于别人能读到别人的日志）。
3. **清空日志只有 `dsh_debug_continue` 一个时机**（truncate 为 0 字节，不删文件、不换目录）。
   用户点「复现」**不清空**——那一刻 Agent 还没读，清空等于把刚复现的现场扔掉。`continue` 前
   有闸门 C：还有超过 `lastRead.bytes` 的未读内容就拒绝（三振降级）。
4. **用户信号不直接删日志。**「已解决」只唤醒 Agent；删日志与删探针由 `dsh_debug_end` 一并
   完成，两者同生共死。
5. **探针必须可机器摘除。** 每处被 `dsh-debug:probe <hash> start/end` 夹住；`dsh_debug_end`
   凭标记恢复干净并给出对账清单。
6. **Agent 不直接读日志文件。** 一律经 `dsh_debug_read`：摘要优先、异常全量、省略量显式声明。
7. **准则只在调试态注入。** `systemPrompt.section` 的 `text` 是 thunk，无活跃任务且无待用票据
   时返回空串。`/debug` 的指令走注入、不走用户消息——模式态走 section，用户输入原样走消息
   （对齐 Plan 模式）。
8. **协议冻结。** 行格式与字段序的唯一真相是 `lib/protocol.js`；只可新增**可选**字段，且必须
   同步 `assets/probe.template.mjs` 与测试（§4.5、§4.6）。
9. **输入框始终可用。** 面板不得挡住输入框；有未发送草稿时禁用面板按钮（否则同一描述送两遍）；
   `awaiting-user` 下收到新用户消息自动回 `active`。
10. **探针账与修复账分开记，收尾只撤探针。** `probe` / `temp` / `change` 三色不混，
    `probeFiles` 与 `changedFiles` 分别登记。**绝不回滚用户的修复**；`git checkout` /
    `git stash` 整体回滚是明令禁止的收尾方式。
11. **Agent 可以不进调试。** 一眼能看出根因时应当不调用 `dsh_debug_start`，说明根因并直接改
    代码；票据自己会过期，不需要任何清理动作。
12. **闸门不死锁，也不静默放行。** 同一原因连续拒绝 3 次必须降级为 warn-only 并记进欠账；
    扫描能力不可用时面板必须写「残留检测未生效」——失效与放行在现象上一模一样。
13. **残留按可判定性处理。** `probe`/`temp` 必删、`fix` 保留、陌生哈希或残缺标记进隔离区逐条
    三选一、无标记只提示不删。**不允许静默保留**：漏删的临时代码没有下游拦截，只会慢慢烂掉。
14. **调试流程里不运行任何命令。** Agent 的动作只有两种：发信号 + 用编辑工具埋点/改代码；
    复现是被调试程序使用者的事。实测依据：`D:\` 归属 `SYSTEM`、当前账号缺 WRITE_DAC 时，所有
    shell 命令在授权阶段就被拒（`SetNamedSecurityInfoW` / `Win32 5`），而同一时刻
    `edit`/`write` 完全正常。连带约束：任何**必需**通道都不许依赖命令（页面类走 HTTP 摄入）。
15. **产物不进工作区。** 落 `join(tempBase, 'dsh-debug-mode')`，`tempBase` 依次取 `tempDir` →
    `DSH_DEBUG_MODE_TMP` → `os.tmpdir()`；临时根不可写时回退 `<workspace>/.dsh/debug-mode/`
    且**必须出声**（`notes` + `debts` + `start` 返回正文）；两个都不可写则拒绝 `start`。任务用
    `artifactRoot` / `artifactRootKind` 记住落点，缺省按 `workspace` 解释（旧任务）。

---

## 2. 真源：改哪里、别改哪里

| 内容 | 唯一真相 | 纪律 |
| --- | --- | --- |
| 日志行协议 | `lib/protocol.js` | 冻结，只可加可选字段（§4.5） |
| 哈希 / 状态机 / 产物根 | `lib/task.js` | 冻结（§4.5） |
| 注入给被调试会话的准则 | `lib/prompt.js` | 改措辞只改这里，本文件不复述（§5） |
| 埋点指南模板 | `assets/AGENT-PROBE-GUIDE.md` | 只放 `{{变量}}`，缺锚点即抛错 |
| 版本号 | `CHANGELOG.md` 顶部 + `package.json` | 三处必须相等（§4.6） |
| 客户端 | 源码 `src/client.js`；产物 `lib/client.js` | 只改源码，产物由构建脚本生成 |

---

## 3. 动作边界（来自 `~/.dsh/AGENTS.md`，与它冲突时以它为准）

**本文件出现的任何命令都不构成"可以跑"的授权**（§4.2 也一样）。

**Always（默认可做）**：只读探索（读文件、列目录、搜代码、看依赖）；编辑用户点名范围内的
代码文件后**写完即停**并如实汇报（未验证就说未验证）；跑仓库**已有**的、与改动相关的单测
（`node --test test/<name>.test.mjs`）。

**Ask first（先说清为什么、大概多少成本，然后停下等回答）**：跑 build / dev / 启动 / 全量
测试 / `probe-selfcheck` / 任何额外命令；用子代理（仅在"工作量大且能切成互不重叠的块"时，
数量按块数给，先讲切法与预期收益）；超出点名范围的改动（含顺手重构、格式化、补文档）。

**Never（无例外）**：自造验证脚手架（冒烟测试、临时脚本、临时目录、渲染核对脚本），哪怕
一次性的；安装任何东西（依赖、字体、驱动、CLI、运行库）；开浏览器/截图/手工走查去"看一眼"；
未点名就改无关文件、写总结报告。**特别地**：AGENTS.md 生态的默认行为是「自动执行文中命令」，
**本仓库明确关闭这一条**（见 §1.1 第 14 条）。

判据只有一句：**用户在这条消息里点名了吗？（相关单测除外。）**

---

## 4. 工程纪律

### 4.1 依赖与运行

纯 ESM（`"type": "module"`），**零运行时依赖**，只用 Node 内置模块——探针桩会被复制进用户
项目，必须零依赖。React / DSH 客户端包一律 `peerDependencies` + `optional`，客户端半必须容忍
它们不存在。测试只用 `node --test`，不引入测试框架。

### 4.2 命令

```bash
node scripts/build-client.mjs      # 生成 lib/client.js（改了 src/client.js 必须重跑）
node --test test/*.test.mjs        # 全部单测（会先自动重新构建客户端产物）
node scripts/probe-selfcheck.mjs   # 探针边界自检（退出码可进 CI；--endpoint 打活的 DSH）
```

别写 `node --test test/`（Node 24 会当成模块名而报 `Cannot find module`）。

### 4.3 客户端半的两条通道（最容易搞错的地方）

本插件走**包通道**（`dsh.client`），与动态通道（`cordis-client-runner`）互不相通：

| | 包通道（本插件） | 动态通道 |
| --- | --- | --- |
| 工厂参数 | 只有 `require` | `React` / `console` / `styles` / `host` |
| `host.call()` | **不存在** | 有（配 `harness.handle`） |
| `styles.insert()` | **不存在** | 有 |
| 网络 | 浏览器 `fetch` | 不可用，必须 `host.call` 回宿主 |
| 宿主侧配对 | `ctx.webServer.register(...)` | `harness.handle(...)` |

可 `require` 的只有平台种子表：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。

三条规矩：只改 `src/client.js`；产物必须带 `window.__ModuleLoader__.load({ id, factory })` 外壳
（`id` 逐字等于包名，宿主不编译、原样下发，ESM 语法上线必白屏）；组件服务所有会话，按
`sessionId` 自过滤，无关时 `return null`，绝不在模块级放全局状态。

### 4.4 代码风格

- 注释解释**为什么**，不解释**是什么**；每条不变量都值得一句「为什么」。
- 面向用户的文案（面板、工具返回值）用中文；标识符与协议字段用英文。
- 探针运行时的每处写入都包在 `try/catch` 里并安静降级；不为「将来可能需要」写抽象层。
- **任何文本文件都不带 emoji**（代码、注释、文档、测试、返回值、面板、提交信息），判定范围
  `U+FE0F`、`U+2600–U+27BF`、`U+2B00–U+2BFF`、`U+1F000–U+1FAFF`，由 `test/style.test.mjs`
  守卫。理由不是审美：编码与字形回退各不相同，emoji 会变乱码或半个代理对。4 字节夹具写
  `String.fromCodePoint(0x1F600)`；非 emoji 排版字符（`→` `·` `—` `≤` `≥` `…` 与中文标点）保留。
- **图标用内联 SVG，不用字符图标**（字形由字体决定，等宽字体下会渲染成方框）。浏览器里
  `createElement('svg', …)` + `aria-hidden="true"` + `focusable="false"`，状态变化用 CSS
  `transform`；纯文本通道用 `[!]` / `[ok]` / `[x]`；两处出现时宿主写标记、面板渲染成 SVG
  （`stripTextMarker()` 剥前缀）。举例只写码点（`U+2713`）。

### 4.5 改动协议或状态机时

三件事按顺序做完，缺一不算改完：① `CHANGELOG.md` 加一行（新→旧）；② 改 `lib/protocol.js` /
`lib/task.js`（协议真相在它们的注释里）；③ 涉及桩就同步 `assets/probe.template.mjs`，并让
`test/protocol.test.mjs` 证明多处实现一致。

### 4.6 版本号纪律（提交前必做）

三处必须**同时**相等，只改一处必红（`test/changelog.test.mjs`）：`CHANGELOG.md` 顶部
`> 最新版本：vX.Y`、表格里最新那一行、`package.json` 的 `version`（写作 `X.Y.0`）。

**触发只有两个**：新功能确认实现完成；问题确认修复完成且准备提交。中途进度与只改注释 / 文案 /
测试细节**不升版本**。触发后同一次编辑做完：表头之后插一行
`| X.Y | <今天日期> | <改了什么 + 为什么，≥20 字符> |`；顶部版本号末位 +1；同步 `package.json`。
日期现取（`Get-Date`），绝不复用相邻行的日期。

---

## 5. 给被调试会话的准则（不复述）

唯一真相是 `lib/prompt.js`：`debugGuidance()`（任务活跃）与 `debugTicketGuidance()`（持票
待用），由 agent 作用域的 `systemPrompt.section` 注入；埋点指南模板是
`assets/AGENT-PROBE-GUIDE.md`。改措辞只改这两处——复制一份到本文件必然漂移，而漂移的那份会被
Agent 当成契约。

---

## 6. 硬契约与踩过的坑（写代码前对照；拿不准先做实验再写）

- 工具参数是 JSON Schema 的**子集**（`type/oneOf/properties/required/additionalProperties/
  items/enum/const` + 注解），多一个关键字 `tools.register()` 当场抛 `JsonSchemaError`；
  `required` 是数组，不是属性上的 `required: true`。`output.render(args, value)` 必填，且
  `execute` 的返回值还要过 `output.schema`——错误路径也必须合规，否则最需要读的错误会被
  `ToolOutputError` 吞掉。
- 命令 handler 返回的 `text` **不进模型**（原文 "without sending it to the model"）。要让 Agent
  干活必须显式 `ctx.sessionController.prompt({ mode: 'queue', … })`。
- 工具必须注册在 **agent 作用域**（`agent/created` 里 `agent.ctx.inject(['tools',
  'systemPrompt'], …)`）；事件回调里的 `this` 会随派发释放；`apply(ctx)` 里裸注册 = 全局可见。
  可见性无法按会话动态开关，所以入口只能靠票据。
- 浏览器↔宿主只有一条路：`ctx.webServer.register({ kind, path, handler })` 同源路由 + `fetch`
  + 轮询（`res` 是 Node `ServerResponse`；包通道没有 `host.call`）。
- 端点自己算（`DSH_WEB_URL` 优先，其次 `webServer.port`）；注入段必须写全**路径形状**与全部
  地址（`/dsh-debug-mode/probe?h=<hash>`，哈希走查询串）——URL 会随上下文压缩丢失。
- 单行超限只能**省略值再重新序列化**（`encodeRecord()`），绝不切已序列化整行（会留下没闭合的
  `[`/`{`）；长度按 UTF-8 字节；三处实现逐字同构，比对时必须给**等长** `ts`（它参与预算）。
  截断权威只有 `encodeRecord()`：摄入路径不许任何静默 `slice` 预截断。
- 空白的命运只看它落在标记哪一侧：标记**外**活下来、标记**内**跟块一起消失。原有的空行留在
  标记外，只有自加的空行才放标记内（`start` 插在原有空行**后面**）；校验比**位置**不比行数。
- `systemPrompt.section` 的 `text` 可为 thunk，但必须**同步**返回字符串（Promise 会渲染成
  `[object Promise]`）；order 用 `SECTION_ORDERS` 的 `TOOLS_SDK=5000` 之后的 **5050**。
- 客户端入口是 `exports["./client"].default`（不是 `main`）。
- 座位选型只看 `kind` / `scope` / 现有 `occupants`：`list` 座位要自己的 `id`；**`kind: "single"`
  一定不能碰**——同 priority 二次注册直接抛错（不是顶掉前者），且发生在同步装配期。面板坐
  `conversation.input.dock`，状态 tag 坐 `conversation.input.left`。
- 面板只显示 `headline` 与 `reproSteps`，不塞整篇 `analysis`；默认折叠，只在 `awaiting-user`
  展开，折叠态那一行要说清轮到谁。`InputState` 面板只看 `draft` 与 `attachmentIds`；
  `awaiting-user → active` 的依据是 `session/event` 的 `user/message`。
- `start` 前做写探针自检（临时根写 `.probe-write-test` 再删），失败回退工作区，两个都不可写才
  拒绝。自检脚本矩阵要跟着 HTTP 契约走（请求体 ≤ 64 KiB），否则本地与活模式会给出两个结论；
  写不变量前先读实现，别把「我以为的契约」烧进检查器。

### 6.1 上限（政策默认值）

| 项 | 默认 | 触发线看什么 / 结果 |
| --- | --- | --- |
| 单条日志行 | **8 KiB** | 看**整行**（UTF-8 字节）。结果是省略超长值后重排（先按档位、再二分找最大 clip），标 `truncated:true`；不是切尾巴 |
| 单任务日志总字节 | **16 MiB** | 写端停止追加并写 `probe:"debug-mode:overflow"`，让「没有更多记录」成为事实 |
| `dsh_debug_read` 默认 | **200 行** | 只是默认值，`limit` 可覆盖；省略量必须显式声明 |
| 单任务目录总字节 | **32 MiB** | 目标值。当前只有 `read` 时按 `LOG_WARN_BYTES` 提示，未单独校验——政策意图，不是已实现闸门 |

真相在代码常量里（`MAX_RECORD_BYTES` / `LOG_WARN_BYTES` / `summary.js` 默认条数）；改常量就要
回来改这张表。

---

## 7. 不要重新引入（被推翻或实测证伪）

| 别做 | 为什么 |
| --- | --- |
| 把 `/debug` 指令和用户描述塞进同一条用户消息 | 对话里出现用户没说过的话；同一份描述两处各存一份必然漂移 |
| 把未标记的改动默认当 fix 保留 | 误删修复已被标记机制防住；漏删临时没有任何下游拦截，只会慢慢烂掉 |
| 假说登记册 + 探针配额 | 用最不可信的输入（Agent 自报数组）限制最需要自由度的动作，三行 JSON 就能冲破 |
| 把「token 只有面板能种下」当安全边界 | 架构上不成立：路由是宿主开的，Agent 有 `fetch`；只能降级为审计 + 摩擦 |
| 把轮次 / 存活时长做成工具可用性 | 任务寿命只该影响看板排序与语气；最需要证据时锁工具是拿可用性换纪律 |
| 包通道里用 `host.call(...)` | 那个 API 不存在，只会拿到 undefined |
| 手写 ESM 客户端半 | 宿主不编译，`import`/`export` 上线必白屏 |
| 面板坐 `conversation.composer.dock` / tag 抢 `conversation.input.plan` | 前者挤走输入框；后者是 `single` 座位，二次注册抛错，装配期崩溃、应用起不来 |
| 「文件被改过就拒绝」当交卷闸门 | 会把埋探针本身判成违规，插件的正常流程被自己锁死 |
| 用「文件数」做残留阈值 | 一个文件 20 处探针远比 6 个文件各 1 处严重，用块数 / 行数加权 |
| 对 `.ts` 直接跑 `node --check` | 必然解析失败，要么全判违规要么完全失效；按扩展名选解析器，区分 `failed` / `unverifiable` |
| 临时产物根不可写就拒绝启动 | 两个位置独立；先自检、失败回退、回退出声，两个都不可写才拒绝 |

---

## 8. 维护这一份文件

**只在边界本身变了时改**：新增/废除不变量、发现新的硬契约或坑、推翻既有选择。做里程碑、加
文件、发版本都**不是**理由。

**逐行问一句「删掉它，Agent 会犯错吗？」** 写可判定的规则与阈值、与默认行为不同的约定、命令
与验证方式、会反复踩的坑、指向唯一真相的路径；不写无法判定的叮嘱（「写好代码」）、通用语言
常识、详细 API 文档、讲故事式的过程叙述、已经存在于别处的第二份内容。

**怎么写**：一节只讲一件事；结论在前、理由在后；每条不变量都尽量给可机械检查的依据（测试名、
代码常量、标记名）。软规则写「应当」，硬规则写「必须 / 绝不」——混用会让硬规则一起被当成建议。

**改完的自检**：正文引用了代码常量/名称就顺手核对代码；跑 `node --test test/style.test.mjs`
（禁 emoji、禁字符图标），动了版本再跑 `node --test test/changelog.test.mjs`；然后停手汇报。

**已知边界**：编号（§1.1 第 N 条、§4.4、§4.6）被 `lib/*.js` 的注释与 `test/*.mjs` 引用，改
编号必须同步那些引用。当前 266 行，比业界建议的 200 行长——因为 15 条不变量与 20 余条硬契约
本身就是正文。除这两块之外，任何新增都要先删等量内容。
