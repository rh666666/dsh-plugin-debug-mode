/**
 * lib/probe-template.js —— 把 assets/probe.template.mjs 变成某个任务的探针桩。
 *
 * 生成是**纯字符串替换 + 锚点校验**：找不到锚点就抛错（宁可起不来，也不要
 * 一个把日志写错地方的桩——那会污染任务目录之间的边界）。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const TEMPLATE_URL = new URL('../assets/probe.template.mjs', import.meta.url)

/** 模板里必须存在的两个锚点（缺一即视为模板损坏）。 */
const TASK_ANCHOR = "export const TASK = '__DSH_TASK__'"
const LOG_ANCHOR = "export const LOG = '__DSH_LOG__'"

/** 读模板源码（测试与生成器共用）。 */
export async function readProbeTemplate() {
  return readFile(fileURLToPath(TEMPLATE_URL), 'utf8')
}

/**
 * 生成探针桩源码。
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
