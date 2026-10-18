/**
 * **增量 194：契约的契约测试覆盖（第十二批 §3.5 `DEF-106`）—— 记录或**项目显式豁免**，缺一份即红。**
 *
 * 病根：**31** 份契约只有 **4** 份有 `contractTest` 记录 ⇒ "在册无守"。修法：判据只认 **id 与记录**
 * （`contractTestGaps` 现算），另一条出路是**项目显式豁免并给理由**（`.sdo/config.yml` 的
 * `contractTests.exempt`，结构声明、语言无关 ⇒ `AC-241`）；**项目声明 `contractTests.enforce` 才启用**
 * （要不要把它当门禁是项目选择，与 `DEF-105③` 同一口径）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { CHECKERS } from '../src/domain/gates.js'
import { contractTestGaps, recordContractTest } from '../src/domain/construction.js'
import { writeContract } from '../src/domain/contracts.js'
import { SdoStore } from '../src/infra/store.js'
import type { GateContext } from '../src/domain/gates.js'
import type { Contract } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm194')
let counter = 0

beforeEach(() => { rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true }) })
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

/** 一个**真 store**（临时目录）—— 读的是 `contracts/` 与 `construction/contract-first.yml` 的真形态。 */
function storeOf(declare: boolean, config = ''): SdoStore {
  counter += 1
  const store = new SdoStore(join(BASE, `ws-${counter}`))
  mkdirSync(store.path('contracts'), { recursive: true })
  mkdirSync(store.path('construction'), { recursive: true })
  if (declare) store.writeYaml(['config.yml'], { contractTests: { enforce: true } })
  if (config !== '') writeFileSync(store.path('config.yml'), config)
  return store
}

function contract(id: string, dropped = false): Contract {
  return {
    id, name: `${id} 的契约`, kind: 'event', producer: 'a', consumer: 'b', schema: 'x',
    failureSemantics: { timeout: 't', retry: 'r', idempotency: 'i' }, at: '2026-10-17T00:00:00.000Z',
    ...(dropped ? { dropped: true } : {}),
  }
}

const ctxOf = (store: SdoStore): GateContext => ({ requirements: [], store } as unknown as GateContext)
const judge = (store: SdoStore) => CHECKERS['contracts.tested']?.(ctxOf(store))

test('M194-01 §3.5（`DEF-106`）契约测试覆盖：未声明 ⇒ N/A；缺记录 ⇒ 红并点名；有记录/有理由的豁免 ⇒ 绿', () => {
  // ① 未声明 `contractTests.enforce` ⇒ N/A（并点名项目声明的键）
  const undeclared = storeOf(false)
  writeContract(undeclared, contract('CT-001'))
  const na = judge(undeclared)
  assert.equal(na?.na, true, '未声明 ⇒ N/A（不是红）')
  assert.match(na?.naReason ?? '', /contractTests\.enforce/u, 'N/A 的理由要点名项目声明的键')
  // ② 声明后：两份契约只有一份有记录 ⇒ 红并**点名缺的那份**
  const store = storeOf(true)
  writeContract(store, contract('CT-001'))
  writeContract(store, contract('CT-002'))
  recordContractTest(store, { task: 'TASK-001', contract: 'CT-001', tool: 'node --test', cmd: 'node --test lib/test/x.js', at: '2026-10-17T00:00:00.000Z' })
  const red = judge(store)
  assert.equal(red?.ok, false, '缺一份记录必须红')
  assert.match(red?.detail ?? '', /CT-002/u, '必须点名缺记录的那份契约')
  assert.equal(/CT-001/u.test(red?.detail ?? ''), false, '有记录的那份不许被点名')
  assert.match(red?.detail ?? '', /no-record/u, '要区分"没记录"与"豁免没理由"')
  // ③ 另一份改为**项目显式豁免并给理由** ⇒ 绿
  store.writeYaml(['config.yml'], { contractTests: { enforce: true, exempt: [{ id: 'CT-002', reason: '该契约由上游团队自测，本轮不覆盖' }] } })
  const green = judge(store)
  assert.equal(green?.ok, true, '逐份有记录或**有理由的豁免** ⇒ 绿')
  // ④ 豁免**没给理由** ⇒ 红，且理由字符串点名 `exempt-needs-reason`
  store.writeYaml(['config.yml'], { contractTests: { enforce: true, exempt: [{ id: 'CT-002', reason: '  ' }] } })
  const noReason = judge(store)
  assert.equal(noReason?.ok, false, '豁免没理由必须红')
  assert.match(noReason?.detail ?? '', /exempt-needs-reason/u, '要区分"没记录"与"豁免没理由"')
  // ⑤ 已作废的契约不参与（否则"作废"等于没作废）
  const withDropped = storeOf(true)
  writeContract(withDropped, contract('CT-001'))
  writeContract(withDropped, { ...contract('CT-009'), dropped: true })
  recordContractTest(withDropped, { task: 'TASK-001', contract: 'CT-001', tool: 'x', cmd: 'y', at: '' })
  assert.equal(judge(withDropped)?.ok, true, '已作废的契约不许计入覆盖')
  // ⑥ 没有契约 ⇒ N/A（不是绿）
  assert.equal(judge(storeOf(true))?.na, true, '没有契约面 ⇒ N/A')
  // ⑦ 流程数据里真的声明了这个 check（与 `DEF-105③` 同一条路：数据与代码都要有）
  const waterfall = readFileSync(join(ROOT, 'src', 'data', 'processes', 'waterfall.yml'), 'utf8')
  assert.match(waterfall, /check: "contracts\.tested"/u, 'G3 必须声明 contracts.tested')
  assert.match(waterfall, /id: C-contracts-tested/u, '判据 id 必须是 C-contracts-tested')
  // ⑧ `contractTestGaps` 的算术自洽：契约 = 记录 + 豁免 + 缺口
  const gaps = contractTestGaps(store)
  assert.equal(gaps.contracts.length, gaps.recorded.length + gaps.exempt.length + gaps.gaps.length, '逐份三分：记录 + 豁免 + 缺口 = 契约总数')
})
