/**
 * test/git.test.mjs —— 用 git status 取工作区改动的守卫测试。
 *
 * 这里钉住三件事：
 *   · 不在仓库里时优雅降级（不抛异常，返回 reason）；
 *   · 修改 / 新增 / 删除各自归类正确，删除文件不进清理清单；
 *   · 工作区是仓库子目录时，路径要相对**工作区**而不是仓库根。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { gitChangedFiles } from '../lib/git.js'
import { createWorkspace } from './helpers.mjs'

function hasGit() {
  return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
}

/** 用 `stdio: 'ignore'` 跑 git：受限环境里默认管道会被拒，这里只关心退出码。 */
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败（${result.error?.code ?? 'exit'}）`)
}

const SKIP = hasGit() ? false : '环境里没有 git'

test('不在 git 仓库里 ⇒ 优雅降级，不抛异常', { skip: SKIP }, async () => {
  const workspace = await createWorkspace({ 'src/app.js': 'export const a = 1\n' })
  try {
    const changes = await gitChangedFiles(workspace.root)
    assert.equal(changes.ok, false)
    assert.equal(changes.reason, 'not-repo')
    assert.deepEqual(changes.files, [])
    assert.ok(changes.error)
  } finally {
    await workspace.cleanup()
  }
})

test('修改 / 新增 / 删除分别归类；删除的文件不进清理清单', { skip: SKIP }, async () => {
  const workspace = await createWorkspace({
    'src/app.js': 'export const a = 1\n',
    'src/gone.js': 'export const gone = 1\n',
  })
  try {
    git(workspace.root, ['init', '-q'])
    git(workspace.root, ['config', 'user.email', 'test@example.com'])
    git(workspace.root, ['config', 'user.name', 'test'])
    git(workspace.root, ['add', '.'])
    git(workspace.root, ['commit', '-qm', 'init'])

    await writeFile(join(workspace.root, 'src', 'app.js'), 'export const a = 2\n', 'utf8')
    await writeFile(join(workspace.root, 'src', 'new.js'), 'export const n = 1\n', 'utf8')
    await rm(join(workspace.root, 'src', 'gone.js'))

    const changes = await gitChangedFiles(workspace.root)
    assert.equal(changes.ok, true, changes.error)
    assert.deepEqual(changes.files, ['src/app.js', 'src/new.js'])
    assert.deepEqual(changes.untracked, ['src/new.js'])
    assert.deepEqual(changes.deleted, ['src/gone.js'])
    const byPath = Object.fromEntries(changes.entries.map((entry) => [entry.path, entry.status]))
    assert.equal(byPath['src/app.js'], 'modified')
    assert.equal(byPath['src/new.js'], 'untracked')
    assert.equal(byPath['src/gone.js'], 'deleted')
  } finally {
    await workspace.cleanup()
  }
})

test('工作区是仓库子目录 ⇒ 路径相对工作区，且不包含工作区外的改动', { skip: SKIP }, async () => {
  const repo = await createWorkspace({
    'sub/src/app.js': 'export const a = 1\n',
    'outside.js': 'export const outside = 1\n',
  })
  const workspace = join(repo.root, 'sub')
  try {
    await mkdir(join(workspace, 'src'), { recursive: true })
    git(repo.root, ['init', '-q'])
    git(repo.root, ['config', 'user.email', 'test@example.com'])
    git(repo.root, ['config', 'user.name', 'test'])
    git(repo.root, ['add', '.'])
    git(repo.root, ['commit', '-qm', 'init'])

    await writeFile(join(workspace, 'src', 'app.js'), 'export const a = 2\n', 'utf8')
    await writeFile(join(repo.root, 'outside.js'), 'export const outside = 2\n', 'utf8')

    const changes = await gitChangedFiles(workspace)
    assert.equal(changes.ok, true, changes.error)
    assert.deepEqual(changes.files, ['src/app.js'], '工作区外的改动不属于这次清理范围')
    assert.equal(changes.prefix, 'sub/')
  } finally {
    await repo.cleanup()
  }
})
