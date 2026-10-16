/**
 * **增量 187：第八批 §3.1 F5（`DEF-080` 第 4 面）—— glob / 宽范围写范围不许整类豁免。**
 *
 * 病根（V15）：字面 glob 形态的写范围（`src/**`、`src/integration/**`）在旧判定里**恒不相交**
 * （`scopePathsIntersect` 只做目录前缀）⇒ **既不拦也不提示**；而真台账里 `TASK-006.yml` 的写范围
 * 就是 `src/integration/**` ⇒ 与被修掉的"单路径收窄"是同一类**整类豁免**。
 *
 * 修法（两半，都在既有唯一出口上）：
 *   · `scopePathsIntersect` **支持 glob**（`**` 跨段 / `*` `?` 段内 / 覆盖任一段边界前缀）；
 *     两边都无 glob 时**逐字节保持原判定**（零破坏）。
 *   · `dirtyScopeHolds` 按**字面前缀段数**（`globLiteralDepth`，即"锚定度"）分级：无 glob 或字面前缀
 *     ≥2 段的 glob ⇒ **拦**；更宽（`**`、`src/**`、`src/*`、`test/m*.test.ts`）⇒ **只提示不拦**
 *     （否则任何脏文件都会把这种卡钉死 —— 那正是当初收窄要避免的噪声）。
 *     **`DEF-090`（第九批 §3.3）**：真实分档键就是这个段数（不是"与单一路径信息量相当"那种说法），
 *     `M187-05` 用一张表逐档钉住它；键的两个方向偏差（偏松 `src/*.ts` / 偏紧 `src/domain/**`）
 *     写在 `src/domain/plan.ts` 的 `dirtyGradeOf` 注释里。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { DIRTY_BLOCK_LITERAL_DEPTH, dirtyGradeOf, dirtyScopeHolds } from '../src/domain/plan.js'
import { globLiteralDepth, hasGlob, scopePathWithin, scopePathsIntersect } from '../src/domain/scopePaths.js'
import { auditWriteScopes } from '../src/integration/orchestrator.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm187')
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition { name: string; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

function harness(): ToolDefinition[] {
  const list: ToolDefinition[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { list.push(tool); return () => {} } }, sessions: {} }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return list
}
const git = (args: string[]): string => execFileSync('git', args, { cwd: WORKSPACE, encoding: 'utf8' })
const card = (id: string, writeScopes: string[]): TaskCard => ({
  id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
  owner: 'dev-a', blockedBy: [], writeScopes, role: 'developer', size: 'small', revision: 1,
  status: 'planned', requirements: [], evidence: [], createdAt: '', updatedAt: '',
})
let office: SoftwareDevOffice
const drive = async (): Promise<string> => {
  const plan = harness().find((item) => item.name === 'sdo_plan')
  assert.ok(plan !== undefined)
  return String(await plan.execute({ action: 'next' }, { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'src', 'integration'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'src', 'integration', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(WORKSPACE, 'README.md'), 'x\n')
  git(['init', '-q'])
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 's-cockpit', cwd: WORKSPACE }
  office.noteSession(call.sessionId, WORKSPACE)
  office.init(call, { name: 'm187', scale: 'normal', stakeholders: ['x'] })
  const store = office.storeFor(WORKSPACE)
  // 真台账形态：`TASK-006.yml` 的写范围就是 `src/integration/**`（**卡号与写范围都与真台账一致**）；
  // ⚠️ 这里的 `TASK-007` 是**合成**对照 —— 真台账 `TASK-007.yml` 的 `writeScopes` 是 5 条**具体路径**、
  // 一个 glob 都没有（见第九批 §8 的反证），不要把这个夹具卡号当成真卡。
  store.writeYaml(['tasks', 'TASK-006.yml'], { task: card('TASK-006', ['src/integration/**']) })
  store.writeYaml(['tasks', 'TASK-007.yml'], { task: card('TASK-007', ['src/**']) })
  git(['add', '-A'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M187-01 唯一出口：glob 语义（`**` 跨段 / `*` 段内 / 覆盖段边界前缀），且无 glob 时判定逐字节不变', () => {
  // ① glob 判定
  assert.equal(scopePathsIntersect('src/integration/**', 'src/integration/a.ts'), true, '`**` 必须覆盖域内文件')
  assert.equal(scopePathsIntersect('src/integration/**', 'src/integration/sub/b.ts'), true, '`**` 必须跨多段')
  assert.equal(scopePathsIntersect('src/**', 'src/integration/a.ts'), true, '`src/**` 覆盖更深路径')
  assert.equal(scopePathsIntersect('src/*', 'src/integration/a.ts'), true, '`*` 段内任意 + 段边界前缀 ⇒ 覆盖')
  assert.equal(scopePathsIntersect('src/**', 'test/a.ts'), false, '域外不许命中')
  assert.equal(scopePathsIntersect('src/integration/**', 'src/other/a.ts'), false, '兄弟目录不许命中')
  // ② **零破坏**：两边都无 glob ⇒ 原判定（目录边界前缀）
  assert.equal(scopePathsIntersect('src/', 'src/a.ts'), true)
  assert.equal(scopePathsIntersect('src/a/', 'src/b.ts'), false)
  assert.equal(scopePathsIntersect('src/a.ts', 'src/a.ts'), true)
  assert.equal(scopePathsIntersect('src', 'src/a.ts'), true)
  // ③ 分级读数
  assert.equal(globLiteralDepth('src/integration/**'), 2, '字面前缀 2 段')
  assert.equal(globLiteralDepth('src/**'), 1)
  assert.equal(globLiteralDepth('**'), 0)
  assert.equal(dirtyGradeOf(card('T', ['src/integration/**'])), 'block', '点了子树 ⇒ 拦')
  assert.equal(dirtyGradeOf(card('T', ['src/**'])), 'hint', '超宽 ⇒ 只提示')
  assert.equal(dirtyGradeOf(card('T', ['**'])), 'hint')
  assert.equal(dirtyGradeOf(card('T', ['src/*'])), 'hint')
  assert.equal(dirtyGradeOf(card('T', ['src/', 'docs/'])), 'block', '无 glob ⇒ 仍是拦（既有口径）')
})

test('M187-02 读数：域内脏文件 ⇒ 命中并分级（真台账形态 `src/integration/**` 是**拦**档）', () => {
  const rows = dirtyScopeHolds([card('TASK-006', ['src/integration/**']), card('TASK-007', ['src/**'])], ['src/integration/a.ts'])
  assert.deepEqual(rows.map((row) => [row.task.id, row.grade]), [['TASK-006', 'block'], ['TASK-007', 'hint']], '两张卡都命中，档不同')
  assert.deepEqual(rows[0]?.over, ['src/integration/a.ts'], '点名的必须是那条脏路径')
  // 反例②：域外脏文件 ⇒ 不命中
  assert.deepEqual(dirtyScopeHolds([card('TASK-006', ['src/integration/**'])], ['README.md']), [], '域外 ⇒ 不命中')
})

test('M187-03 真注册面：`src/integration/**` 的卡被**拦**并点名；`src/**` 的卡**只提示**仍照派', async () => {
  const clean = await drive()
  assert.equal(clean.includes('本轮不派发'), false, '干净时不许有拦')
  assert.equal(clean.includes('超宽 glob'), false, '干净时不许有提示')
  writeFileSync(join(WORKSPACE, 'src', 'integration', 'a.ts'), 'export const a = 2\n')
  const dirty = await drive()
  // ① 窄 glob（`src/integration/**`）⇒ 拦 + 点名
  assert.match(dirty, /本轮不派发/u, ``+'`src/integration/**`'+` 必须被拦：${dirty.slice(0, 400)}`)
  assert.match(dirty, /TASK-006/u, '被拦的卡号必须点名')
  assert.match(dirty, /src\/integration\/a\.ts/u, '必须点名那条相交的脏路径')
  // ② 超宽 glob（`src/**`）⇒ 只提示、**不进"不派发"名单**、且照旧进本次派发
  assert.match(dirty, /超宽 glob/u, '超宽 glob 必须给提示')
  assert.match(dirty, /本次派发 1 张\*\*：TASK-007/u, `超宽 glob 的卡不许被拦（它照派）：${dirty.slice(0, 300)}`)
  assert.equal(/本轮不派发[^\n]*TASK-007/u.test(dirty), false, '`src/**` 的卡不许出现在"不派发"名单里')
  // ③ 反例：提交之后两档都消失
  git(['add', '-A']); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'wip'])
  const again = await drive()
  assert.equal(again.includes('本轮不派发'), false)
  assert.equal(again.includes('超宽 glob'), false)
})

test('M187-04 §3.1 对偶守卫（DEF-089）：两出口同判 + `done` 对账放行域内 / 点名域外 + 无 glob 回归', () => {
  const cases: [string, string][] = [
    ['src/integration/**', 'src/integration/a.ts'],   // 真台账 `TASK-006.yml` 的形态
    ['src/integration/**', 'src/integration/sub/b.ts'],
    ['src/**', 'src/x.ts'],
    ['src/', 'src/a.ts'],
    ['docs/', 'src/a.ts'],
  ]
  for (const [scope, path] of cases) {
    assert.equal(
      scopePathWithin(path, scope),
      scopePathsIntersect(scope, path),
      `两出口必须同判（同一套语义）：scope=${scope} path=${path}`,
    )
  }
  // `done` 对账：域内必须**通过**（修前这里是反向假阳性），域外必须**判越界并点名**
  assert.deepEqual(auditWriteScopes(['src/integration/a.ts'], ['src/integration/**']), { ok: true, violations: [] }, '含 glob 的卡改域内文件必须通过')
  const outside = auditWriteScopes(['src/other/b.ts'], ['src/integration/**'])
  assert.equal(outside.ok, false, '域外必须判越界')
  assert.deepEqual(outside.violations, ['src/other/b.ts'], '越界必须点名那条路径')
  // 无 glob 的既有读数逐字节不变
  assert.deepEqual(auditWriteScopes(['src/a.ts'], ['src/']), { ok: true, violations: [] })
  assert.deepEqual(auditWriteScopes(['docs/a.md'], ['src/']), { ok: false, violations: ['docs/a.md'] })
})

test('M187-05 §3.3 表驱动守卫（DEF-090）：同一脏文件在各档下的期望行为，且每条理由都点名真实分档键', () => {
  const DIRTY = 'src/integration/a.ts'
  // **判据表**（与报告 §8 的 `DEF-090` 表同源）。列：写范围 / 各写范围是否含 glob / 各写范围实测的
  // **字面前缀段数** / 期望档 / 与同一条脏路径是否命中 / 理由（**每条都必须点名真实分档键「字面前缀段数」**）。
  const rows: { scopes: string[]; globs: boolean[]; depths: number[]; grade: 'block' | 'hint'; hit: boolean; reason: string }[] = [
    { scopes: ['src/integration/a.ts'], globs: [false], depths: [3], grade: 'block', hit: true,
      reason: '无 glob（键不适用；字面前缀段数 = 3 仅作记录）⇒ 既有口径一律拦' },
    { scopes: ['src/integration/'], globs: [false], depths: [2], grade: 'block', hit: true,
      reason: '无 glob 的目录前缀 ⇒ 拦（字面前缀段数 = 2）' },
    { scopes: ['src/integration/**'], globs: [true], depths: [2], grade: 'block', hit: true,
      reason: '真台账 `TASK-006.yml` 形态：字面前缀段数 = 2 ≥ 2 ⇒ 拦' },
    { scopes: ['src/integration/*.ts'], globs: [true], depths: [2], grade: 'block', hit: true,
      reason: '段内通配仍锚在 2 段前缀上 ⇒ 字面前缀段数 = 2 ⇒ 拦' },
    { scopes: ['src/data/processes/*.yml'], globs: [true], depths: [3], grade: 'block', hit: false,
      reason: '真台账 `TASK-013.yml`/`TASK-048.yml` 形态：字面前缀段数 = 3 ⇒ 拦（与本条脏路径不相交 ⇒ 不命中）' },
    { scopes: ['src/**'], globs: [true], depths: [1], grade: 'hint', hit: true,
      reason: '字面前缀段数 = 1 < 2 ⇒ 提示（**偏松侧**：它的匹配集其实最大）' },
    { scopes: ['src/*'], globs: [true], depths: [1], grade: 'hint', hit: true,
      reason: '字面前缀段数 = 1 ⇒ 提示（`src/*` 经段边界前缀仍覆盖整棵 `src/`）' },
    { scopes: ['**'], globs: [true], depths: [0], grade: 'hint', hit: true,
      reason: '字面前缀段数 = 0（全匹配）⇒ 提示' },
    { scopes: ['*'], globs: [true], depths: [0], grade: 'hint', hit: true,
      reason: '字面前缀段数 = 0 ⇒ 提示' },
    { scopes: ['test/m*.test.ts'], globs: [true], depths: [1], grade: 'hint', hit: false,
      reason: '字面前缀段数 = 1 ⇒ 提示（与本条脏路径不相交 ⇒ 不命中）' },
    { scopes: ['src/dom?in/**'], globs: [true], depths: [1], grade: 'hint', hit: false,
      reason: '`?` 与 `*` 同档（元字符一视同仁）⇒ 字面前缀段数 = 1 ⇒ 提示' },
    { scopes: ['src/[ab]/**'], globs: [true], depths: [1], grade: 'hint', hit: false,
      reason: '`[` 与 `*` 同档 ⇒ 字面前缀段数 = 1 ⇒ 提示' },
    { scopes: ['src/domain/**'], globs: [true], depths: [2], grade: 'block', hit: false,
      reason: '**偏紧侧**已知代价：字面前缀段数 = 2 ⇒ 拦（子树可以很大）；与本条脏路径不相交 ⇒ 不命中' },
    { scopes: ['src/office.ts', '**'], globs: [false, true], depths: [2, 0], grade: 'hint', hit: true,
      reason: '多写范围取"任一宽度"（`some`）⇒ 有一条宽 glob（字面前缀段数 = 0）整卡就降为提示' },
    { scopes: ['src/office.ts'], globs: [false], depths: [2], grade: 'block', hit: false,
      reason: '反例：单文件写范围本可拦（字面前缀段数 = 2），但与这条脏路径不相交 ⇒ 不命中' },
  ]
  assert.equal(DIRTY_BLOCK_LITERAL_DEPTH, 2, '阈值是判据表的一部分：改阈值必须同时改这张表')
  for (const row of rows) {
    const label = row.scopes.join(' + ')
    assert.equal(row.scopes.length, row.depths.length, `表自身必须逐条对齐：${label}`)
    assert.equal(row.scopes.length, row.globs.length, `表自身必须逐条对齐：${label}`)
    row.scopes.forEach((scope, index) => {
      assert.equal(hasGlob(scope), row.globs[index], `表里的「有/无 glob」与实现不符：${scope}`)
      assert.equal(globLiteralDepth(scope), row.depths[index], `表里的字面前缀段数与实现不符：${scope}`)
    })
    assert.ok(row.reason.includes('字面前缀段数'), `每条理由都必须点名真实分档键：${label} ⇒ ${row.reason}`)
    assert.equal(dirtyGradeOf(card('T', row.scopes)), row.grade, `档不符：${label}`)
    const holds = dirtyScopeHolds([card('T', row.scopes)], [DIRTY])
    assert.equal(holds.length, row.hit ? 1 : 0, `命中与否不符：${label}`)
    if (row.hit) {
      assert.equal(holds[0]?.grade, row.grade, `命中行的档不符：${label}`)
      assert.deepEqual(holds[0]?.over, [DIRTY], `点名的必须是那条脏路径：${label}`)
    }
  }
})

test('M187-06 §3.1 豁免面逐条钉住：两个 glob 的保守相交 + `[` 当字面量（改它 ⇒ 这一格必须红）', () => {
  // ① 两边都是 glob：只按**字面前缀**保守判定 —— 前缀不相交 ⇒ 不相交
  assert.equal(scopePathsIntersect('src/**', 'test/a/**'), false, '两个 glob、字面前缀不相交 ⇒ 不相交（保守判定）')
  assert.equal(scopePathsIntersect('src/a/**', 'src/**'), true, '前缀互为上下级 ⇒ 相交')
  // ② `[` 字符类：`hasGlob` 认它，但 `globCovers` **有意**把它当字面量（本仓零使用）
  assert.equal(scopePathWithin('src/a/x.ts', 'src/[ab]/x.ts'), false, '`[ab]` 有意当字面量（不是字符类）')
})
