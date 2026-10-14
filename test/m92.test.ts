/**
 * M92：**质量需求的人读文档与门禁**（DEF-004 / DEF-005 / DEF-006，2026-10-12 狗粮台账）。
 *
 * 三条缺陷原文（用户记进 `.sdo/defects/`）：
 *   · DEF-004 架构阶段建议产物名与判据/渲染名不一致，审核单长期显示「假缺失」（SDD.md / DECISIONS.md）；
 *   · DEF-005 质量场景与 ATAM 无任何人读文档承载（QUALITY.md 缺渲染器）；
 *   · DEF-006 G3 无质量场景判据：质量需求既不在人读文档里也不受门禁约束。
 *
 * 本文件守的就是"三件一起成立"：
 *   ① `docs/QUALITY.md` / `docs/DECISIONS.md` 有渲染器（真源在 `.sdo/`、头绑渲染序号、手改先留副本）；
 *   ② G3 有 `quality.doc` 判据（C-2G）：真源非空 ⇒ 文档必须存在、由当前真源渲染、且每条场景**可度量**；
 *      **真源为空按三态判**（TASK-049 实现 / TASK-057 更正本条注释）：
 *        · **显式声明不做**（适用性声明的 `artifactsAbsent` 带质量类、且给了理由）⇒ **N/A**；
 *        · **从未声明过质量**（journal 里没有 `quality/recorded` 事件）⇒ **N/A**（与 C-2C 同口径：没说要做也没说不做，不判红）；
 *        · **声明过质量属性却被删光**（`quality/recorded{attribute}` 有记录、而 `listScenarios` 归零）⇒ **判红并点名属性**
 *          —— 属 AC-227 的"漏判"：真源归零不得静默变成 N/A，否则"默默删掉证据"就是一条不留痕的捷径；
 *      另：声明不做**却不给理由**（`why` 为空）同样判红；
 *   ③ 架构阶段的建议产物只声明**造得出来**的名字（`SDD.md` 这个没有任何渲染器的名字已消失）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { loadAllProcesses } from '../src/domain/process.js'
import { derivedDocRelativePath, derivedDocSections, renderQualityDoc } from '../src/domain/derivedDocs.js'
import { listScenarios, readAssessment } from '../src/domain/quality.js'
import { parseRenderLang, parseRenderPhase, parseRenderSeq } from '../src/domain/design.js'
import { withLocale } from '../src/domain/i18n.js'
import { t } from '../src/domain/i18n.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m92/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

/** 一条**可度量**的质量场景（有数值口径）。 */
function goodScenario() {
  office.recordScenario(call, {
    attribute: 'performance',
    stimulus: '被接管的会话开始新一轮',
    response: '组装限长注入文本并完成本地判定',
    measure: '注入文本长度 ≤ 1500 字符；本地处理 ≤ 200 毫秒',
    priority: 'high',
    targets: ['DES-001'],
  })
}

function adr() {
  office.recordAdr(call, {
    title: '按职责域划分设计元素',
    context: '上帝对象是改动热点',
    decision: '按职责域划分并登记技术债',
    alternatives: [{ option: '一次性拆分', pros: '边界干净', cons: '回归面大' }],
    consequences: [{ item: '改动面收敛', mitigation: '按域分批迁移' }],
  })
}

/** 取 C-2G 的判定结果。 */
function c2g(): { ok: boolean; na: boolean; detail: string } {
  const criterion = office.evaluate(call, 'G3').criteria.find((item) => item.id === 'C-2G')
  assert.ok(criterion !== undefined, 'G3 必须有 C-2G 判据')
  return { ok: criterion.ok, na: criterion.na === true, detail: criterion.detail }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.init(call, { name: '质量文档', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { 术语: '释义' } })
  office.capture(call, { title: '需求甲', statement: '须可复核', priority: 'must', sourceStakeholder: '业务方' })
  // 设计适用性声明（C-2B 要求）：五视图全做、不做额外非视图工件
  office.draftApplicability(call, {
    focus: '夹具：质量文档与判据',
    viewsPresent: ['context', 'component', 'runtime', 'data', 'deployment'],
    viewsAbsent: [],
    artifacts: [],
    by: '模型起草',
  })
  office.confirmApplicability(call, '就按这份声明走', '业务方')
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M92-01 DEF-005：docs/QUALITY.md 由真源渲染，头绑渲染序号、章节齐备、且幂等', () => {
  goodScenario()
  office.assessQuality(call, { risks: ['覆盖率靠自报'], sensitivities: ['注入长度上限'], tradeoffs: ['广度与预算'], by: '驾驶舱' })

  const relative = office.render(call, 'quality')
  assert.equal(relative, derivedDocRelativePath('quality'))
  const path = join(WORKSPACE, relative)
  assert.ok(existsSync(path), '必须落盘 docs/QUALITY.md')
  const first = readFileSync(path, 'utf8')
  assert.match(first, /@ journal seq \d+/u, '头里必须有渲染序号（否则判据无法证明"由当前真源渲染"）')
  for (const key of derivedDocSections('quality')) {
    assert.ok(first.includes(t(key)), `缺固定章节：${t(key)}`)
  }
  // 质量需求的四件必须可见：刺激 / 响应 / 度量 / 优先级
  for (const text of ['被接管的会话开始新一轮', '组装限长注入文本', '1500 字符']) {
    assert.ok(first.includes(text), `正文必须含：${text}`)
  }
  assert.ok(first.includes('风险点') && first.includes('敏感点') && first.includes('权衡点'), 'ATAM 三件必须都有')

  // **判据的立足点**：盘上那份必须等于"按**头里声明的元信息**（语言/阶段/渲染序号）重渲染"的结果。
  // 不能拿两次 `render` 直接比 —— 渲染会写 `doc/rendered` 留痕，journal 增长 ⇒ 头里的序号必然 +1。
  const strip = (text: string): string => text.split('\n').slice(3).join('\n')
  const seq = parseRenderSeq(first)
  assert.ok(seq !== undefined)
  const store = office.storeFor(WORKSPACE)
  const expected = withLocale(parseRenderLang(first) ?? 'zh-CN', () =>
    renderQualityDoc({
      project: office.status(call).project,
      scenarios: listScenarios(store),
      assessment: readAssessment(store),
      seq,
      phase: parseRenderPhase(first) ?? '',
    }),
  )
  assert.equal(strip(first), strip(expected), '盘上文档必须等于按头里元信息重渲染的结果')
})

test('M92-02 DEF-005：docs/DECISIONS.md 把 ADR 的备选与后果按真实结构展开（不许 [object Object]）', () => {
  adr()
  const relative = office.render(call, 'decisions')
  const text = readFileSync(join(WORKSPACE, relative), 'utf8')
  assert.equal(relative, derivedDocRelativePath('decisions'))
  for (const key of derivedDocSections('decisions')) assert.ok(text.includes(t(key)), `缺固定章节：${t(key)}`)
  assert.ok(text.includes('按职责域划分设计元素'), '标题必须出现')
  assert.ok(text.includes('一次性拆分') && text.includes('边界干净') && text.includes('回归面大'), '备选方案的 option/pros/cons 必须展开')
  assert.ok(text.includes('改动面收敛') && text.includes('按域分批迁移'), '后果的 item/mitigation 必须展开')
  assert.equal(text.includes('[object Object]'), false, '结构体不许被打成 [object Object]')
})

test('M92-03 DEF-006：C-2G 三态 —— 无真源 N/A、有真源缺文档红、渲染后绿', () => {
  // ① 无质量真源 ⇒ N/A（与 C-2C 同口径：既没说要做也没说不做，不判红）
  const before = c2g()
  assert.equal(before.na, true, `无真源应为 N/A，实际：${before.detail}`)

  // ② 有真源但没有文档 ⇒ 红，且理由点名 QUALITY.md
  goodScenario()
  const missing = c2g()
  assert.equal(missing.ok, false)
  assert.equal(missing.na, false)
  assert.ok(missing.detail.includes('QUALITY.md'), `红的原因必须点名文档：${missing.detail}`)

  // ③ 渲染后 ⇒ 绿
  office.render(call, 'quality')
  const passed = c2g()
  assert.equal(passed.ok, true, `渲染后应通过，实际：${passed.detail}`)
})

test('M92-04 DEF-006：不可度量的质量场景判红并点名；补上度量后转绿', () => {
  // 直写真源：一条**没有数值口径**的场景（"尽量快"不是可核对的度量）
  const store = office.storeFor(WORKSPACE)
  const scenario = (measure: string) => ({
    scenario: {
      id: 'QS-001',
      attribute: 'usability',
      stimulus: '用户首次打开侧边栏',
      response: '显示审核单',
      measure,
      priority: 'medium',
      targets: ['DES-001'],
    },
  })
  store.writeYaml(['quality', 'QS-001.yml'], scenario('尽量快'))
  office.render(call, 'quality')
  const bad = c2g()
  assert.equal(bad.ok, false, '不可度量的场景必须判红')
  assert.match(bad.detail, /QS-001/u, '必须点名是哪条场景')

  // 补上可核对的度量（同一 id 覆盖真源）⇒ 重渲染后转绿
  store.writeYaml(['quality', 'QS-001.yml'], scenario('首屏可见时间 ≤ 300 毫秒'))
  office.render(call, 'quality')
  assert.equal(c2g().ok, true, '度量补齐后应转绿')
})

test('M92-05 DEF-006：真源在渲染之后变更 ⇒ C-2G 判陈旧（必须重渲染）', () => {
  goodScenario()
  office.render(call, 'quality')
  assert.equal(c2g().ok, true)
  // 渲染之后再记一条场景 ⇒ 文档陈旧
  office.recordScenario(call, {
    attribute: 'reliability',
    stimulus: '宿主重启',
    response: '从 journal 重建投影',
    measure: '重建耗时 ≤ 500 毫秒，且事件数与校验和一致',
    priority: 'high',
    targets: ['DES-001'],
  })
  const stale = c2g()
  assert.equal(stale.ok, false, '真源变更后必须判陈旧')
  assert.ok(stale.detail.includes('陈旧') || stale.detail.includes('stale'), `理由应说明陈旧：${stale.detail}`)
  office.render(call, 'quality')
  assert.equal(c2g().ok, true, '重渲染后转绿')
})

test('M92-06 DEF-006：手改 docs/QUALITY.md ⇒ C-2G 判红（整份文件与真源重渲染比对）', () => {
  goodScenario()
  office.render(call, 'quality')
  const path = join(WORKSPACE, derivedDocRelativePath('quality'))
  writeFileSync(path, readFileSync(path, 'utf8').replace('## 2.', '## 2.（手改）'), 'utf8')
  const edited = c2g()
  assert.equal(edited.ok, false, '手改必须判红')
})

test('M92-07 DEF-006：声明"不做质量场景"但**不给理由** ⇒ 判红（与 C-2C 同口径）', () => {
  office.draftApplicability(call, {
    focus: '夹具：声明不做质量却不给理由',
    viewsPresent: ['context', 'component', 'runtime', 'data', 'deployment'],
    viewsAbsent: [],
    artifacts: [],
    artifactsAbsent: [{ kind: 'quality', why: '   ' }],
    by: '模型起草',
  })
  office.confirmApplicability(call, '就按这份声明走', '业务方')
  const bad = c2g()
  assert.equal(bad.ok, false, '声明不做却不给理由必须判红')
})

test('M92-08 DEF-004：架构阶段的建议产物只许出现"造得出来"的名字（SDD.md 已消失）', () => {
  const allowed = new Set(['DESIGN.md', 'DECISIONS.md', 'QUALITY.md'])
  for (const process of loadAllProcesses()) {
    const architecture = process.phases.find((phase) => phase.id === 'architecture')
    assert.ok(architecture !== undefined, `${process.id} 必须有架构阶段`)
    for (const name of architecture.suggestedArtifacts ?? []) {
      assert.ok(
        allowed.has(name),
        `${process.id} 的架构建议产物「${name}」没有任何渲染器 ⇒ 审核单会长期显示假缺失（DEF-004）`,
      )
    }
    assert.equal(
      (architecture.suggestedArtifacts ?? []).includes('SDD.md'),
      false,
      `${process.id} 仍声明 SDD.md：它的内容就是 docs/DESIGN.md（C-25 强制），重名会造成假缺失`,
    )
  }
})

test('M92-09 DEF-006：C-2G 已挂进四套流程的 G3（判据存在但没注册 = 没约束）', () => {
  for (const process of loadAllProcesses()) {
    const g3 = process.gates.find((gate) => gate.id === 'G3')
    assert.ok(g3 !== undefined, `${process.id} 必须有 G3`)
    const criterion = g3.criteria.find((item) => item.id === 'C-2G')
    assert.ok(criterion !== undefined, `${process.id} 的 G3 缺 C-2G`)
    assert.equal(criterion.check, 'quality.doc')
  }
})

test('M92-10 DEF-006／AC-227：**声明过质量属性却被删光** ⇒ C-2G 判红并点名属性（不是 N/A）；补回场景 ⇒ 转绿（TASK-057 补）', () => {
  // 为什么补这条：文件头注释与既有用例只覆盖了「从未声明 ⇒ N/A」那一态，
  // 而 C-2G 的三态里最容易被漏掉的是「**声明过**（journal 有 `quality/recorded`）却被删光」——
  // 它必须是**判红并点名**，否则"默默删掉证据"就是一条不留痕的捷径（AC-227）。
  const store = office.storeFor(WORKSPACE)

  // ① 先证"声明过"这件事真的发生过：登记一条场景后，属性进了 append-only 真源，C-2G 绿
  goodScenario()
  office.render(call, 'quality')
  assert.equal(c2g().ok, true, `有真源 + 文档新鲜 ⇒ 必须绿：${c2g().detail}`)
  assert.deepEqual(listScenarios(store).map((item) => item.id), ['QS-001'], '前置：真源里确实有这条场景')

  // ② 把场景与 ATAM 全部删光（真源归零）⇒ 红，且点名**被声明的属性**
  store.remove('quality', 'QS-001.yml')
  store.remove('quality', 'atam.yml')
  assert.deepEqual(listScenarios(store), [], '前置：真源确实归零了')
  const cleared = c2g()
  assert.equal(cleared.ok, false, `声明过却被删光必须判红，不许静默判过：${cleared.detail}`)
  assert.equal(cleared.na, false, '**没有**显式声明"不做"就不是不适用（这是 AC-227 的分界）')
  assert.match(cleared.detail, /performance/u, `必须点名被声明的质量属性：${cleared.detail}`)

  // ③ 反向对照：同一份真源**补回场景**后转绿 ⇒ 上面那条红确实是"真源归零"造成的，不是恒红
  goodScenario()
  office.render(call, 'quality')
  assert.equal(c2g().ok, true, `补回场景并重渲染后必须转绿：${c2g().detail}`)
})
