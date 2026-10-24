/**
 * **增量 171：DEF-054（major，第三批 §3.17）—— 跨项目串账（含 `dab49d5` 引入的回归）**。
 *
 * 修前现盘：钩子（`tools/pre-execute`）用 `findProjectRoot(call.cwd, projectDirName)` 定位工作区根
 * —— 它会**向上爬到祖先项目**的 `.sdo/`（`findProjectRoot("<祖先>/proj/sub", ".sdo")` ⇒ 认到祖先项目）
 * ⇒ 卡的查找、认领台账、角色缓存键全部落到**别的项目**的真源上（跨项目串账）。
 * 而 `office.workspaceFor` 的契约明写「**绝不向上爬、绝不猜别的项目**；`findProjectRoot` …不参与定位」
 * ⇒ 实现与契约**互相打脸**（第三处打脸在 `test/m102` 的夹具注释里，已随本项统一）。
 *
 * 修法：定位改用**唯一出口** `office.workspaceRootFor`（三个**契约内**来源，逐条都不爬）：
 *   ① 本次调用的 cwd 本身含 `.sdo/`；② 本会话**登记的** cwd 含 `.sdo/`；
 *   ③ **凭据**：本会话在某个**已登记会话的**工作区里认领过卡（台账证明，不是路径上溯）。
 * 都拿不到 ⇒ **fail-closed**（执行者子会话一律拒；修前是 `kind='unknown'` ⇒ 掩码与写范围**两段一起跳过**）。
 * 驾驶舱不受限（它本就不受角色掩码约束、也没有卡的写范围）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm171')
/** 祖先项目（**别的**项目）：`.sdo/` 在它这一层，夹具故意在里面放一张被本会话"认领"的卡。 */
const FOREIGN = join(BASE, 'outer')
/** 本会话 cwd：落在祖先项目**下面**的深层子目录（自己这一路上都没有 `.sdo/`）。 */
const DEEP = join(FOREIGN, 'deep', 'sub')

const CARD_REVISION = 1

interface ToolDefinition { name: string; parameters: unknown; execute: (args: Record<string, unknown>, exec: unknown) => unknown }
type Decision = { kind: string; reason?: string }

function hookHarness(): {
  drive: (tool: string, args: Record<string, unknown>, opts?: { sessionId?: string; cwd?: string | undefined; depth?: number }) => Promise<Decision>
  claim: (sessionId: string, taskId: string, cwd: string) => Promise<string>
  registerSession: (sessionId: string, cwd: string) => void
} {
  const registered: ToolDefinition[] = []
  const listeners = new Map<string, (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } },
    sessions: {},
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: never) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const listener = listeners.get('tools/pre-execute')
  assert.ok(listener !== undefined, '真实装配必须注册 tools/pre-execute')
  const sessionCreated = listeners.get('session/created')
  assert.ok(sessionCreated !== undefined, '真实装配必须注册 session/created（宿主登记会话工作目录的入口）')
  return {
    registerSession(sessionId, cwd) { sessionCreated({ id: sessionId, header: { cwd } }, async () => undefined) },
    async drive(tool, args, opts = {}) {
      const sessionId = opts.sessionId ?? 'child-dev'
      const depth = opts.depth ?? 1
      const header: Record<string, unknown> = { id: sessionId, delegationDepth: depth }
      if (opts.cwd !== undefined) header['cwd'] = opts.cwd
      if (depth > 0) header['parentSession'] = 'cockpit'
      const exec = { name: tool, arguments: args, agent: { id: sessionId, session: { header } } }
      return (await listener(exec, async () => ({ kind: 'allow' }))) as Decision
    },
    async claim(sessionId, taskId, cwd) {
      const tool = registered.find((item) => item.name === 'sdo_task')
      assert.ok(tool !== undefined, '工具面缺少 sdo_task')
      const exec = { agent: { id: sessionId, session: { header: { id: sessionId, cwd, delegationDepth: 1, parentSession: 'cockpit' } } } }
      return String(await tool.execute({ action: 'claim', id: taskId, owner: sessionId, expectedRevision: CARD_REVISION }, exec))
    },
  }
}

/** 在一个目录里初始化一个"项目"（`.sdo/`）并放一张卡；返回 store。 */
function projectAt(dir: string, scopes: string[]): SdoStore {
  mkdirSync(join(dir, '.sdo', 'tasks'), { recursive: true })
  const store = new SdoStore(join(dir, '.sdo'))
  const task: TaskCard = {
    id: 'TASK-901', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
    blockedBy: [], writeScopes: scopes, role: 'developer', size: 'small', revision: CARD_REVISION,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', 'TASK-901.yml'], { task })
  return store
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(DEEP, { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M171-01 祖先项目（串账现场）：**不许**认到祖先的 `.sdo/`，执行者按 fail-closed 拒', async () => {
  const h = hookHarness()
  // 祖先项目是**别的**项目：它的卡由**别的会话**认领（本会话在那边没有任何凭据）
  projectAt(FOREIGN, ['src/index.ts'])
  h.registerSession('other-session', FOREIGN)
  const receipt = await h.claim('other-session', 'TASK-901', FOREIGN)
  assert.match(receipt, /TASK-901/u, `夹具前提：别的会话认领必须成功：${receipt.slice(0, 200)}`)

  const decision = await h.drive('edit', { file_path: join(DEEP, 'src/index.ts') }, { cwd: DEEP })
  assert.equal(decision.kind, 'deny', 'cwd 一路上没有 `.sdo/` 且本会话无凭据 ⇒ 不许把祖先项目当成自己的工作区')
  assert.match(decision.reason ?? '', /无法确定本会话的工作区/u, `必须是 fail-closed 的理由，而不是拿祖先项目的写范围去判：${decision.reason ?? ''}`)
  // **关键**：别把祖先项目的写范围当成自己的（那正是串账）
  assert.equal((decision.reason ?? '').includes('越界'), false, '拒因不得是"祖先项目的写范围"判出来的越界')

  // **对照（两层，口径随第五批 §3.1 / DEF-078 更新）**：
  //   · 修前：把 cwd 直接放在祖先项目那一层时，拒因是"拿那个项目的写范围判出来的越界"；
  //   · 现在：这个会话（`child-foreign`）在那边**没有任何认领** ⇒ 它是"角色未知的子会话" ⇒ 先被
  //     **最小面**拦下（写类不在未认领子会话的面里）。它在**任何**项目里都没认领过，所以这与
  //     "认到了祖先项目的写范围"无关 —— 那正是本用例要否证的事。
  //     "按写范围判越界"这一层由 `M171-02`（**已认领**的会话，范围外路径）继续覆盖。
  const asForeign = await h.drive('edit', { file_path: join(FOREIGN, 'src/other.ts') }, { cwd: FOREIGN, sessionId: 'child-foreign' })
  assert.equal(asForeign.kind, 'deny', 'cwd 就是那个工作区、但没有任何认领 ⇒ 仍未认领子会话 ⇒ 收窄')
  assert.match(asForeign.reason ?? '', /最小面|未认领/u, `拒因必须说清是"角色未知的最小面"：${asForeign.reason ?? ''}`)
  assert.equal((asForeign.reason ?? '').includes('越界'), false, '这一态不是"拿祖先项目的写范围判出来的越界"（那才是串账）')
})

test('M171-02 正常项目（零回归）：cwd 自己含 `.sdo/` ⇒ 照旧放行范围内的绝对路径', async () => {
  const h = hookHarness()
  const store = projectAt(BASE, ['src/index.ts'])
  void store
  h.registerSession('cockpit', BASE)
  const receipt = await h.claim('child-dev', 'TASK-901', BASE)
  assert.match(receipt, /TASK-901/u, `夹具前提：认领必须成功：${receipt.slice(0, 200)}`)
  const inside = await h.drive('edit', { file_path: join(BASE, 'src/index.ts') }, { cwd: BASE })
  assert.equal(inside.kind, 'allow', `正常项目的范围内的绝对路径必须放行：${inside.reason ?? ''}`)
  const outside = await h.drive('edit', { file_path: join(BASE, 'src/other.ts') }, { cwd: BASE })
  assert.equal(outside.kind, 'deny', '范围外仍然拒（判据没被放宽）')
  assert.match(outside.reason ?? '', /other\.ts/u, '拒因要点名被拒路径')
})

test('M171-03 无 cwd：执行者**fail-closed 拒**（修前会跳过掩码与写范围两段）；驾驶舱不受影响', async () => {
  const h = hookHarness()
  projectAt(BASE, ['src/index.ts'])
  h.registerSession('cockpit', BASE)
  const child = await h.drive('edit', { file_path: join(BASE, 'src/index.ts') }, { sessionId: 'child-nocwd', cwd: undefined })
  assert.equal(child.kind, 'deny', '拿不到工作区的**执行者**必须 fail-closed，不许 fail-open')
  assert.match(child.reason ?? '', /无法确定本会话的工作区/u, `拒因必须说明是工作区归属不到：${child.reason ?? ''}`)
  /**
   * **由 ADR-031 导致的预期口径变更（TASK-189）**：根会话的身份是**流程官 `office`**，
   * 于是"写范围纪律第一次对主会话生效"（ADR-031 consequences 第 2 条）。这条用例要守的性质
   * **没有变**：executor 的那条 `workspaceRoot === ''` fail-closed **不许**把根会话一起拦住。
   * 所以现在断的是"拒因不是那条 fail-closed"，而不是"根会话一定放行"：
   *   · 写 `src/`（产品代码）⇒ 拒，但拒因必须是**写范围**（不是"无法确定本会话的工作区"）；
   *   · 写 `.sdo/`（公共面）⇒ 放行（根会话照旧维护台账）。
   */
  const cockpit = await h.drive('edit', { file_path: join(BASE, 'src/index.ts') }, { sessionId: 'cockpit', cwd: undefined, depth: 0 })
  assert.equal(/无法确定本会话的工作区/u.test(cockpit.reason ?? ''), false, `the root session must not be caught by that fail-closed: ${cockpit.reason}`)
  assert.match(cockpit.reason ?? '', /写范围|公共面/u, `the root session writes product code, so it must be refused by the write scope (ADR-031 4): ${cockpit.reason}`)
  const cockpitLedger = await h.drive('edit', { file_path: join(BASE, '.sdo/tasks/TASK-001.yml') }, { sessionId: 'cockpit', cwd: undefined, depth: 0 })
  assert.equal(cockpitLedger.kind, 'allow', 'the root session still maintains the ledger (.sdo/ is in its public face)')
  // **更强的那一态**：连"登记过的 cwd"都没有的驾驶舱（工作区**彻底**不可知）也必须放行 ——
  // 它既没有角色掩码可判、也没有卡的写范围可判，锁死它只会把流程官挡在门外（判据是给执行者的）。
  const cockpitUnknown = await h.drive('edit', { file_path: join(BASE, 'src/index.ts') }, { sessionId: 'cockpit-unknown', cwd: undefined, depth: 0 })
  assert.equal(cockpitUnknown.kind, 'allow', '工作区不可知的驾驶舱同样不该被锁死（fail-closed 只针对执行者）')
})

test('M171-04 子目录会话（DEF-047 不得回归）：靠**台账凭据**定位，而不是靠向上爬', async () => {
  const h = hookHarness()
  projectAt(BASE, ['src/index.ts'])
  h.registerSession('cockpit', BASE)
  const receipt = await h.claim('child-dev', 'TASK-901', BASE)
  assert.match(receipt, /TASK-901/u, `夹具前提：认领必须成功：${receipt.slice(0, 200)}`)
  const sub = join(BASE, 'src')
  // 本会话 cwd 落在子目录（自己这一层没有 `.sdo/`），但它在 BASE 的工作区里**认领过卡** ⇒ 凭据成立
  const inside = await h.drive('edit', { file_path: join(sub, 'index.ts') }, { cwd: sub })
  assert.equal(inside.kind, 'allow', `DEF-047 的原始现场不得回归（子目录会话的范围内绝对路径必须放行）：${inside.reason ?? ''}`)
  const relative = await h.drive('edit', { file_path: 'index.ts' }, { cwd: sub })
  assert.equal(relative.kind, 'deny', '相对写法仍无法表达工作区根下的路径 ⇒ 照旧 fail-closed 拒')
})

test('M171-05 反例（如实记录的行为变化）：子目录 + 无任何凭据 ⇒ fail-closed（不再猜）', async () => {
  const h = hookHarness()
  projectAt(BASE, ['src/index.ts'])
  h.registerSession('cockpit', BASE)
  // 该会话**没有**在任何工作区认领过卡 ⇒ 三个来源都不成立
  const orphan = await h.drive('edit', { file_path: join(BASE, 'src/index.ts') }, { sessionId: 'child-orphan', cwd: join(BASE, 'src') })
  assert.equal(orphan.kind, 'deny', '没有任何凭据 ⇒ 不许猜（这正是"不向上爬"的代价，如实钉住）')
  assert.match(orphan.reason ?? '', /无法确定本会话的工作区/u, '理由必须是工作区归属不到')
})

test('M171-06 结构：`src/index.ts` 的**代码行**里不再有 `findProjectRoot`（定位不再向上爬）', () => {
  const code = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
    .join('\n')
  assert.equal(/findProjectRoot/u.test(code), false, '钩子侧不许再用 findProjectRoot 定位（DEF-054）')
  const office = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.match(office, /workspaceRootFor\(call: OfficeCall\)/u, '唯一出口 workspaceRootFor 必须在位')
  assert.match(office, /绝不向上爬/u, '契约里"不向上爬"的措辞必须在位（三处口径统一）')
})

test('M171-07 有凭据但**本次调用没有 cwd**：掩码与写范围**照判**（DEF-054 残余，不许退回放行态）', async () => {
  const h = hookHarness()
  projectAt(BASE, ['src/index.ts'])
  h.registerSession('cockpit', BASE)
  const receipt = await h.claim('child-dev', 'TASK-901', BASE)
  assert.match(receipt, /TASK-901/u, `夹具前提：认领必须成功：${receipt.slice(0, 200)}`)
  // 本会话**没有**在 `session/created` 里登记过 cwd（真机现场：宿主只登记驾驶舱，执行者子会话靠**凭据**定位）。
  // 工作区仍能被 `workspaceRootFor` 解析出来（第三步凭据：本会话在 BASE 的台账里认领过卡）
  // ⇒ 归属判定**必须**按这个工作区照判，而不是因为 `call.cwd === undefined` 就退回 `unknown/cockpit`。
  const outside = await h.drive('edit', { file_path: join(BASE, 'src/other.ts') }, { sessionId: 'child-dev', cwd: undefined })
  assert.equal(outside.kind, 'deny', `范围外必须拒（修前这里 allow：归属退回 unknown/cockpit 把掩码与写范围两段一起跳过）：${outside.reason ?? ''}`)
  assert.match(outside.reason ?? '', /写范围|越界/u, `拒因必须是写范围判定：${outside.reason ?? ''}`)
  const inside = await h.drive('edit', { file_path: join(BASE, 'src/index.ts') }, { sessionId: 'child-dev', cwd: undefined })
  assert.equal(inside.kind, 'allow', `范围内的路径仍放行（不是把执行者一律拒掉）：${inside.reason ?? ''}`)
  // **执行者禁令**也走同一个归属：同一会话、同一张卡，只差 `call.cwd`
  const plan = await h.drive('sdo_plan', {}, { sessionId: 'child-dev', cwd: undefined })
  assert.equal(plan.kind, 'deny', `执行者禁令不许因 cwd 缺省而消失：${plan.reason ?? ''}`)
  const planWithCwd = await h.drive('sdo_plan', {}, { sessionId: 'child-dev', cwd: BASE })
  assert.equal(planWithCwd.kind, 'deny', '两态必须同判（对照：cwd 在的时候本来就拒）')
})

test('M171-08 TC-134②：驾驶舱资格**不是写死的身份** —— 任意 id 的根会话算驾驶舱，被派发的子代理叫什么都 不算', async () => {
  const { resolveSettings } = await import('../src/config.js')
  const { SoftwareDevOffice } = await import('../src/office.js')
  projectAt(BASE, ['src/index.ts'])
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))

  // ① 名字不参与：三个**任意** id 的根会话都按驾驶舱处理
  for (const id of ['s-arbitrary', 'cockpit', 'user-42']) {
    office.noteSession(id, BASE)
    assert.equal(
      office.canAdministerTasks({ sessionId: id, cwd: BASE } as never),
      true,
      `${id} 是根会话 ⇒ 应当按驾驶舱处理（资格不该由名字决定）`,
    )
  }

  // ② 关键反例：被派发出去的子代理**即使 id 就叫 `cockpit`** 也不是驾驶舱
  office.noteSession('cockpit', BASE)
  office.recordDispatchStarted({ sessionId: 'cockpit', cwd: BASE } as never, {
    taskId: 'TASK-901', provider: 'spawn', childSessionId: 'cockpit', parentSessionId: 'root',
    tools: 1, role: 'developer', mode: 'continuable', maskHash: 'H',
  } as never)
  assert.equal(
    office.canAdministerTasks({ sessionId: 'cockpit', cwd: BASE } as never),
    false,
    '被派发的子代理不许因为 id 叫 cockpit 就获得处置权（身份不是名字）',
  )

  /**
   * ③ 结构：判据体里不许"按会话 id / 名字"认定流程官 —— 只许用角色口径的正面信号。
   *
   * **由 ADR-031 导致的预期口径变更（TASK-189）**：根会话的角色从 `cockpit` 变成 `office` 之后，
   * `canAdministerTasks` 不再自己比较字面量，而是委托 `isProcessOfficer(call)`（同一个角色口径的
   * **唯一入口** —— 换身份时"一处漏改就挡掉驾驶舱自己的特许动作"，`reassign` 就是这个形状）。
   * 所以守卫从"body 里必须有 `roleOf(call)` + `'cockpit'` 字面量"改成"body 必须走角色口径的入口
   * （`roleOf` 或 `isProcessOfficer`），且 `isProcessOfficer` 自己必须按**角色**判"。
   */
  const source = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  const start = source.indexOf('canAdministerTasks(call: OfficeCall): boolean {')
  assert.ok(start > 0, '夹具前提：`canAdministerTasks` 在盘上找得到')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.equal(/sessionId/u.test(body), false, `判据体不许读会话 id（那正是"写死身份"的形态）：${body}`)
  assert.match(body, /isDispatchedChild/u, '必须用「是不是被派发的子代理」这个正面信号')
  assert.match(body, /roleOf|isProcessOfficer/u, 'plus the role-based lineage (root session = process officer)')
  // 委托出去的那条口径本身必须是**角色**判定（不是一个名字常量）
  const officerStart = source.indexOf('isProcessOfficer(call: OfficeCall): boolean {')
  assert.ok(officerStart > 0, '夹具前提：`isProcessOfficer` 在盘上找得到')
  const officerBody = source.slice(officerStart, source.indexOf('\n  }', officerStart))
  assert.match(officerBody, /isProcessOfficerRole\(this\.roleOf\(call\)\)/u, 'the officer check must derive from the ROLE (roleOf -> role face), never from a hard-coded name')
  assert.equal(/sessionId/u.test(officerBody), false, 'the officer check must not read the session id either')
})
