/**
 * M96：**判据自适性**（TASK-056 / 缺陷 DEF-009 / DEF-019 / DEF-023 / DEF-026）。
 *
 * 这三条判据（`tdd-mutation-missing` / `tdd-red-green-missing` / `contract-test-missing`）在真机上
 * 对**没有对应对象**的卡一刀切，累计逼出 15 条逐卡 `profile.exempt`（用户 2026-10-13 已追认），
 * 并诱导"把卡挂到不相干契约上凑记录"。本卡把「该不该判」从**角色**改成**卡的写范围路径**：
 *
 *   · 写范围**不触及产品代码**（`.sdo/**`、`docs/**`、`*.md`）⇒ 红绿时序与变异自证 N/A；
 *   · 写范围**不触及契约面**且 `contractsOfCard()` 为空 ⇒ 契约测试 N/A；
 *   · **产品代码卡照旧判红**（防"顺手全判 N/A"）。
 *
 * 本文件的守卫**一律走真实注册的工具**（`apply()` → 注册表 → `execute`），不走域函数：
 * 本卡的可观察形式是「done **回执文本**里能 grep 到 N/A 理由」—— 只调 `doneGaps()` 断言空数组
 * 会把"漏判"和"N/A"混为一谈（那正是这批缺陷的成因，知识库 `tq_ff348198` 同源教训）。
 * 域层只有一处复算（`doneNaNotes()` 与 `doneGaps()` 读同一组门槛函数），用于钉住
 * "回执里那句话就是判据自己给出的理由"，而不是渲染层另编的。
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | 只读评审卡（写范围 `.sdo/reviews/`）跑 done | 通过、**不需要任何豁免**，回执含 N/A 理由 |
 * | ② | 纯文档卡（写范围 `docs/**`）跑 done | 同上 |
 * | ③ | 产品代码卡（写范围 `src/**`）跑 done | **仍判红** `tdd-red-green-missing`（不得放松） |
 * | ④ | `evidenceRequired` 含 `mutation`：tdd.yml 有名下 killed≥1 | 通过（读台账，不要求 incoming 的 kind） |
 * | ④'| 同卡：tdd.yml 无条目 | 判红、**点名**这张卡、文案指向台账 |
 * | ⑤ | 契约侧：`contractsOfCard()` 为空且写范围不含契约面 | N/A 且回执有理由 |
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, readProjectConfig } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { doneGaps, doneNaNotes, recordMutation, writeConstructionProfile } from '../src/domain/construction.js'
import type { ConstructionProfile } from '../src/domain/construction.js'
import { writeContract } from '../src/domain/contracts.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { writeTask } from '../src/domain/plan.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import { writeRequirement } from '../src/domain/requirements.js'
import type { Requirement, TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm96')
const SESSION = 'm96-session'

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

const registered = new Map<string, RegisteredTool>()

/** 一次**真实装配**：`apply()` 注册进宿主工具表的那一份定义。 */
function makeHarness(): void {
  const services: Record<string, unknown> = {
    tools: { register: (tool: RegisteredTool) => { registered.set(tool.name, tool) } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error() {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
}

function store(): SdoStore {
  return new SdoStore(join(BASE, '.sdo'))
}

function journal(): Journal {
  return new Journal(store())
}

/** 走真实注册的工具。 */
async function callTask(args: Record<string, unknown>): Promise<string> {
  const tool = registered.get('sdo_task')
  assert.ok(tool !== undefined, '真实装配没有注册 sdo_task')
  // **取会话工作目录只能读 `agent.session.header.cwd`**（dsh-agent 0.2.0-rc.1 上没有顶层 cwd）
  const exec = { agent: { id: SESSION, session: { header: { id: SESSION, cwd: BASE, delegationDepth: 1, parentSession: 'cockpit' } } } }
  return String(await tool.execute(args, exec))
}

/** 一张卡 + 一份 tdd+contract-first 的 profile（**空 exempt**：本卡的 N/A 不许靠豁免）。 */
function writeCard(id: string, writeScopes: string[], extra: Partial<TaskCard> = {}): TaskCard {
  const card: TaskCard = {
    id, title: `卡 ${id}`, goal: 'g', inputs: [], outputs: [], dod: ['d'],
    evidenceRequired: ['command'], blockedBy: [], writeScopes,
    role: 'developer', size: 'small', revision: 1, status: 'in-progress', owner: 'dev-a',
    requirements: [], evidence: [], createdAt: '', updatedAt: '',
    ...extra,
  }
  writeTask(store(), card)
  return card
}

function writeProfile(packages: ConstructionProfile['packages'] = ['tdd', 'contract-first']): ConstructionProfile {
  const profile: ConstructionProfile = {
    version: 1, decidedAt: '', decidedBy: 'office', packages, scope: 'all',
    derivedFrom: ['scale=critical'], reason: 'm96', exempt: [], history: [],
  }
  writeConstructionProfile(store(), profile)
  return profile
}

function doneArgs(id: string, owner = 'dev-a', evidence: unknown[] = [{ kind: 'command', detail: 'node --test 全绿', exitCode: 0 }]): Record<string, unknown> {
  return { action: 'done', id, owner, evidence: JSON.stringify(evidence) }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  registered.clear()
  makeHarness()
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M96-01 只读评审卡（.sdo/reviews/）：不带任何豁免也能 done，且回执里能读到 N/A 理由', async () => {
  const card = writeCard('TASK-901', ['.sdo/reviews/'], { role: 'reviewer', owner: 'rev-a' })
  const profile = writeProfile()

  // ① 域层：该判的都没判（0 缺口），但**有**一条机械可核的 N/A 理由
  assert.deepEqual(doneGaps(store(), journal(), card, profile, { scale: 'critical' }), [], '写范围不触及产品代码/契约面 ⇒ 三条判据都不判')
  const notes = doneNaNotes(store(), card, profile, { scale: 'critical' })
  assert.equal(notes.length, 3, `三条该判 N/A：${JSON.stringify(notes)}`)
  assert.ok(notes.every((note) => note.includes('.sdo/reviews/')), 'N/A 理由必须引用**卡的写范围**（机械可核，不按角色/自述）')

  // ② 工具面（本卡的**可观察形式**）：回执文本里 grep 得到 N/A 理由
  const receipt = await callTask(doneArgs('TASK-901', 'rev-a'))
  assert.match(receipt, /TASK-901/u, `回执要认得出是这张卡：${receipt}`)
  assert.match(receipt, /N\/A/u, `回执里必须看得见 N/A（否则就是把漏判伪装成 N/A）：${receipt}`)
  assert.match(receipt, /\.sdo\/reviews\//u, `N/A 理由要写明写范围：${receipt}`)
  assert.match(receipt, /不触及产品代码/u, `N/A 理由要说明**为什么**：${receipt}`)
  // 回执里**不许出现判红**。注意不能用不带冒号的裸检查名：N/A 理由本身就会引用判据名
  // （"N/A（tdd-mutation-missing 不判）…"）—— 判红的文案形态是「检查名：」，据此区分。
  assert.doesNotMatch(receipt, /tdd-red-green-missing：|tdd-mutation-missing：|contract-test-missing：/u, `不许再判红这三条：${receipt}`)

  // ③ 真的落了 done（不是"看起来成功"）
  assert.equal(journal().read().events.filter((event) => event.type === 'task/done').length, 1, '这次要真的落 task/done')
})

test('M96-02 纯文档卡（docs/**）：同样不需要豁免，回执含 N/A 理由', async () => {
  const card = writeCard('TASK-902', ['docs/'], { role: 'developer' })
  const profile = writeProfile()

  assert.deepEqual(doneGaps(store(), journal(), card, profile, { scale: 'critical' }), [], '纯文档卡：三条判据都没有对象')
  assert.equal(doneNaNotes(store(), card, profile, { scale: 'critical' }).length, 3)

  const receipt = await callTask(doneArgs('TASK-902'))
  assert.match(receipt, /N\/A/u, `回执要含 N/A 理由：${receipt}`)
  assert.match(receipt, /docs\//u, `N/A 理由要写明写范围：${receipt}`)
  assert.doesNotMatch(receipt, /tdd-red-green-missing：|contract-test-missing：/u, `不许判红：${receipt}`)
  assert.equal(journal().read().events.filter((event) => event.type === 'task/done').length, 1)
})

test('M96-03 产品代码卡仍按原判据判红（防“顺手全判 N/A”）', async () => {
  // 产品代码卡**带一条需求**：这样它撞的是 `tdd-red-green-missing`（需求名下没有先红后绿的用例），
  // 而不是"没有需求所以只剩变异那条"——两条都是真红，这里钉的是更常见的那条。
  writeRequirement(store(), {
    id: 'REQ-901', title: 'm96 产品卡需求', kind: 'functional', statement: 's', priority: 'must',
    acceptance: [], status: 'baselined', version: 1, createdAt: '', updatedAt: '',
  } as unknown as Requirement)
  const card = writeCard('TASK-903', ['src/domain/'], { role: 'developer', requirements: ['REQ-901'] })
  const profile = writeProfile()

  // 域层：仍然判红，且 **N/A 理由为空**（不许既判红又自称 N/A）。
  // 关键档位下两条都是真红：需求名下没有先红后绿的用例（`tdd-red-green-missing`），
  // 且台账里没有本卡的变异记录（`tdd-mutation-missing`）—— 正好证明"按写范围判"没有把产品卡放过。
  const gaps = doneGaps(store(), journal(), card, profile, { scale: 'critical' })
  assert.deepEqual(gaps.map((item) => item.check), ['tdd-red-green-missing', 'tdd-mutation-missing'], '产品代码卡照旧判红')
  // **判红的两条不许同时自称 N/A**。注意：契约侧那条 N/A 是**对的** —— 这张卡的写范围是
  // `src/domain/`，它确实不触及契约面、也没有契约对象（"判 N/A"与"判红"是**逐条**的，
  // 不是整卡的开关）。所以这里只钉 tdd 那两条。
  const naOfProductCard = doneNaNotes(store(), card, profile, { scale: 'critical' }).join('\n')
  assert.doesNotMatch(naOfProductCard, /tdd-red-green-missing 不判|tdd-mutation-missing 不判/u, '判红的那两条不许同时报 N/A')

  // ① 还没有用例计划 ⇒ 卡在 C7 测试先行（更早的一道闸），**照样是被拒** —— 产品代码卡不可能悄悄收工
  const beforePlan = await callTask(doneArgs('TASK-903'))
  assert.match(beforePlan, /test-case-missing/u, `产品代码卡不许通过：${beforePlan}`)
  assert.equal(journal().read().events.filter((event) => event.type === 'task/done').length, 0, '被拒的完成不许落 done')

  // ② **补上用例计划与红→绿一对结果** —— 那是产品代码卡**该走的路**（本卡的 N/A 只放过
  // "没有对应对象"的卡，不是放过产品卡）。补齐之后 done 才通过：说明上一步的拒绝是 C7
  // 在正常拦人，而不是"判据坏掉一律判红"。
  //
  // 注意两件事：
  //   · 回执走的是 `report()`，它**从台账回读卡**（不是内存里的 `card` 夹具）；
  //   · 工具面的档位来自项目 `.sdo/config.yml`（本夹具没写 ⇒ `normal`），**不是 critical**；
  //     所以这里要用**与工具同一档位**复算，才不会拿 critical 的期望去断言 normal 的行为
  //     （`tdd-mutation-missing` 只在 critical 档触发 —— 域层那两条断言已经覆盖了它）。
  const scale = readProjectConfig(store()).config.scale
  assert.notEqual(scale, 'critical', '本夹具不写 config.yml ⇒ 工具面档位是 normal（域层断言另行用 critical 复算）')
  const testCase = recordTestCase(store(), journal(), {
    title: 'm96 产品卡用例', kind: 'unit', requirement: 'REQ-901', steps: ['s'], expected: 'e',
  })
  recordTestResult(store(), journal(), {
    caseId: testCase.id, status: 'fail', evidence: 'red', env: 'node=26; suite=m96', harness: 'node --test',
  })
  recordTestResult(store(), journal(), {
    caseId: testCase.id, status: 'pass', evidence: 'green', env: 'node=26; suite=m96', harness: 'node --test',
  })
  assert.deepEqual(doneGaps(store(), journal(), card, profile, { scale }), [], `同一档位下补齐红绿对后判据转绿（scale=${scale}）`)

  const receipt = await callTask(doneArgs('TASK-903'))
  // 产品代码卡**不许把 tdd 那两条判成 N/A**（防"顺手全判 N/A"）。契约侧那句 N/A 是**对的** ——
  // 这张卡的写范围是 `src/domain/`，它确实没有契约对象；逐条判据各自成立才是本卡的口径。
  assert.doesNotMatch(receipt, /N\/A（tdd-red-green-missing 不判）|N\/A（tdd-mutation-missing 不判）/u, `产品代码卡不许出现 tdd 的 N/A：${receipt}`)
  assert.equal(journal().read().events.filter((event) => event.type === 'task/done').length, 1, '补齐之后才真的落 done')

  // **反向对照（域层，critical 档）**：补上本卡的变异记录 ⇒ critical 下那两条也都转绿 ——
  // 证明上面那两条红是"产品代码卡真的被判了"，不是"判据坏掉一律判红"。
  recordMutation(store(), { task: 'TASK-903', tool: 'node --test', target: 'lib/src/domain/x.js', killed: 1, survived: 0, at: '' })
  assert.deepEqual(doneGaps(store(), journal(), card, profile, { scale: 'critical' }), [], '补齐红绿对与变异之后 critical 下也不再判红')
})

test('M96-04 证据面读方法产物台账：tdd.yml 有本卡条目 ⇒ 通过；没有 ⇒ 判红并点名', async () => {
  // **`mutation` 不在 `EvidenceItem['kind']` 的值域里**（这正是 DEF-023 的病根），
  // 而历史卡就是按文档这么写的 —— 所以这里用真实形状（`as never` 绕开的是**类型**，不是运行时：
  // 卡文件里就是这四个字，`auditDoneEvidence` 读到的也是它）。
  const withMutation = { evidenceRequired: ['command', 'mutation'] } as unknown as Partial<TaskCard>
  writeCard('TASK-904', ['src/domain/'], withMutation)
  writeProfile()

  // ④' 先没有条目：判红、**点名这张卡**、文案指向台账，且**不再**要求 incoming 里有 mutation 这个 kind
  const refused = await callTask(doneArgs('TASK-904'))
  assert.match(refused, /TASK-904/u, `要点名是哪张卡：${refused}`)
  assert.match(refused, /tdd\.yml/u, `要指向真源台账：${refused}`)
  assert.doesNotMatch(refused, /evidence-kind-missing/u, `不许再报“缺 mutation 这个证据种类”（DEF-023 的病根）：${refused}`)

  // ④ 记一条本卡的变异（killed≥1 且 tool 非空）⇒ 同一张卡同一份证据可以收工
  recordMutation(store(), { task: 'TASK-904', tool: 'node --test', target: 'lib/x.js', killed: 2, survived: 0, at: '' })
  const accepted = await callTask(doneArgs('TASK-904'))
  assert.doesNotMatch(accepted, /evidence-method-artifact-missing|evidence-kind-missing/u, `台账有名下条目就该放行：${accepted}`)
  assert.equal(journal().read().events.filter((event) => event.type === 'task/done').length, 1, '这次要真的落 task/done')

  // **别人名下的条目不算数**（防止"顺手拿隔壁卡的变异记录充数"）
  writeCard('TASK-905', ['src/domain/'], { evidenceRequired: ['command', 'mutation'], owner: 'dev-a' } as unknown as Partial<TaskCard>)
  const other = await callTask(doneArgs('TASK-905'))
  assert.match(other, /TASK-905/u, `别的卡的条目不算，要点名本卡：${other}`)
  assert.match(other, /tdd\.yml/u)
})

test('M96-05 契约侧：没有契约对象（contractsOfCard 为空 + 写范围不含契约面）⇒ N/A 且回执有理由', async () => {
  const card = writeCard('TASK-906', ['test/m96.test.ts'])
  const profile = writeProfile(['contract-first'])

  // 写范围既不在契约面、也没有契约声明 requires 命中本卡需求 ⇒ 没有契约对象
  assert.deepEqual(doneGaps(store(), journal(), card, profile), [], '没有契约对象 ⇒ contract-test-missing 不判')
  const notes = doneNaNotes(store(), card, profile)
  assert.equal(notes.length, 1, `只该有一条契约侧 N/A：${JSON.stringify(notes)}`)
  assert.match(notes[0] ?? '', /contractsOfCard/u, 'N/A 理由要写清判定依据（contractsOfCard 为空）')

  const receipt = await callTask({
    action: 'done', id: 'TASK-906', owner: 'dev-a',
    evidence: JSON.stringify([{ kind: 'command', detail: 'node --test 全绿', exitCode: 0 }]),
  })
  assert.match(receipt, /N\/A/u, `回执要含契约侧 N/A 理由：${receipt}`)
  assert.match(receipt, /contractsOfCard/u, `理由要写明依据：${receipt}`)
  assert.doesNotMatch(receipt, /contract-test-missing：/u, `不许判红：${receipt}`)

  // **反例（同一张卡，补一份契约声明它命中本卡需求）**：这时不再 N/A，照旧判红 ——
  // 证明"判 N/A"靠的是**有没有契约对象**，不是"写范围里没有 src/interface"这一条就够。
  // 注意：`doneGaps` 读的是**传进去的卡对象**（不自己回读台账），所以这里要用新的那份。
  const hooked = writeCard('TASK-906', ['test/m96.test.ts'], { requirements: ['REQ-045'] })
  writeContract(store(), {
    id: 'CT-901', name: 'm96 探针契约', kind: 'schema', producer: 'p', consumer: 'c',
    schema: 'x', requires: ['REQ-045'], at: '',
    failureSemantics: { timeout: 't', retry: 'r', idempotency: 'i' },
  })
  assert.deepEqual(
    doneGaps(store(), journal(), hooked, profile).map((item) => item.check),
    ['contract-test-missing'],
    '卡挂在契约上 ⇒ 照旧判红',
  )
  assert.deepEqual(doneNaNotes(store(), hooked, profile), [], '契约侧判红的那条不许同时报 N/A')
})
