/**
 * **SDO-57 的 C 口径**（先做轻机制，B 待评估）：
 *
 * 真机病根：13 张卡普遍引用一句限定语「`run_checks.py --all` exit 1 的唯一来源是 `spell_pieces`…」，
 * 而环境/探针一变它就**静默过期**（复跑后失败项变成 `real-registry`），代价是一整轮复评。
 *
 * C 的做法：把「时点 + 前置」钉在**证据**上，并把"过期"变成可机械判定的东西 ——
 *   · `sdo_test action=env`：环境**时序账本**（换 JDK/升探针就再登记一条，最近一条生效）；
 *   · `sdo_test action=record env=… artifact=…`：证据自带环境指纹，并**绑定被检产物的 sha256**；
 *   · 交付/记录回执摆出**时效告警**（过期 / 没记环境）——**只告警、不判红**（先观察一轮噪音）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { evidenceFreshness } from '../src/domain/records.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm49')
let office: SoftwareDevOffice
let store: SdoStore

const call = (): { sessionId: string; cwd: string } => ({ sessionId: 's-dev', cwd: BASE })

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev', BASE)
  store = new SdoStore(join(BASE, '.sdo'))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('SDO-57 C①：环境指纹是**时序账本**（最近一条生效），空指纹必须被拒', () => {
  assert.equal(office.currentEnvironment(call()), undefined, '没登记过 ⇒ 未知（不假装有环境）')
  const first = office.noteEnvironment(call(), { env: 'jdk=21.0.2; probe=run_checks.py@v3' })
  assert.equal(first.ok, true)
  assert.equal(office.currentEnvironment(call()), 'jdk=21.0.2; probe=run_checks.py@v3')

  // 换环境 ⇒ 再登记一条，**最近一条生效**（旧记录还在，可回溯）
  assert.equal(office.noteEnvironment(call(), { env: 'jdk=21.0.3; probe=run_checks.py@v4' }).ok, true)
  assert.equal(office.currentEnvironment(call()), 'jdk=21.0.3; probe=run_checks.py@v4')

  // 空指纹 ⇒ 拒绝（"没登记"和"登记了个空"必须区分开）
  const empty = office.noteEnvironment(call(), { env: '   ' })
  assert.equal(empty.ok, false)
})

test('SDO-57 C②：结果继承/声明环境指纹，并绑定被检产物哈希 —— 产物或环境一变即判过期', () => {
  assert.equal(office.noteEnvironment(call(), { env: 'jdk=21; probe=v3' }).ok, true)
  writeFileSync(join(BASE, 'report.json'), '{"items":76}', 'utf8')

  // ① 未声明 env ⇒ 按最近登记的环境归属，并**如实标注 inherited**
  office.addTestResult(call(), { caseId: 'TC-001', status: 'pass', evidence: 'run_checks exit 0', artifact: 'report.json' })
  const inherited = store.readYaml<{ result: { env?: string; envSource?: string; artifactSha256?: string } }>('tests', 'results', 'TR-001.yml')?.result
  assert.equal(inherited?.env, 'jdk=21; probe=v3')
  assert.equal(inherited?.envSource, 'inherited', '继承来的要标 inherited（不假装是声明的）')
  assert.equal((inherited?.artifactSha256 ?? '').length, 64, '被检产物要当场绑定哈希')

  // ② 环境一致 + 产物未变 ⇒ 无过期、无"未记录"
  const clean = office.evidenceFreshness(call())
  assert.deepEqual(clean.stale, [])
  assert.deepEqual(clean.unrecorded, [])

  // ③ 产物变了 ⇒ **过期**（最强的一种判定：哈希不符）
  writeFileSync(join(BASE, 'report.json'), '{"items":34}', 'utf8')
  const changed = office.evidenceFreshness(call())
  assert.equal(changed.stale.length, 1)
  assert.match(changed.stale[0]?.reason ?? '', /被检产物/u)

  // ④ 产物还原、但**环境登记变了** ⇒ 仍然过期（限定语的时点/前置绑定）
  writeFileSync(join(BASE, 'report.json'), '{"items":76}', 'utf8')
  office.noteEnvironment(call(), { env: 'jdk=21; probe=v4' })
  const envChanged = office.evidenceFreshness(call())
  assert.equal(envChanged.stale.length, 1)
  assert.match(envChanged.stale[0]?.reason ?? '', /环境指纹已变/u)

  // ⑤ 显式声明的 env 与"继承"要能区分：新结果按**当前**环境声明 ⇒ 它是新鲜的，
  //    而 TR-001（记于 v3）**仍然过期**（改环境不会让旧证据自动变新，这正是要防的"静默洗白"）
  office.addTestResult(call(), { caseId: 'TC-002', status: 'pass', evidence: 'x', env: 'jdk=21; probe=v4' })
  const mixed = office.evidenceFreshness(call())
  assert.deepEqual(mixed.stale.map((item) => item.resultId), ['TR-001'], '旧环境的结果仍过期')
  assert.equal(mixed.stale.some((item) => item.resultId === 'TR-002'), false, '按当前环境声明的新结果不得被误判')
})

test('SDO-57 C③：没记环境的结果**如实标"无法机械核验"**，而不是判红（历史证据不能被追溯判死）', () => {
  office.addTestResult(call(), { caseId: 'TC-003', status: 'pass', evidence: '旧证据' })
  const freshness = office.evidenceFreshness(call())
  assert.deepEqual(freshness.stale, [], '没有 env/artifact ⇒ 不判过期')
  assert.deepEqual(freshness.unrecorded, ['TR-001'], '但要如实列出来（交付回执会说出来）')

  // 函数级：`evidenceFreshness` 是域函数（交付门禁与回执共用同一口径）
  const direct = evidenceFreshness(store, BASE, undefined)
  assert.deepEqual(direct.unrecorded, ['TR-001'])
})
