/**
 * **增量 168：R5（第三批 §3.7）—— "改语义前先扫既有夹具影响面"，做成机械面而非纪律**。
 *
 * 任务书的 DoD 先把这件事本身判清楚：**能机械强制就不要靠提醒**。现盘可用面：`impact` 是 DEF-036 立起的
 * **规范声明字段**（"本卡会影响到哪些文件/用例"），而 `done` 面已经有写范围对账（`auditWriteScopes`）
 * 与自报清单（DEF-016 的 `reportedFiles`）⇒ "被点名的夹具**真的**被跑过/改过"可以结构化核对。
 *
 * 口径（三选一即视为"处理过"，**不解析任何散文**）：
 *   ① 在**本卡写范围**内；② 有**一条 pass 的测试结果**绑着它（`artifact` == 该路径）；③ 在**自报写入清单**里。
 * 声明了 `undecidable` ⇒ 不逐条要求；没声明 `impact` ⇒ 不判（存量卡零噪声）。
 * **回显不拦截**：`done` 照常成功，读数挂在回执上（拦截会让"改既有语义"的卡永远收不了工——与 DEF-033 同类顾虑）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { createTask } from '../src/domain/plan.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m168/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-batch3', cwd: WORKSPACE } as unknown as OfficeCall

/** 建一张卡并认领（`done` 需要 owner 对上）。 */
function claimedCard(extra: Record<string, unknown>): { id: string; owner: string } {
  const owner = 'dev'
  const card = createTask(office.storeFor(WORKSPACE), office.journalFor(WORKSPACE), {
    title: '夹具卡', goal: 'g', dod: ['d'], role: 'developer', size: 'small',
    // 夹具用 `command` 证据（`createTask` 的默认是 `artifact` —— 与本次要测的 impact 对账无关，
    // 但若不给，`done` 会先被 `evidence-kind-missing` 拒掉，测不到本条）
    evidenceRequired: ['command'],
    writeScopes: ['src/own/'], ...extra,
  } as never)
  const claimed = office.claimTask(call, { taskId: card.id, owner, expectedRevision: card.revision })
  assert.equal(claimed.ok, true, `夹具前提：${card.id} 必须能认领：${JSON.stringify(claimed)}`)
  return { id: card.id, owner }
}

const done = (id: string, owner: string, reportedFiles?: string[]): ReturnType<SoftwareDevOffice['reportTask']> =>
  office.reportTask(call, {
    taskId: id,
    owner,
    status: 'done',
    evidence: [{ kind: 'command', detail: '跑过了', exitCode: 0 }],
    ...(reportedFiles === undefined ? {} : { reportedFiles }),
  } as never)

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-batch3', WORKSPACE)
  office.init(call, { name: 'M168 impact 对账', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M168-01 两态：声明了 impact 却没「处理过」⇒ 逐条点名；两条出路任一成立 ⇒ 不再点名', () => {
  // ① 既不在写范围、也没有 pass 结果绑着、也不在自报清单 ⇒ 点名
  const first = claimedCard({ impact: ['test/m39.test.ts', 'src/other/thing.ts'] })
  const outcome = done(first.id, first.owner)
  assert.equal(outcome.ok, true, '回显**不拦截**收工（这与"收不了工"是两件事）')
  if (outcome.ok) {
    assert.deepEqual(outcome.impactGaps, ['test/m39.test.ts', 'src/other/thing.ts'], '未处理的两条都要点名')
  }

  // ② 出路一：在**本卡写范围**内 ⇒ 不再点名
  const second = claimedCard({ impact: ['src/own/inside.ts'] })
  const viaScope = done(second.id, second.owner)
  assert.equal(viaScope.ok, true)
  if (viaScope.ok) assert.equal(viaScope.impactGaps, undefined, '写范围内的影响面不需要额外证据（本卡就是改它的那条路）')

  // ③ 出路二：有**一条 pass 的测试结果**绑着它 ⇒ 不再点名
  office.storeFor(WORKSPACE).writeYaml(['tests', 'TC-168.yml'], {
    testCase: { id: 'TC-168', title: '夹具', kind: 'unit', requirement: '', steps: [], expected: 'x', at: '' },
  })
  const recorded = office.addTestResult(call, {
    caseId: 'TC-168', status: 'pass', evidence: 'jest 输出', artifact: 'test/m39.test.ts',
  } as never)
  assert.equal(recorded.ok, true, `夹具前提：结果必须记成功：${JSON.stringify(recorded)}`)
  const third = claimedCard({ impact: ['test/m39.test.ts'] })
  const viaResult = done(third.id, third.owner)
  assert.equal(viaResult.ok, true)
  if (viaResult.ok) assert.equal(viaResult.impactGaps, undefined, '被 pass 结果绑定的影响面视为"跑过"')

  // ④ **反例（本轮实测出来的"死路"）**：初版还把"出现在自报写入清单里"当作第三条出路，
  // 实测它**永不独立成立** —— 清单里出现写范围**之外**的路径会先被 `write-scope-violation` 拒掉
  // （DEF-016 的对账就是干这个的）⇒ 该出路只在"已在写范围内"时"成立"，等于 ① 的影子。
  // 现已删除；这条断言把"为什么删"钉在盘上。
  //
  // **`DEN-198`（`TASK-214`）校正了本格的前提**：公共面（`test/` `docs/` `被`disciplineAllowPaths` 放行的面）
  // 从 `TASK-214` 起**不再算越界**（那是它要修的病灶 —— 闸门放行、done 却判越界）。
  // 所以这一格要证的"自报越界必被拒"必须落在**产品面**上：夹具卡写范围是 `src/own/`，
  // 自报 `src/elsewhere/x.ts` 仍是越界 ⇒ 断言与语义**一个字都没改**，只换了路径的面。
  // **不得**因此放宽：这条反例仍然是"那条出路是死路"的证据（产品面越界照样拒）。
  const fourth = claimedCard({ impact: ['src/elsewhere/x.ts'] })
  const viaReport = done(fourth.id, fourth.owner, ['src/elsewhere/x.ts'])
  assert.equal(viaReport.ok, false, '自报写范围外的路径必须先被写范围对账拒掉（所以那条出路是死路）')
  if (!viaReport.ok) assert.equal(viaReport.code, 'write-scope-violation', `拒因应当是写范围对账：${JSON.stringify(viaReport)}`)
})

test('M168-02 反例（零噪声）：没声明 impact / 声明了 undecidable ⇒ 既不逐条要求也不误报', () => {
  const plain = claimedCard({})
  const none = done(plain.id, plain.owner)
  assert.equal(none.ok, true)
  if (none.ok) assert.equal(none.impactGaps, undefined, '没声明影响面 ⇒ 不判（存量卡零噪声）')

  const undecidable = claimedCard({ impact: ['test/m39.test.ts'], undecidable: '影响面推不出来：这条改动横跨生成器与模板' })
  const skipped = done(undecidable.id, undecidable.owner)
  assert.equal(skipped.ok, true)
  if (skipped.ok) assert.equal(skipped.impactGaps, undefined, '声明了 undecidable ⇒ 不逐条要求（那是它的语义）')

  // 反例（不许放宽）：**failing** 的结果不算"跑过"
  // ⚠️ 用例 id 必须是 `TC-<数字>`（`listTestCases` 只认这个文件名口径）—— 初版写成 `TC-168f`，
  // 结果**根本没落盘**、反例变成空转（变异跑过来也不红）。这里**断言它确实落盘**，不给空转留缝。
  office.storeFor(WORKSPACE).writeYaml(['tests', 'TC-169.yml'], {
    testCase: { id: 'TC-169', title: '夹具', kind: 'unit', requirement: '', steps: [], expected: 'x', at: '' },
  })
  const failedRun = office.addTestResult(call, { caseId: 'TC-169', status: 'fail', evidence: '红', artifact: 'test/red.test.ts' } as never)
  assert.equal(failedRun.ok, true, `夹具前提：fail 结果必须真的落盘：${JSON.stringify(failedRun)}`)
  const failing = claimedCard({ impact: ['test/red.test.ts'] })
  const still = done(failing.id, failing.owner)
  assert.equal(still.ok, true)
  if (still.ok) assert.deepEqual(still.impactGaps, ['test/red.test.ts'], 'fail 的结果不构成"跑过"（否则红灯也能当证据）')
})

test('M168-03 结构：角色卡里有落点，且**标注了这是机械面**（不是靠提醒）', () => {
  const card = readFileSync(join(ROOT, 'skills', 'role-developer.md'), 'utf8')
  assert.equal(card.includes('impact'), true, '角色卡必须提到 `impact` 这条规范声明')
  assert.equal(/机械面/u.test(card), true, '角色卡必须写明"有机械面"，否则后人以为只是纪律')
  assert.equal(card.includes('impact-undeclared'), true, '拆卡期的判据要指路（那条已经在役）')
  assert.equal(card.includes('sdo_test action=record'), true, '收工面的出路要可执行')
})
