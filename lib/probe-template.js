/**
 * lib/probe-template.js —— 把 assets/ 下的探针模板变成某个任务可用的桩。
 *
 * 生成是**纯字符串替换 + 锚点校验**：找不到锚点就抛错（宁可起不来，也不要
 * 一个把日志写错地方的桩——那会污染任务目录之间的边界）。
 *
 * 两个桩，同一个协议：
 *   · `probe.template.mjs` —— Node/ESM，`node:fs` 直接追加写（本地进程）；
 *   · `probe.browser.js`    —— 浏览器/经典脚本，POST 给宿主的摄入端点
 *     （页面没有文件系统，也不该为了调试去起一个本地服务器 ⇒ DESIGN.md §7.6）。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const TEMPLATE_URL = new URL('../assets/probe.template.mjs', import.meta.url)
const BROWSER_TEMPLATE_URL = new URL('../assets/probe.browser.js', import.meta.url)

/** 模板里必须存在的两个锚点（缺一即视为模板损坏）。 */
const TASK_ANCHOR = "export const TASK = '__DSH_TASK__'"
const LOG_ANCHOR = "export const LOG = '__DSH_LOG__'"

/** 浏览器模板的锚点（生成时烘死任务哈希与摄入端点）。 */
const BROWSER_TASK_ANCHOR = "var TASK = '__DSH_TASK__'"
const BROWSER_ENDPOINT_ANCHOR = "var ENDPOINT = '__DSH_ENDPOINT__'"

/** 读 Node 桩模板源码（测试与生成器共用）。 */
export async function readProbeTemplate() {
  return readFile(fileURLToPath(TEMPLATE_URL), 'utf8')
}

/** 读浏览器桩模板源码。 */
export async function readBrowserProbeTemplate() {
  return readFile(fileURLToPath(BROWSER_TEMPLATE_URL), 'utf8')
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
