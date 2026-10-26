/**
 * 面向 Agent 的四段正文：
 *
 *   1. `renderGuide()` —— 把 `assets/AGENT-PROBE-GUIDE.md` 的 `{{变量}}` 换成真值，
 *      作为 `dsh_debug_start` 的返回正文。
 *   2. `debugGuidance()` —— 任务活跃期注入 systemPrompt 的调试准则。
 *   3. `debugTicketGuidance()` —— 持票待用期注入的指令（`/debug` 之后、`start` 之前）。
 *   4. `debugSignalGuidance()` —— 用户表态之后注入的指令（收尾或继续排查）。
 *
 * 2/3/4 只在调试态返回非空：组装由 `lib/index.js` 的 section thunk 负责，
 * 任一分支拿不到"现在该说什么"就返回空串，否则未进入调试的会话也会收到埋点指令。
 *
 * 2/3/4 都不含用户输入的正文——那永远是那一条用户消息本身。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const GUIDE_URL = new URL('../assets/AGENT-PROBE-GUIDE.md', import.meta.url)

/** 读指南模板（生成器与测试共用）。 */
export async function readGuideTemplate() {
  return readFile(fileURLToPath(GUIDE_URL), 'utf8')
}

/**
 * 渲染埋点指南：锚点必须是显式变量，替换后不得残留 `{{`。
 *
 * `browserStubUrl` 与 `artifactRootKind` 可选：前者为 `null` 时指南会写成一句人话，
 * 后者缺省按用户临时目录解释。
 *
 * @param {{ template: string, hash: string, logPath: string, probeStub: string,
 *           probeImport: string, browserStub: string, browserStubUrl?: string|null,
 *           httpGuide: string, probeEndpoint: string, round: number, goal: string,
 *           taskDir: string, artifactRootKind?: 'temp'|'workspace' }} input
 * @returns {string}
 */
export function renderGuide(input) {
  const values = {
    HASH: input.hash,
    LOG_PATH: input.logPath,
    PROBE_STUB: input.probeStub,
    PROBE_IMPORT: input.probeImport,
    BROWSER_STUB: input.browserStub,
    // 页面用经典 `<script src>` 直接引这个 URL（由宿主路由即时渲染）。拿不到宿主
    // 地址时写一句人话而不是空串：空串会让指南里出现一个"看起来很对"的空引用。
    BROWSER_STUB_URL: input.browserStubUrl || '（宿主地址未知，未生成——见下面「HTTP 探针通道」）',
    ARTIFACT_ROOT_KIND: input.artifactRootKind === 'workspace'
      ? '（[!] 临时目录不可写，本次产物落在工作区的 .dsh/debug-mode/ 下）'
      : '（用户临时目录）',
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
 * 注入给 Agent 的调试准则（systemPrompt section 正文）。
 *
 * 刻意写短：完整埋点指南由 `dsh_debug_start` 返回，这一段只承担"进入会话后规则是什么"。
 * 但本任务的具体地址（端点 / 桩 / 日志 / 指南）必须在这里——这是唯一每次模型调用都在的
 * 文本，而 `dsh_debug_start` 的返回值只出现一次，上下文压缩后地址就没了。
 *
 * @param {{hash: string, round: number, status: string, endpoint?: string|null,
 *          logPath?: string, probeStubPath?: string, browserStubPath?: string,
 *          browserStubUrl?: string|null, httpGuidePath?: string, guidePath?: string,
 *          artifactRootKind?: 'temp'|'workspace'}} task
 * @returns {string}
 */
export function debugGuidance(task) {
  if (!task || !task.hash) return ''
  const round = Number(task.round ?? 1)
  const firstRound = round <= 1
  // 地址块是让模型直接照抄的，因此单独成段并说明无需翻文件。
  // 只给拼好的 URL 不够：模型可能知道 origin 与哈希，却不知道中间那段路径，
  // 所以要单独写一行路径形状，URL 丢失时也能拼回来。
  const routePath = '/dsh-debug-mode/probe'
  const addresses = [
    '**本任务的地址（照抄，不用去翻文件）：**',
    task.endpoint
      ? `- 摄入端点（**首选**）：\`${task.endpoint}\``
      : '- [!] **HTTP 通道无法自动给出地址**：宿主没交出端口，也不在 `DSH_WEB_URL` 里。'
        + '用下面那行路径形状自己拼（宿主地址 = 你系统提示里那个 Web GUI 地址）。',
    `  · **路径是固定的，逐字如此**：\`POST <宿主地址>${routePath}?h=${task.hash}\``,
    '    （哈希走**查询串** `?h=`，不是路径段；宿主地址就是你系统提示里那个',
    '    "DeepSeek Harness Web GUI at http://127.0.0.1:<端口>" 里的那一段。）',
    '  · 写记录 = `POST`（**只有 `probe` 必填**）；自检 = `GET` 同一个地址，看 `httpRecords` 涨不涨。',
    task.httpGuidePath && task.endpoint
      ? `  · 现成代码片段（curl/Python/Node/Ruby/Go/PHP/PowerShell/Java）：\`${task.httpGuidePath}\``
      : '',
    task.probeStubPath ? `- Node 文件桩（热路径 / 崩溃前落盘 / 没网络时才用）：\`${task.probeStubPath}\`` : '',
    // 浏览器桩给**两样**：URL 与落盘副本。URL 优先，因为页面直接 `<script src>` 取它
    // （经典 script 跨源可加载）；落盘副本只在页面 CSP 挡掉跨源时才是出路。
    // 拿不到 URL 时保留"只给副本路径"的老措辞，不编一个引不到的地址。
    task.browserStubPath && task.endpoint && task.browserStubUrl
      ? `- 浏览器桩（经典 \`<script src>\`，**由宿主伺服**）：\`${task.browserStubUrl}\``
        + `\n  · 落盘副本（页面有 CSP 限制时整段粘贴它）：\`${task.browserStubPath}\``
      : task.browserStubPath && task.endpoint
        ? `- 浏览器桩（经典 \`<script src>\`）：\`${task.browserStubPath}\``
        : '',
    task.logPath ? `- 日志文件（**你不要直接读**，只走 \`dsh_debug_read\`）：\`${task.logPath}\`` : '',
    task.guidePath ? `- 完整埋点指南（要细节时读它）：\`${task.guidePath}\`` : '',
    // 回退必须出声：产物落在工作区这件事只会静默地留下
    // 一个 `.dsh/` 目录，不写出来下一轮就没人知道为什么日志"跑到仓库里了"。
    task.artifactRootKind === 'workspace'
      ? '[!] 本次产物回退在工作区（临时目录不可写），收尾会随任务一起删除。'
      : '',
  ].filter(Boolean)
  return [
    `## 调试模式（任务 ${task.hash} · 第 ${round} 轮 · ${task.status}）`,
    '',
    `用户已经通过 /debug 授权本次调试。当前任务哈希是 \`${task.hash}\`，`,
    '所有探针块与改动标记都必须带这个哈希——收尾时宿主凭它把调试标记清干净。',
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
    // [!] 数组必须**展开**（`...`）：作为单个元素塞进去的话，`.join('\n')` 会用
    // `Array.prototype.toString()` 把它变成"A,B"，逗号就留在正文里了。
    ...(task.endpoint
      ? [
        '- 埋点入口**优先走 HTTP 端点**（语言无关：写日志、时间戳、截断、限额、并发都归宿主管）；',
        ' 只在热路径、需要"崩溃前落盘"、或没有网络栈时，才用 Node 文件桩或自写文件桩。',
      ]
      : [
        '- 本轮 HTTP 通道**拿不到自动给出的地址**，埋点用上面那个 Node 文件桩；',
        ' 若目标本来该走 HTTP（浏览器/别的语言），按上面那行路径形状自己拼出地址再用。',
      ]),
    '- 桩会在**加载时**写一条 `debug-mode:ready`——**它是唯一的区分手段**：',
    ' 看得到它 = 桩被加载了（去查调用点）；看不到 = 桩根本没加载（去查 import 路径）。',
    ...(task.endpoint
      ? [
        '- 让用户复现**之前**先 GET 一次端点自检；投递是尽力而为的，"通道死了"与"埋点没执行"',
        ' 的现象一模一样（日志一片空白），不自检就会在这一轮里白等。',
      ]
      : []),
    '- 每一处探针用 `dsh-debug:probe <hash> start/end` 夹住（成对、同缩进、中间不夹别的标记）；',
    '  临时探索用 `dsh-debug:temp <hash> start/end`（写 `tmp` 也认），修复用 `dsh-debug:change <hash>`，三色不许混；',
    '  收尾会清掉**所有**调试标记：probe/temp 整块删，fix/change 只删标记注释、代码保留。',
    '- 读日志只走 `dsh_debug_read`，不要自己 cat/read 日志文件。',
    '- 用户点「问题复现」后：**日志还在**。顺序是 `dsh_debug_read`（先看现场）→ 分析 → `dsh_debug_continue`。',
    '  [!] `continue` 会清空日志，所以它必须排在 `read` 之后——顺序反了，用户刚复现出来的东西就没了；',
    ' 宿主会拦住"还有没读过的字节就想清空"的调用。',
    '- 埋完立刻 `dsh_debug_report` 交卷（同时报 `probeFiles` 与 `changedFiles`），然后停手等用户复现。',
    ' 交卷时必须给面板两样东西——它们是你和用户之间**唯一**的交接面：',
    '  ① `headline`：一句话结论（≤ 80 字），用户会读到的是这一句，别把整篇分析倒进去；',
    '  ② `reproSteps`：让用户照着做的复现步骤，一条一个可执行动作。',
    ' 写"请复现一下"没用，写"清空标题后点保存"才有用——面板会把它做成编号清单。',
    '- 宿主会自己看 git 工作区改动：新增文件会被点名，你漏报的改动会被按"行为改动"记账。',
    '  [!] 加块时**不要动原有的空行**：宿主只删标记**之间**的行，所以——',
    ' 原有的空行留在标记**外**（它才活得下来），你自加的空行才放进标记**内**。',
    ' 把原有的空行包进标记里，摘除时它会跟块一起消失（那是在吃用户的空行，清理逻辑兜不住）。',
    '- 用户说「已解决」后：`dsh_debug_end` → 清掉所有调试标记（探针块、临时块、fix/change 注释）→ 删探针桩；**绝不用 `git checkout` 整体回滚**。',
    '- `probeFiles` 就是**清理范围**：宿主只扫账本 + git 检测到的改动文件，不再遍历全仓库。',
    '  有 git 时它帮你兜底；**没有 git 时必须报全**——漏报的文件收尾不会碰。',
    '- `dsh_debug_end` 返回 `scanIncomplete: true` 时，说明这次**没清干净**：只许说清',
    '  "哪些已清、哪些需要人工确认"，**绝不许**说"已清理干净"（任务目录被保留着，证据还在）。',
    '- 收尾若被暂停（隔离区有无法判定归属的残留），用 `ask_user_question` 逐条问用户三选一，回填 `quarantine` 再收尾。',
    '- 永远不要留着探针代码当作「以后可能有用」——那是下一个 bug 的温床。',
  ].join('\n')
}

/**
 * 持票期的注入正文，走 `systemPrompt.section` 而非用户消息。
 *
 * 形态与 Plan 模式一致：模式态由宿主侧的 section 承担，用户输入原样作为对话消息。
 * 两者混在一条消息里会让对话出现用户没说过的话，并迫使指令复述用户描述。
 *
 * 本段**不含**用户描述：用户描述就是那一条用户消息本身，复述会让同一份数据出现两处。
 * 它也不是命令 handler 的返回值——返回值只给人看，不进模型。
 *
 * @param {{ expiresInMinutes?: number, hasUserText?: boolean }} [input]
 * @returns {string}
 */
export function debugTicketGuidance(input = {}) {
  const minutes = Number(input.expiresInMinutes ?? 0)
  const hasUserText = input.hasUserText === true
  return [
    '## 调试模式（持票中 · 等你判断）',
    '',
    '用户刚刚通过 `/debug` 授权了一次调试。门票**一次性**'
      + (minutes > 0 ? `、${minutes} 分钟内有效` : '') + '：',
    '`dsh_debug_start` 会校验这张票；没有这张票，那个工具会拒绝你。',
    '',
    '**先判断，再动手。** 两条路：',
    '',
    'A. 读完代码就确定根因（空指针、拼写错误、缺一次 await、写死常量……）',
    '   → **不要调用 `dsh_debug_start`**。直接说明根因并改代码，给出验证方式。',
    '   这张票就当作用掉了，你不需要为"拒绝了"做任何清理。',
    '',
    'B. 需要现场数据才能定位',
    '   → 调用 `dsh_debug_start`，`goal` 里**原样抄用户那条消息**（不要自己概括）。',
    '   它会返回本次任务的哈希、日志路径、探针桩路径与完整的埋点指南。',
    '',
    '无论走哪条路：**跑起来复现是用户的事**。埋点、改代码、发信号都不需要你运行任何命令，',
    '所以即使本会话的 shell 被环境策略挡掉，这条流程也照常走完（页面类目标有 HTTP 探针通道）。',
    '',
    '若本会话已有进行中的任务，`dsh_debug_start` 会直接告诉你哈希——',
    '那时改用 `dsh_debug_continue`，不要新开一个任务（日志会裂成两份）。',
    // 数组必须**展开**（`...`）：作为单个元素塞进去的话，`.join('\n')` 会用
    // `Array.prototype.toString()` 把它变成"A,B"，逗号就留在正文里了。
    ...(hasUserText
      ? []
      : ['', '用户这次**没有写描述**：先用一句话问清现象、期望与复现路径，不要猜。']),
  ].join('\n')
}

/**
 * 面板两个按钮的文案，同时充当用户原话的兜底。
 *
 * 用户只点按钮、没有输入文字时，投给 Agent 的消息内容就是这条文案——那是他实际表达的
 * 内容，宿主不替他转述。客户端渲染标签时从这里取值，两侧因此不会各叫一个名字。
 */
export const USER_SIGNAL_LABEL = Object.freeze({
  resolved: '问题已解决',
  reproduced: '问题复现，需要进一步修复',
})

/**
 * 用户表态之后的注入正文，走 `systemPrompt.section` 而非用户消息。
 *
 * 用户点按钮时他表达的内容只有一句（按钮文案，或他在 note 里补的话）；"接下来该
 * `dsh_debug_read` 还是 `dsh_debug_end`"由本段承担，否则就要把指令塞进那条用户消息。
 *
 * @param {{ verdict: 'resolved'|'reproduced', anytime?: boolean,
 *           hash: string, round?: number }} input
 * @returns {string}
 */
export function debugSignalGuidance(input) {
  const resolved = input.verdict === 'resolved'
  const round = Number(input.round ?? 1)
  const head = resolved
    ? [
      `## 调试模式（任务 ${input.hash} · 用户表态：问题已解决）`,
      '',
      '用户刚刚选择「问题已解决」，**这一轮就是收尾**：',
    ]
    : [
      `## 调试模式（任务 ${input.hash} · 第 ${round} 轮 · 用户表态：问题复现，需要进一步修复）`,
      '',
      '用户刚刚复现了问题并选择继续排查。**这一轮的日志完整保留着**——它就是你要的证据。',
    ]
  return [
    ...head,
    '',
    ...(resolved
      ? [
        '1) 调用 `dsh_debug_end` 声明清理清单（`summary` 必填）；',
        `2) 宿主会在账本与 git 改动文件里清掉本次任务的全部调试标记（probe/temp 整块删，fix/change 只删注释）；`,
        '3) 在回复里逐条列出「修复代码（保留）/ 调试标记（已清）」；',
        '[!] 绝不要用 `git checkout` / `git stash` 整体回滚——那会把用户要的修复一起 revert 掉。',
        // chip 上的叉跳过了"复现 → 表态"的窗口，所以这条要求必须更硬：
        // 用户可能根本没跑过，Agent 却很容易顺手写一句"已验证"。
        ...(input.anytime === true
          ? [
            '[!] 用户是随时按下的「结束调试」，可能**没有**走完整复现流程：'
              + '不要为了凑流程假装验证过——没验证就把 `verified` 填 `false`，'
              + '并在结论里如实说明你据什么判断它已经解决。',
          ]
          : []),
      ]
      : [
        '按信号序列执行：`dsh_debug_read`（先看现场）→ 分析 → 需要开下一轮时才 `dsh_debug_continue` → 埋点 → `dsh_debug_report`。',
        '[!] `dsh_debug_continue` 会**清空**日志，所以它必须排在 `dsh_debug_read` 之后——'
          + '顺序反了，用户刚刚复现出来的东西就再也看不到了。',
        '用户如果还补了话，会在上面那条用户消息里；那是**补充信息**，与信号本身同等重要。',
      ]),
    '',
    '**跑起来复现是用户的事**：你只需要埋点、改代码、发信号，不需要运行任何命令。',
  ].join('\n')
}
