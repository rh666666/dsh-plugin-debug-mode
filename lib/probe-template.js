/**
 * lib/probe-template.js —— 把 assets/ 下的探针模板变成某个任务可用的桩。
 *
 * 生成是**纯字符串替换 + 锚点校验**：找不到锚点就抛错（宁可起不来，也不要
 * 一个把日志写错地方的桩——那会污染任务目录之间的边界）。
 *
 * 三份产物，同一个协议：
 *   · `probe.template.mjs` —— Node/ESM，`node:fs` 直接追加写（**热路径与"崩溃前落盘"**用）；
 *   · `probe.browser.js`    —— 浏览器/经典脚本，POST 给宿主；
 *   · `probe.http.md`       —— **多语言代码片段**（curl/Python/Node/Ruby/Go/PHP/PowerShell/Java），
 *     端点与哈希已烘死。为什么要有这一份：写日志这件事（字段序、时间戳、截断、限额、
 *     并发追加）应该只有**一份实现**，也就是宿主里那个摄入端点；让每种语言照着文档再实现
 *     一遍协议，等于把冻结协议复制成 N 份，而它们必然漂移——DESIGN.md §7.6。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const TEMPLATE_URL = new URL('../assets/probe.template.mjs', import.meta.url)
const BROWSER_TEMPLATE_URL = new URL('../assets/probe.browser.js', import.meta.url)
const HTTP_TEMPLATE_URL = new URL('../assets/probe.http.md', import.meta.url)

/** 模板里必须存在的两个锚点（缺一即视为模板损坏）。 */
const TASK_ANCHOR = "export const TASK = '__DSH_TASK__'"
const LOG_ANCHOR = "export const LOG = '__DSH_LOG__'"

/** 浏览器模板的锚点（生成时烘死任务哈希与摄入端点）。 */
const BROWSER_TASK_ANCHOR = "var TASK = '__DSH_TASK__'"
const BROWSER_ENDPOINT_ANCHOR = "var ENDPOINT = '__DSH_ENDPOINT__'"

/** HTTP 片段模板的占位符（`{{NAME}}` 写法，与埋点指南同一套）。 */
const HTTP_PLACEHOLDERS = ['HASH', 'ENDPOINT', 'LOG_PATH', 'PROBE_STUB']

/** 读 Node 桩模板源码（测试与生成器共用）。 */
export async function readProbeTemplate() {
  return readFile(fileURLToPath(TEMPLATE_URL), 'utf8')
}

/** 读浏览器桩模板源码。 */
export async function readBrowserProbeTemplate() {
  return readFile(fileURLToPath(BROWSER_TEMPLATE_URL), 'utf8')
}

/** 读 HTTP 片段模板源码。 */
export async function readHttpProbeTemplate() {
  return readFile(fileURLToPath(HTTP_TEMPLATE_URL), 'utf8')
}

/**
 * 生成 Node 探针桩源码。
 * @param {{ template?: string, hash: string, logAbsolutePath: string }} input
 *   `logAbsolutePath` 必须是**绝对路径**：桩会被复制到项目里，相对路径没有意义。
 * @returns {Promise<string>}
 */
export async function renderProbeStub({ template, hash, logAbsolutePath }) {
  const source = template ?? (await readProbeTemplate())
  for (const anchor of [TASK_ANCHOR, LOG_ANCHOR]) {
    if (!source.includes(anchor)) {
      throw new Error(`debug-mode: probe template anchor missing -> ${anchor}`)
    }
  }
  return source
    .replace(TASK_ANCHOR, `export const TASK = ${JSON.stringify(hash)}`)
    .replace(LOG_ANCHOR, `export const LOG = ${JSON.stringify(logAbsolutePath)}`)
}

/**
 * 生成浏览器探针桩源码。
 *
 * @param {{ template?: string, hash: string, endpoint: string }} input
 *   `endpoint` 是**宿主的绝对 URL**（页面在 `file://` 下，相对路径到不了宿主）。
 * @returns {Promise<string>}
 */
export async function renderBrowserStub({ template, hash, endpoint }) {
  const source = template ?? (await readBrowserProbeTemplate())
  for (const anchor of [BROWSER_TASK_ANCHOR, BROWSER_ENDPOINT_ANCHOR]) {
    if (!source.includes(anchor)) {
      throw new Error(`debug-mode: browser probe template anchor missing -> ${anchor}`)
    }
  }
  return source
    .replace(BROWSER_TASK_ANCHOR, `var TASK = ${JSON.stringify(hash)}`)
    .replace(BROWSER_ENDPOINT_ANCHOR, `var ENDPOINT = ${JSON.stringify(endpoint)}`)
}

/**
 * 生成「HTTP 探针通道」的多语言片段文件。
 *
 * 与另外两份一样做锚点校验：任何占位符没被替换掉，都会让 Agent 照字面量去埋点，
 * 所以宁可在这里抛错。
 *
 * @param {{ template?: string, hash: string, endpoint: string, logPath: string, probeStub: string }} input
 * @returns {Promise<string>}
 */
export async function renderHttpGuide({ template, hash, endpoint, logPath, probeStub }) {
  const source = template ?? (await readHttpProbeTemplate())
  const values = { HASH: hash, ENDPOINT: endpoint, LOG_PATH: logPath, PROBE_STUB: probeStub }
  for (const name of HTTP_PLACEHOLDERS) {
    if (!source.includes(`{{${name}}}`)) {
      throw new Error(`debug-mode: http probe template placeholder missing -> {{${name}}}`)
    }
  }
  let text = source
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{{${name}}}`).join(value)
  }
  const leftover = text.match(/\{\{[A-Z_]+\}\}/)
  if (leftover) throw new Error(`debug-mode: http probe template has unresolved ${leftover[0]}`)
  return text
}
