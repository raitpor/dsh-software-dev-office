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
import { join, resolve } from 'node:path'
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
  // 产品报的是 `resolve()` 后的绝对路径；win32 上 `/tmp/x` 会落成 `D:/tmp/x`（DEF-155）
  assert.deepEqual(outside.violations, [resolve('/tmp/probe-abs-124.txt').replace(/\\/gu, '/')], '点名必须是**原始绝对路径**')
  assert.equal(outside.detail.includes(resolve('/tmp/probe-abs-124.txt').replace(/\\/gu, '').replace(/^[A-Za-z]:/u, '').slice(1)), true)
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

const WIN32_SKIP_POSIX_FIXTURE = process.platform === 'win32'
  ? { skip: '本格夹具把 `/ws` 当**POSIX 绝对根**（`workspace: /ws`）；win32 上它解析成当前盘符下的 `\\ws`，属另一种夹具语义（产品行为已由 M212 的 win32 形态覆盖，DEF-154/155）' }
  : {}

test('M124-09 §3.8（`S2`）真机形态：宿主给的 `paths` 是**绝对路径**（工作区内）—— 归一后仍按卡范围判', WIN32_SKIP_POSIX_FIXTURE, () => {
  // 真机实录形态：`write`/`edit` 的 `file_path` 是 `/ws/src/a.ts` 这种**工作区内绝对路径**。
  const scopeOf = (paths: string[]) => evaluateWriteScope({
    role: 'dispatched',
    tool: 'edit',
    paths,
    workspace: '/ws',
    workspaceRoot: '/ws',
    guardedTools: ['edit', 'write'],
    sharedPaths: ['.sdo/', 'docs/', 'test/'],
    cardScopes: ['src/a.ts'],
  })
  // ① 绝对路径**在卡范围内** ⇒ 放行（修前这里会被当"工作区外"或"越界"）
  const allowed = scopeOf(['/ws/src/a.ts'])
  assert.equal(allowed.kind, 'allow', '工作区内的绝对路径必须归一后按卡范围判（放行）')
  // ② 绝对路径**越出卡范围**（同名前缀文件）⇒ 拒并点名
  const denied = scopeOf(['/ws/src/a.tsx'])
  assert.equal(denied.kind, 'deny', '绝对路径的 `src/a.tsx` 不在卡范围 `src/a.ts` 内')
  // ③ 绝对路径落在**公共面**（`test/`）⇒ 放行（公共面不受卡范围约束）
  assert.equal(scopeOf(['/ws/test/x.test.ts']).kind, 'allow', '公共面放行')
  // ④ 反例：前缀**不许越界命中** —— `/wsx/src/a.ts` 不是 `/ws` 下的文件
  const outside = scopeOf(['/wsx/src/a.ts'])
  assert.equal(outside.kind, 'deny', '`/wsx/...` 不是工作区内路径')
  if (outside.kind === 'deny') assert.equal(outside.code, 'write-scope-outside-workspace', '必须按"工作区外"拒（而不是"越界"）')
  // ⑤ 已登记的**口径差异**（第十二批 §9.10 如实记）：POSIX 工作区里给**反斜杠绝对路径**（`\ws\src\a.ts`）
  //    会被归一成相对路径 `ws/src/a.ts` ⇒ 仍**拒**（安全侧），但分类是 `write-scope-violation` 而不是
  //    `write-scope-outside-workspace`。**判据只看归一后的字符串**：跨平台的路径归属需要平台知识（不在本判据面内）。
  const backslash = scopeOf(['\\ws\\src\\a.ts'])
  assert.equal(backslash.kind, 'deny', '反斜杠绝对路径仍然拒（安全侧；分类差异见上）')
})

test('M124-10 §1.1（`DEF-119`）已落地卡（done/verified）不参与拆卡期校验：四条规则只在未落地卡上判（**两态**）', () => {
  const malformed = (status: TaskCard['status'], id: string): TaskCard =>
    card(id, [], { status, dod: [], size: 'large', evidenceRequired: [] })
  const CODES = ['write-scope-empty', 'dod-nonempty', 'size-cap', 'evidence-required'] as const
  // ① 已落地（done / verified）⇒ 四条**一条都不许出现**（否则历史卡把派发面永久判红：DEF-119 的真机现象）
  for (const status of ['done', 'verified'] as const) {
    const codes = validatePlan([malformed(status, `TASK-96${status === 'done' ? 1 : 2}`)]).map((issue) => issue.code)
    for (const code of CODES) {
      assert.equal(codes.includes(code), false, `已落地卡（${status}）不许判 \`${code}\`（历史不重写）`)
    }
  }
  // ② 同形状但**未落地** ⇒ 四条**必须全在**（没松过头：两态都要断言）
  const planned = validatePlan([malformed('planned', 'TASK-963')]).map((issue) => issue.code)
  for (const code of CODES) {
    assert.ok(planned.includes(code), `未落地卡必须仍判 \`${code}\`（松紧两态都要有判别力）`)
  }
})

test('M124-12 A3（DEF-148）：设备节点**不再靠 writeScope 的单列特例过滤**，判定只在 classifyTarget 一处', () => {
  const writeScope = readFileSync(join(ROOT, 'src', 'domain', 'writeScope.ts'), 'utf8')
  // ① 特例过滤已删：这个文件里不许再出现"按名字排除设备路径"的过滤调用
  assert.equal(/\.filter\(\(path\) => !isDevicePath\(/u.test(writeScope), false, '单列特例过滤必须已删除')
  assert.equal(writeScope.includes('!isDevicePath('), false, '不许换一种写法把同一个特例搬回来')
  // ② 设备判定只有一处实现（`isDeviceNode`），且归属分类的 device 分支在 scopePaths
  const scopePaths = readFileSync(join(ROOT, 'src', 'domain', 'scopePaths.ts'), 'utf8')
  assert.match(scopePaths, /if \(isDeviceNode\(text\)\) return \{ kind: 'device', raw: text \}/u, 'device 分支必须在 classifyTarget 里')
  const sources = readFileSync(join(ROOT, 'src', 'domain', 'writeScope.ts'), 'utf8')
  assert.match(sources, /isDeviceNode\(raw\)/u, 'writeScope 的别名只能委托给 scopePaths 的单一实现（不许自带判定）')
  // ③ 行为不变（同一格断言的反面）：/dev/null 仍放行、/dev 下的工具链字面量仍拦
  const allowed = evaluateWriteScope({
    role: 'dispatched', tool: 'edit', paths: ['/dev/null'], workspace: '/ws', workspaceRoot: '/ws',
    guardedTools: ['edit'], sharedPaths: ['.sdo/'], cardScopes: ['src/a.ts'],
  })
  assert.equal(allowed.kind, 'allow', '/dev/null 必须仍放行（行为不变）')
  const denied = evaluateWriteScope({
    role: 'dispatched', tool: 'edit', paths: ['/dev/fd/3'], workspace: '/ws', workspaceRoot: '/ws',
    guardedTools: ['edit'], sharedPaths: ['.sdo/'], cardScopes: ['src/a.ts'],
  })
  assert.equal(denied.kind, 'allow', '/dev/fd/N 同样不是工作区文件 ⇒ 不参与判定')
})

test('M124-13 A3 残留（DEF-150）：空白不许改变设备节点的结论；真越界仍按原始绝对路径点名；三类归属一处可区分', () => {
  const WS = join(BASE, 'ws-m124-13')
  mkdirSync(WS, { recursive: true })
  const base = {
    role: 'dispatched' as const, tool: 'edit', workspace: WS, workspaceRoot: WS,
    guardedTools: ['edit'], sharedPaths: ['.sdo/'], cardScopes: ['src/a.ts'],
  }

  // ① **空白不许改变设备节点的结论**：`classifyTarget` 的 `raw` 是 trim 过的，按字符串比会漏
  // （漏了就会被剥成 `dev/null` 这个工作区里不存在的幽灵相对路径 ⇒ DEF-074 那一族假阳性）
  for (const path of ['/dev/null', ' /dev/null', '/dev/null ', '\t/dev/stdout']) {
    const verdict = evaluateWriteScope({ ...base, paths: [path] })
    assert.equal(verdict.kind, 'allow', `空白不许改变设备节点的结论：${JSON.stringify(path)} 应放行`)
    assert.deepEqual(verdict.violations, [], `设备节点不参与判定 ⇒ 不许点名任何违反项：${JSON.stringify(path)}`)
  }

  // ② 带空白的**真越界**仍拒，且按**原始绝对路径**点名（幽灵路径面钉死，也让①有判别力）
  const outside = evaluateWriteScope({ ...base, paths: [' /tmp/probe.txt'] })
  assert.equal(outside.kind, 'deny', '带空白的工作区外绝对路径仍然是越界（不许因为修①把它一起放过）')
  if (outside.kind !== 'deny') assert.fail('工作区外写入必须拒绝')
  assert.equal(outside.code, 'write-scope-outside-workspace')
  assert.deepEqual(outside.violations, ['/tmp/probe.txt'], '点名必须是原始绝对路径（不是剥掉前导斜杠的幽灵形态）')
  assert.equal(/(?:^|[^/])tmp\/probe\.txt/u.test(outside.detail), false, `detail 里不许出现幽灵形态 tmp/probe.txt：${outside.detail}`)

  // ③ **归属三类**在同一处可区分：设备节点 / 工作区外 / 工作区内（在卡写范围内）
  const device = evaluateWriteScope({ ...base, paths: ['/dev/null'] })
  const inside = evaluateWriteScope({ ...base, paths: ['src/a.ts'] })
  const shape = (verdict: typeof device): { kind: string; code: string; violations: string[] } => ({
    kind: verdict.kind,
    code: verdict.kind === 'deny' ? verdict.code : '',
    violations: verdict.kind === 'deny' ? verdict.violations : [],
  })
  assert.deepEqual(
    [shape(device), shape(outside), shape(inside)],
    [
      { kind: 'allow', code: '', violations: [] },
      { kind: 'deny', code: 'write-scope-outside-workspace', violations: ['/tmp/probe.txt'] },
      { kind: 'allow', code: '', violations: [] },
    ],
    '三类必须一处可区分：设备节点放行 / 工作区外拒绝并点名原始绝对路径 / 工作区内（卡写范围内）放行',
  )
  assert.notEqual(device.kind, outside.kind, '设备节点与工作区外的结论必须不同（否则分类没起作用）')
})
