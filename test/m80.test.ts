/**
 * **增量 80：R-7 / R-9 / R-14 / R-15 / R-5D / D-12 / R-11 口径** —— 回归 + 变异自证。
 *
 *   · **R-7（major）**：掩码指纹漏了**代码层**的执行者禁用面 ⇒ 禁令上线前创建的会话指纹不变 ⇒
 *     被判"指纹一致 ⇒ 可复用"，而它公告面里仍握着 `exit_plan_mode`/`memory_forget`…（真机 `4e7ea6d8`）。
 *   · **R-9（major）**：卡被"未结算派发"冻结到孤儿 TTL（默认 60 分钟），`release` 也解不开，
 *     TTL 只能改 preset 重启。现在：`task/released` 晚于派发 ⇒ 不再冻结；`sdo_plan action=next
 *     orphanTtlMinutes=N` 是一轮内就能用的逃生口；回执点名"被谁冻着、冻了多久"。
 *   · **R-14（major）**：派发前不做"卡的要求 ∩ 角色能力"的静态校验（真机两次）—— 现在把
 *     `evidenceRequired` 要 `command` 却没有 `bash`、有写范围却没有 `write/edit` 的卡**当场点名**。
 *   · **R-15（minor 口径）**：交付缺「带已知偏差通过」档 ⇒ 偏差塞在 `evidence` 里、渲染成干净 `pass`。
 *     现在 `pass-with-deviation` **必须**带 `deviation`，矩阵与告警都要看得见它。
 *   · **R-5 症状 D（minor）**：全局预算拒收回执里的"进行中 N 张"是硬编码 0。
 *   · **D-12**：结构通道按「每设计元素一张」产卡（粒度是方法学选择，**不改成可配**），但回执要提示
 *     "粒度与模板范围可能与本项目不符，不可独立实现的元素请人工收窄/作废"。
 *   · **R-11 口径（用户裁定）**：复现是**同角色实现会话**的活；**`reviewer` 只管文档/设计/逻辑审阅**，
 *     **不新增"核实者"角色**（那只是重复评审员的工作，对要干活的角色而言结论依旧不可信）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { CHECKERS } from '../src/domain/gates.js'
import { describeGate, deviationsNote } from '../src/interface/describe.js'
import { apply } from '../src/index.js'
import { admitDispatch, rolePools } from '../src/domain/pool.js'
import type { PoolChild } from '../src/domain/pool.js'
import { deliveryCompleteness, packageDelivery, renderDelivery } from '../src/domain/records.js'
import { capabilityGaps, listRoleCards, maskFingerprint, toolAllowList } from '../src/domain/roles.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm80')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function card(id: string, role: string, extra: Partial<TaskCard> = {}): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['lib/'], role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '', ...extra,
  }
}

// ————————————————————————— R-7 —————————————————————————

test('M80-01 R-7：掩码指纹必须覆盖**代码层**的执行者禁用面（否则禁令上线前后指纹相同）', () => {
  const card0 = toolAllowList('tester')
  // 旧口径的指纹 = `sha1(allow ∪ roles.yml 的 deny)`（**逐字**按旧实现算 —— 只取 allow 是错的，
  // 那样连"禁用面没进指纹"这个缺陷都测不出来）
  const testerCard = listRoleCards().find((item) => String(item.code) === 'tester')
  assert.ok(testerCard !== undefined)
  const legacy = createHash('sha1')
    .update([...new Set<string>([...toolAllowList('tester'), ...testerCard.deny])].sort().join('|'))
    .digest('hex')
    .slice(0, 12)
  const current = maskFingerprint('tester')
  assert.notEqual(current, legacy, `指纹必须因为执行者禁用面而改变（current=${current} legacy=${legacy}）`)
  assert.ok(card0.includes('sdo_test'), '前置：tester 的白名单里确实有 sdo_test')
  // 行为面：拿**旧指纹**记录的会话不许被复用（禁令前的会话公告面里握着禁用工具）
  const stale: PoolChild[] = [
    { childSessionId: 'old-1', role: 'tester', task: 'T0', mode: 'continuable', state: 'idle', rounds: 1, startedAt: '', finishedAt: '', maskHash: legacy },
  ]
  const pools = rolePools({ children: stale, roles: ['tester'], caps: {}, defaultCap: 2, maskHashOf: () => current })
  assert.equal(pools[0]?.idle.length, 0, '旧指纹的会话不算可复用')
  assert.match(pools[0]?.unusable[0]?.reason ?? '', /掩码已变更/u)
  const admission = admitDispatch({
    ready: [card('TASK-001', 'tester')], pools, globalRoom: 4, reuseIdle: true, maskHashOf: () => current,
  })
  assert.equal(admission.dispatch[0]?.reuseChildId, undefined, '不得复用 ⇒ 新起一个')
})

// ————————————————————————— R-9 / R-14 / R-5D（office 层） —————————————————————————

/** 把最后一条 journal 事件的 `at` 改到过去（`foldPoolChildren` 取的是 `event.at`，孤儿判定据此算时长）。 */
function backdateLastEvent(ms: number): void {
  const path = join(BASE, '.sdo', 'journal.jsonl')
  const rows = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
  const last = rows[rows.length - 1]
  if (last !== undefined) last['at'] = new Date(Date.now() - ms).toISOString()
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function officeWith(tasks: TaskCard[], events: Record<string, unknown>[]): { office: SoftwareDevOffice; call: { sessionId: string; cwd: string } } {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', BASE)
  office.init({ sessionId: 's-cockpit', cwd: BASE }, { name: 'M80', scale: 'normal', stakeholders: ['业务方'] })
  const store = office.storeFor(BASE)
  for (const task of tasks) store.writeYaml(['tasks', `${task.id}.yml`], { task })
  const journal = office.journalFor(BASE)
  for (const event of events) journal.append(event['type'] as never, (event['data'] ?? {}) as Record<string, unknown>)
  return { office, call: { sessionId: 's-cockpit', cwd: BASE } }
}

test('M80-02 R-9：卡被 `release` 过就不再被它自己的孤儿派发冻住；没 release 要点名"被谁冻着"', () => {
  const started = { type: 'dispatch/started', data: { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-x', role: 'developer', tools: 9 } }
  // ① 只有派发、没有 release ⇒ 被冻住，且回执能点名
  const frozen = officeWith([card('TASK-001', 'developer')], [started])
  const frozenPlan = frozen.office.poolPlan(frozen.call)
  assert.equal(frozenPlan.dispatch.length, 0, '在飞未结算 ⇒ 不重复派（一张卡不许同时在两个子代理里）')
  assert.equal(frozenPlan.heldByDispatch?.length, 1, '要如实报"被谁冻着"')
  assert.equal(frozenPlan.heldByDispatch?.[0]?.taskId, 'TASK-001')
  assert.equal(frozenPlan.heldByDispatch?.[0]?.childSessionId, 'child-x')
  // ② 派发之后 `release` ⇒ 操作者已判定那个子会话没了 ⇒ 不再冻
  const released = officeWith([card('TASK-001', 'developer')], [
    started,
    { type: 'task/released', data: { id: 'TASK-001', actor: 'cockpit', reason: '子会话已停', previousOwner: 'subagent:developer:1' } },
  ])
  backdateLastEvent(30_000)   // release 与派发都在 30 秒前（真实时间轴）
  const releasedPlan = released.office.poolPlan(released.call)
  assert.equal(releasedPlan.dispatch.length, 1, `release 之后必须能派：${JSON.stringify(releasedPlan.blocked)}`)
  assert.equal(releasedPlan.heldByDispatch?.length ?? 0, 0, '不再算"被冻着"')
  // ③ 没 release 但有 TTL 覆盖（一轮内可用的逃生口）
  const escaped = officeWith([card('TASK-001', 'developer')], [started])
  backdateLastEvent(30_000)   // 派发发生在 30 秒前：默认 TTL 60 分钟内算在飞，覆盖成 0.1 分钟（6 秒）即过期
  const escapedPlan = escaped.office.poolPlan(escaped.call, { orphanTtlMinutes: 0.1 })
  assert.equal(escapedPlan.dispatch.length, 1, 'orphanTtlMinutes 覆盖后应放行（不必改 preset 重启）')
  // **两套口径的教训（R-6/R-9 同源）**：状态行也要按**覆盖后**的 TTL 算，否则回执说"在飞"、
  // 派发路径却已放行 —— 用户读到的与系统做的不一致
  assert.equal(escapedPlan.pools[0]?.stale.length, 1, '覆盖后的 TTL 也要作用到池视图（stale 里那位）')
  assert.equal(escapedPlan.pools[0]?.busy.length, 0, '它不该再算在飞')
  // 接线：`sdo_plan action=next` 要接受这个参数
  assert.match(readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8'), /orphanTtlMinutes: args\.orphanTtlMinutes/u)
})

test('M80-03 R-14：派发前点名"卡的要求 ∩ 角色能力"矛盾（卡照派，但矛盾绝不静默）', () => {
  // 纯函数：两个方向
  assert.deepEqual(capabilityGaps(card('T', 'reviewer'), 'reviewer'), ['needs-bash', 'needs-write'], 'reviewer：要命令证据 + 有写范围 ⇒ 两条都缺')
  assert.deepEqual(capabilityGaps(card('T', 'reviewer', { writeScopes: [] }), 'reviewer'), ['needs-bash'])
  assert.deepEqual(capabilityGaps(card('T', 'developer'), 'developer'), [], 'developer 有 bash/write ⇒ 无矛盾')
  assert.deepEqual(capabilityGaps(card('T', 'reviewer', { evidenceRequired: ['artifact'], writeScopes: [] }), 'reviewer'), [], '不要命令、不写盘 ⇒ 无矛盾')
  // office 层：把不可行的卡列出来
  const { office, call } = officeWith([card('TASK-002', 'reviewer')], [])
  const plan = office.poolPlan(call)
  assert.deepEqual(plan.infeasible?.map((row) => row.taskId), ['TASK-002'])
  assert.deepEqual(plan.infeasible?.[0]?.gaps, ['needs-bash', 'needs-write'])
  // 接线：回执要印出来（`kCapabilityGap`）
  assert.match(readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8'), /uiIndex\.kCapabilityGap/u)
})

test('M80-04 R-5 症状 D：全局预算拒收回执要报**真实**的"进行中"张数', () => {
  const pools = rolePools({ children: [], roles: ['developer'], caps: {}, defaultCap: 4, maskHashOf: () => 'H' })
  const admission = admitDispatch({ ready: [card('TASK-001', 'developer')], pools, globalRoom: 0, reuseIdle: false, inProgress: 4 })
  assert.equal(admission.blocked[0]?.reason, 'global-budget')
  assert.match(admission.blocked[0]?.detail ?? '', /进行中 4 张/u, `旧实现硬编码 0：${admission.blocked[0]?.detail}`)
})

// ————————————————————————— R-15 —————————————————————————

test('M80-05 R-15：`pass-with-deviation` 必须带 `deviation`，且渲染/门禁都要看得见', () => {
  const store = new SdoStore(join(BASE, '.sdo'))
  const journal = new Journal(store)
  // ① 缺 `deviation` ⇒ 落进 `runGaps`（交付门禁会据此判红）
  const bad = packageDelivery(store, journal, {
    workspace: BASE, by: 'cockpit', artifacts: [], rollbackPoint: 'sha:abc', prototypeDir: 'prototype',
    acceptance: [{ requirement: 'REQ-006', criterion: 'AC-012', evidence: 'e', verdict: 'pass-with-deviation' }],
  })
  assert.match(bad.manifest.runGaps.join(' '), /pass-with-deviation.*deviation/u, `缺偏差说明必须被点名：${bad.manifest.runGaps.join(' ')}`)
  // ② 带了偏差 ⇒ **渲染**出档位与偏差正文（用合成 manifest：`packageDelivery` 在缺运行证据时会把
  //    所有"通过"降级成 `unverified` —— 那是既有口径，与 R-15 无关）
  const rendered = renderDelivery({
    id: 'DLV-001', at: 'x', by: 'cockpit', artifacts: [], runs: [], runGaps: [],
    rollbackPoint: 'sha:abc', prototypeExcluded: true, notes: '', runsRequired: [],
    acceptance: [{
      requirement: 'REQ-006', criterion: 'AC-012', evidence: 'e2',
      verdict: 'pass-with-deviation', deviation: '举例 URL 与 ADR-008 冲突，用户批准',
    }],
  } as never, 'header')
  assert.match(rendered, /pass-with-deviation/u, '档位必须出现在矩阵里')
  assert.match(rendered, /举例 URL 与 ADR-008 冲突/u, `偏差正文必须出现在矩阵里：${rendered.slice(-200)}`)
  assert.match(rendered, /带已知偏差/u, '还要有人眼可见的标记（不能与干净 pass 长得一样）')
  // ③ 门禁侧：`pass-with-deviation` **放行**但出告警 —— 断言交付完整性口径的源（读码，不搭重型夹具）
  const records = readFileSync(join(ROOT, 'src', 'domain', 'records.ts'), 'utf8')
  assert.match(records, /pass-with-deviation.*放行/u, '门禁要把"带偏差通过"当通过，但必须出声')
  assert.match(records, /带已知偏差通过 \$\{deviations\.length\} 条/u, '并进 `warnings`（交付回执与门禁都看得到）')
})

// ————————————————————————— D-12 / R-11 —————————————————————————

test('M80-06 D-12：结构通道粒度**不改**，但回执必须提示"粒度与模板范围可能不符"', () => {
  const plan = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  assert.match(plan, /structuralCount/u, '要把结构通道的产卡数交回回执')
  // 域层不许塞用户可见中文（棘轮）—— 文案在语言包里
  assert.doesNotMatch(plan, /每设计元素一张.*请人工收窄/u)
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /uiIndex\.kStructuralGranularity/u, '回执要印那条提示')
  for (const file of ['zh-CN.yml', 'en.yml']) {
    assert.match(readFileSync(join(ROOT, 'src', 'data', 'lang', file), 'utf8'), /kStructuralGranularity:/u, `${file} 要有该键`)
  }
  // **行为面**：真的拿"需求 + 设计元素 + req-des 边"跑一遍 `decompose`，产卡数要被算出来
  // （只靠源码文本断言会被"死代码消除"绕过去 —— 变异 Z8 就是这么存活的）
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', BASE)
  office.init({ sessionId: 's-cockpit', cwd: BASE }, { name: 'M80-d12', scale: 'normal', stakeholders: ['业务方'] })
  // 直接写真源（`capture` 的 DoR/评分链要求一堆字段，与本条无关）
  office.storeFor(BASE).writeYaml(['requirements', 'REQ-001.yml'], {
    requirement: {
      id: 'REQ-001', title: '解析 CSV', statement: '要能解析 CSV', priority: 'must', status: 'baselined',
      kind: 'functional', source: { kind: 'user', raw: '用户说：要能解析 CSV' }, acceptance: [], revision: 1,
      createdAt: '', updatedAt: '',
    },
  })
  office.upsertElement({ sessionId: 's-cockpit', cwd: BASE }, { kind: 'component', id: 'DES-001', name: 'Parser', elementKind: 'component', responsibility: '解析 CSV', requires: ['REQ-001'] })
  office.linkTrace({ sessionId: 's-cockpit', cwd: BASE }, [{ from: 'REQ-001', to: 'DES-001', kind: 'req-des' }])
  const result = office.planDecompose({ sessionId: 's-cockpit', cwd: BASE })
  assert.ok((result.structuralCount ?? 0) >= 1, `结构通道产卡数要如实交回（实际 ${result.structuralCount}）`)
})

test('M80-07 R-11 口径：复现归同角色实现会话，reviewer 只管文档/设计审阅（不加"核实者"角色）', () => {
  const reviewer = readFileSync(join(ROOT, 'skills', 'role-reviewer.md'), 'utf8')
  assert.match(reviewer, /我不承担「复现」/u, 'reviewer 卡要写明不承担复现')
  assert.match(reviewer, /`bash`/u, '并说明原因是掩码里没有 bash')
  // 不得新增"核实者"角色（用户裁定：那只是重复评审员的工作）
  const roles = readFileSync(join(ROOT, 'src', 'data', 'roles.yml'), 'utf8')
  assert.doesNotMatch(roles, /verifier|核实者/u, '不新增核实者角色')
  // C-42 的文案要跟着口径走
  const zh = readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8')
  const line = zh.split(/\n/u).find((item) => item.startsWith('  kReviewUnadopted:')) ?? ''
  assert.match(line, /同角色/u, '代核口径要说"同角色"')
  assert.match(line, /reviewer.*不承担复现/u, '并点名 reviewer 不承担复现')
  // toolAllowList 的既有事实：reviewer 没有 bash（口径的事实基础）
  assert.equal(toolAllowList('reviewer').includes('bash'), false)
})

// ————————————————————————— R-21：**必须经过工具层** —————————————————————————

/**
 * **M80-08 R-21（本轮真机缺陷）**：R-15 的新档位被更外层的 `verdictOf` 改写成 `unverified`
 * ⇒ 端到端不可用，而"缺 `deviation` 判红"的守卫**永远不可达**。
 *
 * 教训（报告的建议 3）：**只调 `packageDelivery` 的用例测不到这条路径** —— 我上一轮的 M80-05 正是如此，
 * 于是"674/674 全绿"而真机仍不可用。这条用例走**真实工具**（`apply()` 注册的 `sdo_deliver`）。
 */
function toolHarness(): (name: string, args: Record<string, unknown>) => Promise<string> {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: never) => { registered.push(tool as never); return () => {} } },
    sessions: {},
    subagents: {},
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  const exec = { agent: { id: 'cockpit', session: { header: { cwd: BASE } } } }
  return async (name, args) => {
    const tool = registered.find((item) => item.name === name)
    assert.ok(tool !== undefined, `${name} 必须注册进工具表`)
    return String(await tool.execute(args, exec))
  }
}

test('M80-08 R-21：`pass-with-deviation` 必须**活着穿过工具层**（不许被 verdictOf 改写成 unverified）', async () => {
  const callTool = toolHarness()
  await callTool('sdo_init', { name: 'R21 交付演练', process: 'waterfall', scale: 'normal', stakeholders: '运维' })
  writeFileSync(join(BASE, 'app.txt'), 'artifact\n')
  const artifacts = JSON.stringify([{ path: 'app.txt', kind: 'source' }])
  const row = (extra: Record<string, unknown>): string => JSON.stringify([
    { requirement: 'REQ-006', criterion: 'AC-012', evidence: '举例 URL 与 ADR-008 冲突', verdict: 'pass-with-deviation', ...extra },
  ])

  const readManifest = (): { acceptance: { verdict: string; deviation?: string }[]; runGaps: string[] } | undefined =>
    new SdoStore(join(BASE, '.sdo')).readYaml<{ manifest: { acceptance: { verdict: string; deviation?: string }[]; runGaps: string[] } }>('delivery', 'manifest.yml')?.manifest

  // ① 正向：带完整 `deviation` ⇒ **不得**出现"验收结论被改写"（真机在这里被改写成 unverified），
  //    而且 `runGaps` 里**没有**"必须给 deviation"这条 ⇒ 说明它带着 deviation 活着到了 packageDelivery
  const okReceipt = await callTool('sdo_deliver', { action: 'package', artifacts, acceptance: row({ deviation: '举例 URL 与 ADR-008 冲突，用户批准' }), rollbackPoint: 'sha:abc' })
  assert.doesNotMatch(okReceipt, /验收结论被改写|invalid `verdict`/u, `档位必须活到 packageDelivery（真机在这里被改写成 unverified）：${okReceipt.slice(0, 400)}`)
  const okManifest = readManifest()
  assert.equal(okManifest?.acceptance[0]?.deviation, '举例 URL 与 ADR-008 冲突，用户批准', '偏差正文要落盘')
  assert.doesNotMatch(okManifest?.runGaps.join(' ') ?? '', /必须给 `deviation`/u, '带了偏差就不该报"缺偏差"')
  // 注：本例没有真机运行证据 ⇒ 档位会按**既有口径**降级成 `unverified`（那是"缺运行证据"，与 R-21 无关）

  // ② 负向：同一行**不给** `deviation` ⇒ 守卫必须**可达**并点名。
  //    这是"值没被改写"的**可达性证明**：旧实现里行在到达 packageDelivery 前就变成 `unverified`，
  //    这条 gap **永远筛不到**（R-21 的真机症状）。
  const badReceipt = await callTool('sdo_deliver', { action: 'package', artifacts, acceptance: row({}), rollbackPoint: 'sha:abc' })
  assert.doesNotMatch(badReceipt, /验收结论被改写/u, '缺 deviation 不是"非法取值"（档位合法），要走守卫那条路')
  assert.match(badReceipt, /必须给 `deviation`/u, `缺偏差说明要被点名：${badReceipt.slice(0, 500)}`)
  assert.match(readManifest()?.runGaps.join(' ') ?? '', /必须给 `deviation`/u, '守卫的判据要落在 runGaps（交付门禁据此判红）')

  // ③ 门禁口径（合成清单，避开"缺运行证据"这条无关降级）：带偏差 ⇒ **通过** + 出告警，而不是判红
  const store = new SdoStore(join(BASE, '.sdo'))
  store.writeYaml(['delivery', 'manifest.yml'], {
    manifest: {
      id: 'DLV-999', at: 'x', by: 'cockpit', artifacts: [], runs: [], runGaps: [], runsRequired: [],
      rollbackPoint: 'sha:abc', prototypeExcluded: true, notes: '',
      acceptance: [{ requirement: 'REQ-006', criterion: 'AC-012', evidence: 'e', verdict: 'pass-with-deviation', deviation: '用户批准' }],
    },
  })
  const completeness = deliveryCompleteness(
    store,
    [{ id: 'REQ-006', priority: 'must', acceptance: [{ id: 'AC-012' }] } as never],
    'prototype',
  )
  assert.match(completeness.warnings.join(' '), /带已知偏差通过 1 条/u, `要出 warning：${completeness.warnings.join(' ')}`)
  // 与 R-15 口径一致：`pass-with-deviation` 是**通过**（这里剩下的 problems 只会是"清单为空/缺运行证据"这类无关项）
  assert.doesNotMatch(completeness.problems.join(' '), /pass-with-deviation|带已知偏差/u, `不许因为"如实声明偏差"判红：${completeness.problems.join(' ')}`)
})

test('M80-09 R-22：门禁与交付回执都要看得见"带已知偏差通过"（不许与干净通过长得一样）', () => {
  // ① **判据层**：`delivery.manifest` 必须把 `deliveryCompleteness().warnings` 交出去（旧实现直接丢掉）
  const store = new SdoStore(join(BASE, '.sdo'))
  store.writeYaml(['delivery', 'manifest.yml'], {
    manifest: {
      id: 'DLV-010', at: 'x', by: 'cockpit', artifacts: [{ path: 'app.txt', kind: 'source', sha256: 'dir:x' }],
      runs: [{ outcome: 'pass', artifactSha256: 'dir:x', target: 'server' }], runGaps: [], runsRequired: [],
      rollbackPoint: 'sha:abc', prototypeExcluded: true, notes: '',
      acceptance: [
        { requirement: 'REQ-006', criterion: 'AC-012', evidence: 'e', verdict: 'pass-with-deviation', deviation: '用户批准' },
        { requirement: 'REQ-008', criterion: 'AC-014', evidence: 'e2', verdict: 'pass-with-deviation', deviation: '用户批准' },
        { requirement: 'REQ-008', criterion: 'AC-020', evidence: 'e3', verdict: 'pass-with-deviation', deviation: '用户批准' },
      ],
    },
  })
  const requirementFixtures = [
    { id: 'REQ-006', priority: 'must', acceptance: [{ id: 'AC-012' }] },
    { id: 'REQ-008', priority: 'must', acceptance: [{ id: 'AC-014' }, { id: 'AC-020' }] },
  ] as never
  const criterion = CHECKERS['delivery.manifest']?.({ store, requirements: requirementFixtures, prototypeDir: 'prototype' } as never)
  assert.ok(criterion !== undefined)
  assert.equal(criterion.ok, true, `判据口径不变（仍算通过）：${JSON.stringify(criterion)}`)
  assert.deepEqual(
    criterion.warnings,
    ['带已知偏差通过 3 条：REQ-006/AC-012 REQ-008/AC-014 REQ-008/AC-020'],
    `判据必须把 warnings 交出来（R-22 的缺口就是这里被丢掉）：${JSON.stringify(criterion.warnings)}`,
  )
  // ② **渲染层**：`describeGate` 要把 warnings 印成回执行（真机：C-60/61/62 三行里一个字都没有）
  const text = describeGate({
    gate: 'G7', phase: 'delivery', status: 'passed', at: 'x', remedy: [],
    criteria: [criterion],
  })
  assert.match(text, /带已知偏差通过 3 条：REQ-006\/AC-012 REQ-008\/AC-014 REQ-008\/AC-020/u, `门禁回执里必须看得见：${text}`)
  // ③ 干净通过 ⇒ **不出现**该行（不许变成"总有这行"的噪音）
  store.writeYaml(['delivery', 'manifest.yml'], {
    manifest: {
      id: 'DLV-011', at: 'x', by: 'cockpit', artifacts: [{ path: 'app.txt', kind: 'source', sha256: 'dir:x' }],
      runs: [{ outcome: 'pass', artifactSha256: 'dir:x', target: 'server' }], runGaps: [], runsRequired: [],
      rollbackPoint: 'sha:abc', prototypeExcluded: true, notes: '',
      acceptance: [{ requirement: 'REQ-006', criterion: 'AC-012', evidence: 'e', verdict: 'pass' }],
    },
  })
  const clean = CHECKERS['delivery.manifest']?.({
    store,
    requirements: [{ id: 'REQ-006', priority: 'must', acceptance: [{ id: 'AC-012' }] }] as never,
    prototypeDir: 'prototype',
  } as never)
  // 先确认这条 fixture 真的走在**通过**分支上（否则下面的 assertions 会因为"提前 fail ⇒ 没有 warnings"而假绿 ——
  // 变异 V4' 就是这么存活的）
  assert.equal(clean?.ok, true, `干净包这条要真的通过：${JSON.stringify(clean)}`)
  assert.equal(clean?.warnings, undefined, '干净通过不许挂告警')
  assert.doesNotMatch(describeGate({ gate: 'G7', phase: 'delivery', status: 'passed', at: 'x', remedy: [], criteria: [clean!] }), /带已知偏差通过/u)
  // ④ 交付回执（`sdo_deliver action=package`）也要印 —— 报告把这条标为"未核实"；核实结果：那边确实没有，已补。
  //    这段**行为断言**（而不是只断源码文本）：干净清单 ⇒ undefined；带偏差 ⇒ 那句话
  assert.equal(deviationsNote({ acceptance: [{ requirement: 'REQ-006', criterion: 'AC-012', verdict: 'pass' }] }), undefined, '干净通过不许挂这条噪音')
  const note = deviationsNote({
    acceptance: [
      { requirement: 'REQ-006', criterion: 'AC-012', verdict: 'pass-with-deviation' },
      { requirement: 'REQ-008', criterion: 'AC-014', verdict: 'pass-with-deviation' },
      { requirement: 'REQ-008', criterion: 'AC-020', verdict: 'pass-with-deviation' },
    ],
  })
  assert.match(note ?? '', /3 条/u, `回执行要报条数：${note}`)
  assert.match(note ?? '', /REQ-006\/AC-012 REQ-008\/AC-014 REQ-008\/AC-020/u, `并逐行点名：${note}`)
  assert.match(readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8'), /deviationsNote\(result\.manifest\)/u, '交付回执要接上它')
})
