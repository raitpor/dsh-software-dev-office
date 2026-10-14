/**
 * M91：**受审载荷的工件级呈现**（2026-10-12 用户 G3 评审反馈）。
 *
 * 用户逐字反馈："我在G3签字评审时又遇到了上次G2评审文档的表述不清问题，改。其他门禁评审也按
 * 现在G2文档风格。"
 *
 * 根因（真机 G3 审核单的目录暴露出来的）：`design/` 目录里**混着六种工件** ——
 * 设计适用性声明（`applicability.yml`）、视图（`component.yml` 等）、界面方案（`ui.yml`）、
 * 设计方法选择（`method.yml`）、方法产物（`method-*.yml`）、用户确认戳（`confirmed.yml`）；
 * `quality/` 里也混着质量场景（`QS-*.yml`）与 ATAM 工件（`atam.yml`）。
 * 旧实现把它们**全按"集合的默认形态"渲染** ⇒ 标题行只剩文件名或英文 kind
 * （`#### applicability`、`#### component`、`#### MA-001　classes`、`#### atam　质量场景：`），
 * 正文整段掉进「其他字段」。
 *
 * 两条守卫（都是机械可复算的）：
 *   M91-01：**每条标题行都必须带得出人话名称**，且不许把原始 YAML 键当标签、取值要过人话映射；
 *   M91-02：**所有流程声明的受审集合都要有显式呈现规则**（不许静默落进兜底默认 —— 那正是"不清楚"的来源）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { loadAllProcesses } from '../src/domain/process.js'
import { COLLECTION_VIEWS, artifactOf } from '../src/domain/reviewView.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m91/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.init(call, { name: '工件呈现', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { 术语: '释义' } })
  office.capture(call, { title: '需求甲', statement: '须可复核', priority: 'must', sourceStakeholder: '业务方' })

  // ── 架构阶段的真源：**六种工件**各来一份（形状照抄真机台账）────────────────
  const store = office.storeFor(WORKSPACE)
  store.writeYaml(['design', 'applicability.yml'], {
    applicability: {
      focus: '存量项目的架构补录：把既有实现补录为可复核台账。',
      viewsPresent: ['component', 'data'],
      viewsAbsent: [],
      artifacts: ['invariants'],
      artifactsAbsent: [{ kind: 'mapping', why: '本项目没有「旧→新」两套实现并存，映射表没有对手方。' }],
      confirmed: { by: 'human', at: '2026-10-12T12:00:00.000Z', basis: '就按这份确认' },
    },
  })
  store.writeYaml(['design', 'component.yml'], {
    view: {
      kind: 'component',
      summary: '',
      elements: [
        {
          id: 'DES-006',
          name: '门禁引擎',
          kind: '组件',
          layer: 'domain',
          responsibility: '流程即数据的解析与门禁判定。',
          dependsOn: [],
          requires: [],
          confidence: 'high',
        },
      ],
    },
  })
  store.writeYaml(['design', 'ui.yml'], {
    ui: {
      id: 'UI-001',
      style: { source: 'follow-host', tokens: { 'sdo-doc-max-width': '72ch' }, rationale: '与宿主一致' },
      screens: [
        { id: 'SCR-001', name: '门禁签字审核单', columns: [{ name: '判定总览', kind: '摘要' }], layout: { grid: '单列纵向' } },
      ],
      breakpoints: [{ name: '窄栏', width: '< 420px', changes: ['判据表退化为定义列表'] }],
      accessibility: { contrast: '>= 4.5:1', keyboard: true, screenReader: '标签页可被读屏识别' },
    },
  })
  store.writeYaml(['design', 'method.yml'], {
    method: { question: 'Q-0008', answer: 'oo+evolutionary（面向对象 + 敏捷-演进式）', status: 'chosen', methods: ['oo', 'evolutionary'] },
  })
  store.writeYaml(['design', 'method-classes.yml'], {
    artifact: {
      id: 'MA-001',
      kind: 'classes',
      summary: '按层给出关键类型、职责与协作方。',
      types: [
        {
          id: 'TYPE-001',
          name: 'SdoStore',
          kind: 'class',
          layer: 'infra',
          responsibility: '真源读写门面。',
          collaborators: ['SdoJournal', 'SdoYaml'],
        },
      ],
    },
  })
  store.writeYaml(['design', 'confirmed.yml'], {
    confirmations: [{ target: 'CT-001', basis: '确认这9条', by: 'human', basisSource: 'user', contentHash: 'sha256:abc' }],
  })
  store.writeYaml(['quality', 'QS-001.yml'], {
    scenario: {
      id: 'QS-001',
      attribute: 'performance',
      stimulus: '被接管的会话开始新一轮',
      response: '组装限长注入文本并完成本地判定',
      measure: '注入文本 ≤ 1500 字符',
      priority: 'high',
      targets: ['DES-006'],
    },
  })
  store.writeYaml(['quality', 'atam.yml'], {
    assessment: { by: 'SDO 驾驶舱', risks: ['客户端半的打开动作任一处缺失都表现为静默降级'], sensitivities: ['注入长度上限越丰富越接近上界'] },
  })
  store.writeYaml(['contracts', 'CT-001.yml'], {
    contract: {
      id: 'CT-001',
      name: '接口面（工具与命令）',
      kind: 'schema',
      producer: '工具面',
      consumer: '领域层',
      schema: { request: "{ tool: 'sdo_*', action: string }" },
      failureSemantics: { timeout: '本地判定不含模型调用' },
      requires: [],
    },
  })
  store.writeYaml(['decisions', 'ADR-001.yml'], {
    adr: {
      id: 'ADR-001',
      title: '设计元素按职责域划分',
      status: 'accepted',
      context: '上帝对象是改动热点',
      decision: '按职责域划分并登记技术债',
      alternatives: ['一次性拆分'],
      consequences: ['改动面收敛'],
    },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function g3(): string {
  office.signReview(call, 'G3')
  return readFileSync(join(WORKSPACE, '.sdo/evidence/sign-reviews/G3.md'), 'utf8')
}

test('M91-01 G3 受审载荷：每条标题行都必须带得出人话名称，且不许把原始键当标签', () => {
  const doc = g3()
  const headings = doc.split('\n').filter((line) => line.startsWith('#### '))
  assert.ok(headings.length >= 10, `夹具应当渲染出足够多的条目，实际 ${headings.length} 条`)

  // ① **通用判据**：每条标题都是 `#### <代号>　<名称>`（`　` 是全角空格分隔符），不许只有代号或文件名
  for (const line of headings) {
    assert.match(line, /^#### \S+　\S/u, `标题行必须带名称（用户原话：只写代号不说内容）：${line}`)
  }

  // ② 六种工件各自的人话标题（G3 真机上它们曾是 `#### applicability` / `#### component` / …）
  for (const wanted of [
    '设计适用性声明',
    '视图：组件视图',
    '界面方案',
    '设计方法选择',
    '方法产物：类与接口清单',
    '用户确认戳',
    '质量场景：性能',
    'ATAM 分析',
  ]) {
    assert.ok(doc.includes(wanted), `G3 审核单必须出现人话标题「${wanted}」`)
  }

  // ③ 原始 YAML 键**不许**当标签（G3 真机的"表述不清"主体）
  for (const raw of [
    '**focus**',
    '**viewsPresent**',
    '**elements**',
    '**screens**',
    '**types**',
    '**summary**',
    '**style**',
    '**responsibility**',
    '**kind**',
    '**from**',
    '**to**',
    '**trigger**',
    '- confirmed：',
  ]) {
    assert.equal(doc.includes(raw), false, `不许把原始键当标签：${raw}`)
  }

  // ④ 取值要过人话映射（受控词表：kind / layer / priority / status）
  assert.ok(doc.includes('层 基础设施层'), '取值 `infra` 必须映射成「基础设施层」')
  assert.ok(doc.includes('类型 类'), '取值 `class` 必须映射成「类」')
  assert.ok(doc.includes('优先级 **高**'), '取值 `high` 必须映射成「高」')
  assert.ok(doc.includes('状态 **已接受**'), '取值 `accepted` 必须映射成「已接受」')

  // ⑤ 代号要带名称（G2 那轮的口径在架构工件上同样成立）
  assert.ok(doc.includes('CT-001「接口面（工具与命令）」'), '引用代号必须解析成「代号+名称」')
  assert.ok(doc.includes('DES-006「门禁引擎」'), '质量场景的 targets 也要解析')
})

test('M91-02 工件分派：design/quality 下的每种工件都有自己的呈现规则', () => {
  // 分派本身就是可机械断言的行为（G3 的病根就是"全按一种形态渲染"）
  assert.equal(artifactOf('design', 'design/applicability.yml', {}), 'applicability')
  assert.equal(artifactOf('design', 'design/component.yml', {}), 'view')
  assert.equal(artifactOf('design', 'design/ui.yml', {}), 'ui')
  assert.equal(artifactOf('design', 'design/method.yml', {}), 'methodChoice')
  assert.equal(artifactOf('design', 'design/method-classes.yml', {}), 'artifact')
  assert.equal(artifactOf('design', 'design/confirmed.yml', {}), 'confirmations')
  assert.equal(artifactOf('quality', 'quality/atam.yml', {}), 'atam')
  assert.equal(artifactOf('quality', 'quality/QS-001.yml', {}), 'entry')
  // 形状兜底：没有 id/title 的视图（外层 `view:`）也能被认出来
  assert.equal(artifactOf('design', 'unknown.yml', { kind: 'component', elements: [] }), 'view')
})

test('M91-03 跨门禁一致性：所有流程声明的受审集合都必须有**显式**呈现规则', () => {
  const declared = new Set<string>()
  for (const process of loadAllProcesses()) {
    for (const phase of process.phases) {
      for (const collection of phase.reviewPayload ?? []) declared.add(collection)
    }
  }
  assert.ok(declared.size >= 10, `流程声明的受审集合应当覆盖各阶段，实际 ${declared.size} 个`)
  const missing = [...declared].filter((collection) => COLLECTION_VIEWS[collection] === undefined)
  assert.deepEqual(
    missing,
    [],
    `这些受审集合没有显式呈现规则（会落进兜底默认 ⇒ 又是"表述不清"）：${missing.join('、')}`,
  )
})
