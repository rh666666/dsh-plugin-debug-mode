/**
 * scripts/build-client.mjs —— 把插件自己的客户端源码包成 DSH Module Loader 产物。
 *
 * 为什么需要这一步：宿主对客户端半**不做任何编译**，它把每个 `client.js` 的字节
 * 原样拼接下发。所以 `lib/client.js` 必须已经是一个
 * `window.__ModuleLoader__.load({ id, factory })` 注册脚本，`import`/`export` 直接
 * 上线必死。详。
 *
 * 为什么不用 esbuild/rollup：客户端半只有一两个文件，而引入打包器会带来
 * node_modules、锁文件与版本漂移——本项目的工程纪律是零运行时依赖。
 * 这个脚本只做四件确定性的事：校验导入白名单 → 改写 import/export → 套外壳 → 写文件。
 *
 * 用法：node scripts/build-client.mjs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'client.js')
const OUT = join(ROOT, 'lib', 'client.js')

/** 工厂 id 必须逐字等于包名（宿主按包名登记，）。 */
const PACKAGE_NAME = 'dsh-plugin-debug-mode'

/**
 * 平台种子表（`PLATFORM_MODULES`，实测清单）。factory 只能 require 这些名字；
 * 写成数组而不是对象，是因为我们只关心「允不允许」，不关心它指哪个实现。
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** 源码里禁止出现的模块系统用法——出现即视为误用宿主 API，直接构建失败。 */
const FORBIDDEN = [
  { pattern: /\brequire\s*\(/, why: '客户端源码不要自己调 require，请用 import（构建脚本会改写）' },
  { pattern: /__ModuleLoader__/, why: '外壳由构建脚本生成，源码里不要再写一遍' },
  { pattern: /\bexports\./, why: '源码用 export 语法，不要手写 exports.*' },
  { pattern: /^\s*import\s*\(/m, why: '不支持动态 import' },
]

function fail(message) {
  console.error(`[build-client] ${message}`)
  process.exit(1)
}

/** import → require，并校验模块在白名单内。 */
function rewriteImports(source) {
  const importRe = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm
  const names = new Set()
  const out = source.replace(importRe, (_match, clause, specifier) => {
    if (!PLATFORM_MODULES.includes(specifier)) {
      fail(
        `不允许的导入 '${specifier}'。factory 只能 require 平台种子表里的模块：\n  `
        + PLATFORM_MODULES.join('\n  '),
)
    }
    names.add(specifier)
    return `const ${clause.trim()} = require(${JSON.stringify(specifier)});`
  })
  // 裸副作用导入（import 'x'）单独处理：本插件不需要，遇到就说明写错了。
  if (/^[ \t]*import\s+['"]/m.test(out)) {
    fail('不支持裸副作用导入（import \'x\'）；客户端半不需要它')
  }
  return { out, names: [...names] }
}

/** export → 局部声明，导出面在末尾统一登记为 exports.apply / exports.inject。 */
function rewriteExports(source) {
  let sawInject = false
  let sawApply = false
  const out = source.replace(/^[ \t]*export\s+const\s+inject\s*=/gm, () => {
    sawInject = true
    return 'const inject ='
  }).replace(/^[ \t]*export\s+function\s+apply\s*\(/gm, () => {
    sawApply = true
    return 'function apply('
  })
  if (!sawInject) fail('客户端源码必须声明 `export const inject = [...]`')
  if (!sawApply) fail('客户端源码必须声明 `export function apply(ctx) { ... }`')
  if (/^[ \t]*export\s/m.test(out)) {
    fail('客户端源码只允许 `export const inject` 与 `export function apply` 两种导出')
  }
  return out
}

const source = await readFile(SRC, 'utf8')

for (const { pattern, why } of FORBIDDEN) {
  if (pattern.test(source)) fail(why)
}
if (source.includes('__DSH_')) fail('源码里残留了未替换的模板占位符')

const { out: withRequires, names } = rewriteImports(source)
const body = rewriteExports(withRequires)

/** 缩进正文，让产物可读、可 diff。 */
const indented = body
  .split('\n')
  .map((line) => (line.trim() ? `\t\t${line}` : line))
  .join('\n')

const banner = [
  '// 本文件由 scripts/build-client.mjs 生成，请勿手改。',
  `// 源码：src/client.js · 平台模块：${names.join(', ') || '（无）'}`,
  '// 生成时间不写入产物（保证同输入同字节，便于 diff 审阅）。',
  '',
].join('\n')

const bundle = `${banner}window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

${indented}

\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t},
});
`

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, bundle, 'utf8')
console.log(`[build-client] 已生成 ${OUT}（${bundle.length} 字节，${names.length} 个平台模块）`)
