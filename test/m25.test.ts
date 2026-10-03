/**
 * sdo-test 回归报告（2026-10-02，立项到设计）六条缺陷的回归用例。
 *
 * 口径：每条都走**缺陷同一条路径**（真实装配 / 真实渲染 / 真实台账），并对关键修复断言
 * **反向**（例如 C-25 修好"puml 不再顶替"之后，手改 phase 仍必须判红）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { describeInit, describeSignature, describeStatus } from '../src/interface/describe.js'
import { link, readLinksChecked, report, unlink } from '../src/domain/trace.js'
import { SdoStore } from '../src/infra/store.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import { Journal } from '../src/infra/journal.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m25/', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  store = new SdoStore(join(workspace, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 立项 + 基本真源，足够跑 G3 的 C-25。 */
function ready(): void {
  office.init(call(), { name: 'F 项', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单' })
}

const c25 = (): { ok: boolean; detail: string } | undefined =>
  office.checkGate(call(), 'G3').criteria.find((criterion) => criterion.id === 'C-25')

// —————————————————————— F-1 ——————————————————————

test('F-1：`render --puml` 不得让 C-25 假红（puml 事件不再顶替文档事件）；手改 phase 仍必须判红', () => {
  ready()
  office.renderDesign(call())
  assert.equal(c25()?.ok, true, '前置：正常渲染后 C-25 通过')

  // 缺陷路径：带 puml 骨架再渲染一次（旧实现：后写的 puml 事件无 phase → 判"头里的阶段被改过"）
  office.renderDesign(call(), 'docs/probe-ui.puml')
  const after = c25()
  assert.equal(after?.ok, true, `render --puml 后 C-25 必须仍通过：${after?.detail}`)

  // 反向：真的手改渲染头里的 phase → 必须判红（修复不能把这条判据变成空壳）
  const doc = join(workspace, 'docs', 'DESIGN.md')
  const original = readFileSync(doc, 'utf8')
  writeFileSync(doc, original.replace(/phase\s+\S+/u, 'phase delivery'), 'utf8')
  const forged = c25()
  assert.equal(forged?.ok, false, '手改 phase 必须判红')
  assert.match(forged?.detail ?? '', /不一致/u, `文案应说明"不一致"而不是指控伪造：${forged?.detail}`)
  assert.equal(/伪造/u.test(forged?.detail ?? ''), false, '不得使用"伪造"这类人格指控式措辞')
  writeFileSync(doc, original, 'utf8')
})

// —————————————————————— F-3 ——————————————————————

test('F-3：立项回执的两个分支都不得漏占位符、也不得打出别的功能的文案', () => {
  const created = describeInit(office.init(call(), { name: 'F3 项目', scale: 'normal', stakeholders: ['业务方'] }), '.sdo')
  const existing = describeInit(office.init(call(), { name: 'F3 项目', scale: 'normal', stakeholders: ['业务方'] }), '.sdo')
  for (const [label, text] of [['新建', created], ['已存在', existing]] as const) {
    assert.equal(/\{p\d+\}/u.test(text), false, `${label}回执不得漏出占位符：\n${text}`)
    assert.equal(/本次没有写入任何字段|已记录质量场景|已建立 \{p1\} 条追溯边/u.test(text), false, `${label}回执不得复用别的功能的文案：\n${text}`)
  }
  assert.match(created, /已立项：F3 项目/u, `新建回执应说明已立项：\n${created}`)
  assert.match(created, /台账目录/u, '新建回执应给出台账目录')
  assert.match(existing, /已存在/u, `已存在回执应说明未新建：\n${existing}`)
})

test('F-3：`project.json` 读不出时，回执要打出真话（而不是语言包键名）', () => {
  ready()
  const path = join(workspace, '.sdo', 'project.json')
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, `${original.slice(0, 2)}坏${original.slice(3)}`, 'utf8')
  try {
    const receipt = describeStatus(office.status(call()), '.sdo')
    assert.equal(receipt.includes('k9Unverified'), false, `不得漏出语言包键名：\n${receipt.slice(0, 300)}`)
    assert.match(receipt, /这不等于/u, `必须说清"读不出 ≠ 没有"：\n${receipt.slice(0, 300)}`)
  } finally {
    writeFileSync(path, original, 'utf8')
  }
})

// —————————————————————— F-4 ——————————————————————

test('F-4：引用对不上时，文案要给出 `channel=question` 这条替代通道', () => {
  const zh = loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/zh-CN.yml')
  const en = loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/en.yml')
  assert.match(zh['uiIndex']?.['kSignQuoteMismatch'] ?? '', /channel=question/u)
  assert.match(en['uiIndex']?.['kSignQuoteMismatch'] ?? '', /channel=question/u)
})

// —————————————————————— F-5 ——————————————————————

test('F-5：`des-ct` 不再是被拒绝的死类型（契约按契约全集校验），且可 unlink', () => {
  ready()
  const element = office.views(call()).flatMap((view) => view.elements)[0]
  assert.ok(element !== undefined, '前置：有设计元素')
  const contract = office.recordContract(call(), {
    name: '订单服务-契约',
    producer: element.id,
    consumer: element.id,
    schema: 'request: timeout:number',
  })

  // 旧实现：CT- 与 DES- 一起拿去和"设计元素全集"比对 → 永远命中不了 → 这条边永远建不起来
  const created = link(store, journal, { from: element.id, to: contract.id, kind: 'des-ct' })
  assert.equal(created.created, true, 'des-ct 边必须建得起来')
  assert.equal(report(store, office.requirements(call())).total, 1)

  // 反向：不存在的契约仍要点名"契约"（不是笼统的"设计元素"）
  assert.throws(
    () => link(store, journal, { from: element.id, to: 'CT-999', kind: 'des-ct' }),
    /不存在的契约 CT-999/u,
  )

  // unlink：撤掉这条边，且坏行原样保留
  const linksPath = join(workspace, '.sdo', 'trace', 'links.jsonl')
  writeFileSync(linksPath, `${readFileSync(linksPath, 'utf8')}{坏行\n`, 'utf8')
  const before = readLinksChecked(store)
  assert.equal(before.badLines, 1, '前置：已埋一条坏行')
  const removed = unlink(store, journal, { from: element.id, to: contract.id, kind: 'des-ct' })
  assert.equal(removed.removed, 1)
  const after = readLinksChecked(store)
  assert.equal(after.links.length, 0, '边必须被撤掉')
  assert.equal(after.badLines, 1, '坏行必须原样保留（撤销边不该抹掉坏行证据）')
})

// —————————————————————— F-6 ——————————————————————

test('F-6：方法产物重写时，未声明 id 的条目按 name 复用既有 id（不漂移）', () => {
  ready()
  const first = office.writeMethodArtifact(call(), 'dfd', {
    summary: '分层 DFD',
    levels: [
      {
        level: 0,
        name: '顶层',
        processes: [{ name: '对账', inputs: ['文件'], outputs: ['差异'] }],
        flows: [],
        internalFlows: [],
      },
    ] as never,
  })
  const idOf = (artifact: typeof first, name: string): string | undefined =>
    (artifact.levels ?? []).flatMap((level) => level.processes).find((process) => process.name === name)?.id
  const before = idOf(first, '对账')
  assert.ok(before !== undefined, '前置：条目拿到了 id')

  // 缺陷路径：同一份产物再写一次（条目仍不带 id）→ 旧实现按 usedEntryIds 往后发号，id 漂移
  const second = office.writeMethodArtifact(call(), 'dfd', {
    summary: '分层 DFD（重写）',
    levels: [
      {
        level: 0,
        name: '顶层',
        processes: [{ name: '对账', inputs: ['文件'], outputs: ['差异', '汇总'] }],
        flows: [],
        internalFlows: [],
      },
    ] as never,
  })
  assert.equal(idOf(second, '对账'), before, '同名条目重写后 id 必须稳定')
})

// —————————————————————— 实测评审批次的 3 条观察（2026-10-02 16:03 / 16:16） ——————————————————————

test('观察 1：立项回执与注入块同口径 —— 流程/规模/阶段用本地化标签，不裸露 id', () => {
  const created = describeInit(office.init(call(), { name: '口径项目', scale: 'normal', stakeholders: ['业务方'] }), '.sdo')
  assert.match(created, /瀑布模型/u, `流程要用中文标签：\n${created}`)
  assert.match(created, /立项/u, `阶段要用中文标签：\n${created}`)
  assert.equal(/waterfall|\bnormal\b|intake/u.test(created), false, `不得裸露生 id：\n${created}`)
})

test('观察 2：签字回执必须写明签字范围（质量属性场景不在范围内）', () => {
  const signature = {
    gate: 'G3',
    by: '张三',
    channel: 'command' as const,
    basis: '用户原话',
    at: new Date().toISOString(),
    atSeq: 1,
    basisChecked: 'session' as const,
  }
  const receipt = describeSignature(signature, { status: 'valid', reason: '有效', signature })
  assert.match(receipt, /签字范围/u, `签字回执要写明范围：\n${receipt}`)
  assert.match(receipt, /质量属性场景/u, '要点名质量属性场景')
  assert.match(receipt, /补充证据/u, '要说明它是补充证据（不在范围内）')
})

test('观察 3（§3.5）：流程数据不得再把「建议产物」写成可强制的 artifacts', () => {
  for (const name of ['waterfall', 'prototype', 'agile', 'spiral']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'processes', `${name}.yml`), 'utf8')
    assert.match(text, /suggestedArtifacts:/u, `${name} 应把字段改名为 suggestedArtifacts（建议而非契约）`)
    assert.equal(/^\s+artifacts:/mu.test(text), false, `${name} 不得再有裸 artifacts:（会被误读为契约）`)
    assert.match(text, /applicability/u, `${name} 的说明要指出可强制的路径是适用性声明（C-2C）`)
  }
})

test('语言包守卫：两包的 snake_case 标识符必须一一对应（重载键串位 / 工具名写错）', () => {
  // 为什么只查 snake_case：它跨语言**不翻译**（`send_message`、`sdo_requirement`、`journal.jsonl` 之类），
  // 所以两包出现不同集合就是真的写错了。普通散文/标点/占位符（`…` vs `...`、`<区域名>` vs `<region name>`）
  // 差异是正常翻译，不在此守卫范围。实测本仓 1482 个共有键里，只有 2 处命中，且都是真缺陷：
  //   ① 我改语言包时用 `re.M` 匹配到**第一条** `k105`（该键名在 uiDescribe/uiIndex/uiGates 三个段复用）
  //      → 把 en 的**门禁**文案覆盖成了派发文案；
  //   ② 既有的 en `uiMethod.selectionMissing` 让英文用户去跑 `sdo_design action=grill`，
  //      而中文与代码实现都是需求阶段的 `sdo_requirement action=design-questions`。
  const packs = (locale: string): Record<string, Record<string, string>> =>
    loadPackagedYaml<Record<string, Record<string, string>>>(`src/data/lang/${locale}.yml`)
  const zh = packs('zh-CN')
  const en = packs('en')
  const idsOf = (text: string | undefined): string[] =>
    [...new Set((text ?? '').match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gu) ?? [])].sort()
  const problems: string[] = []
  for (const [section, keys] of Object.entries(zh)) {
    for (const key of Object.keys(keys)) {
      const a = idsOf(zh[section]?.[key]).join(',')
      const b = idsOf(en[section]?.[key]).join(',')
      if (a !== b) problems.push(`${section}.${key}：zh=[${a}] en=[${b}]`)
    }
  }
  assert.deepEqual(problems, [], `两包的 snake_case 标识符不一致（多半是段位串了或工具名写错）：\n${problems.join('\n')}`)
})

// —————————————————————— 类级守卫：语言包 ↔ 调用面 ——————————————————————

test('语言包类级守卫：被引用的键都取得到（含 fmt()），且 t() 调用的文案不含占位符', () => {
  const packs = {
    'zh-CN': loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/zh-CN.yml'),
    en: loadPackagedYaml<Record<string, Record<string, string>>>('src/data/lang/en.yml'),
  }
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.js')) files.push(path)
    }
  }
  walk(join(ROOT, 'lib', 'src'))
  // 从**编译产物**提取调用（与实现同源，不依赖人写清单）
  const calls = new Map<string, Set<string>>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\b(t|fmt)\('([a-zA-Z]+\.[A-Za-z0-9_]+)'/gu)) {
      const key = match[2] ?? ''
      const set = calls.get(key) ?? new Set<string>()
      set.add(match[1] ?? '')
      calls.set(key, set)
    }
  }
  assert.ok(calls.size > 500, `应扫描到足量调用，实际 ${calls.size}`)
  const missing: string[] = []
  const leaking: string[] = []
  for (const [key, kinds] of calls) {
    const [section, id] = key.split('.')
    const zh = packs['zh-CN']?.[section ?? '']?.[id ?? '']
    const en = packs.en?.[section ?? '']?.[id ?? '']
    if (zh === undefined || en === undefined) missing.push(key)
    else if (kinds.has('t') && /\{p\d+\}/u.test(zh)) leaking.push(key)
  }
  assert.deepEqual(missing, [], `这些键在语言包里取不到（会漏出键名）：${missing.join(', ')}`)
  assert.deepEqual(leaking, [], `这些键用 t() 调用，但文案含占位符（必然漏出）：${leaking.join(', ')}`)
})

test('M25 语言包不得出现重复键（YAML 后者会静默覆盖前者 —— param.evidence 踩过一次）', () => {
  // 事故背景：2026-10-03 修 A1 的可发现性时，我**新加**了一个已存在的 `param.evidence` 键，
  // YAML 解析取后者 ⇒ 新文案根本没到模型面前，而一切"看起来都改了"。文本级扫描成本极低，直接钉住。
  const duplicates: string[] = []
  for (const locale of ['zh-CN', 'en']) {
    const lines = readFileSync(new URL(`../../src/data/lang/${locale}.yml`, import.meta.url), 'utf8').split('\n')
    let section = ''
    const seen = new Map<string, number>()
    for (const [index, line] of lines.entries()) {
      if (/^[A-Za-z][\w]*:/u.test(line)) {
        section = line.replace(/:.*$/u, '')
        seen.clear()
        continue
      }
      const key = /^  ([A-Za-z][\w]*):/u.exec(line)
      if (key === null) continue
      const name = `${locale}:${section}.${key[1]}`
      const previous = seen.get(name)
      if (previous !== undefined) duplicates.push(`${name}（行 ${previous + 1} 与 ${index + 1}）`)
      else seen.set(name, index)
    }
  }
  assert.deepEqual(duplicates, [], `语言包里有重复键，后者会静默覆盖前者：${duplicates.join('；')}`)
})

test('M25 语言包哨兵：不同段的同号键文案必须各就各位（我按行首匹配改语言包时顶掉过别段）', () => {
  // 事故：修 P-1 派发文案时，我用"行首匹配 `  k104:`"批量替换，把 **uiIndex.k104**（创建元素需要 name）、
  // **uiGates.k104**（失败用例）一起覆盖成了派发文案 —— 键没重复、守卫全绿，但三个功能同时说错话。
  const packs = (locale: string): Record<string, Record<string, string>> =>
    loadPackagedYaml<Record<string, Record<string, string>>>(`src/data/lang/${locale}.yml`)
  const zh = packs('zh-CN')
  const sentinels: [string, string, RegExp][] = [
    ['uiIndex', 'k104', /name/u],
    ['uiIndex', 'k105', /ADR|title|decision/u],
    ['uiGates', 'k104', /用例/u],
    ['uiDescribe', 'k104', /派发|子代理/u],
  ]
  for (const [section, key, pattern] of sentinels) {
    assert.match(zh[section]?.[key] ?? '', pattern, `${section}.${key} 的文案被别的段的同号键顶掉了`)
  }
  // 反向：被点名这几段的同号键不得彼此雷同（否则说明有人又"整文件替换"了）
  const k104s = ['uiIndex', 'uiGates', 'uiDescribe'].map((section) => zh[section]?.k104 ?? '')
  assert.equal(new Set(k104s).size, k104s.length, `三段 k104 的文案不该雷同：${JSON.stringify(k104s)}`)
})

test('M25 语言包 markdown 守卫：`**` 要成对**且不能是空粗体**（第四轮复审：旧判据抓不住它记录的那次事故）', () => {
  // 事故原文（我自己改文案时留下的）：`**仍然**可以调用****了掩码外的工具`
  //   —— `**` 一共 4 个（**偶数**），旧的"个数为偶数"判据会**放行** ✗；真正的坏味道是 `****`（空粗体）。
  // 判据：按顺序吃掉 `**…**`，要求**能配上**且**中间非空**；另外直接禁掉 `****`。
  const markdownOk = (value: string): boolean => {
    if (value.includes('****')) return false
    let rest = value
    for (;;) {
      const open = rest.indexOf('**')
      if (open === -1) return true
      const close = rest.indexOf('**', open + 2)
      if (close === -1) return false
      if (rest.slice(open + 2, close).trim() === '') return false // 空内容或只有空白都算坏
      rest = rest.slice(close + 2)
    }
  }
  // **把事故原文当反例钉住**（变异自证该走的路：喂事故串，守卫必须红）
  assert.equal(markdownOk('子代理**仍然**可以调用****了掩码外的工具'), false, '事故原文必须被判红（旧判据会放行）')
  assert.equal(markdownOk('仍然**可以调用**掩码外的工具'), true, '成对且非空 → 放行')
  assert.equal(markdownOk('**未闭合的粗体'), false)
  assert.equal(markdownOk('空粗体 ** ** 也不行'), false, '中间只有空格也算空内容')

  const problems: string[] = []
  for (const locale of ['zh-CN', 'en']) {
    const lines = readFileSync(new URL(`../../src/data/lang/${locale}.yml`, import.meta.url), 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      const value = /^  [A-Za-z][\w]*: "(.*)"$/u.exec(line)?.[1]
      if (value !== undefined && !markdownOk(value)) problems.push(`${locale}:${index + 1}`)
    }
  }
  assert.deepEqual(problems, [], `这些语言包值的 ** 不成对或是空粗体：${problems.join('；')}`)
})
