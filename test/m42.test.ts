/**
 * 真机报告（2026-10-05 23:00 追加）新增三条的回归。
 *
 *   · **SDO-30b**：派发排序读不出「必须最后跑」的语义 —— 最终全量构建卡（TASK-132）与写卡同时就绪时被
 *     **并发**派出，跑出的 jar 必然过期（少了同批写卡的改动）。`blockedBy` 只能表达"排在某几张卡之后"，
 *     表达不了"排在**所有**卡之后"。修法：支持 **`blockedBy: ['*']`**（通配依赖），并保证：
 *     ① 依赖存在性校验不把 `*` 当"不存在的卡"；② 依赖环遍历跳过它；③ 其它卡没做完前它不 ready；
 *     ④ 「等 `*`」的卡在"为什么还不能派"里如实显示。
 *   · **SDO-32 / SDO-31** 是**纪律类**发现（空集合假绿 / 评审清单当可执行清单），落在角色卡上：
 *     这类知识只有在执行者真会读到的位置才有用，所以用例钉的是"角色卡里确实写了这几条"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { loadPackagedYaml } from '../src/infra/data.js'
import { blockedTasks, readyTasks, validatePlan } from '../src/domain/plan.js'
import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { parseRenderLang, parseRenderPhase, parseRenderSeq } from '../src/domain/design.js'
import { derivedDocRelativePath, renderQualityDoc } from '../src/domain/derivedDocs.js'
import { listScenarios, readAssessment } from '../src/domain/quality.js'
import { withLocale } from '../src/domain/i18n.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm42')
/** 质量/产物夹具的**独立**工作区（与上面 m42 的 `BASE` 分开，避免互踩）。 */
const QUALITY_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm42-quality')
const QUALITY_WORKSPACE = join(QUALITY_BASE, 'proj')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function card(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
    ...overrides,
  }
}

test('SDO-30b：`blockedBy: [\'*\']` 的卡必须等到**其它所有卡**都完成才 ready（独占窗口）', () => {
  const finale = card('TASK-132', { blockedBy: ['*'] })
  const writer = card('TASK-133')
  const done = card('TASK-130', { status: 'done' })

  // ① 还有别的卡没完成 ⇒ 最终卡不 ready（write 卡照常 ready）
  const early = readyTasks([finale, writer, done], 8).map((task) => task.id)
  assert.deepEqual(early, ['TASK-133'], `最终卡不许与写卡并发派出：${early.join(' ')}`)
  const waiting = blockedTasks([finale, writer, done]).find((item) => item.task.id === 'TASK-132')
  assert.deepEqual(waiting?.waitingOn, ['*'], '要如实说明它在等"所有其它卡"')

  // ② 其它卡全部完成 ⇒ 最终卡 ready
  const late = readyTasks([finale, { ...writer, status: 'done' }, done], 8).map((task) => task.id)
  assert.deepEqual(late, ['TASK-132'], '所有卡完成后最终卡才放行')

  // ③ 作废（dropped）的卡不该把它永久挡住
  const dropped = card('TASK-136', { status: 'dropped' })
  const withDropped = readyTasks([finale, { ...writer, status: 'done' }, dropped], 8).map((task) => task.id)
  assert.deepEqual(withDropped, ['TASK-132'], 'dropped 不算"还没做完"')

  // ④ 计划校验不许把 `*` 当成"引用了不存在的卡"，也不许判成环
  const issues = validatePlan([finale, writer])
  assert.deepEqual(issues.map((item) => item.code), [], `\`*\` 是通配依赖：${JSON.stringify(issues)}`)
})

test('SDO-32 / SDO-31：纪律落在角色卡上（空集合假绿 / 评审清单是假设）——执行者真会读到的位置', () => {
  const tester = readFileSync(join(ROOT, 'skills', 'role-tester.md'), 'utf8')
  assert.match(tester, /空集合断言/u, '测试角色卡要写"空集合断言"这一形态')
  assert.match(tester, /先断言集合非空|先证集合非空/u, '要给出可执行的动作（先证非空）')
  assert.match(tester, /负向对照/u, '负向对照要先证"修复前触发过"')
  assert.match(tester, /变异自证|把被测逻辑改坏/u, '恒真断言要用变异自证抓')

  const reviewer = readFileSync(join(ROOT, 'skills', 'role-reviewer.md'), 'utf8')
  assert.match(reviewer, /已核实 \/ 待核实/u, 'finding 必须自标"已核实/待核实"')
  assert.match(reviewer, /不是动作项|不得被当成 DoD 的动作清单/u, '要写明"待核实项不是动作项"')

  const developer = readFileSync(join(ROOT, 'skills', 'role-developer.md'), 'utf8')
  assert.match(developer, /待核对的假设，不是可执行清单/u, '承接评审清单前先逐条机械复核')
  assert.match(developer, /验证.*而不是采信|默认动作是\*\*验证\*\*/u, '默认动作是验证而非采信')
})

test('语言包守卫补强：两个包必须**解析成功**（YAML 打坏时 `t()` 会静默回退成键名，M11/DoR 那批用例才会红）', () => {
  // 真机 2026-10-05（本轮自曝）：往双引号 YAML 值里写 ASCII 双引号把整包打坏，
  // `t()` 于是回退成键名（`pkgMissing；pkgNotSelected；…`），而**语言包守卫本身没红** ——
  // 是 M11/DoR 那批"正文对不上"的用例替它报的警。这里补一条直球守卫：解析必须成功。
  for (const file of ['zh-CN.yml', 'en.yml']) {
    const tables = loadPackagedYaml(`src/data/lang/${file}`) as Record<string, Record<string, string>>
    // 各区段抽查一个键：值不能等于键名（等于键名 = 该区段整段没解析出来）
    for (const [section, key] of [['uiMethod', 'pkgMissing'], ['uiDesign', 'docElementResp'], ['param', 'suggestions'], ['uiIndex', 'kFreshChild']] as const) {
      const value = tables[section]?.[key]
      assert.notEqual(value, undefined, `${file} 缺 ${section}.${key}`)
      assert.notEqual(value, key, `${file} 的 ${section}.${key} 回退成了键名（多半是 YAML 没解析出来）`)
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// TASK-023：**三条已修缺陷的守卫用例**（DEF-004 / DEF-005 / DEF-006）
//
// 三条缺陷都落在"质量需求与阶段产物"这条缝上（`.sdo` 狗粮台账，2026-10-12 登记、当天修）：
//   · DEF-004 架构阶段建议产物名与判据/渲染名不一致 ⇒ 审核单长期显示**补不上的「假缺失」**；
//   · DEF-005 质量场景与 ATAM **无任何人读文档承载**（只有 `.sdo/quality/*.yml` 真源）；
//   · DEF-006 G3 **无质量场景判据**：质量需求既不在人读文档里、也不受门禁约束。
//
// 守卫纪律（角色卡「断言纪律」+ TASK-029 的次序纪律）：
//   ① 每条判据都写成**两态**：把属性删掉 ⇒ 判红**并点名**；补回 ⇒ 转绿。只测绿态等于没测；
//   ② 先证红态的触发条件在**当前实现**上真的成立（不是空条件上的"会误报"）；
//   ③ 负向对照：纯函数同输入必须逐字节同输出，**换入参必须变**（否则"逐字节一致"是恒真断言）；
//   ④ 每条修复都要做**变异自证**（回滚修复 ⇒ 对应用例转红）—— 变异命令与结果记在卡证据里。
//
// ⚠️ **本文件里两条守卫在写下这一刻是红的，而且必须继续红**（TASK-023，2026-10-13 实测）：
//   它们不是在测"已完成的行为"，而是把**尚未落地的 DoD 句子**钉成红灯。核实过的缺口有两处，
//   都在 `src/`（本卡写范围只有 `test/m42.test.ts`，改不了被测实现）：
//     · AC-227「某条声明的质量属性没有任何场景 ⇒ 判红并点名」：C-2G 在真源为空时直接判 **N/A**
//       （`src/domain/gates.ts`：只有"声明了不做却不给理由"才红）⇒ 删掉唯一场景不会变红；
//     · AC-228/AC-229「产物表分建议/必需两栏 + 明示对齐关系 + 缺失给可执行修法」：
//       `src/domain/reviewDoc.ts` 的产物表仍是**单栏**（`| 产物 | 状态 | 字节 |`），
//       流程数据只有 `suggestedArtifacts`、没有 `requiredArtifacts`（`src/office.ts:1733`），
//       语言包也没有「必需产物」/「对齐到规范名」文案。
//   旧口径（`test/m92.test.ts` 的 M92-08）只验了"建议名已换成造得出来的名字"，没验分栏与对齐 ——
//   于是这两句 DoD 在"测试全绿"的表象下一直没兜住。**修好实现后这两条自然转绿，无需改断言。**
// ═══════════════════════════════════════════════════════════════════════════════════════

let qualityOffice: SoftwareDevOffice
const qualityCall = { sessionId: 's1', cwd: QUALITY_WORKSPACE } as unknown as OfficeCall

/** 建一个**装了质量真源**的样例工作区：项目 + 一条 must 需求 + 设计适用性声明（五视图全做）。 */
function seedQualityWorkspace(): void {
  qualityOffice = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  qualityOffice.init(qualityCall, { name: '质量守卫', scale: 'normal', stakeholders: ['业务方'] })
  qualityOffice.updateProject(qualityCall, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { 术语: '释义' } })
  qualityOffice.capture(qualityCall, { title: '需求甲', statement: '须可复核', priority: 'must', sourceStakeholder: '业务方' })
  // C-2B 要求：每个视图显式二选一（这里五视图全做、不做额外非视图工件）
  qualityOffice.draftApplicability(qualityCall, {
    focus: '夹具：三条缺陷的守卫',
    viewsPresent: ['context', 'component', 'runtime', 'data', 'deployment'],
    viewsAbsent: [],
    artifacts: [],
    by: '模型起草',
  })
  qualityOffice.confirmApplicability(qualityCall, '就按这份声明走', '业务方')
}

/** 取 G3 的 C-2G（`quality.doc`）三态判定。 */
function c2g(call: OfficeCall = qualityCall): { ok: boolean; na: boolean; detail: string } {
  const criterion = qualityOffice.evaluate(call, 'G3').criteria.find((item) => item.id === 'C-2G')
  assert.ok(criterion !== undefined, 'G3 必须有 C-2G 判据（DEF-006 的落点）')
  return { ok: criterion.ok === true, na: criterion.na === true, detail: criterion.detail }
}

/** 一条**可度量**的场景（有数值口径），挂到一个设计元素上。 */
function goodScenario(call: OfficeCall = qualityCall): void {
  qualityOffice.recordScenario(call, {
    attribute: 'performance',
    stimulus: '被接管的会话开始新一轮',
    response: '组装限长注入文本并完成本地判定',
    measure: '注入文本长度 ≤ 1500 字符；本地处理 ≤ 200 毫秒',
    priority: 'high',
    targets: ['DES-001'],
  })
}

/** 直写真源的一条场景（用于构造"缺某属性"的形态；形状与 `.sdo/quality/QS-*.yml` 一致）。 */
function writeScenario(
  id: string,
  fields: { attribute?: string; stimulus?: string; response?: string; measure?: string; targets?: string[] },
  call: OfficeCall = qualityCall,
): void {
  const store = qualityOffice.storeFor(call.cwd ?? QUALITY_WORKSPACE)
  store.writeYaml(['quality', `${id}.yml`], {
    scenario: {
      id,
      attribute: fields.attribute ?? 'reliability',
      stimulus: fields.stimulus ?? '宿主重启',
      response: fields.response ?? '从 journal 重建投影',
      measure: fields.measure ?? '重建耗时 ≤ 500 毫秒',
      priority: 'high',
      targets: fields.targets ?? ['DES-001'],
    },
  })
}

beforeEach(() => {
  rmSync(QUALITY_BASE, { recursive: true, force: true })
  mkdirSync(QUALITY_WORKSPACE, { recursive: true })
  seedQualityWorkspace()
})

afterEach(() => {
  rmSync(QUALITY_BASE, { recursive: true, force: true })
})

test('TASK-023／DEF-005：QUALITY.md 渲染幂等（同真源同序号逐字节一致 + 换入参必变），且真源变更后 C-2G 判过期并点名', () => {
  goodScenario()
  qualityOffice.assessQuality(qualityCall, { risks: ['r'], sensitivities: ['s'], tradeoffs: ['t'], by: '驾驶舱' })
  const relative = qualityOffice.render(qualityCall, 'quality')
  assert.equal(relative, derivedDocRelativePath('quality'), '渲染落点必须是 docs/QUALITY.md')
  const first = readFileSync(join(QUALITY_WORKSPACE, relative), 'utf8')
  const seq = parseRenderSeq(first)
  assert.notEqual(seq, undefined, '渲染头必须绑渲染序号（否则判据无法证明"由当前真源渲染"）')
  assert.equal(c2g().ok, true, `渲染后必须绿：${c2g().detail}`)

  // ① 幂等：盘上那份 == 「同真源 + 头里声明的序号/语言/阶段」重渲染的结果（逐字节，含渲染头）。
  const store = qualityOffice.storeFor(QUALITY_WORKSPACE)
  const rerender = (withSeq: number | undefined): string =>
    withLocale(parseRenderLang(first) ?? 'zh-CN', () =>
      renderQualityDoc({
        project: qualityOffice.status(qualityCall).project,
        scenarios: listScenarios(store),
        assessment: readAssessment(store),
        seq: withSeq ?? seq ?? 0,
        phase: parseRenderPhase(first) ?? '',
      }),
    )
  assert.equal(first, rerender(undefined), '同真源同序号必须逐字节一致（幂等）')

  // ── **TASK-068 补断言**（处置 TASK-023 记录①那条 survived：删掉场景「刺激」的取值 ⇒
  //    补这条之前整份文件 7/7 全绿、存活）──
  // 场景四件（刺激 / 响应 / 度量 / 属性）必须**真的落到人读文档正文**里：删掉真源里的取值、
  // 或停掉渲染器那一行输出，都必须在这条断言上转红（TASK-023 的 DoD ② 钉的正是"defect 不能只在
  // `.sdo/quality/*.yml` 里可读、人读文档却读不到"）。
  // 先证明"取值真的在真源里"——否则下面的正文断言可能落在空夹具上（前置断言不是装饰）。
  assert.equal(listScenarios(store).length, 1, '前置：真源里确实有这条场景')
  assert.equal(listScenarios(store)[0]?.stimulus, '被接管的会话开始新一轮', '前置：真源里「刺激」的取值非空')
  for (const text of ['被接管的会话开始新一轮', '限长注入文本', '≤ 200 毫秒'] as const) {
    assert.ok(
      first.includes(text),
      `docs/QUALITY.md 正文必须含场景「${text}」（真源四件落到人读文档，DEF-005 的落点）：\n${first.slice(0, 800)}`,
    )
  }

  // ② 负向对照：**换入参必须变** —— 否则上面那条"逐字节一致"是恒真断言（角色卡：恒真断言要变异自证）。
  assert.notEqual(first, rerender((seq ?? 0) + 1), '渲染序号变了，正文必须跟着变（防线：断言不是恒真）')
  assert.notEqual(
    first,
    withLocale(parseRenderLang(first) ?? 'zh-CN', () =>
      renderQualityDoc({
        project: qualityOffice.status(qualityCall).project,
        scenarios: [...listScenarios(store), {
          id: 'QS-999', attribute: 'performance', stimulus: 'x', response: 'y', measure: '≤ 1 毫秒', priority: 'low', targets: [], at: '',
        }],
        assessment: readAssessment(store),
        seq: seq ?? 0,
        phase: parseRenderPhase(first) ?? '',
      }),
    ),
    '真源多一条场景，正文必须跟着变（防线：断言不是恒真）',
  )

  // ③ 真源变更 ⇒ 过期（必须重渲染），且理由**点名**改了质量真源的事件
  goodScenario()
  const stale = c2g()
  assert.equal(stale.ok, false, '真源变更后必须判过期（不许拿旧渲染当"当前真源"）')
  assert.equal(stale.na, false, '这是"陈旧"，不是"不适用"')
  assert.ok(/陈旧|stale/u.test(stale.detail), `理由必须说明陈旧：${stale.detail}`)
  assert.ok(stale.detail.includes('docs/QUALITY.md'), `理由必须点名文档：${stale.detail}`)
  assert.ok(/quality\/recorded/u.test(stale.detail), `理由必须点名是质量真源变了：${stale.detail}`)

  // ④ 重渲染 ⇒ 转绿（两态闭合）
  qualityOffice.render(qualityCall, 'quality')
  assert.equal(c2g().ok, true, '重渲染后必须转绿')
})

test('TASK-023／DEF-006：质量场景缺可核对度量 ⇒ C-2G 判红并点名场景 id；补回度量 ⇒ 转绿（两态）', () => {
  // 直写真源：一条"尽量快"式的场景 —— 有刺激、有响应、**没有可核对的度量**
  writeScenario('QS-001', { measure: '尽量快' })
  qualityOffice.render(qualityCall, 'quality')
  const red = c2g()
  assert.equal(red.ok, false, `不可度量的场景必须判红（实际：${red.detail}）`)
  assert.equal(red.na, false, '这是"不可度量"，不是"不适用"')
  assert.ok(red.detail.includes('QS-001'), `必须点名是哪条场景：${red.detail}`)

  // 补回可核对的度量（同一 id 覆盖真源）⇒ 重渲染后转绿
  writeScenario('QS-001', { measure: '首屏可见时间 ≤ 300 毫秒' })
  qualityOffice.render(qualityCall, 'quality')
  assert.equal(c2g().ok, true, '度量补齐后必须转绿')
})

// ⚠️ **已知红（缺口在 `src/domain/gates.ts`，不在本卡写范围）**：真源归零时 C-2G 判 N/A 而不是判红，
// 与 AC-227「某条声明的质量属性没有任何场景 ⇒ 判红并点名」不符。修好 C-2G 的"真源为空"分支后本用例转绿。
test('TASK-023／DEF-006：已声明属性的场景被删掉（真源归零）⇒ C-2G 判红并点名"没有质量真源/未声明不做"；补回场景 ⇒ 转绿（两态）', () => {
  const store = qualityOffice.storeFor(QUALITY_WORKSPACE)
  goodScenario()
  qualityOffice.render(qualityCall, 'quality')
  assert.equal(c2g().ok, true, '有真源 + 文档新鲜 ⇒ 必须绿')
  // **负向对照的触发条件必须真的成立**（角色卡：先证它触发过）——
  // 删之前先证明"场景真的在真源里"，否则下面的红是在空条件上断言"会误报"。
  assert.deepEqual(listScenarios(store).map((item) => item.id), ['QS-001'], '前置：真源里确实有这条场景')

  // 删掉唯一一条场景（真源归零）⇒ 没有"未声明不做"的显式理由时不许静默判过
  store.remove('quality', 'QS-001.yml')
  store.remove('quality', 'atam.yml')
  assert.deepEqual(listScenarios(store), [], '前置：真源确实归零了')
  const red = c2g()
  assert.equal(red.ok, false, `场景被删光后不许静默判过（实际：${red.na ? 'N/A' : '通过'} —— ${red.detail}）`)
  assert.equal(red.na, false, '没有声明"不做"就不是不适用')
  assert.ok(/QUALITY\.md|质量/u.test(red.detail), `必须点名文档或质量真源：${red.detail}`)

  // 补回场景（真源非空）⇒ 重渲染后转绿
  goodScenario()
  qualityOffice.render(qualityCall, 'quality')
  assert.equal(c2g().ok, true, '补回场景并重渲染后必须转绿')
})

// **TASK-049 已补齐实现，本文件原来那两条"已知红"如今全绿**（TASK-057 更正本条注释）：
//   · AC-227「某条声明的质量属性没有任何场景 ⇒ 判红并点名」：C-2G 的真源为空分支已按三态实现
//     （显式声明不做 ⇒ N/A；**声明过却被删光 ⇒ 判红并点名**；从未声明 ⇒ N/A）⇒ 删掉唯一场景会判红；
//   · AC-228/AC-229「产物表分建议/必需两栏 + 明示对齐关系 + 缺失给可执行修法」：`src/domain/reviewDoc.ts`
//     已渲染两栏 + 对齐节（`uiSignReview.alignmentHeading` / `alignmentItem`）。
//
// ⚠️ **但 TASK-057 实测到一处"断言恒真"**：本文件原先那条对齐断言是
//     `/对齐到规范名|规范名/u.test(artifactTable)` —— 它的 `|规范名` 那一支会被**必需栏表头**
//     文字「必需产物（规范名）」（`uiSignReview.colRequired`）满足；而本文件夹具里
//     建议名恰好都等于规范名 ⇒ **「名字对齐」节从不渲染**，这条断言**不可能失败**
//     （TASK-023 的变异实测：停用对齐节渲染、或改掉对齐文案 ⇒ 断言仍绿，两条 survived 同源）。
//     TASK-057 的修法：① 夹具里造出「建议名 ≠ 规范名」（根下手写 `DESIGN.md` ⇒ 与规范落点
//     `docs/DESIGN.md` 不一致），让对齐节**真的渲染**；② 把正则收紧为 `（对齐到规范名`，
//     去掉被表头满足的 `|规范名` 那一支；③ 断言对齐节标题存在、且两个名字与对齐动作同现。
test('TASK-023／DEF-004：审核单的「本门相关产物」表分「建议 / 必需」两栏，并明示建议名与渲染名的对齐关系（AC-228）', () => {
  goodScenario()
  qualityOffice.assessQuality(qualityCall, { risks: ['r'], sensitivities: ['s'], tradeoffs: ['t'], by: '驾驶舱' })
  qualityOffice.render(qualityCall, 'quality')
  qualityOffice.render(qualityCall, 'decisions')
  const { full } = qualityOffice.signReview(qualityCall, 'G3')
  // 侧边栏/归档读到的必须是**同一份**（客户端半按固定路径取全文）
  const onDisk = readFileSync(join(QUALITY_WORKSPACE, '.sdo', 'evidence', 'sign-reviews', 'G3.md'), 'utf8')
  assert.equal(onDisk, full, '落盘的那份必须与返回的全文逐字节一致')

  // ① 建议名单以流程数据为唯一真源（架构阶段：DESIGN.md / DECISIONS.md / QUALITY.md）
  const artifactTable = full.slice(full.indexOf('本门相关产物'))
  assert.notEqual(artifactTable, '', '审核单必须有「本门相关产物」段（AC-174）')
  const names = ['DESIGN.md', 'DECISIONS.md', 'QUALITY.md']
  for (const name of names) {
    // DEF-004 的形态：**建议名**（流程数据里的名字）与**渲染名/路径**对不上（历史事故：建议 SDD.md、实际 docs/DESIGN.md）
    assert.ok(
      artifactTable.includes(name),
      `产物表里必须出现建议名 ${name}（DEF-004：假缺失正是"建议名与渲染名对不上"造成的）`,
    )
  }
  assert.ok(
    artifactTable.includes('docs/DESIGN.md') || artifactTable.includes('docs/QUALITY.md'),
    '产物表必须给出**规范渲染路径**（建议名 → 渲染名的对齐关系）',
  )

  // ② **两栏**：建议产物与必需产物必须分栏呈现（AC-228 的第一句）
  assert.ok(artifactTable.includes('建议'), '必须有「建议产物」栏')
  assert.ok(
    artifactTable.includes('必需'),
    '必须有「必需产物」栏（AC-228：建议 / 必需分栏、同一文档只允许一个规范名）—— 当前实现只有一栏',
  )

  // ④ **对齐关系（AC-228 后半句）在"建议名 ≠ 规范名"时**：同一份文档只允许一个规范名；两者不一致时
  //    行里要同时给出两者 **与对齐动作**。⚠️ TASK-057：**这一态必须由夹具真的造出来** ——
  //    上面那个夹具里建议名恰好都等于规范名（`docs/DESIGN.md` 的首选候选根就是规范落点，两者相同）
  //    ⇒ 对齐节**从不渲染**，于是原先那条 `/对齐到规范名|规范名/` 断言其实是被**必需栏表头**
  //    「必需产物（规范名）」满足的 ⇒ 恒真、不可能失败（TASK-023 早已变异实测过这条空转）。
  //    故这里把"声明名与规范落点不一致"的样例工程真的摆出来：按流程数据声明的名字（`DESIGN.md`）
  //    手写一份，而规范落点是 `docs/DESIGN.md` ⇒ 两者不同 ⇒ 对齐节必须渲染、且逐条对齐。
  writeFileSync(
    join(QUALITY_WORKSPACE, 'DESIGN.md'),
    '# 手写在设计（**声明的名字**与规范落点 docs/DESIGN.md 不一致 —— DEF-004 的形态）\n',
  )
  const { full: alignedFull } = qualityOffice.signReview(qualityCall, 'G3')
  const alignedTable = alignedFull.slice(alignedFull.indexOf('本门相关产物'))
  assert.notEqual(alignedTable, '', '审核单必须有「本门相关产物」段（AC-174）')
  // ① 对齐**节标题**必须存在 —— 只认那一段标题，不认表头里的「（规范名）」
  assert.ok(
    alignedTable.includes('名字对齐'),
    `建议名 ≠ 规范名时，产物表必须渲染「名字对齐」节（AC-228）：\n${alignedTable.slice(0, 600)}`,
  )
  // ② 两个名字必须**同时出现**（逐条对齐：声明名 → 规范渲染名）
  assert.ok(
    alignedTable.includes('`DESIGN.md`') && alignedTable.includes('docs/DESIGN.md'),
    `对齐节必须同时给出声明名与规范渲染名（DEF-004 的"假缺失"就是只给一个）：\n${alignedTable.slice(0, 600)}`,
  )
  // ③ 正则**收紧到唯一那句文案**：去掉 `|规范名` 那一支（它被必需栏表头「必需产物（规范名）」满足，
  //    正是恒真的来源）；`（对齐到规范名` 只在 `uiSignReview.artifactAlignment` 那一条文案里出现。
  assert.ok(
    /（对齐到规范名/u.test(alignedTable),
    `必须给出"对齐到规范名"的**动作**（那条唯一文案，不是表头）：\n${alignedTable.slice(0, 600)}`,
  )
  // ④ 反向对照：**表头确实满足旧正则** —— 用它证明"旧断言是恒真"，也证明新正则没有把表头当动作
  assert.ok(/规范名/u.test(alignedTable), '反向对照：产物表里本来就有「规范名」字样（表头）')
  assert.equal(
    /（对齐到规范名/u.test('### 必需产物（判据**强制**：缺了本门判据就判红）\n| 产物 | 必需产物（规范名） | 状态 | 字节 |'),
    false,
    '反向对照：只有必需栏表头、没有对齐节时，收紧后的正则**必须不匹配**（否则空转照旧）',
  )
  assert.ok(
    /修法|补文件|重新渲染/u.test(artifactTable),
    '缺失项必须给可执行修法（AC-229），不得只标一个「缺失」',
  )
})

