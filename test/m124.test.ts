/**
 * **增量 124：写范围模型的单一判定出口（DEF-057 / DEF-074，2026-10-14 机制缺陷批）**。
 *
 * 交接文档 §3A 的第一组：「先修这组，它堵着其余全部」。两条缺陷同源 —— 相交判定此前**散在四处**
 * 各自实现，口径还不一致：
 *
 * | 调用点 | 旧实现 | 症状 |
 * |---|---|---|
 * | `collab.ts`（认领期互斥） | 双向 `startsWith` | `src/a.ts` × `src/a.tsx` 判互斥（**文件名前缀假阳性**） |
 * | `plan.ts`（计划期重叠，两处） | 双向 `startsWith` | 同上 ⇒ 评审卡被无谓判"可能并行但重叠" |
 * | `orchestrator.ts`（`done` 对账） | 单向 `file.startsWith(scope)` | 改动 `src/a.tsx` 对范围 `src/a.ts` 判**在范围内**（**假放行**，比误拒危险） |
 * | `writeScope.ts`（守卫） | 归一时**前缀剥离** | 工作区外 `/tmp/x` 被剥成幽灵相对路径 `tmp/x`（DEF-074：方向对、**点名错**） |
 *
 * **先钉红**（修前现盘读数，`node` 直跑）：
 *   · `auditWriteScopes(['src/a.tsx'], ['src/a.ts'])` ⇒ `{"ok":true,"violations":[]}` ✗（应拒）
 *   · `validatePlan([T1:[src/a.ts], T2:[src/a.tsx]])` ⇒ 1 条 `write-scope-disjoint` ✗（应 0 条）
 *   · 守卫写 `src/a.tsx`、卡范围 `[src/a.ts]` ⇒ `allow` ✗（应 deny）
 *   · 守卫写 `/tmp/probe-x.txt` ⇒ deny 但 `detail` 是 `tmp/probe-x.txt` ✗（应点名原始绝对路径）
 *
 * **修后**：上面四条逐条翻转，且**不得放宽**的那两条仍是原口径 ——
 *   · `src/domain/` × `src/domain/plan.ts` **仍相交**（目录范围覆盖其下，DEF-057 现算事实 ③）；
 *   · 设备节点 `/dev/null` 仍**放行**（TASK-090 的口径，m102 已覆盖）。
 *
 * 口径（ADR-009）：归一后 —— **同一路径**，或**目录边界前缀**相交，其余一律不相交。
 * 语言无关（REQ-060）：**不靠扩展名**判断谁是目录（所以"无扩展名文件"会与其同名目录相交，方向取保守）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { auditWriteScopes } from '../src/integration/orchestrator.js'
import { evaluateWriteScope } from '../src/domain/writeScope.js'
import { validatePlan } from '../src/domain/plan.js'
import { normalizeScopePath, scopePathWithin, scopePathsIntersect } from '../src/domain/scopePaths.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m124/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, writeScopes: string[], overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes,
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.init(call, { name: '写范围模型', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { 术语: '释义' } })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M124-01 相交判定：同一路径 / 目录边界前缀相交，其余不相交（文件名前缀不算）', () => {
  // **修的那条（DEF-057 甲）**：互为前缀的两个**不同文件**不相交
  assert.equal(scopePathsIntersect('src/a.ts', 'src/a.tsx'), false, 'src/a.ts × src/a.tsx 是文件名前缀假阳性')
  assert.equal(scopePathsIntersect('src/a.tsx', 'src/a.ts'), false, '对称方向同样不相交')
  // **不得放宽的那条（DEF-057 乙）**：目录范围覆盖其下
  assert.equal(scopePathsIntersect('src/domain/', 'src/domain/plan.ts'), true, '目录范围必须覆盖其下文件')
  assert.equal(scopePathsIntersect('src/domain', 'src/domain/plan.ts'), true, '目录写法不带尾斜杠也必须覆盖')
  assert.equal(scopePathsIntersect('src/domain/a/', 'src/domain/'), true, '目录 × 其父目录（边界前缀）')
  // 同目录各写各文件：本来就**不相交**（别把这句笼统化的错误说法写进实现）
  assert.equal(scopePathsIntersect('src/a.ts', 'src/b.ts'), false)
  // 归一：`./`、`//`、`..`、尾斜杠、反斜杠
  assert.equal(scopePathsIntersect('./src/a.ts', 'src/a.ts'), true)
  assert.equal(scopePathsIntersect('src//a.ts', 'src/a.ts'), true)
  assert.equal(scopePathsIntersect('src/x/../a.ts', 'src/a.ts'), true)
  assert.equal(scopePathsIntersect('src\\a.ts', 'src/a.ts'), true)
  assert.equal(normalizeScopePath('src/domain/'), 'src/domain', '归一后不带尾斜杠（目录语义靠边界表达）')
  // 落座判定与相交判定是**同一套语义**
  assert.equal(scopePathWithin('src/domain/plan.ts', 'src/domain/'), true)
  assert.equal(scopePathWithin('src/a.tsx', 'src/a.ts'), false, '文件名前缀不得算"在范围内"（假放行）')
})

test('M124-02 done 对账：改动 src/a.tsx 对卡范围 [src/a.ts] 必须判越界（旧实现假放行）', () => {
  const bad = auditWriteScopes(['src/a.tsx'], ['src/a.ts'])
  assert.equal(bad.ok, false, '文件名前缀命中是**假放行**：真越界被静默放过')
  assert.deepEqual(bad.violations, ['src/a.tsx'])
  const good = auditWriteScopes(['src/a.ts'], ['src/a.ts'])
  assert.equal(good.ok, true)
  const inDir = auditWriteScopes(['src/domain/plan.ts'], ['src/domain/'])
  assert.equal(inDir.ok, true, '目录范围内的文件照旧通过')
})

test('M124-03 计划期：互为前缀的两个文件不再报"可能重叠"，目录 × 其下仍报', () => {
  const falsePositive = validatePlan([card('TASK-901', ['src/a.ts']), card('TASK-902', ['src/a.tsx'])]).filter(
    (issue) => issue.code === 'write-scope-disjoint',
  )
  assert.deepEqual(falsePositive, [], '文件名前缀不得判成"可能并行但写范围重叠"')

  const real = validatePlan([card('TASK-903', ['src/domain/']), card('TASK-904', ['src/domain/plan.ts'])]).filter(
    (issue) => issue.code === 'write-scope-disjoint',
  )
  assert.equal(real.length, 1, '目录范围与其下文件**必须**仍报重叠（这是真冲突）')
})

test('M124-04 认领期：认领拒签回执点名**重叠的那个路径**，且不误伤互不冲突的卡', async () => {
  const store = office.storeFor(WORKSPACE)
  const holder = card('TASK-911', ['src/a.ts'])
  store.writeYaml(['tasks', 'TASK-911.yml'], { task: holder })
  const claimed = office.claimTask(call, { taskId: 'TASK-911', owner: 'subagent:developer:1', expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：先让一张卡在飞（${JSON.stringify(claimed).slice(0, 120)}）`)

  // ① 不同文件（互为前缀）⇒ 不冲突，可认领
  const sibling = card('TASK-912', ['src/a.tsx'])
  store.writeYaml(['tasks', 'TASK-912.yml'], { task: sibling })
  const okClaim = office.claimTask(call, { taskId: 'TASK-912', owner: 'subagent:developer:2', expectedRevision: 1 })
  assert.equal(okClaim.ok, true, 'src/a.ts × src/a.tsx 不是冲突，必须放行认领')

  // ② 同一路径 ⇒ 拒，且**点名重叠路径**（不是倒出对方全量写范围）
  const same = card('TASK-913', ['src/a.ts', 'src/other/'])
  store.writeYaml(['tasks', 'TASK-913.yml'], { task: same })
  const denied = office.claimTask(call, { taskId: 'TASK-913', owner: 'subagent:developer:3', expectedRevision: 1 })
  assert.equal(denied.ok, false)
  if (denied.ok) assert.fail('同名路径必须拒绝')
  assert.equal(denied.code, 'write-scope-conflict')
  assert.match(denied.detail, /src\/a\.ts/u, '回执必须点名重叠的那个路径')
  assert.equal(denied.detail.includes('src/other/'), false, '不得把对方**全量**写范围倒出来（读者还得自己算）')
  assert.match(denied.detail, /TASK-911/u, '必须点名挡住你的是哪张卡')
})

test('M124-05 守卫：写超出声明文件范围的路径必须拒（旧实现按前缀放行）', () => {
  const decision = evaluateWriteScope({
    role: 'dispatched',
    tool: 'edit',
    paths: ['src/a.tsx'],
    workspace: '/ws',
    workspaceRoot: '/ws',
    guardedTools: ['edit', 'write'],
    sharedPaths: ['.sdo/', 'docs/', 'test/'],
    cardScopes: ['src/a.ts'],
  })
  assert.equal(decision.kind, 'deny', 'src/a.tsx 不在卡范围 src/a.ts 内')
  const allowed = evaluateWriteScope({
    role: 'dispatched',
    tool: 'edit',
    paths: ['src/a.ts'],
    workspace: '/ws',
    workspaceRoot: '/ws',
    guardedTools: ['edit', 'write'],
    sharedPaths: ['.sdo/', 'docs/', 'test/'],
    cardScopes: ['src/a.ts'],
  })
  assert.equal(allowed.kind, 'allow')
})

test('M124-06 DEF-074：工作区外的绝对路径必须**点名原始路径**，且设备节点仍放行', () => {
  const outside = evaluateWriteScope({
    role: 'dispatched',
    tool: 'edit',
    paths: ['/tmp/probe-abs-124.txt'],
    workspace: '/ws',
    workspaceRoot: '/ws',
    guardedTools: ['edit'],
    sharedPaths: ['.sdo/'],
    cardScopes: ['src/a.ts'],
  })
  assert.equal(outside.kind, 'deny')
  if (outside.kind !== 'deny') assert.fail('工作区外写入必须拒绝')
  assert.equal(outside.code, 'write-scope-outside-workspace')
  assert.deepEqual(outside.violations, ['/tmp/probe-abs-124.txt'], '点名必须是**原始绝对路径**')
  assert.equal(outside.detail.includes('tmp/probe-abs-124.txt'), true)
  assert.equal(/^tmp\//u.test(outside.detail), false, '不得剥成工作区里并不存在的幽灵相对路径')

  // 设备节点不是工作区文件 ⇒ 不参与判定（TASK-090 的既有口径，不得回退）
  const device = evaluateWriteScope({
    role: 'dispatched',
    tool: 'edit',
    paths: ['/dev/null'],
    workspace: '/ws',
    workspaceRoot: '/ws',
    guardedTools: ['edit'],
    sharedPaths: ['.sdo/'],
    cardScopes: ['src/a.ts'],
  })
  assert.equal(device.kind, 'allow', '/dev/null 不是工作区文件，判不了就不判')
})

test('M124-07 防再生：四处调用点必须走**唯一出口**，不得再各写一份前缀匹配', () => {
  const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')
  // ① 认领期与计划期：不得再出现"双向 startsWith"这种各写一份的判定
  for (const file of ['src/domain/collab.ts', 'src/domain/plan.ts']) {
    const text = read(file)
    assert.equal(
      /startsWith\(textOf\(/.test(text),
      false,
      `${file} 仍在用双向前缀匹配判定写范围相交 —— 必须走 scopePaths.scopeOverlaps`,
    )
  }
  // ② done 对账：必须走同一出口
  assert.match(read('src/integration/orchestrator.ts'), /scopePathWithin\(file, scope\)/u, 'done 对账必须走唯一出口')
  // ③ 出口只有一处实现（正反两个方向都断）
  const outlet = read('src/domain/scopePaths.ts')
  assert.match(outlet, /export function scopePathsIntersect/u)
  assert.match(outlet, /export function scopePathWithin/u)
})
