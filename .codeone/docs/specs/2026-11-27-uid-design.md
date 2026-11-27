# 块级 UID 消除配对歧义

## 背景

`lib/scan.js` 的 `pairBlocks()` 目前用栈式配对，靠 kind / hash / 缩进 / “块内无其他标记”这套启发式判定成交。缩进不一致、嵌套、缺边、标记与代码同行都会进 `unresolved`，进而进隔离区打断收尾。本次给块标记加块级 uid，把配对从启发式改为精确匹配，消除结构性歧义。

## 目标与非目标

**目标**：消除“配对歧义”这一类 `unresolved`——带 uid 的块靠 uid 精确配对。

**非目标（保持不变）**：

- 残缺类问题仍进 `unresolved`，不静默清理：缺 start 或 end、标记与代码同行、start/end 的 uid 写错或重复。
- 兼容旧标记：无 uid 的块回退现有栈式配对，两套逻辑互不干扰。
- 不改工具契约、产物模板、`CHANGELOG.md`、`package.json`（项目约束）。

**范围**：`lib/scan.js`、`assets/AGENT-PROBE-GUIDE.md`、`test/scan.test.mjs`、`test/helpers.mjs`。

## 标记格式

在现有结构上扩展，任务 hash 与块 uid 各司其职：

```
// dsh-debug:probe deadbeef uid=b1 start
// ... 探针代码 ...
// dsh-debug:probe deadbeef uid=b1 end
```

- `deadbeef` 是任务 hash，用于归属判定与已知哈希表，语义不变。
- `b1` 是块 uid，仅用于配对。
- uid 由 Agent 手写，格式为 `b` 加正整数。
- 指南口径：**必须写** uid，漏写会回退旧栈式配对但不推荐，指南里明说这一点。

## 正则与解析

`lib/scan.js` 的 `MARKER_RE`（当前第 19 行）在 hash 捕获之后追加可选 uid 捕获组：

```js
// 现有：kind + hash
/dsh[\s\-_]*debug\s*[:\-]\s*([A-Za-z]+)?[\s_:\-]*([0-9a-fA-F]{8})?/i
// 扩展：末尾追加 uid 捕获组 3
/dsh[\s\-_]*debug\s*[:\-]\s*([A-Za-z]+)?[\s_:\-]*([0-9a-fA-F]{8})?(?:[\s_:\-]*uid\s*[=:\-]\s*([Bb][0-9]+))?/i
```

- `findMarkers()` 把捕获组 3 归一化为小写、去前导零后写入 `marker.uid`；无 uid 为 `null`。
- 写错格式的 uid（如 `uid=xyz`）不被识别为 uid，该标记按无 uid 处理并保留原文，不静默改写。

## 配对规则

`pairBlocks()` 按“标记是否带 uid”分两条互不干扰的路：

1. **带 uid 的块**：按 uid 分组。同 uid 恰好一个 start 加一个 end、且 kind/hash 一致才成交；同 uid 重复 start、重复 end、缺边、kind/hash 不一致都进 `unresolved`。不再要求缩进一致，也不再检查“块内有无其他标记”——不同 uid 的嵌套块合法。
2. **无 uid 的块**：走原栈式配对，旧行为不变。

补充约束：

- 带 uid 与无 uid 的标记混在同一文件时，两条路各自处理，不互相卷入。
- 摘除安全检查保留：块起始行前缀有代码时进 `unresolved`（那是摘除会删掉用户代码的问题，不是配对歧义）。
- 同一文件的嵌套块都属本任务时，按行去重摘除，报告不重复删除。
- 唯一性作用域为 **(任务 hash, uid) 组合**：同一任务内同 uid 重复才进 `unresolved`，不同任务的同 uid 天然隔离。

## 指南文案

`assets/AGENT-PROBE-GUIDE.md` 在块标记说明处补 uid 写法，给出 `b1`/`b2` 示例，说明同一任务内编号唯一、写错格式按无 uid 处理。口径为必须写 uid，漏写回退但不推荐。

## 测试清单

`test/scan.test.mjs`：

- 新增带 uid 的配对成功用例：嵌套、缩进不一致、同文件多块交错。
- 新增 uid 重复、缺边、格式错误进 `unresolved` 的用例。
- 现有旧格式用例全部保留，证明兼容未破坏。

`test/helpers.mjs`：`probeBlock()` 增加可选 uid 参数。

## 验收标准

- `node --test test/*.test.mjs` 全部通过。
- 带 uid 的结构性歧义场景（嵌套、缩进不一致、多块交错）配对成功，不再进 `unresolved`。
- 残缺类场景（缺边、同行、uid 重复/写错）仍进 `unresolved`。
- 旧格式标记的配对与摘除行为与改动前一致。
