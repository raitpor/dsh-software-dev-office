/**
 * 本轮（0.1.2 后续）三件事的验收测试 —— 每一件都**双向**测，且断言必须可被反例推翻：
 *
 *   ① **界面线框图 + PlantUML 骨架**：线框里的栏目与 `ui` 视图**逐项对应**
 *      （有则按 `columns` 顺序出现、删掉就不出现、全空则线框为空且给可读提示）；
 *      `.puml` 只写文件、不渲染成图，且落点被限制在工作区内。
 *   ② **完整 argv 解析器**：`--note choice=waive` 不得把 `choice` 设成选项（反例：显式
 *      `--choice=waive` 必须能设上）；三种写法回执逐字节相同；引号值完整保留；`--` 之后是位置参数。
 *   ③ **C-26 并入 C-28**：未回答只有**一条**方法选择判据且它红；显式 `none` 它绿、
 *      产物判据 N/A；`design.method-chosen` 不再挂在任何门禁上。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

import { Config, resolveSettings } from '../src/config.js'
import type { UiColumn } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import {
  DEFAULT_PUML_PATH,
  plantUmlText,
  resolvePumlPath,
} from '../src/domain/design.js'
import { evaluateGate } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { fmt, t } from '../src/domain/i18n.js'
import { Journal } from '../src/infra/journal.js'
import { regionBuckets, renderWireframes, screenWireframe, plantUmlSkeleton } from '../src/domain/wireframe.js'
import type { WireframeStrings } from '../src/domain/wireframe.js'
import { ArgvReader, parseArgv, tokenize } from '../src/interface/argv.js'
import { createOfficeCommands } from '../src/interface/commands.js'
import type { OfficeCommandDeps } from '../src/interface/commands.js'
import { decideBudgetReceipt, setBudgetReceipt } from '../src/interface/budgetReceipt.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { UiScreen, UiView } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m12/', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M12 测试', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// —————————————————————— ① 界面线框图（机械推导，逐项对应） ——————————————————————

/** 线框排版用的文案：测试里直接取语言包，保证"可读提示"确实是用户看得懂的文案。 */
function strings(): WireframeStrings {
  return {
    emptyColumns: t('uiDesign.docWireframeEmpty'),
    noRegions: t('uiDesign.docWireframeNoRegions'),
    screenNote: t('uiDesign.docWireframePumlNote'),
    breakpoints: t('uiDesign.docUiBreakpoints'),
    noScreens: t('uiDesign.docUiNoScreens'),
  assignmentGuessed: '[assignment guessed]',
  regionUnknown: (_column, declared, regions) => `[unknown region ${declared} of ${regions}]`,
    // F-15：方向来源注记（声明 / 缺省）
    stackNote: (stack) => (stack === undefined
      ? t('uiDesign.docWireframeStackDefault')
      : fmt('uiDesign.docWireframeStackDeclared', { p1: stack })),
  }
}

/** 三栏目 + 三区域的列表页。 */
function screen(columns: UiColumn[] = [
  { name: '编号', kind: 'text' },
  { name: '标题', kind: 'text' },
  { name: '状态', kind: 'badge' },
]): UiScreen {
  return {
    id: 'SCR-001',
    name: '需求列表',
    columns,
    layout: { grid: '1fr 2fr 80px', regions: ['header', 'filter-bar', 'table'] },
    interactions: ['筛选'],
    states: { empty: '暂无数据' },
    requires: [],
  }
}

test('M12-01 线框：3 个栏目按 columns 顺序出现，且各自落在 layout.regions 声明的区域里', () => {
  const block = screenWireframe(screen(), strings())
  const text = block.lines.join('\n')

  // 顺序断言：编号 < 标题 < 状态（不是"包含即可"）
  const at = (name: string): number => {
    const index = text.indexOf(name)
    assert.ok(index >= 0, `线框里必须出现栏目 ${name}：\n${text}`)
    return index
  }
  assert.ok(at('编号') < at('标题'), '编号 必须排在 标题 之前')
  assert.ok(at('标题') < at('状态'), '标题 必须排在 状态 之前')

  // 区域名逐项来自 `layout.regions`（本模块不发明区域名）
  for (const region of screen().layout.regions) assert.ok(text.includes(region), `线框里必须有区域 ${region}`)

  // 机械分配：3 栏目 / 3 区域 → 一栏一区，顺序与 columns 一致
  const buckets = regionBuckets(screen(), strings().noRegions)
  assert.deepEqual(buckets, [
    { region: 'header', columns: ['编号'], assignment: 'exact' },
    { region: 'filter-bar', columns: ['标题'], assignment: 'exact' },
    { region: 'table', columns: ['状态'], assignment: 'exact' },
  ])
})

test('F-2 线框：栏目显式声明 region 时按声明排（不再按数量均分），且不标"猜测"', () => {
  // 5 栏目 / 3 区域：均分必然错位（实测把表单字段排进页头）；显式声明后逐项归位
  const declared = screen([
    { name: '出发站', kind: 'input', region: 'filter-bar' },
    { name: '到达站', kind: 'input', region: 'filter-bar' },
    { name: '乘车日期', kind: 'input', region: 'filter-bar' },
    { name: '查询', kind: 'button', region: 'filter-bar' },
    { name: '车次结果', kind: 'table', region: 'table' },
  ])
  const buckets = regionBuckets(declared, strings().noRegions)
  assert.deepEqual(buckets.map((b) => ({ region: b.region, columns: b.columns })), [
    { region: 'header', columns: [] },
    { region: 'filter-bar', columns: ['出发站', '到达站', '乘车日期', '查询'] },
    { region: 'table', columns: ['车次结果'] },
  ])
  assert.ok(buckets.every((b) => b.assignment === 'declared'), '声明优先时归属来源必须是 declared')
  const text = screenWireframe(declared, strings()).lines.join('\n')
  assert.equal(text.includes(strings().assignmentGuessed), false, '声明齐全时不得标"猜测"')
  assert.ok(text.indexOf('出发站') < text.indexOf('车次结果'), '栏目仍按 columns 顺序')
})

test('F-2 线框：未声明归属时按数量均分**并明确标注这是猜测**（旧实现静默错位）', () => {
  const guessed = screen([
    { name: '出发站', kind: 'input' },
    { name: '到达站', kind: 'input' },
    { name: '乘车日期', kind: 'input' },
    { name: '查询', kind: 'button' },
    { name: '车次结果', kind: 'table' },
  ])
  const block = screenWireframe(guessed, strings())
  assert.equal(block.assignment, 'guessed')
  assert.ok(block.lines.join('\n').includes(strings().assignmentGuessed), '猜测必须在图里标注')
  // 骨架源码同样标注（两份产物同口径）
  const puml = plantUmlSkeleton({ id: 'UI-001', style: { source: 'custom', tokens: {}, rationale: '' }, screens: [guessed], breakpoints: [], accessibility: { contrast: '', keyboard: false, screenReader: '' }, updatedAt: '' }, strings(), 'T', 'a11y')
  assert.ok(puml.includes(strings().assignmentGuessed), '骨架源码也要标注猜测')
})

test('F-2 线框：栏目声明了不存在的区域名 → 图里点名（不静默排进凭空出现的区域）', () => {
  const bad = screen([{ name: '车次结果', kind: 'table', region: 'nonexistent' }])
  const text = screenWireframe(bad, strings()).lines.join('\n')
  assert.ok(text.includes(strings().regionUnknown('车次结果', 'nonexistent', 'header / filter-bar / table')), '必须点名栏目 / 声明值 / 可用区域')
})

test('M12-02 线框双向：删掉一个栏目 → 线框里不再出现它（栏目缺失绝不臆造）', () => {
  const full = screenWireframe(screen(), strings()).lines.join('\n')
  assert.ok(full.includes('状态'))

  const trimmed = screenWireframe(screen([
    { name: '编号', kind: 'text' },
    { name: '标题', kind: 'text' },
  ]), strings()).lines.join('\n')
  assert.equal(trimmed.includes('状态'), false, '台账里删掉的栏目不得出现在线框里')
  assert.ok(trimmed.includes('编号') && trimmed.includes('标题'), '剩下的栏目仍要在线框里')
  // 没有栏目时应给出可读提示；有栏目时不该出现该提示
  assert.equal(trimmed.includes(strings().emptyColumns), false, '有栏目时不得出现"没有栏目"提示')
  assert.equal(full.includes(strings().emptyColumns), false)
})

test('M12-03 线框双向：栏目全空 → 线框里没有任何栏目，且给出可读提示（不是静默留白）', () => {
  const block = screenWireframe(screen([]), strings())
  assert.equal(block.empty, true)
  const text = block.lines.join('\n')
  for (const name of ['编号', '标题', '状态']) assert.equal(text.includes(name), false, `空栏目屏不得出现 ${name}`)
  assert.ok(text.includes(strings().emptyColumns), '空栏目屏必须给出可读提示（用户能看懂）')
  // 提示必须来自语言包（不是键名，也不是硬编码）
  assert.notEqual(strings().emptyColumns, 'docWireframeEmpty')
  assert.ok(strings().emptyColumns.length > 5)

  // 没有页面的 ui 视图 → 一块线框都不产出（不造示例页面）
  const view: UiView = { id: 'UI-001', style: { source: 'minimal', tokens: {}, rationale: '' }, screens: [], breakpoints: [], accessibility: { contrast: '', keyboard: false, screenReader: '' }, updatedAt: '' }
  assert.deepEqual(renderWireframes(view, strings()), [])
})

test('M12-04 线框宽度：CJK 按 2 列排版，方框每一行的显示宽度一致（不是 .length 对齐）', () => {
  const block = screenWireframe(screen(), strings())
  const width = (line: string): number => {
    let out = 0
    for (const ch of line) out += (ch.codePointAt(0) ?? 0) > 0x1100 && /[\u2e80-\ua4cf\uac00-\ud7a3\uff00-\uff60]/u.test(ch) ? 2 : 1
    return out
  }
  const boxLines = block.lines.filter((line) => line.startsWith('│') || line.startsWith('┌') || line.startsWith('└') || line.startsWith('├'))
  assert.ok(boxLines.length >= 4, '线框必须真的画成方框')
  const widths = new Set(boxLines.map(width))
  assert.equal(widths.size, 1, `方框各行宽度必须一致（CJK 双宽）：${[...widths].join(',')}\n${block.lines.join('\n')}`)
})

test('M12-04b DESIGN.md 的界面方案章真的带上线框图（含 UI 判真时；判假时不画）', () => {
  office.updateProject(call(), { surfaces: ['web'] })
  office.writeUiView(call(), {
    id: 'UI-001',
    style: { source: 'minimal', tokens: {}, rationale: '极简' },
    screens: [screen()],
    breakpoints: [],
    accessibility: { contrast: '>=4.5:1', keyboard: true, screenReader: '读屏可用' },
    updatedAt: new Date().toISOString(),
  })
  office.renderDesign(call())
  const doc = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  const uiChapter = doc.slice(doc.indexOf(`## 7. ${t('uiDesign.docS5')}`), doc.indexOf('## 8. '))
  assert.ok(uiChapter.includes(t('uiDesign.docWireframe')), '界面方案章必须带线框图小节')
  for (const column of ['编号', '标题', '状态']) assert.ok(uiChapter.includes(column), `线框图缺栏目 ${column}`)
  assert.ok(uiChapter.indexOf('编号') < uiChapter.indexOf('标题'), '线框里的栏目顺序必须与 columns 一致')

  // 判假（没有需求界面面、也没声明项目级 surfaces）时该章不画线框，但仍要有 N/A 说明
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M12 判假', scale: 'normal', stakeholders: ['业务方'] })
  office.renderDesign(call())
  const naDoc = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  const naChapter = naDoc.slice(naDoc.indexOf(`## 7. ${t('uiDesign.docS5')}`), naDoc.indexOf('## 8. '))
  assert.ok(naChapter.includes(t('uiDesign.docUiNa')), '判假时必须写明不适用')
  assert.equal(naChapter.includes(t('uiDesign.docWireframe')), false, '判假时不得画线框图')
  assert.equal(naChapter.includes('编号'), false, '判假时不得出现任何栏目')
})

// —————————————————————— ① PlantUML 骨架（只写文件，不渲染成图） ——————————————————————

test('M12-05 PlantUML 骨架：内容逐项来自 ui 视图，注释里写明"只是源码、不出图"', () => {
  const view: UiView = {
    id: 'UI-001',
    style: { source: 'minimal', tokens: { '--fg': '#111' }, rationale: '极简' },
    screens: [screen()],
    breakpoints: [{ name: 'sm', width: '<=640px', changes: ['表格改卡片'] }],
    accessibility: { contrast: '>=4.5:1', keyboard: true, screenReader: '读屏可用' },
    updatedAt: '',
  }
  const text = plantUmlText(view)
  assert.ok(text.startsWith('@startuml'), '必须是合法的 PlantUML 源码')
  assert.ok(text.trimEnd().endsWith('@enduml'))
  assert.ok(text.includes('SCR-001 需求列表'), '页面 id 与名字必须出现在图里')
  for (const column of ['编号', '标题', '状态']) assert.ok(text.includes(column), `栏目 ${column} 必须出现在 .puml 里`)
  for (const region of ['header', 'filter-bar', 'table']) assert.ok(text.includes(region), `区域 ${region} 必须出现在 .puml 里`)
  assert.ok(text.includes(t('uiDesign.docUiBreakpoints')), '断点注记要走语言包')
  assert.ok(text.includes(t('uiDesign.docUiA11y')), '无障碍注记要走语言包')
  assert.ok(text.includes(t('uiDesign.docWireframePumlNote')), '必须写明这只是骨架源码、本仓库不出图')

  // 还没有界面视图时也要给一份合法骨架（写明"还没有页面"，不编造）
  const empty = plantUmlText(undefined)
  assert.ok(empty.startsWith('@startuml') && empty.trimEnd().endsWith('@enduml'))
  assert.ok(empty.includes(t('uiDesign.docUiNoScreens')), '没有视图时必须写明还没有页面')
  assert.equal(empty.includes('SCR-001'), false, '没有视图时不得出现任何页面')
})

test('M12-06 PlantUML 落点：默认路径、拒绝绝对路径与 `..`（双向）', () => {
  /** 取"接受"分支的路径（不接受时断言失败并给出可读原因）。 */
  const pathOf = (raw: string | undefined): string => {
    const result = resolvePumlPath(raw)
    assert.ok('path' in result, `${raw ?? '(undefined)'} 应当被接受：${'error' in result ? result.error : ''}`)
    return result.path
  }
  assert.equal(pathOf(undefined), DEFAULT_PUML_PATH)
  assert.equal(pathOf('   '), DEFAULT_PUML_PATH)
  assert.equal(pathOf('design/wire.puml'), 'design/wire.puml', '工作区内的相对路径必须接受')
  assert.equal(pathOf('./design//wire.puml'), 'design/wire.puml', '归一化 `.` 与重复斜杠')

  for (const bad of ['/tmp/x.puml', '../outside.puml', 'a/../../x.puml', 'C:\\tmp\\x.puml']) {
    const result = resolvePumlPath(bad)
    assert.ok('error' in result, `${bad} 必须被拒绝（不许写到工作区外）`)
    assert.ok(result.error.includes(bad), '拒绝文案里必须点名非法落点')
    assert.notEqual(result.error, 'uiRenderPumlBadPath', '拒绝文案必须是真文案，不是键名')
  }
})

test('M12-07 action=render 带 puml：真的写出 .puml 文件，回执同时说明"不出图"；不带则不写', async () => {
  const deps = {
    design: async (_call: unknown, args: { action: string; puml?: string | undefined }) =>
      (await import('../src/interface/designReceipt.js')).designInteraction(office, call(), args.action, args as never),
  }
  const command = createOfficeCommands(deps as unknown as OfficeCommandDeps, false).find((item) => item.name === 'sdo-design-render')
  assert.ok(command !== undefined)
  const invocation = (rawInput: string): CommandInvocation => ({
    commandId: 'cmd-test',
    agent: { id: 's1', session: { header: { cwd: workspace } } },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }) as unknown as CommandInvocation

  // 不带 `--puml`：只写 DESIGN.md，不产生 .puml（默认路径必须保持"不多写文件"）
  const plain = await command.handler(invocation(''))
  assert.equal(plain.kind, 'success')
  assert.ok(existsSync(join(workspace, 'docs', 'DESIGN.md')))
  assert.equal(existsSync(join(workspace, DEFAULT_PUML_PATH)), false, '没要 PlantUML 时不得写 .puml')

  // 带 `--puml`：写到默认落点，且回执里带"不渲染成图"的说明
  const withPuml = await command.handler(invocation('--puml'))
  assert.equal(withPuml.kind, 'success')
  assert.ok(existsSync(join(workspace, DEFAULT_PUML_PATH)), '--puml 必须真的写出文件')
  const text = readFileSync(join(workspace, DEFAULT_PUML_PATH), 'utf8')
  assert.ok(text.startsWith('@startuml') && text.trimEnd().endsWith('@enduml'))
  assert.ok((withPuml.text ?? '').includes(DEFAULT_PUML_PATH), '回执必须回报实际落点')
  assert.ok((withPuml.text ?? '').includes('PlantUML'), '回执必须点到 PlantUML')
  assert.ok((withPuml.text ?? '').includes(t('uiDesign.uiRenderPuml').split('{')[0] ?? ''), '回执必须用语言包文案')

  // 指定相对路径
  const custom = await command.handler(invocation('--puml design/wire.puml'))
  assert.equal(custom.kind, 'success')
  assert.ok(existsSync(join(workspace, 'design', 'wire.puml')), '自定义相对路径必须生效')
  assert.ok((custom.text ?? '').includes('design/wire.puml'))

  // 非法落点：明确报错，且不得写到工作区外
  const bad = await command.handler(invocation('--puml ../escape.puml'))
  assert.equal(bad.kind, 'error', '越界落点必须报错')
  assert.equal(existsSync(join(BASE, 'escape.puml')), false, '越界落点绝不允许落盘')
})

// —————————————————————— ② 完整 argv 解析器 ——————————————————————

test('M12-08 argv：`--note choice=waive` 里 choice=waive 只是 --note 的值，绝不设 choice（反向：--choice=waive 必须设上）', async () => {
  // 纯解析层：`decide` 是纯布尔开关，因此它后面的 `choice=waive` 不得被认领
  const parsed = parseArgv('--decide --note choice=waive', ['--decide', '--set'])
  assert.equal(parsed.options.choice, undefined, '`choice=waive` 是 --note 的值，不得被认成 choice 选项')
  assert.equal(parsed.options.note, 'choice=waive')
  assert.equal(new ArgvReader(parsed).flag('decide'), true)

  // 端到端：`/sdo-budget --decide --note choice=waive` 必须落到"缺少 choice"的提示，
  // 而不是把 choice 认成 waive（旧实现的残留边界）
  const seen: string[] = []
  const deps = {
    decideBudget: (_call: unknown, choice: string, note: string) => {
      seen.push(`${choice}|${note}`)
      return 'ok'
    },
    cost: async () => 'report',
  }
  const command = createOfficeCommands(deps as unknown as OfficeCommandDeps, false).find((item) => item.name === 'sdo-budget')
  assert.ok(command !== undefined)
  const handler = async (raw: string): Promise<string> => {
    const result = await command.handler({
      commandId: 'cmd-test',
      agent: { id: 's1', session: { header: { cwd: workspace } } },
      rawInput: raw,
      attachments: [],
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    assert.equal(result.kind, 'success', `${raw} 应成功：${result.text}`)
    return result.text ?? ''
  }

  assert.equal(await handler('--decide --note choice=waive'), t('uiCommands.k3'), '只给 --note 时仍是"缺少 choice"')
  assert.deepEqual(seen, [], '不得凭空落一条 choice=waive 的决定')

  // **反例方向**：显式 `--choice=waive` 与裸 `choice=waive` 都必须能设上
  await handler('--decide --choice=waive')
  assert.deepEqual(seen, ['waive|' + t('uiCommands.k4')])
  seen.length = 0
  await handler('--decide choice=waive')
  assert.deepEqual(seen, ['waive|' + t('uiCommands.k4')], '历史裸写法仍须生效')
})

test('M12-09 argv：`--k=v` / `--k v` / 裸 `k=v` 三形态**回执逐字节相同**且落盘一致', async () => {
  const run = async (raw: string): Promise<string> => {
    rmSync(BASE, { recursive: true, force: true })
    mkdirSync(workspace, { recursive: true })
    office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
    office.noteSession('s1', workspace)
    office.init(call(), { name: 'M12 测试', scale: 'normal', stakeholders: ['业务方'] })
    office.updateProject(call(), {
      scopeIn: ['对账'],
      scopeOut: ['自动调账'],
      metricsSuccess: ['识别率 ≥ 99%'],
      glossary: { 差异: '不一致记录' },
    })
    const deps = {
      setBudget: (c: unknown, input: unknown) => setBudgetReceipt(office, c as never, input as never, {}),
      decideBudget: (c: unknown, choice: string, note: string) => decideBudgetReceipt(office, c as never, choice, note),
    }
    const command = createOfficeCommands(deps as unknown as OfficeCommandDeps, false).find((item) => item.name === 'sdo-budget')
    assert.ok(command !== undefined)
    const result = await command.handler({
      commandId: 'cmd-test',
      agent: { id: 's1', session: { header: { cwd: workspace } } },
      rawInput: raw,
      attachments: [],
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    assert.equal(result.kind, 'success', `${raw} 应成功：${result.text}`)
    return result.text ?? ''
  }

  const equals = await run('--set --total=100 --currency=CNY --tiers=50,80,100')
  const space = await run('--set --total 100 --currency CNY --tiers 50,80,100')
  const bare = await run('--set total=100 currency=CNY tiers=50,80,100')
  assert.equal(space, equals, '`--k v` 与 `--k=v` 回执必须逐字节相同')
  assert.equal(bare, equals, '裸 `k=v` 与 `--k=v` 回执必须逐字节相同')
  assert.equal(office.budget(call())?.total, 100)
  assert.equal(office.budget(call())?.currency, 'CNY')
  assert.deepEqual(office.budget(call())?.tiers, [50, 80, 100])
})

test('M12-10 argv：引号里的空白完整保留；`--` 之后一律位置参数（含同形的 k=v）', () => {
  const quotedDouble = parseArgv('--note "见 choice=waive 与 x=1"', ['--decide'])
  assert.equal(quotedDouble.options.note, '见 choice=waive 与 x=1', '双引号内的空白与 k=v 必须原样保留')
  assert.equal(quotedDouble.options.choice, undefined)
  const quotedSingle = parseArgv("--note '单引号 也能 包 空格'", [])
  assert.equal(quotedSingle.options.note, '单引号 也能 包 空格')

  // 引号在**值**位置上（等号写法）同样剥掉引号
  assert.equal(parseArgv('--name="a b"', []).options.name, 'a b')

  // 多词未加引号：空格写法只吃一个 token（诚实边界，见 README/模块注释）
  const unquoted = parseArgv('--note 见 choice=waive', [])
  assert.equal(unquoted.options.note, '见', '未加引号时只吃一个 token')
  assert.equal(unquoted.options.choice, 'waive', '剩下的 `choice=waive` 是独立 token（历史裸写法）')

  // `--` 之后全是位置参数：同形的 `--state=all` 也不再是选项
  const after = parseArgv('--state=open -- --state=all k=v', [])
  assert.equal(after.options.state, 'open')
  assert.deepEqual(after.positionals, ['--state=all', 'k=v'])
  assert.equal(after.options.k, undefined, '`--` 之后不得再解析任何 k=v')

  // 分词：引号内空白不切分、`--` 自身不混进位置参数
  assert.deepEqual(tokenize('a "b c" \'d e\'').map((token) => token.text), ['a', 'b c', 'd e'])
  assert.deepEqual(parseArgv('foo -- bar', []).positionals, ['foo', 'bar'])
})

test('M12-11 argv：布尔开关三种写法仍与旧行为一致（`--f` / `--f=true` / `--f true` / `--f=false`）', () => {
  const flag = (raw: string, names: readonly string[]): boolean => ArgvReader.of(raw, names).flag('rebuild')
  assert.equal(flag('--rebuild', ['--rebuild']), true)
  assert.equal(flag('--rebuild=true', ['--rebuild']), true)
  assert.equal(flag('--rebuild true', ['--rebuild']), true)
  assert.equal(flag('--rebuild=false', ['--rebuild']), false)
  assert.equal(flag('--rebuild false', ['--rebuild']), false)
  assert.equal(flag('', ['--rebuild']), false)
  assert.equal(flag('--rebuild=1', ['--rebuild']), false, '非 true/false 不算开关（与旧实现一致）')
  // 前缀相似的开关不得命中
  assert.equal(flag('--xrebuild', ['--rebuild']), false)
  assert.equal(parseArgv('--xchoice=waive', ['--decide']).options.choice, undefined)
})

// —————————————————————— ③ C-26 并入 C-28（双向） ——————————————————————

const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }

/** 造一条已基线需求（G2 通过）—— 方法题只在设计缺口检测器跑得起来时才会被问出来。 */
function baselineRequirement(): string {
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), {
    title: '格式变更',
    level: 'low',
    probability: 'low',
    impact: '小',
    mitigation: '校验',
    owner: '业务方',
  })
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    kind: 'functional',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: ALL2,
  })
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call(), { id: open[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  // D1 + D4：未决 P1 补风险处置，再签 G2 字（放行依据是签字台账）
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}

test('M12-12 合并后 G3 的方法判据恰好一条：未回答它红；显式 none 它绿且产物判据 N/A', () => {
  // A：连方法题都还没问过 → 只有一条方法选择判据，且是红（不是 N/A）
  const g3Before = office.process(call()).gates.find((gate) => gate.id === 'G3')
  assert.ok(g3Before !== undefined)
  const methodCriteria = g3Before.criteria.filter((item) => /method-(chosen|selected)/u.test(item.check))
  assert.equal(methodCriteria.length, 1, 'G3 的方法选择判据必须恰好一条')
  assert.equal(methodCriteria[0]!.id, 'C-28')

  const unanswered = office.evaluate(call(), 'G3').criteria.find((item) => item.id === 'C-28')
  assert.ok(unanswered !== undefined, 'G3 必须挂 C-28')
  assert.equal(unanswered.ok, false, '未回答 → 红')
  assert.equal(unanswered.na, undefined, '未回答是失败，不是 N/A')
  assert.ok((unanswered.remedy ?? '').length > 0, '失败必须给出补救办法')

  // B：显式 none → 它绿、产物判据 N/A + 理由
  baselineRequirement()
  office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  const methodQuestion = office.designIssues(call()).open.find((question) => question.targets.includes('design:method'))
  assert.ok(methodQuestion !== undefined, 'grill 必须问出方法题')
  office.answerDesign(call(), methodQuestion.id, 'none')

  const criteria = office.evaluate(call(), 'G3').criteria
  const selected = criteria.find((item) => item.id === 'C-28')
  assert.equal(selected?.ok, true, '显式 none → C-28 必须绿')
  const products = criteria.find((item) => item.id === 'C-29')
  assert.equal(products?.na, true, '显式 none → 产物判据 N/A')
  assert.equal(products?.ok, false, 'N/A 绝不能被算成通过')
  assert.ok((products?.naReason ?? '').length > 0, 'N/A 必须带理由')
  assert.equal(criteria.some((item) => item.id === 'C-26'), false, 'C-26 不得再出现')
})

test('M12-13 合并后 `design.method-chosen` 不再挂载：全流程门禁 + 检查器注册表都没有它', () => {
  const processes = ['waterfall', 'prototype', 'agile', 'spiral'] as const
  for (const process of processes) {
    office.init(call(), { name: `M12 ${process}`, process, scale: 'normal', stakeholders: ['业务方'] })
    const gates = office.process(call()).gates
    for (const gate of gates) {
      assert.equal(
        gate.criteria.some((item) => item.check === 'design.method-chosen' || item.id === 'C-26'),
        false,
        `${process} 的 ${gate.id} 仍挂着 C-26 / design.method-chosen`,
      )
      const methodCriteria = gate.criteria.filter((item) => /method-(chosen|selected)/u.test(item.check))
      for (const item of methodCriteria) {
        assert.equal(item.check, 'design.method-selected', `${process}/${gate.id} 只允许留下 design.method-selected`)
      }
    }
  }
  // 检查器注册表里也不再有它（`evaluateGate` 对未实现检查器一律判失败，留着就是死键）
  const synthetic = {
    id: 'x',
    name: 'x',
    description: '',
    phases: [{ id: 'architecture', role: 'architect', entry: [], exit: ['G3'], artifacts: [] }],
    gates: [{ id: 'G3', name: '架构门禁', criteria: [{ id: 'C-26', check: 'design.method-chosen', desc: '已删除的判据' }] }],
  }
  const context: GateContext = {
    workspace,
    store: office.storeFor(workspace),
    journal: new Journal(office.storeFor(workspace)),
    process: synthetic,
    project: office.status(call()).project,
    requirements: office.requirements(call()),
    questions: office.questions(call()),
    risks: [],
    issues: [],
    feasibility: undefined,
    redTeamExecuted: false,
    redTeamDisabled: false,
    waivedGates: [],
    prototypeDir: 'prototype',
    prototypeThrowaway: false,
    riskConclusion: undefined,
  }
  const result = evaluateGate(synthetic, 'G3', context)
  const missing = result.criteria.find((item) => item.id === 'C-26')
  assert.equal(missing?.ok, false, '已删除的检查器必须判红（不允许"查不到就算过"）')
  assert.equal(result.status, 'failed')
})
