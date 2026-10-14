/**
 * **CT-024 契约测试**：台账基础设施 → 验证与交付（含追溯）的**存储契约**在测试域真源上的落点。
 *
 * 契约原文（`.sdo/contracts/CT-024.yml`）里与本卡（TASK-001 / DES-031 的 `.sdo/testing/**`）相关的三条不变量：
 *   ① 「完成必须带证据」—— 本卡的证据是**产物 + 可复跑命令**（`evidenceRequired: [artifact]`）；
 *   ② 「artifact 绑 sha256 且**产物改动即过期**」—— 真源/派生文档的哈希绑定与过期判定；
 *   ③ 「验收矩阵每条 must 需求一行，未验证降级为 unverified」—— 本条对应**文档未登记不得当证据**。
 *
 * 为什么单独一份：契约测试要能被**单独复跑**（`cmd` 里写的就是它），不能混在别的用例文件里 ——
 * 否则"这条契约被测过"这句话在真机上无法机械复算。
 *
 * 复跑：`node --test lib/test/ct024-testing-store.test.js`
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { docSha256, renderStale, sourceFingerprintOf, writeTestingSource } from '../src/domain/testingStore.js'
import { writeTestingDoc } from '../src/domain/testingRender.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/ct024/', import.meta.url))

let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 关键档位的真源写盘（本 repo scale=critical 时 tdd 要求产物绑定，故这里显式绑定产物哈希）。 */
function writePlan(): { artifactSha256: string } {
  writeTestingSource(store, 'plan', 'plan', {
    levels: [{ id: 'TL-001', level: '单元', entry: '构建通过', exit: '用例全绿' }],
    exitCriteria: [{ id: 'XC-001', criterion: '语句覆盖', metric: 'statement', threshold: '80%', scope: 'src/domain/testing*' }],
  }, journal)
  return { artifactSha256: docSha256(readFileSync(join(BASE, '.sdo', 'testing', 'plan.yml'), 'utf8')) }
}

test('CT-024①「完成必须带证据」：写下的真源与渲染的文档都留可复算的事件（truth/file-written 与 doc/rendered）', () => {
  const { artifactSha256 } = writePlan()
  writeTestingDoc(store, 'plan', { store, seq: journal.read().events.length }, journal)
  const events = journal.read().events
  const written = events.filter((event) => event.type === 'truth/file-written')
  const rendered = events.filter((event) => event.type === 'doc/rendered')
  assert.equal(written.length, 1, '真源写盘必须留事件（否则手写文件与跑出来的写入分不开）')
  assert.equal(rendered.length, 1, '派生文档必须留渲染登记')
  assert.match(String(written[0]?.data.sourceHash), /^sha256:[0-9a-f]{64}$/u)
  assert.match(artifactSha256, /^sha256:[0-9a-f]{64}$/u, 'artifact 绑 sha256')
  assert.equal(rendered[0]?.data.fingerprint, sourceFingerprintOf(store, 'plan'), '登记里记的是真源指纹')
  assert.equal(String(rendered[0]?.data.sha256), docSha256(readFileSync(join(BASE, 'docs', 'TESTPLAN.md'), 'utf8')))
})

test('CT-024②「产物改动即过期」：真源一动，绑定它的派生文档立刻判过期', () => {
  writePlan()
  writeTestingDoc(store, 'plan', { store, seq: journal.read().events.length }, journal)
  assert.equal(renderStale(store, 'plan', journal).stale, false)
  const path = join(BASE, '.sdo', 'testing', 'plan.yml')
  writeFileSync(path, `${readFileSync(path, 'utf8')}  # 产物改动\n`, 'utf8')
  assert.equal(renderStale(store, 'plan', journal).stale, true, '产物改动 ⇒ 绑定它的文档过期')
})

test('CT-024③「未验证不得升级为已验」：盘上有文档但真源里没有它的登记 ⇒ 判过期（不冒充证据）', () => {
  writePlan()
  mkdirSync(join(BASE, 'docs'), { recursive: true })
  writeFileSync(join(BASE, 'docs', 'TESTPLAN.md'), '# 手写的一份\n', 'utf8')
  const stale = renderStale(store, 'plan', journal)
  assert.equal(stale.stale, true)
  assert.equal(stale.recordedFingerprint, '', '没有登记就没有指纹可绑')
})
