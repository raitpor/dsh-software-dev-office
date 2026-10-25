/**
 * **增量 245（`TASK-232` 落点一）：临时验证面 `.verify/` 进闸门的豁免面，判定仍在同一出入口。**
 *
 * 立案背景（`DEF-211`）：本仓要求「取改前/改后对照读数只在独立副本里做」（`DEF-206` 的教训），
 * 但 `.verify/` 既不在卡的写范围、也不在公共面（`disciplineAllowPaths`）里 ⇒ 此前那些副本
 * **只能靠闸门 fail-open 才写得进去**，于是一条正确的纪律靠一个漏洞才成立。
 *
 * 本卡的落点一就修这一处，两条口径必须一起读：
 *   · `.verify/` 与「公共面」是**两个概念**（公共面可配置、按角色裁；临时面是固定约定、不按角色裁）
 *     ⇒ 各留一个入口，合流只发生在交给闸门的那一步（`SoftwareDevOffice.publicWritePaths`）；
 *   · 判定**没有另起一套**：命中仍由 `evaluateWriteScope` 在公共面那个分支里按目录边界语义判
 *     ⇒ `M245-04` 用源码守卫钉住「闸门源码里不出现 `.verify`」与「`index.ts` 不长出 `.verify` 分支」。
 *
 * 守卫（DoD 要的双态 + 反例格都在这里）：
 *   · `M245-01` 同一输入两态：改前（只给公共面）**拒**且拒绝码是 `write-scope-no-claim`；
 *     改后（给豁免面）**放行**且 `checked=true`（说明是**判过**的放行，不是 fail-open）。
 *   · `M245-02` 反例格：`.verifyx/`、`x/.verify/`、`src/` 一律拒；`.verify/` 内任意深度放行。
 *   · `M245-03` 两个概念分得开：`office` 的公共面照旧只有 `.sdo/` 与 `docs/`（`M225-R4` 的读数不变），
 *     而它的临时面照旧在；配置里已经列了 `.verify/` 时去重。
 *   · `M245-04` 单一出入口（源码守卫，形态同 `M76-07` / `M193-03` 的接线守卫）。
 *   · `M245-05` 卡级不受影响：临时面不需要卡上登记，产品面照样受卡范围约束。
 *   · `M245-06` 残余 fail-open 的现算读数：`paths` 判不出时闸门给 `allow` + `checked=false`
 *     —— 读数**已经**在判定对象里，缺的是把它落到事件与回执（那一处在 `index.ts`，不在本卡写范围）。
 *
 * 断言消息一律用英文（本文件不进 `KNOWN_PROSE_GAP`）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SCRATCH_WRITE_PATHS, publicWritePathsFor, writeExemptPathsFor } from '../src/domain/roles.js'
import { evaluateWriteScope } from '../src/domain/writeScope.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'

/** 仓库根（`lib/test/` 往上两级）。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** 夹具区：与其余测试一致，只写 `node_modules/.sdo-test/`。 */
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm245')
const WORKSPACE = join(BASE, 'ws')
/** 插件行配置的公共面默认值（`config.ts` 的 schema 默认；照抄常量而不是读用户配置）。 */
const CONFIGURED = ['.sdo/', 'docs/', 'test/']

after(() => { rmSync(BASE, { recursive: true, force: true }) })

interface DecideInput {
  /** 闸门的豁免面（本卡的两个概念就在这里合流） */
  shared: readonly string[]
  path: string
  role?: string
  tool?: string
  cardScopes?: readonly string[] | undefined
}

/** 走真闸门（不复制判定逻辑）：同一 `workspace` / `workspaceRoot` 基准。 */
function decide(input: DecideInput): ReturnType<typeof evaluateWriteScope> {
  return evaluateWriteScope({
    role: input.role ?? 'developer',
    tool: input.tool ?? 'write',
    paths: [input.path],
    workspace: WORKSPACE,
    workspaceRoot: WORKSPACE,
    guardedTools: ['write', 'edit', 'bash'],
    sharedPaths: input.shared,
    cardScopes: input.cardScopes,
  })
}

test('M245-01 same input, two states: public face only denies, write-exempt face allows', () => {
  mkdirSync(WORKSPACE, { recursive: true })
  const target = '.verify/task-232/probe.txt'
  // 改前 = 只把「公共面」交给闸门（`TASK-232` 之前的输入面）
  const before = decide({ shared: publicWritePathsFor('developer', CONFIGURED), path: target })
  assert.equal(before.kind, 'deny', 'before the change .verify/ is outside both the public face and the card scope')
  if (before.kind === 'deny') {
    assert.equal(before.code, 'write-scope-no-claim', 'the deny reason must be the no-claim one, not an outside-workspace one')
  }
  // 改后 = 同一个调用、同一个路径，只把豁免面换成合流后的那一份
  const after = decide({ shared: writeExemptPathsFor('developer', CONFIGURED), path: target })
  assert.equal(after.kind, 'allow', 'after the change the same input passes')
  if (after.kind === 'allow') {
    assert.equal(after.checked, true, 'the pass must be checked=true: the gate really judged it (not a fail-open)')
  }
})

test('M245-02 directory boundary: .verify/ passes, look-alikes and product paths do not', () => {
  const shared = writeExemptPathsFor('developer', CONFIGURED)
  assert.equal(decide({ shared, path: '.verify/a.txt' }).kind, 'allow', 'a file directly inside .verify/ passes')
  assert.equal(decide({ shared, path: '.verify/task-232/deep/b.bin' }).kind, 'allow', 'any depth inside .verify/ passes')
  // 反例格（与公共面同一套目录边界语义，不新造判据）
  assert.equal(decide({ shared, path: '.verifyx/a.txt' }).kind, 'deny', 'a sibling directory sharing the prefix must NOT pass')
  assert.equal(decide({ shared, path: 'x/.verify/a.txt' }).kind, 'deny', 'a nested .verify deeper in the tree must NOT pass')
  assert.equal(decide({ shared, path: '.verify/../src/x.ts' }).kind, 'deny', 'a path escaping .verify/ by .. must NOT pass')
  // `..` 是**先折叠再判**（闸门原有的归一顺序）：折叠后仍在 `.verify/` 里的写法属于临时面，不算逃逸
  assert.equal(decide({ shared, path: '.verify/a.txt/../b.txt' }).kind, 'allow',
    'dots are folded before judging: .verify/a/../b.txt really is .verify/b.txt')
  // 不带尾斜杠的那一份：与 `.sdo` 在 `.sdo/` 下的表现一致（同一套语义，没有为临时面加特例）
  assert.equal(decide({ shared, path: '.verify' }).kind, 'allow', 'the bare name behaves exactly like .sdo under .sdo/ (same semantics)')
  assert.equal(decide({ shared: publicWritePathsFor('developer', CONFIGURED), path: '.verify' }).kind, 'deny',
    'and the public face alone does not cover it either (the two faces are separate inputs)')
  // 临时面是**增量**，不是"什么都放行"
  assert.equal(decide({ shared, path: 'src/domain/roles.ts' }).kind, 'deny', 'product source stays denied')
  assert.equal(decide({ shared, path: 'docs/a.md' }).kind, 'allow', 'the public face keeps working unchanged')
})

test('M245-03 public face and scratch face stay two concepts (role narrowing untouched)', () => {
  // 公共面读数逐项不变（`M225-R4` 钉住的那三条）
  assert.deepEqual(publicWritePathsFor('office', CONFIGURED), ['.sdo/', 'docs/'], 'office public face unchanged')
  assert.deepEqual(publicWritePathsFor('developer', CONFIGURED), CONFIGURED, 'non-office public face unchanged')
  assert.deepEqual(publicWritePathsFor('cockpit', CONFIGURED), CONFIGURED, 'the unknown-session fallback stays untouched')
  // 豁免面 = 公共面 ∪ 临时面：角色收窄只作用在公共面那一半
  assert.deepEqual(writeExemptPathsFor('office', CONFIGURED), ['.sdo/', 'docs/', '.verify/'],
    'office keeps the scratch face although its public face is narrowed')
  assert.deepEqual(writeExemptPathsFor('developer', CONFIGURED), [...CONFIGURED, '.verify/'],
    'other roles get the configured face plus the scratch face')
  assert.deepEqual([...SCRATCH_WRITE_PATHS], ['.verify/'], 'the scratch path is declared as its own constant')
  // 去重：项目自己的公共面里已经列了 `.verify/` 时只出现一次
  assert.deepEqual(writeExemptPathsFor('developer', ['.sdo/', '.verify/']), ['.sdo/', '.verify/'],
    'no duplicate entry when the configured face already lists it')
})

test('M245-04 single exit: the scratch face is judged where the public face is judged', () => {
  const writeScopeSrc = readFileSync(join(ROOT, 'src', 'domain', 'writeScope.ts'), 'utf8')
  assert.equal(writeScopeSrc.includes('.verify'), false, 'the gate source must not name .verify (no parallel predicate inside it)')
  const rolesSrc = readFileSync(join(ROOT, 'src', 'domain', 'roles.ts'), 'utf8')
  assert.equal(rolesSrc.includes("SCRATCH_WRITE_PATHS: readonly string[] = ['.verify/']"), true,
    'the scratch path is declared once, in roles.ts')
  const officeSrc = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.equal(/return writeExemptPathsFor\(role, configured\)/u.test(officeSrc), true,
    'the facade hands the merged face to the gate (name kept for the existing call site)')
  const indexSrc = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.equal(indexSrc.includes('sharedPaths: office.publicWritePaths(attributed.role, settings.disciplineAllowPaths)'), true,
    'the gate call site is unchanged: the scratch face travels the existing input')
  assert.equal(indexSrc.includes(".verify/"), false, 'index.ts must not grow a scratch-path branch of its own')
})

test('M245-05 a live card is not required for the scratch face (product files still are)', () => {
  const shared = writeExemptPathsFor('developer', CONFIGURED)
  assert.equal(decide({ shared, path: '.verify/task-232/x.txt', cardScopes: ['src/office.ts'] }).kind, 'allow',
    'scratch writes need no entry on the card')
  assert.equal(decide({ shared, path: 'src/office.ts', cardScopes: ['src/office.ts'] }).kind, 'allow',
    'the card scope still governs product files')
  assert.equal(decide({ shared, path: 'src/domain/plan.ts', cardScopes: ['src/office.ts'] }).kind, 'deny',
    'a product file outside the card scope stays denied')
})

test('M245-06 residual fail-open readout: the decision carries checked=false (the event does not exist yet)', () => {
  mkdirSync(WORKSPACE, { recursive: true })
  const undecidable = evaluateWriteScope({
    role: 'developer',
    tool: 'bash',
    paths: [],
    workspace: WORKSPACE,
    workspaceRoot: WORKSPACE,
    guardedTools: ['write', 'edit', 'bash'],
    sharedPaths: writeExemptPathsFor('developer', CONFIGURED),
  })
  assert.equal(undecidable.kind, 'allow', 'no derivable write target still allows (the fail-open direction)')
  if (undecidable.kind === 'allow') {
    assert.equal(undecidable.checked, false, 'and the decision says checked=false: the readout exists, the trace does not')
  }
  // 角色维度在 `TASK-189` 之后由闸门判（根会话的角色是 office），所以活的 fail-open 是上一条那种形态
  assert.equal(decide({ shared: writeExemptPathsFor('office', CONFIGURED), path: 'src/x.ts', role: 'office' }).kind, 'deny',
    'the office role is judged here, not waved through')
  // 接线：门面给出的豁免面 = 上面被测的那一份（不让测试与实现各说一套）
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  assert.deepEqual(office.publicWritePaths('developer', CONFIGURED), writeExemptPathsFor('developer', CONFIGURED),
    'the facade must return exactly the merged face this file exercises')
})
