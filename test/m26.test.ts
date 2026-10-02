/**
 * 方法包**人审文档**（`docs/METHOD-<包>.md`）的回归用例。
 *
 * 需求（用户）：设计阶段各方法包的结果要成**文档**（OO 要能出类图/时序图）用于人工审核，
 * 而不是只有 `.yml` 台账；文档内容**由模型撰写**；口径是 **必须存在 + 台账变更未重生成即判红**。
 *
 * 因此本用例钉四件事：① 没有文档 → G3 判红并点名路径与当前指纹；② 指纹不符（台账变了）→ 判红；
 * ③ 正文漏条目 id → 判红并逐个点名；④ 齐全 → 绿；⑤ 显式 `none`/未选 → N/A（不拦）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { SdoStore } from '../src/infra/store.js'
import { renderMethodStatus } from '../src/interface/designReceipt.js'
import { methodDocFingerprint, methodDocHeader, PACKAGE_ARTIFACT_KINDS } from '../src/domain/methodDocs.js'
import { writeMethodDoc } from './support/method-doc-fixture.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m26/', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice
let store: SdoStore

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  store = new SdoStore(join(workspace, '.sdo'))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

const c2f = (): { ok: boolean; detail: string; na?: boolean | undefined } | undefined =>
  office.checkGate(call(), 'G3').criteria.find((criterion) => criterion.id === 'C-2F')

/** 立项 + 一条需求 + 选定方法包（问题账本 → 机械解析）；`answer` 传方法名或 `none`。 */
function setupProject(answer: string, recommendation = '面向对象'): void {
  office.init(call(), { name: '方法文档项目', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  // 设计方法选择题在设计阶段提出，但它要挂在需求上 —— 因此至少先有一条需求
  office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.askDesignQuestions(call(), { recommendation: { method: recommendation, rationale: '领域模型清晰' } })
  const question = office.questions(call()).find((item) => item.targets.includes('design:method'))
  assert.ok(question !== undefined, `前置：应有方法选择题（拿到 ${office.questions(call()).length} 题）`)
  office.answer(call(), { id: question.id, answer })
  const selection = office.methodSelection(call())
  // `none` 分支：状态可能是 chosen(none) 或 none，都算"已入账"（两者的判据口径都是 N/A）
  assert.ok(
    selection.status === 'chosen' || selection.status === 'none',
    `前置：方法选择应已入账（answer=${answer}，实际 ${selection.status} / ${selection.reason}）`,
  )
}

/** 选定 `oo` 包 + 写齐 OO 三件产物（不写人审文档）。 */
function ooWithArtifacts(): void {
  setupProject('面向对象')
  office.writeMethodArtifact(call(), 'classes', {
    types: [
      { name: 'OrderService', responsibility: '下单', collaborators: ['OrderRepo'], leaf: false },
      { name: 'OrderRepo', responsibility: '持久化', collaborators: [], leaf: true },
    ],
  } as never)
  office.writeMethodArtifact(call(), 'sequences', {
    sequences: [
      {
        name: '下单主流程',
        participants: ['OrderService', 'OrderRepo'],
        messages: [{ from: 'OrderService', to: 'OrderRepo', text: 'save(order)', condition: '校验通过' }],
        requirement: 'REQ-001',
      },
    ],
  } as never)
  office.writeMethodArtifact(call(), 'layers', {
    rules: { layers: ['api', 'service', 'repo'], assignments: { OrderService: 'service', OrderRepo: 'repo' }, allowed: ['api->service', 'service->repo'] },
  } as never)
}

test('方法文档：选中 oo 但没有 docs/METHOD-oo.md → G3 判红，并点名路径与当前指纹', () => {
  ooWithArtifacts()
  const criterion = c2f()
  assert.equal(criterion?.ok, false, '缺人审文档必须判红')
  assert.match(criterion?.detail ?? '', /docs\/METHOD-oo\.md/u, `要点名文件：${criterion?.detail}`)
  const basis = methodDocFingerprint(store, 'oo')
  assert.match(criterion?.detail ?? '', new RegExp(basis, 'u'), `要点名当前指纹（模型据此写文档头）：${criterion?.detail}`)
  assert.match(criterion?.detail ?? '', /method-doc: package=oo/u, '要给出可直接使用的文档头写法')
})

test('方法文档：齐全 → 绿；台账再改 → 立即判红（文档即证据，双向）', () => {
  ooWithArtifacts()
  writeMethodDoc(workspace, store, 'oo')
  assert.equal(c2f()?.ok, true, `文档齐全后应通过：${c2f()?.detail}`)

  // 双向：改台账（新增一个类的字段）→ 指纹变化 → 文档过期必须判红
  office.writeMethodArtifact(call(), 'classes', {
    types: [
      { name: 'OrderService', responsibility: '下单并占用座位', collaborators: ['OrderRepo'], leaf: false },
      { name: 'OrderRepo', responsibility: '持久化', collaborators: [], leaf: true },
    ],
  } as never)
  const stale = c2f()
  assert.equal(stale?.ok, false, '台账变更后旧文档必须判红')
  assert.match(stale?.detail ?? '', /不一致|过期/u, `要说明"台账变了、文档没重生成"：${stale?.detail}`)

  // 重新生成（按新指纹）→ 恢复绿
  writeMethodDoc(workspace, store, 'oo')
  assert.equal(c2f()?.ok, true, '重新生成后应恢复通过')
})

test('方法文档：正文漏掉条目 id → 判红并逐个点名（文档不能只写感想）', () => {
  ooWithArtifacts()
  const ids = PACKAGE_ARTIFACT_KINDS['oo']
  assert.ok(ids.length >= 3, '前置：oo 有三类产物')
  writeMethodDoc(workspace, store, 'oo', { omitIds: ['TYPE-002'] })
  const criterion = c2f()
  assert.equal(criterion?.ok, false, '漏条目必须判红')
  assert.match(criterion?.detail ?? '', /TYPE-002/u, `要点名漏掉的 id：${criterion?.detail}`)
})

test('方法文档：指纹写错（头里声明别的值）→ 判红；缺文档头也判红', () => {
  ooWithArtifacts()
  writeMethodDoc(workspace, store, 'oo', { basis: 'deadbeef0000' })
  assert.equal(c2f()?.ok, false, '指纹不符必须判红')
  assert.match(c2f()?.detail ?? '', /deadbeef0000/u, '要点名头里的值')

  const path = join(workspace, 'docs', 'METHOD-oo.md')
  writeFileSync(path, readFileSync(path, 'utf8').replace(/<!-- method-doc[^\n]*-->\n/u, ''), 'utf8')
  assert.equal(c2f()?.ok, false, '缺文档头必须判红')
})

test('方法文档：显式 none / 未选包 → N/A（不拦门禁）', () => {
  setupProject('none', '不采用任何方法包')
  const criterion = c2f()
  assert.equal(criterion?.na, true, `显式 none 应 N/A：${JSON.stringify(criterion)}`)
})

test('方法文档：回执要把「当前指纹」给模型（否则模型写不出文档头）', () => {
  ooWithArtifacts()
  const receipt = renderMethodStatus(office, call())
  const basis = methodDocFingerprint(store, 'oo')
  assert.match(receipt, /人审文档/u, `回执要有"人审文档"一节：${receipt.slice(0, 400)}`)
  assert.match(receipt, /docs\/METHOD-oo\.md/u, '回执要点名文件')
  assert.match(receipt, new RegExp(`basis=${basis}`, 'u'), `回执要给出当前指纹（basis=${basis}）`)
  assert.match(receipt, new RegExp(methodDocHeader('oo', basis).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), '回执要给出可直接抄的文档头')
})
