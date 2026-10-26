/**
 * **`TASK-187` 声明形状的写入时校验的守卫**（可观测性③ / `DEF-163` / `DEF-168`）。
 *
 * 病灶（卡上的问题陈述）：`impact` / `landing` / `writeScopes` **只在 `done` 时才回显问题**，
 * 而 `done` 卡不可改 ⇒ 写中文括注的那一刻没人反对，错误要到判据面才炸，且**不可挽回**。
 *
 * 本文件把卡上的五条守卫钉成**两态**（每条都同时证明"该拒的拒了"与"该受的受了"）：
 *
 *   M226-01 ①带中文括注的 `impact` ⇒ **拒绝**并给纯路径示例（②纯路径 ⇒ **接受**，卡面真的变了）
 *   M226-02 ③空串 / 重复项 ⇒ **拒绝并点名**（不是"整体不合法"一句话）
 *   M226-03 ④不存在的顶层目录 ⇒ **拒绝**（并给"显式新建"的机械形态）；存在顶层的深目录 ⇒ 接受
 *   M226-04 ⑤与在飞卡相交 ⇒ **接受**，但**回执点名**（谁 / 哪条路径 / 撞上哪条范围）
 *   M226-05 `decompose` 建卡同样拒（坏 suggestion 逐条 issue、好 suggestion 照建）+ `createTask` 兜底抛错
 *   M226-06 **不回溯历史**：老卡上的中文括注声明不被任何判据追溯判红
 *   M226-07 语言中立：`en` 下拒绝文案与相交点名都零中文（同一份口径，两套标签）
 *
 * 纪律：断言消息一律英文、中文只写在断言**之外**（本文件不进 `KNOWN_PROSE_GAP`）——
 * 连"中文证据串"也不许进断言实参。所以中文括注的夹具**只作为被判的输入**存在，
 * 断言只核对结构（`code` / 路径 / 示例）与 ASCII 片段；中文回执原文走 `en` 侧断言。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { checkDeclaration, declarationOverlaps } from '../src/domain/declarationCheck.js'
import { setLocale } from '../src/domain/i18n.js'
import { createTask, listTasks, writeTask } from '../src/domain/plan.js'
import { OFFICE_TOOL_GROUPS } from '../src/domain/roles.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m226/', import.meta.url))

/** 汉字字形判定（本文件只用来断言"零中文"，不做内容匹配）。 */
const CJK = /[\u4e00-\u9fff]/u

interface Fixture {
  office: SoftwareDevOffice
  call: OfficeCall
  workspace: string
  journal: Journal
  store: SdoStore
}

/**
 * 一台真实的办公室。**工作区顶部先建出 `src/`、`test/`**：
 * 口径② 判的是"顶层目录在**本工作区**里真的存在"，空夹具目录下 `src/x.ts` 本来就不该被接受。
 */
function fixture(name: string): Fixture {
  const workspace = join(BASE, name)
  rmSync(workspace, { recursive: true, force: true })
  for (const dir of ['src', 'test', 'docs']) mkdirSync(join(workspace, dir), { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# fixture\n', 'utf8')
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const sessionId = `s226-${name}`
  office.noteSession(sessionId, workspace)
  const call = { sessionId, cwd: workspace } as unknown as OfficeCall
  office.init(call, { name: `M226 ${name}`, scale: 'normal', stakeholders: ['stakeholder'] })
  return { office, call, workspace, journal: office.journalFor(workspace), store: office.storeFor(workspace) }
}

/** 造一张卡（真 `createTask`；声明必须是合法的，否则本卡的校验会当场拒）。 */
function card(f: Fixture, title: string, over: Partial<TaskCard> = {}): TaskCard {
  const created = createTask(f.store, f.journal, {
    title,
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    size: 'small',
    writeScopes: ['src/office.ts'],
    ...over,
  } as never)
  return created
}

/** 直接写一张卡（**绕过建卡入口**：用来复现"历史遗留形状"，那是本卡不该追溯的对象）。 */
function legacyCard(f: Fixture, id: string, over: Partial<TaskCard>): TaskCard {
  const now = new Date().toISOString()
  const card: TaskCard = {
    id,
    title: `legacy ${id}`,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['artifact'],
    blockedBy: [],
    writeScopes: ['src/office.ts'],
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'planned',
    requirements: [],
    fixes: [],
    mitigates: [],
    mitigatesWaiver: [],
    impact: [],
    unfrozen: [],
    landing: [],
    evidence: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  }
  writeTask(f.store, card)
  return card
}

/* ———————————————————————————————— 真实注册的工具面 ———————————————————————————————— */

interface ToolDefinition {
  name: string
  parameters: { properties?: Record<string, unknown> }
  execute(args: unknown, exec: unknown): unknown
}

function registeredTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { tools.set(tool.name, tool); return () => {} } },
    commands: { register: (): (() => void) => () => {} },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  return tools
}

/**
 * 调一个已注册的工具（按**声明面**过滤实参，与宿主 schema 阶段同口径）。
 *
 * `async` 是必须的：工具面每个 `execute` 都是 `async`（`deps.*` 全部返回 Promise），
 * 而注册循环还会在回执尾部追写"子代理报告"等异步段 —— 同步取只会拿到一个 Promise，
 * 断言就会变成"什么都没读到"（`test/m105.test.ts` 的同款写法）。
 */
async function callTool(tools: Map<string, ToolDefinition>, name: string, workspace: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name)
  assert.ok(tool !== undefined, `${name} must be registered`)
  const properties = tool.parameters.properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agent = { id: 's226-tool', session: { header: { id: 's226-tool', cwd: workspace, delegationDepth: 0 } } }
  const result = await Promise.resolve(tool.execute(filtered, { agent } as never))
  assert.equal(typeof result, 'string', 'the tool must answer with a receipt')
  return String(result)
}

/* ———————————————————————————————— ① 中文括注必拒 / 纯路径必受 ———————————————————————————————— */

test('M226-01 (guard 1 + 2, two-state) an annotated impact is refused with a pure-path example; a pure one is accepted', async () => {
  const f = fixture('annotated')
  const target = card(f, 'target')
  const tools = registeredTools()

  // ① 反例：**带括注**的 impact（判据面永远对不上的那种写法）
  const annotated = 'src/office.ts' + '\uFF08' + 'note' + '\uFF09'
  const refused = await callTool(tools, 'sdo_task', f.workspace, { action: 'update', id: target.id, impact: JSON.stringify([annotated]) })
  assert.equal(refused.includes('not-a-path'), true, `the annotated value must be refused by code: ${refused}`)
  assert.equal(refused.includes('src/office.ts'), true, `the refusal must echo a usable pure path: ${refused}`)
  // 期望的修法示例必须是**纯路径数组**（可修，不是"形状不合法"一句话）
  const structured = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', impact: [annotated] })
  assert.equal(structured.ok, false, 'the annotated declaration must be refused')
  if (structured.ok) return
  assert.equal(structured.code, 'not-a-path', 'the structured code must say not-a-path')
  assert.equal(JSON.stringify(structured.example).includes('['), true, 'the example must be a JSON array literal')
  for (const entry of structured.example) assert.equal(/\s|[\u4e00-\u9fff]/u.test(entry), false, `the example entries must be pure paths: ${entry}`)
  // 卡面不许被这次尝试改脏
  assert.deepEqual(f.office.taskById(f.call, target.id)?.impact, [], 'a refused write must not touch the card')

  // ② 正例：**纯路径** ⇒ 真的写进去了
  const accepted = await callTool(tools, 'sdo_task', f.workspace, { action: 'update', id: target.id, impact: JSON.stringify(['src/office.ts']) })
  assert.equal(accepted.includes('not-a-path'), false, `a pure path must not be refused: ${accepted}`)
  assert.deepEqual(f.office.taskById(f.call, target.id)?.impact, ['src/office.ts'], 'a pure path must land on the card')
})

/* ———————————————————————————————— ③ 空串 / 重复项 ———————————————————————————————— */

test('M226-02 (guard 3) a blank entry and a duplicate entry are refused and named individually', () => {
  const f = fixture('blank-dup')
  const target = card(f, 'target')

  const blank = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', writeScopes: [''] })
  assert.equal(blank.ok, false, 'a blank entry must be refused')
  if (blank.ok) return
  assert.equal(blank.code, 'blank', 'the structured code must say blank')
  // 该字段这次**没有**任何合法项 ⇒ 示例回落到该字段的规范样例（可修，且是纯路径）
  assert.deepEqual(blank.example, ['src/domain/'], 'the example must fall back to the canonical pure path for that field')

  const dup = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', impact: ['src/a.ts', 'src/a.ts'] })
  assert.equal(dup.ok, false, 'a duplicate entry must be refused')
  if (dup.ok) return
  assert.equal(dup.code, 'duplicate', 'the structured code must say duplicate')
  assert.equal(dup.detail.includes('src/a.ts'), true, 'the refusal must name the duplicated value')

  // 两态：清空声明（空数组）**必须**受 —— 那是"撤回"，不是"空串"
  const cleared = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', impact: [] })
  assert.equal(cleared.ok, true, 'an empty array must be accepted (that is a withdrawal, not a blank entry)')
})

/* ———————————————————————————————— ④ 顶层目录存在性 ———————————————————————————————— */

test('M226-03 (guard 4, two-state) a not-yet-existing top level is named as a warning; using a FILE as a directory is refused', async () => {
  const f = fixture('top-dir')
  const target = card(f, 'target')
  const tools = registeredTools()

  // ① **判不了就不拦**：顶层目录还不存在 —— 既可能是笔误，也可能是本卡要新建 ⇒ **接受 + 必须看见的告警**
  const absent = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', writeScopes: ['no-such-dir/deep/x.ts'] })
  assert.equal(absent.ok, true, 'a not-yet-created top-level directory must not be refused (it may be this card new tree)')
  if (!absent.ok) return
  assert.deepEqual(
    (absent.warnings ?? []).map((warning) => `${warning.code}:${warning.missing}`),
    ['unknown-top-dir:no-such-dir'],
    'the fact must be named as a warning, not silently dropped',
  )
  assert.equal((absent.warnings ?? [])[0]?.raw, 'no-such-dir/deep/x.ts', 'the warning must echo the declared path')
  // 回执里也要看得见（口径②的"要求显式新建标记"分支：作者被要求当场确认）
  const receipt = await callTool(tools, 'sdo_task', f.workspace, { action: 'update', id: target.id, writeScopes: JSON.stringify(['no-such-dir/deep/x.ts']) })
  assert.equal(receipt.includes('no-such-dir'), true, `the receipt must name the missing top level: ${receipt}`)

  // ② **真错**：把一个**已存在的文件**当目录用 ⇒ 当场拒绝（这是笔误，不是"将来新建"）
  const fileAsDir = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', writeScopes: ['README.md/x.ts'] })
  assert.equal(fileAsDir.ok, false, 'a file used as a directory must be refused')
  if (fileAsDir.ok) return
  assert.equal(fileAsDir.code, 'file-as-directory', 'the structured code must say file-as-directory')
  assert.equal(fileAsDir.detail.includes('README.md'), true, 'the refusal must name the file')

  // ③ 两态：落在**已存在顶层目录**之下的新目录 ⇒ 接受且**一条告警都没有**
  const nested = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', writeScopes: ['test/m999-branch/a.ts'] })
  assert.equal(nested.ok, true, 'a new directory under a real top level must be accepted')
  if (nested.ok) assert.deepEqual(nested.warnings ?? [], [], 'a known top level must not raise a warning')
  // 顶层文件名（没有 `/`）不参与这条判据
  const topFile = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', landing: ['README.md'] })
  assert.equal(topFile.ok, true, 'a top-level file path must not be refused')
})

/* ———————————————————————————————— ⑤ 相交：接受 + 点名 ———————————————————————————————— */

test('M226-04 (guard 5, two-state) an overlap with an in-flight card is accepted and named in the receipt', async () => {
  const f = fixture('overlap')
  // 两张在飞卡：A 占 `src/office.ts`，B 占 `src/domain/plan.ts`
  legacyCard(f, 'TASK-0901', { status: 'in-progress', owner: 'dev-a', writeScopes: ['src/office.ts'] })
  legacyCard(f, 'TASK-0902', { status: 'in-progress', owner: 'dev-b', writeScopes: ['src/domain/plan.ts'] })
  // 目标卡自己的写范围**故意不相交**：这样"回执里有没有点名"只取决于本次声明（才是干净的两态）
  const target = card(f, 'target', { writeScopes: ['src/never-touched.ts'] })
  const tools = registeredTools()

  // ① 相交 ⇒ **接受**（不是拒绝），但回执必须点名"谁 + 哪条路径"
  const hit = await callTool(tools, 'sdo_task', f.workspace, { action: 'update', id: target.id, impact: JSON.stringify(['src/office.ts']) })
  assert.equal(hit.includes('TASK-0901'), true, `the receipt must name the overlapping in-flight card: ${hit}`)
  assert.equal(hit.includes('src/office.ts'), true, `the receipt must name the overlapping path: ${hit}`)
  assert.equal(hit.includes('not-a-path'), false, 'an overlap is not a shape error')
  assert.deepEqual(f.office.taskById(f.call, target.id)?.impact, ['src/office.ts'], 'the overlapping declaration must still land')

  // ② 结构化读数同源（回执文字与 `overlaps` 不许各说一套）
  const again = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', impact: ['src/office.ts'] })
  assert.equal(again.ok, true, 'an overlap must be accepted')
  if (!again.ok) return
  assert.deepEqual(
    (again.overlaps ?? []).map((row) => `${row.taskId}:${row.field}:${row.path}`),
    ['TASK-0901:impact:src/office.ts'],
    'the structured reading must name the same pair (field + path + card)',
  )

  // ③ 两态：另建一张卡，本次声明**不相交** ⇒ 回执里不许出现任何相交点名
  const cleanTarget = card(f, 'clean', { writeScopes: ['src/clean-only.ts'] })
  const clean = await callTool(tools, 'sdo_task', f.workspace, { action: 'update', id: cleanTarget.id, impact: JSON.stringify(['src/clean-only.ts']) })
  assert.equal(clean.includes('TASK-0901'), false, `a non-overlapping write must not name in-flight cards: ${clean}`)
  // ④ 只读入口（任何回执/提示通道都能取到同一份读数）
  assert.equal(f.office.declarationOverlapLines(f.call).length >= 1, true, 'the read-only entry must report the open overlap')
})

/* ———————————————————————————————— 建卡两条路径 ———————————————————————————————— */

test('M226-05 (decompose) a bad suggestion is refused with an issue while a good one still creates its card', () => {
  const f = fixture('decompose')
  const outcome = f.office.planDecompose(f.call, {
    suggestions: [
      { title: 'bad-shape', dod: ['d'], role: 'developer', writeScopes: [''] },
      { title: 'good-shape', dod: ['d'], role: 'developer', writeScopes: ['src/office.ts'] },
    ],
  } as never)
  const issue = outcome.issues.find((item) => item.code === 'declaration-invalid')
  assert.equal(issue !== undefined, true, `a bad declaration must raise its own issue: ${outcome.issues.map((item) => item.code).join(' ')}`)
  assert.equal(issue?.taskId, 'bad-shape', 'the issue must name the refused suggestion by title')
  assert.equal(issue?.detail.includes('[') || (issue?.remedy ?? '').includes('['), true, 'the issue must carry a pure-path array example')
  assert.equal(outcome.tasks.some((task) => task.title === 'bad-shape'), false, 'no card may be created for a bad declaration')
  assert.equal(outcome.tasks.some((task) => task.title === 'good-shape'), true, 'a legal suggestion must still create its card')

  // 防御纵深：绕过 `decompose` 直接建卡同样拒（唯一建卡入口，漏一层就是后门）
  assert.throws(
    () => createTask(f.store, f.journal, { title: 'x', goal: 'g', dod: ['d'], role: 'developer', writeScopes: ['bad top/'] } as never),
    /bad top|not a pure path|use a pure path|\uFF08/u,
    'createTask itself must refuse a bad declaration',
  )
})

/* ———————————————————————————————— 不回溯历史 ———————————————————————————————— */

test('M226-06 (no retroactivity) legacy annotated declarations on old cards are not re-judged', () => {
  const f = fixture('legacy')
  const annotated = 'src/office.ts' + '\uFF08' + 'old note' + '\uFF09'
  // 历史遗留形状（本卡之前写进去的）：仍然留在卡面上，谁也不许追溯判红
  legacyCard(f, 'TASK-0903', { status: 'done', impact: [annotated] })
  const stored = f.office.taskById(f.call, 'TASK-0903')
  assert.deepEqual(stored?.impact, [annotated], 'a legacy declaration must stay exactly as written')

  // 判据面（`validatePlan` 一族）**没有**任何"声明形状"判据：本卡的校验只挂在新写入的三个点
  const codes = f.office.planIssues(f.call).map((issue) => issue.code)
  assert.equal(codes.includes('declaration-invalid' as never), false, 'no retroactive declaration issue may appear for stored cards')

  // 新写入照常判（同一条口径，不分老新卡）
  const live = card(f, 'live')
  const refused = f.office.updateTask(f.call, { taskId: live.id, by: 'cockpit', impact: [annotated] })
  assert.equal(refused.ok, false, 'a new write of the same shape must still be refused')
})

/* ———————————————————————————————— 语言中立 ———————————————————————————————— */

test('M226-07 (i18n) the refusal and the overlap note are CJK-free under en', () => {
  const f = fixture('en')
  legacyCard(f, 'TASK-0904', { status: 'in-progress', owner: 'dev-a', writeScopes: ['src/office.ts'] })
  // 第二张在飞卡：`declarationOverlaps(call)` 的口径是"在飞卡**之间**"，只有一张时它按定义为空
  legacyCard(f, 'TASK-0905', { status: 'in-progress', owner: 'dev-b', writeScopes: ['src/domain/plan.ts'] })
  const target = card(f, 'target', { writeScopes: ['src/never-touched.ts'] })
  setLocale('en')
  try {
    const refused = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', impact: ['src/office.ts（note）'] })
    assert.equal(refused.ok, false, 'the annotated declaration must still be refused under en')
    if (!refused.ok) assert.equal(CJK.test(refused.detail), false, `the en refusal must stay CJK-free: ${refused.detail}`)
    const accepted = f.office.updateTask(f.call, { taskId: target.id, by: 'cockpit', impact: ['src/office.ts'] })
    assert.equal(accepted.ok, true, 'the pure path must be accepted under en')
    for (const line of f.office.declarationOverlapLines(f.call)) {
      assert.equal(CJK.test(line), false, `the en overlap note must stay CJK-free: ${line}`)
    }
  } finally {
    setLocale('zh-CN')
  }
  // 反向：基准语言下同一份读数**确实**是中文（否则"零中文"只是因为它什么都没说）
  assert.equal(CJK.test(f.office.declarationOverlapLines(f.call).join('\n')), true, 'the base locale must localise the same reading')
})

/* ———————————————————————————————— 纯函数层（不吃台账） ———————————————————————————————— */

test('M226-08 (pure layer) the checker is a pure function: normalized output, no side effects, stable repeats', () => {
  const ok = checkDeclaration({ impact: ['./src/a.ts', 'test/b.ts', 'src/a.ts'] }, { root: process.cwd() })
  assert.equal(ok.ok, false, 'the duplicate must be refused even when everything else is pure')
  assert.equal(ok.code, 'duplicate', 'the first problem decides the code')
  assert.deepEqual(ok.normalized.impact, ['src/a.ts', 'test/b.ts'], 'normalization strips ./ and de-duplicates')

  const clean = checkDeclaration({ writeScopes: ['src/domain/'] }, { root: process.cwd() })
  assert.equal(clean.ok, true, 'a pure path under a real top-level directory must pass')
  assert.deepEqual(clean.normalized.writeScopes, ['src/domain/'], 'the normalized form keeps the directory slash')

  // 判不了就不判：没有工作区（`root` 缺省）时**整条②跳过**，绝不放行成"任意路径都拒"
  const noRoot = checkDeclaration({ writeScopes: ['no-such-dir/x.ts'] })
  assert.equal(noRoot.ok, true, 'without a workspace the existence rule must be skipped, not guessed')

  // 相交判定走唯一出口（目录范围覆盖其下；同名互为前缀的两个文件不相交）
  const overlaps = declarationOverlaps(
    { impact: ['src/domain/plan.ts'], writeScopes: ['src/a.ts'] },
    [{ id: 'TASK-1', writeScopes: ['src/domain/'] }, { id: 'TASK-2', writeScopes: ['src/a.tsx'] }],
  )
  assert.deepEqual(overlaps.map((row) => `${row.taskId}:${row.field}`), ['TASK-1:impact'], 'the directory scope intersects, the file-prefix twin does not')

  // 幂等：同一入参两次判定逐字相同（不吃时间、不吃台账）
  assert.deepEqual(checkDeclaration({ impact: ['src/x'] }, { root: process.cwd() }), checkDeclaration({ impact: ['src/x'] }, { root: process.cwd() }))
})

/* ———————————————————————————————— 卡面读回（防"只判不写") ———————————————————————————————— */

test('M226-09 (landing) accepted declarations are really written and readable back', () => {
  const f = fixture('landing')
  const target = card(f, 'target')
  const written = f.office.updateTask(f.call, {
    taskId: target.id,
    by: 'cockpit',
    impact: ['src/office.ts'],
    landing: ['src/landing.ts'],
    writeScopes: ['src/office.ts', 'test/m226.test.ts'],
  })
  assert.equal(written.ok, true, 'a fully legal declaration set must be accepted')
  const readBack = listTasks(f.store).find((item) => item.id === target.id)
  assert.deepEqual(readBack?.impact, ['src/office.ts'], 'impact must be on the card')
  assert.deepEqual(readBack?.landing, ['src/landing.ts'], 'landing must be on the card')
  assert.deepEqual(readBack?.writeScopes, ['src/office.ts', 'test/m226.test.ts'], 'writeScopes must be on the card')
})

/**
 * **`M226-10`（`TASK-190` / `ADR-031` ⑤）：`bash` 对 office 的三处封锁，一处都不许被从别处引回来。**
 *
 * 真正的风险不是"配置里少了 deny 那一项"（那早在 `TASK-189` 就成立），而是**有人从别处把它加回来**：
 * presets 的挂载行、presets 的纪律工具面、以及代码侧的工具**分组声明**。
 *
 * 三条判据 + 一条反例自证：
 *   ① `roles.yml`：office 的 `allow` **不含** bash、`deny` **含** bash（现读，不采信注释）；
 *   ② `presets/sdo-office.patch.yml`：**不挂** `tool-bash`，`disciplineTools` 里**没有** bash；
 *   ③ 分组声明：`OFFICE_TOOL_GROUPS.bash` 是**空组**（断言在声明上，不只断言 roles.yml —— `TASK-189` 的教训）；
 *   ④ 反例自证：把一份**故意**在 allow 里写了 bash 的假 roles 表喂给同一个扫描函数 ⇒ 必须**点名**它，
 *      否则这条判据就是恒真（只证明"现实里没有"，不证明"能抓"）。
 *
 * 断言消息全英文（本文件不进 `KNOWN_PROSE_GAP`，中文只写在断言之外）。
 */
test('M226-10 (bash, three faces) office never gets bash: roles allow/deny, preset mount + discipline face, group declaration', () => {
  const rolesText = readFileSync(join(ROOT, 'src', 'data', 'roles.yml'), 'utf8')
  // ① roles.yml：office 段的 allow / deny（现读，不看注释）
  const allowOffenders = rolesWithBashInAllow(rolesText)
  assert.equal(allowOffenders.includes('office'), false, `office must never list bash in allow (offenders: ${allowOffenders.join(',') || 'none'})`)
  assert.equal(roleDenyOf(rolesText, 'office').includes('bash'), true, 'office must keep bash in deny')
  // ④ 反例自证：同一扫描函数对一份**故意**犯规的假表必须点名（否则 ① 只是"现实里没有"）
  const fake = ['roles:', '  - code: office', '    allow: [read, bash]', '    deny: []', ''].join('\n')
  assert.deepEqual(rolesWithBashInAllow(fake), ['office'], 'self-proof: the same scan must catch a role that puts bash in allow')

  // ② presets：不许挂 tool-bash、纪律工具面里不许有 bash
  const preset = readFileSync(join(ROOT, 'presets', 'sdo-office.patch.yml'), 'utf8')
  // 挂载行**必须留着**：M28-02 要求「roles.yml 里出现的非本插件工具名都要有提供行」，
  // 而 developer/tester 等角色确实用 bash ⇒ 共享 preset 必须挂它；office 拿不到 bash 靠 deny + 不在 allow。
  assert.equal(/^\s*-\s*id:\s*tool-bash\s*$/mu.test(preset), true, 'the shared preset must keep the tool-bash mount row (M28-02)')
  const discipline = /disciplineTools:\s*\[([^\]]*)\]/u.exec(preset)
  assert.ok(discipline !== null, 'the preset must declare disciplineTools explicitly')
  assert.equal((discipline[1] ?? '').includes('bash'), false, `bash must not be a discipline tool for office: ${String(discipline[1])}`)

  // ③ 分组声明：bash 组必须是空组
  assert.deepEqual(OFFICE_TOOL_GROUPS.bash, [], 'the bash group in the office tool face must stay empty')
})

/** 一份 `roles.yml` 文本里，把 `bash` 写进 `allow` 的角色码（按段现读，不采信注释）。 */
function rolesWithBashInAllow(text: string): string[] {
  const offenders: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    const code = /^\s*-\s*code:\s*(\S+)\s*$/u.exec(line)
    if (code !== null) { current = code[1] ?? ''; continue }
    const allow = /^\s+allow:\s*\[([^\]]*)\]/u.exec(line)
    if (allow === null || current === '') continue
    if ((allow[1] ?? '').split(',').map((item) => item.trim()).includes('bash')) offenders.push(current)
  }
  return offenders
}

/** 一份 `roles.yml` 文本里某个角色码的 `deny` 列表（空/缺省 ⇒ 空数组）。 */
function roleDenyOf(text: string, code: string): string[] {
  let current = ''
  for (const line of text.split('\n')) {
    const found = /^\s*-\s*code:\s*(\S+)\s*$/u.exec(line)
    if (found !== null) { current = found[1] ?? ''; continue }
    if (current !== code) continue
    const deny = /^\s+deny:\s*\[([^\]]*)\]/u.exec(line)
    if (deny !== null) return (deny[1] ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')
  }
  return []
}
