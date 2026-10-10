/**
 * lib/prompt.js —— 两段面向 Agent 的正文。
 *
 *   1. `renderGuide()` —— 把 assets/AGENT-PROBE-GUIDE.md 里的 `{{变量}}` 换成真值，
 *      作为 `dsh_debug_start` 的返回正文（Agent 因此不必读本插件任何源码）。
 *   2. `debugGuidance()` —— 注入 systemPrompt 的调试准则。
 *
 * ⚠️ 第 2 段的**唯一硬约束**（AGENTS.md §1.1 第 7 条）：它必须只在调试模式下出现。
 * 无活跃任务且无票据时返回空串，否则没进调试模式的会话也会收到「去埋点」的指令，
 * 等于把"只有 /debug 能进入"这条约束从提示词层面又打开一次（DESIGN.md §3.9）。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const GUIDE_URL = new URL('../assets/AGENT-PROBE-GUIDE.md', import.meta.url)

/** 读指南模板（生成器与测试共用）。 */
export async function readGuideTemplate() {
  return readFile(fileURLToPath(GUIDE_URL), 'utf8')
}

/**
 * 渲染埋点指南。与探针桩生成器同一种做法：锚点必须是显式变量，替换后不得残留 `{{`。
 * @param {{ template: string, hash: string, logPath: string, probeStub: string,
 *           probeImport: string, browserStub: string, httpGuide: string, probeEndpoint: string,
 *           round: number, goal: string, taskDir: string }} input
 * @returns {string}
 */
export function renderGuide(input) {
  const values = {
    HASH: input.hash,
    LOG_PATH: input.logPath,
    PROBE_STUB: input.probeStub,
    PROBE_IMPORT: input.probeImport,
    BROWSER_STUB: input.browserStub,
    HTTP_GUIDE: input.httpGuide,
    PROBE_ENDPOINT: input.probeEndpoint,
    ROUND: String(input.round),
    GOAL: input.goal || '（未提供描述——请向用户确认现象、期望与复现路径）',
    TASK_DIR: input.taskDir,
  }
  let text = String(input.template ?? '')
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{{${name}}}`).join(value)
  }
  const leftover = text.match(/\{\{[A-Z_]+\}\}/)
  if (leftover) {
    // 宁可让调用方看见错误，也不要发一份带占位符的指南给 Agent——
    // 那会让模型照着 `{{HASH}}` 字面量去埋点。
    throw new Error(`debug-mode: guide template has unresolved placeholder ${leftover[0]}`)
  }
  return text
}

/**
 * 注入给 Agent 的调试准则（systemPrompt section 的正文）。
 *
 * 刻意写得**短**：完整的埋点指南由 `dsh_debug_start` 返回，注入的这一段只承担
 * 「一旦你在这个会话里，规则是什么」这件事，避免每次模型调用都背上整份文档。
 *
 * ⚠️ 但**本任务的具体地址必须在这里**（端点 / 桩 / 日志 / 指南）。理由见
 * `DebugService.guidanceFor()`：这是唯一每次模型调用都在的文本，而
 * `dsh_debug_start` 的返回值只出现一次——上下文一压缩，Agent 就变成
 * "知道该用 HTTP 端点、却不知道端点是哪个地址"（实测事故）。
 *
 * @param {{hash: string, round: number, status: string, endpoint?: string|null,
 *          logPath?: string, probeStubPath?: string, browserStubPath?: string,
 *          httpGuidePath?: string, guidePath?: string}} task
 * @returns {string}
 */
export function debugGuidance(task) {
  if (!task || !task.hash) return ''
  const round = Number(task.round ?? 1)
  const firstRound = round <= 1
  // 地址块是"照着抄"的东西，所以单独成段、并明说"不用去翻文件"——
  // Agent 反问「摄入路径是什么」，本身就是这一段的失败。
  // ⚠️ 光给一个拼好的 URL 不够：实测里 Agent 知道 origin（宿主把 Web GUI 地址写在
  // 它自己的系统提示里）、也知道哈希，却不知道**中间那段路径**。所以这里必须
  // 把路径形状单独写一行——URL 丢了也能自己拼回来。
  const routePath = '/dsh-debug-mode/probe'
  const addresses = [
    '**本任务的地址（照抄，不用去翻文件）：**',
    task.endpoint
      ? `- 摄入端点（**首选**）：\`${task.endpoint}\``
      : '- ⚠️ **HTTP 通道无法自动给出地址**：宿主没交出端口，也不在 `DSH_WEB_URL` 里。'
        + '用下面那行路径形状自己拼（宿主地址 = 你系统提示里那个 Web GUI 地址）。',
    `  · **路径是固定的，逐字如此**：\`POST <宿主地址>${routePath}?h=${task.hash}\``,
    '    （哈希走**查询串** `?h=`，不是路径段；宿主地址就是你系统提示里那个',
    '    "DeepSeek Harness Web GUI at http://127.0.0.1:<端口>" 里的那一段。）',
    '  · 写记录 = `POST`（**只有 `probe` 必填**）；自检 = `GET` 同一个地址，看 `httpRecords` 涨不涨。',
    task.httpGuidePath && task.endpoint
      ? `  · 现成代码片段（curl/Python/Node/Ruby/Go/PHP/PowerShell/Java）：\`${task.httpGuidePath}\``
      : '',
    task.probeStubPath ? `- Node 文件桩（热路径 / 崩溃前落盘 / 没网络时才用）：\`${task.probeStubPath}\`` : '',
    task.browserStubPath && task.endpoint ? `- 浏览器桩（经典 \`<script src>\`）：\`${task.browserStubPath}\`` : '',
    task.logPath ? `- 日志文件（**你不要直接读**，只走 \`dsh_debug_read\`）：\`${task.logPath}\`` : '',
    task.guidePath ? `- 完整埋点指南（要细节时读它）：\`${task.guidePath}\`` : '',
  ].filter(Boolean)
  return [
    `## 调试模式（任务 ${task.hash} · 第 ${round} 轮 · ${task.status}）`,
    '',
    `用户已经通过 /debug 授权本次调试。当前任务哈希是 \`${task.hash}\`，`,
    '所有探针块与改动块都必须带这个哈希——收尾时宿主凭它把探针摘干净。',
    '',
    ...addresses,
    '',
    '**调试模式是宿主侧的一个独立服务，你在这个流程里的动作只有两种：',
    '给它发信号（`dsh_debug_*` 工具）+ 用编辑工具在源代码里埋点/改代码。',
    '不需要运行任何命令**——复现是用户的事，不是你的。',
    '（`bash` / `pwsh` 在本会话里可能被环境策略整个挡掉，那是正常的：本流程不依赖它，',
    '被挡了也不要去找替代命令，直接埋点交卷。）',
    '',
    '- 埋点前先列 2–5 条具体假设；每处探针要能证实/证伪其中一条，不做无脑入口打点。',
    firstRound
      ? '- **本轮是只读取证轮：不许改代码。** 先改会掩盖现场，后面的日志再也证不出真相。'
      : '- 本轮可以「先按假设改代码，再埋点验证」；但改完必须再埋点，用日志证明改前复现、改后不复现。',
    // 关于通道的两条必须**跟着地址块一起变**：地址块说"HTTP 不可用"，
    // 这两条却继续推荐它，Agent 只会更迷茫——降级要整段一致，不能只降一半。
    // ⚠️ 数组必须**展开**（`...`）：作为单个元素塞进去的话，`.join('\n')` 会用
    // `Array.prototype.toString()` 把它变成"A,B"，逗号就留在正文里了（踩过一次）。
    ...(task.endpoint
      ? [
        '- 埋点入口**优先走 HTTP 端点**（语言无关：写日志、时间戳、截断、限额、并发都归宿主管）；',
        '  只在热路径、需要"崩溃前落盘"、或没有网络栈时，才用 Node 文件桩或自写文件桩。',
      ]
      : [
        '- 本轮 HTTP 通道**拿不到自动给出的地址**，埋点用上面那个 Node 文件桩；',
        '  若目标本来该走 HTTP（浏览器/别的语言），按上面那行路径形状自己拼出地址再用。',
      ]),
    '- 桩会在**加载时**写一条 `debug-mode:ready`——**它是唯一的区分手段**：',
    '  看得到它 = 桩被加载了（去查调用点）；看不到 = 桩根本没加载（去查 import 路径）。',
    ...(task.endpoint
      ? [
        '- 让用户复现**之前**先 GET 一次端点自检；投递是尽力而为的，"通道死了"与"埋点没执行"',
        '  的现象一模一样（日志一片空白），不自检就会在这一轮里白等。',
      ]
      : []),
    '- 每一处探针用 `dsh-debug:probe <hash> start/end` 夹住（成对、同缩进、中间不夹别的标记）；',
    '  临时探索用 `dsh-debug:temp <hash> start/end`（收尾必删），修复用 `dsh-debug:change <hash>`，三色不许混。',
    '- 读日志只走 `dsh_debug_read`，不要自己 cat/read 日志文件。',
    '- 用户点「问题复现」后：**日志还在**。顺序是 `dsh_debug_read`（先看现场）→ 分析 → `dsh_debug_continue`。',
    '  ⚠️ `continue` 会清空日志，所以它必须排在 `read` 之后——顺序反了，用户刚复现出来的东西就没了；',
    '  宿主会拦住"还有没读过的字节就想清空"的调用。',
    '- 埋完立刻 `dsh_debug_report` 交卷（同时报 `probeFiles` 与 `changedFiles`），然后停手等用户复现。',
    '  交卷时必须给面板两样东西——它们是你和用户之间**唯一**的交接面：',
    '  ① `headline`：一句话结论（≤ 80 字），用户会读到的是这一句，别把整篇分析倒进去；',
    '  ② `reproSteps`：让用户照着做的复现步骤，一条一个可执行动作。',
    '     写"请复现一下"没用，写"清空标题后点保存"才有用——面板会把它做成编号清单。',
    '- 宿主会自己 diff 工作区：新增文件会被点名，你漏报的改动会被按"行为改动"记账。',
    '  ⚠️ 加块时**不要动原有的空行**：宿主只删标记**之间**的行，所以——',
    '  原有的空行留在标记**外**（它才活得下来），你自加的空行才放进标记**内**。',
    '  把原有的空行包进标记里，摘除时它会跟块一起消失（那是在吃用户的空行，清理逻辑兜不住）。',
    '- 用户说「已解决」后：`dsh_debug_end` → 只删探针块与临时块 → 删探针桩；**绝不用 `git checkout` 整体回滚**。',
    '- 收尾若被暂停（隔离区有无法判定归属的残留），用 `ask_user_question` 逐条问用户三选一，回填 `quarantine` 再收尾。',
    '- 永远不要留着探针代码当作「以后可能有用」——那是下一个 bug 的温床。',
  ].join('\n')
}

/**
 * `/debug` 命令投给 Agent 的指令正文 —— 这段文本会被**开成一轮对话**
 * （`sessionController.prompt`），所以它同时承担"指令"与"用户消息"两个角色。
 *
 * 为什么这段文字由插件写死：用户敲的描述只作为**数据**附在里面，指令长什么样由插件
 * 说了算，模型不能改写它——这正是闸门确定性的来源（DESIGN.md §3.5）。
 *
 * ⚠️ 它**不是**命令 handler 的返回值。命令的返回值是给人看的，宿主不会发给模型
 * （已核实 dsh-commands 的 `execute()`），所以"Agent 要开始干活"只能靠投一轮来实现。
 *
 * @param {{ text: string, expiresInMinutes: number }} input
 * @returns {string}
 */
export function debugCommandInstruction(input) {
  const goal = String(input.text ?? '').trim()
  return [
    '[debug-mode] 用户通过 `/debug` 请求进入调试模式。',
    '**这一轮就是完整的请求，请立刻开始判断与动手**——不要回复「好的，请描述一下现象」，',
    '也不要等用户再说一句「开始」：描述就在下面，没有别的补充了。',
    '',
    '用户描述的现象（原文，未经改写）：',
    goal ? `> ${goal.replace(/\n/g, '\n> ')}` : '> （用户没有写描述——请先用一句话向用户确认现象、期望与复现路径）',
    '',
    '你现在有两个选择，**先判断再动手**：',
    '',
    'A. 读完代码就确定根因（空指针、拼写错误、缺一次 await、写死常量……）',
    '   → **不要调用 `dsh_debug_start`**。直接说明根因并改代码，给出验证方式。',
    '     票据会自己过期，你不需要为"拒绝了"做任何清理。',
    '',
    'B. 需要现场数据才能定位',
    '   → 调用 `dsh_debug_start`，把用户的描述原样放进 `goal`（不要自己概括）。',
    '     它会返回本次任务的哈希、日志路径、探针桩路径与完整的埋点指南。',
    '',
    '无论走哪条路：**跑起来复现是用户的事**。埋点、改代码、发信号都不需要你运行任何命令，',
    '所以即使本会话的 shell 被环境策略挡掉，这条流程也照常走完（页面类目标有 HTTP 探针通道）。',
    '',
    `门票 ${input.expiresInMinutes} 分钟内有效且只用一次；若本会话已有进行中的任务，`,
    '命令会直接告诉你哈希，请改用 `dsh_debug_continue` 而不是新开一个任务。',
  ].join('\n')
}
