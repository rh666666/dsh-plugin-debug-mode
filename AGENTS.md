# AGENTS.md — 开发纪律

> 只有两章：**开发纪律**（长期约束每一次改动的规则）与**本文件的维护规则**。
> 项目是什么、模块怎么装配、有哪些不变量，都从代码与测试读——那才是唯一真相；
> 写在这里只是第二份会漂移的副本。

## 1. 工程纪律

### 1.1 依赖与运行

- 纯 ESM（`"type": "module"`），**零运行时依赖**，只用 Node 内置模块——探针桩会被复制进
  用户项目，必须零依赖。
- React / DSH 客户端包一律 `peerDependencies` + `optional`，客户端半必须容忍它们不存在。
- 测试只用 `node --test`，不引入测试框架。

### 1.2 命令

```bash
node scripts/build-client.mjs      # 生成 lib/client.js（改了 src/client.js 必须重跑）
node --test test/*.test.mjs        # 全部单测（会先自动重新构建客户端产物）
node scripts/probe-selfcheck.mjs   # 探针边界自检（退出码可进 CI；--endpoint 打活的 DSH）
```

别写 `node --test test/`（Node 24 会当成模块名而报 `Cannot find module`）。

### 1.3 客户端半的两条通道（最容易搞错的地方）

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

### 1.4 代码风格

- 注释写**契约**：这段代码做什么、前置条件、副作用、调用方要注意什么。解释"为什么"仅限
  读者无法从代码推断的取舍（例如某处刻意不用某个 API）。不写变更史、不写发现过程、
  不写"我如何调试出来的"、不引用本文件。
- 优先让代码自解释：能通过命名、类型、早期返回表达清楚的，不再加注释。
- 面向用户的文案（面板、工具返回值）用中文；标识符与协议字段用英文。
- 不为「将来可能需要」写抽象层。
- **任何文本文件都不带 emoji**（代码、注释、文档、测试、返回值、面板、提交信息），判定范围
  `U+FE0F`、`U+2600–U+27BF`、`U+2B00–U+2BFF`、`U+1F000–U+1FAFF`，由 `test/style.test.mjs`
  守卫。编码与字形回退各家不同，emoji 会变乱码或半个代理对。4 字节夹具写
  `String.fromCodePoint(0x1F600)`；非 emoji 排版字符（`→` `·` `—` `≤` `≥` `…`）保留。
- **图标用内联 SVG，不用字符图标**：字形由字体决定，等宽字体下会渲染成方框。浏览器里
  `createElement('svg', …)` + `aria-hidden="true"` + `focusable="false"`，状态变化用 CSS
  `transform`；纯文本通道用 `[!]` / `[ok]` / `[x]`；同一件事两处出现时宿主写标记、面板渲染成
  SVG（`stripTextMarker()` 剥前缀）。

### 1.5 改协议或状态机时

改 `lib/protocol.js` / `lib/task.js`；涉及桩就同步 `assets/probe.template.mjs`，并让
`test/protocol.test.mjs` 证明各处实现一致。

### 1.6 CHANGELOG 与版本号

只在用户说要发版时动。`CHANGELOG.md` 是面向使用者的发布日志，不是工作日志，也不承载
设计说明；功能做完、测试全绿都不算发版。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：`## [x.y] - 日期`
小节 + 新增 / 变更 / 移除 / 修复 / 安全 分类。每条**一句话**说清对使用者意味着什么；
实现细节写进代码注释或提交信息。发版时最新小节版本与 `package.json` 的 `X.Y.0` 相等
（`test/changelog.test.mjs` 守卫），日期现取。

## 2. 维护这一份文件

**只在纪律本身变了时改**。项目结构、模块职责、不变量、被推翻的方案都不属于这里——代码、测试与
`git log` 才是它们的存放处。

**逐行问一句「删掉它，Agent 会犯错吗？」** 只留可判定的规则、与默认行为不同的约定、会反复踩的
坑。删掉：无法判定的叮嘱、通用语言常识、目录树与文件清单、过程叙事、别处已有的第二份内容。

**怎么写**：一节只讲一件事；结论在前、理由在后；软规则写「应当」，硬规则写「必须 / 绝不」。
每加一段，先看有没有等量的旧内容可以删。
