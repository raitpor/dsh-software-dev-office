/**
 * **增量 206：`DEF-142` —— `docs/TESTPLAN.md` 只许有一个渲染来源。**
 *
 * 病根：同一份路径有两个渲染器、两套真源 ——
 *   · `office.renderVerificationDocs()` → `records.renderTestPlan()`（真源 `.sdo/tests/`），由
 *     `sdo_deliver action=package` 调用，**后写者生效**；
 *   · `testingRender.writeTestingDoc(store, 'plan', …)`（真源 `.sdo/testing/plan.yml`，REQ-047 的计划真源），
 *     **零调用点**。
 * ⇒「有真源的计划文档」和「打包时写的计划文档」内容不同，且没有任何冲突提示。
 *
 * 修法口径（任务书 §3.2）：
 *   · package 出口改走计划真源（`writeTestingDoc`）；
 *   · `.sdo/testing/plan.yml` **缺失 ⇒ 不写** `docs/TESTPLAN.md`，回执点名缺哪份真源（**不许**退回旧渲染器）；
 *   · 旧渲染器 `records.renderTestPlan` 无其它调用点 ⇒ 删除（同源重复合并）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm206')
const WORKSPACE = join(BASE, 'proj')
const TESTPLAN = join(WORKSPACE, 'docs', 'TESTPLAN.md')

let office: SoftwareDevOffice
const call = { sessionId: 's-m206', cwd: WORKSPACE } as unknown as OfficeCall

/** 一份**计划真源**（`.sdo/testing/plan.yml`）——准出准则 EC-001 是渲染正文里必须出现的证据。 */
function writePlanSource(): void {
  mkdirSync(join(WORKSPACE, '.sdo', 'testing'), { recursive: true })
  writeFileSync(join(WORKSPACE, '.sdo', 'testing', 'plan.yml'), [
    'plan:',
    '  levels:',
    '    - { id: LV-001, level: 单元测试, entry: 实现完成, exit: 单测全绿, traceability: req-tc }',
    '  exitCriteria:',
    '    - { id: EC-001, criterion: 全量用例通过率, threshold: "100%", comparator: gte, source: 全量套件 }',
    '',
  ].join('\n'), 'utf8')
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-m206', WORKSPACE)
  office.init(call, { name: 'M206 测试计划单一来源', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M206-01 计划真源存在 ⇒ 渲染 `docs/TESTPLAN.md` 走真源：正文有 EC-001 与 `source: .sdo/testing/plan.yml`', () => {
  writePlanSource()
  const written = office.renderVerificationDocs(call)
  assert.equal(existsSync(TESTPLAN), true, `必须渲染计划文档（实际写了：${written.join(' / ')}）`)
  const text = readFileSync(TESTPLAN, 'utf8')
  assert.match(text, /EC-001/u, '正文必须含计划真源里的准出准则（旧渲染器读的是 .sdo/tests，不会有它）')
  assert.match(text, /source: \.sdo\/testing\/plan\.yml/u, '渲染头必须自报真源路径（读者要知道这份是从哪来的）')
  assert.ok(written.some((item) => item.includes('TESTPLAN.md')), '回执必须报出写了哪份文档')
})

test('M206-02 计划真源缺失 ⇒ **不写** `docs/TESTPLAN.md`，回执点名缺哪份真源（不许退回旧渲染器）', () => {
  // 先放一份"上一次渲染的"文件：真源缺失时**不许**被改写（也不许被旧渲染器覆盖成另一套口径）
  mkdirSync(join(WORKSPACE, 'docs'), { recursive: true })
  writeFileSync(TESTPLAN, 'OLD-PLAN-BYTES\n', 'utf8')
  const before = readFileSync(TESTPLAN, 'utf8')
  const written = office.renderVerificationDocs(call)
  assert.equal(readFileSync(TESTPLAN, 'utf8'), before, '没有计划真源 ⇒ 盘上那份必须一字不动')
  assert.equal(written.some((item) => item.includes('TESTPLAN.md')), false, '没写就不许报"写了"')
  assert.ok(
    written.some((item) => item.includes('.sdo/testing/plan.yml')),
    `回执必须点名缺哪份真源（实际：${written.join(' / ')}）`,
  )
})

test('M206-03 反例（不许误伤）：`docs/DELIVERY.md` 的渲染行为与修前逐字节一致', () => {
  // 交付清单真源存在 ⇒ DELIVERY.md 照旧渲染；改动只碰 TESTPLAN 那一段
  office.storeFor(WORKSPACE).writeYaml(['delivery', 'manifest.yml'], {
    manifest: {
      id: 'DLV-001', at: '2026-10-20T00:00:00.000Z', version: '0.1.6',
      artifacts: [{ path: 'lib/src/index.js', sha256: 'a'.repeat(64) }],
      acceptance: [{ requirement: 'REQ-001', criterion: 'AC-001', evidence: 'e', verdict: 'pass' }],
      rollbackPoint: 'HEAD', runsRequired: [],
    },
  })
  const written = office.renderVerificationDocs(call)
  const delivery = join(WORKSPACE, 'docs', 'DELIVERY.md')
  assert.equal(existsSync(delivery), true, `DELIVERY.md 必须照旧渲染（实际写了：${written.join(' / ')}）`)
  const text = readFileSync(delivery, 'utf8')
  assert.match(text, /source: \.sdo\/delivery\/manifest\.yml/u, 'DELIVERY.md 的真源头不许变')
  assert.match(text, /DLV-001|交付清单/u, 'DELIVERY.md 正文仍由交付清单渲染')
  // 没有计划真源 ⇒ TESTPLAN 不写；这不影响 DELIVERY（两段互不牵连）
  assert.equal(existsSync(TESTPLAN), false, '没有计划真源时不许顺手写一份 TESTPLAN')
})
