/**
 * **增量 186：第七批 §3.2（`DEF-084`）—— 非 ASCII 路径必须命中（语言无关）。**
 *
 * 病根：`git status --porcelain` 的默认出参受 `core.quotePath=true` 影响，把非 ASCII 文件名
 * **八进制转义**（`文档/说明.md` ⇒ `"\\346\\226\\207…"`），而旧解析只剥外层引号、不做反转义
 * ⇒ 转义串与写范围里的真名**永不相等**，命中恒为 0。
 * 修法：`-z`（git 直接给**原始字节**，以 `\0` 分隔），**不自己写反转义**。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { classifyNonDispatchable } from '../src/domain/plan.js'
import { readDirtyWorktree } from '../src/infra/git.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm186')
const WORKSPACE = join(BASE, 'proj')
const git = (args: string[]): string => execFileSync('git', args, { cwd: WORKSPACE, encoding: 'utf8' })
const commit = (): void => {
  git(['add', '-A'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'])
}
const card = (id: string, writeScopes: string[]): TaskCard => ({
  id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
  owner: 'dev-a', blockedBy: [], writeScopes, role: 'developer', size: 'small', revision: 1,
  status: 'planned', requirements: [], evidence: [], createdAt: '', updatedAt: '',
})

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, '文档'), { recursive: true })
  mkdirSync(join(WORKSPACE, 'my docs'), { recursive: true })
  writeFileSync(join(WORKSPACE, '文档', '说明.md'), '一\n')
  writeFileSync(join(WORKSPACE, 'my docs', 'a b.md'), '二\n')
  writeFileSync(join(WORKSPACE, 'a"b.md'), '三\n')
  writeFileSync(join(WORKSPACE, 'a\\b.md'), '四\n')
  writeFileSync(join(WORKSPACE, 'plain.txt'), '五\n')
  git(['init', '-q'])
  commit()
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M186-01 正例：**中文名**脏文件必须命中（修前是八进制转义串 ⇒ 永不相等）', () => {
  assert.deepEqual(readDirtyWorktree(WORKSPACE).tracked, [], '前置：干净树')
  writeFileSync(join(WORKSPACE, '文档', '说明.md'), '改\n')
  const read = readDirtyWorktree(WORKSPACE)
  assert.deepEqual(read.tracked, ['文档/说明.md'], `必须给**原始**中文路径（不是 \\346… 转义串）：${JSON.stringify(read.tracked)}`)
  const rows = classifyNonDispatchable([card('TASK-001', ['文档/'])], undefined, read.tracked).dirty
  assert.deepEqual(rows?.map((row) => row.task.id), ['TASK-001'], '中文路径的卡必须命中')
  assert.deepEqual(rows?.[0]?.over, ['文档/说明.md'], '回执必须点名那条中文路径')
})

test('M186-02 对称反例：英文名照旧命中；中文卡与英文脏文件**不相交**时不许命中', () => {
  writeFileSync(join(WORKSPACE, 'plain.txt'), '改\n')
  assert.deepEqual(readDirtyWorktree(WORKSPACE).tracked, ['plain.txt'], '英文名读数照旧')
  assert.deepEqual(
    classifyNonDispatchable([card('TASK-002', ['plain.txt'])], undefined, ['plain.txt']).dirty?.map((row) => row.task.id),
    ['TASK-002'],
    '英文名卡照旧命中（回归）',
  )
  assert.equal(
    classifyNonDispatchable([card('TASK-003', ['文档/'])], undefined, ['plain.txt']).dirty,
    undefined,
    '不相交 ⇒ 不命中（不是恒红）',
  )
})

test('M186-03 特殊字符：空格 / 双引号 / 反斜杠的名字都不许崩、不许误判', () => {
  writeFileSync(join(WORKSPACE, 'my docs', 'a b.md'), '改\n')
  writeFileSync(join(WORKSPACE, 'a"b.md'), '改\n')
  writeFileSync(join(WORKSPACE, 'a\\b.md'), '改\n')
  const read = readDirtyWorktree(WORKSPACE)
  assert.deepEqual(
    [...read.tracked].sort(),
    ['a"b.md', 'a\\b.md', 'my docs/a b.md'].sort(),
    `三种特殊名字都必须原样给出：${JSON.stringify(read.tracked)}`,
  )
  for (const [scope, name] of [['my docs/', 'my docs/a b.md'], ['a"b.md', 'a"b.md']] as const) {
    const rows = classifyNonDispatchable([card('TASK-004', [scope])], undefined, read.tracked).dirty
    assert.deepEqual(rows?.[0]?.over, [name], `${name} 必须被点名`)
  }
  // ⚠️ **反斜杠是个刻意的例外**（如实记）：**读取层**给的是原名（上面那条断言已经钉住），
  // 但**判定层**走的是唯一出口 `scopePaths.normalizeScopePath`，它把 `\` 归一成 `/`（Windows 分隔符口径，
  // 既有语义，不是本批引入）⇒ 回执里点名的是归一后的 `a/b.md`。零破坏：判定层不另写一份路径代数。
  assert.deepEqual(
    classifyNonDispatchable([card('TASK-004', ['a/b.md'])], undefined, read.tracked).dirty?.[0]?.over,
    ['a/b.md'],
    '归一后的形态照样命中（判定层与读取层分工明确）',
  )
})

test('M186-04 改名条目：`-z` 会多一段（新路径 + 旧路径）⇒ 只算**新**路径、不许把旧名字混进来', () => {
  git(['mv', 'plain.txt', 'renamed.txt'])
  const read = readDirtyWorktree(WORKSPACE)
  assert.equal(read.tracked.includes('renamed.txt'), true, `改名后的新路径必须在：${JSON.stringify(read.tracked)}`)
  assert.equal(read.tracked.includes('plain.txt'), false, `旧路径不许混进来：${JSON.stringify(read.tracked)}`)
  assert.deepEqual(read.tracked, ['renamed.txt'], '改名只算一条')
})

test('M186-05 结构：用 `-z` 让 git 给原文，且**没有**自己写八进制反转义（第二份路径实现）', () => {
  const source = readFileSync(join(ROOT, 'src', 'infra', 'git.ts'), 'utf8')
  assert.match(source, /'-z'/u, '必须用 `-z` 出参')
  assert.equal(/-c',\s*'core\.quotePath/u.test(source), false, '不许用"改配置开关"去绕（那要再跑一次 git 且依赖配置）')
  assert.equal(/parseInt\([^)]*,\s*8\s*\)/u.test(source), false, '不许自己写八进制反转义')
  assert.equal(/\\\\\[0-7\]\{3\}/u.test(source), false, '不许自己写八进制反转义（正则形态）')
})
