/**
 * **增量 184：第六批 §3.7（`DEF-081`）+ §3.5（`D1`）。**
 *
 * §3.7：`blockedBy` 是**别人写在我身上**的声明 ⇒ 把被引用那张卡作废，引用者的依赖**永远等不到**
 * （`blockedTasks` 只认"指向未结束的卡"，被作废的引用就变成"等一张永远不会完成的卡"而**永久卡住**）。
 * 修法：作废前点名**直接引用者 + 传递下游**；`'*'`（等所有卡）不算下游。
 *
 * §3.5：`lib/` 是交付产物 ⇒「变异/试验只在副本树里做」＋「变异先自证字节变了」＋
 * 「`lib/` 不被 git 跟踪 ⇒ 用 sha256/cmp 判定」三条必须写进**随包交付的角色卡**与 docs 约定处。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { dropDependents } from '../src/domain/plan.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm184')
const WORKSPACE = join(BASE, 'proj')

/**
 * **`R22`（第十一批 §3.4）的三处精确化 —— 第十二批 `DEF-102` 起按落点分开判**：
 *   · **随包卡**（`skills/role-*.md`）：只留与项目无关的**原则**（`R22-③` 基数给算式）；
 *   · **项目侧**（`docs/README.md`）：冻结件、tap 的适用面与项目命令（`R22-①` / `R22-②`）。
 * 判据都是**字面串 / 标识符存在性**（不读措辞、不看语言），缺哪一处就**点名哪一处**。
 */
const R22_CARD: readonly { id: string; literal: string }[] = [
  {
    id: 'R22-③（随包卡：基数类断言必须给算式）',
    literal: '18. **基数类断言必须给算式** —— 凡引用**台账基数**（卡数、缺陷数、用例数、站点数…）一律**现算并写出算式**',
  },
]

const R22_PROJECT: readonly { id: string; literal: string }[] = [
  { id: 'R22-①（项目侧：历史任务书是冻结件）', literal: '**不许**改历史任务书' },
  {
    id: 'R22-②（项目侧：tap 只在直接 node --test 下有效）',
    literal: '经 `scripts/run-tests.mjs` **传不进去**（该脚本第 **37** 行自拼 `spawnSync`）',
  },
]

const missingCardPrecisions = (text: string): string[] =>
  R22_CARD.filter((item) => !text.includes(item.literal)).map((item) => item.id)
const missingProjectPrecisions = (text: string): string[] =>
  R22_PROJECT.filter((item) => !text.includes(item.literal)).map((item) => item.id)

interface ToolDefinition { name: string; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

function harness(): ToolDefinition[] {
  const list: ToolDefinition[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { list.push(tool); return () => {} } }, sessions: {} }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return list
}
const card = (id: string, blockedBy: string[]): TaskCard => ({
  id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
  owner: 'dev-a', blockedBy, writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
  status: 'in-progress', requirements: [], evidence: [], createdAt: '', updatedAt: '',
})

let call: { sessionId: string; cwd: string }
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, '.sdo'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  call = { sessionId: 's-cockpit', cwd: WORKSPACE }
  office.noteSession(call.sessionId, WORKSPACE)
  office.init(call, { name: 'm184', scale: 'normal', stakeholders: ['x'] })
  const store = office.storeFor(WORKSPACE)
  store.writeYaml(['tasks', 'TASK-001.yml'], { task: card('TASK-001', []) })
  store.writeYaml(['tasks', 'TASK-002.yml'], { task: card('TASK-002', ['TASK-001']) })
  store.writeYaml(['tasks', 'TASK-003.yml'], { task: card('TASK-003', ['TASK-002']) })
  store.writeYaml(['tasks', 'TASK-004.yml'], { task: card('TASK-004', ['*']) })
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M184-01 §3.7 行为（真注册面）：直接引用者 + 传递下游 ⇒ `drop` 被拒、点名、**零写盘**', async () => {
  const drop = harness().find((item) => item.name === 'sdo_task')
  assert.ok(drop !== undefined)
  const exec = { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }
  const refused = String(await drop.execute({ action: 'drop', id: 'TASK-001', reason: '拆错了' }, exec))
  assert.match(refused, /被拒/u, `必须可读拒绝：${refused.slice(0, 300)}`)
  assert.match(refused, /TASK-002/u, '必须点名直接引用者')
  assert.match(refused, /TASK-003/u, '必须点名传递下游（B 引 A、C 引 B）')
  assert.equal(refused.includes('TASK-004'), false, '`*` 不算下游（它等的是全部，少一张没被吊住）')
  const still = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  assert.equal(still?.status, 'in-progress', '被拒时**零写盘**（卡状态不许变）')
  // 反例：没有人引用它 ⇒ 放行（不是恒拒）
  const ok = String(await drop.execute({ action: 'drop', id: 'TASK-004', reason: '不需要了' }, exec))
  assert.equal(ok.includes('被拒'), false, `没人吊着就必须放行：${ok.slice(0, 200)}`)
  assert.equal(office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-004.yml')?.task?.status, 'dropped', '放行后真的作废')
})

test('M184-02 §3.7 读数（`dropDependents`）：直接/传递分层，`*` 与已结束的卡都不算', () => {
  const tasks = [
    card('TASK-001', []), card('TASK-002', ['TASK-001']), card('TASK-003', ['TASK-002']),
    card('TASK-004', ['*']), { ...card('TASK-005', ['TASK-003']), status: 'done' as TaskCard['status'] },
  ]
  const one = dropDependents(tasks, 'TASK-001')
  assert.deepEqual(one.direct.map((task) => task.id), ['TASK-002'], '直接引用者只有 TASK-002')
  assert.deepEqual(one.downstream.map((task) => task.id), ['TASK-003'], '传递下游只有 TASK-003（已 done 的 TASK-005 不算）')
  assert.deepEqual(dropDependents(tasks, 'TASK-004'), { direct: [], downstream: [] }, '没人引用 ⇒ 空（可作废）')
  assert.deepEqual(dropDependents(tasks, 'TASK-003').downstream, [], '末端卡没有下游')
})

test('M184-03 §3.5（`D1`）/ `DEF-102`：原则进随包卡、清单与命令只落项目侧（**两份不同源**）', () => {
  const cards = ['skills/role-developer.md', 'skills/role-tester.md', 'skills/role-reviewer.md']
  // **随包卡**：只留与项目无关的原则（缺任一条 ⇒ 红并点名）
  const PRINCIPLES: readonly [string, string][] = [
    ['绝不改主工作区的交付产物目录', '第 1 条：交付产物目录不许就地改'],
    ['副本树必须**完整**', '第 1 条：副本树要完整（清单以项目声明为准）'],
    ['以项目声明为准', '第 1/7/8 条：具体清单与工具以项目声明为准'],
    ['从盘上读回', '第 13 条：哈希变了 ≠ 文件被写了'],
    ['必须**逐用例**取读数', '第 16 条：逐用例取读数'],
    ['基数类断言必须给算式', '第 18 条：基数给算式'],
    ['副本树清单只在项目侧维护', '第 8 条：清单只在项目侧维护'],
    ['「哈希变了」 ≠ 「文件被写了」', '第 13 条标题'],
    ['运算符优先级会造出不存在的缺陷', '第 17 条'],
  ]
  for (const rel of cards) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    assert.match(text, /变异与交付产物的纪律/u, `${rel} 缺 D1 那一节`)
    for (const [phrase, why] of PRINCIPLES) assert.ok(text.includes(phrase), `${rel} 缺原则「${phrase}」（${why}）`)
    // **`DEF-102` 的验收**：随包面不许出现本仓的工具链 / 目录（任何项目装上都会读到）
    const hits = text.match(/\bnpm\b|\btsc\b|node_modules|tsconfig|client\.d\.ts|presets\/|package-lock|sha256sum|diff -rq|xargs/u)
    assert.equal(hits, null, `${rel} 的随包面不许出现本仓工具链（命中了「${hits?.[0]}」）`)
    const section = text.slice(text.indexOf('## 变异与交付产物的纪律'))
    const bullets = (section.match(/^\d+\. /gmu) ?? []).length
    assert.equal(bullets, 18, `${rel} 的 D1 必须是 18 条原则，实际 ${bullets} 条`)
    assert.deepEqual(missingCardPrecisions(text), [], `${rel} 缺 R22 的随包卡部分：${missingCardPrecisions(text).join(' / ')}`)
  }
  // 三张随包卡的那个节必须**逐字节相同**（同属交付侧）
  const cardHash = (rel: string): string => {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    return createHash('sha256').update(text.slice(text.indexOf('## 变异与交付产物的纪律'))).digest('hex')
  }
  assert.equal(new Set(cards.map(cardHash)).size, 1, '三张随包卡的 D1 必须逐字节相同')
  // **项目侧**：清单 / 命令 / 路径只在 `docs/README.md`（第十二批 §0-2：项目侧 ≠ 交付侧）
  const docs = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8')
  const PROJECT: readonly [string, string][] = [
    ['15 项', '副本树 15 项'],
    ['指向仓库 `node_modules` 的软链', '清单第 15 项'],
    ['node scripts/run-tests.mjs', '全量测试命令'],
    ['不许', '`npm test` 的禁令'],
    ['npm test', '被禁的复合命令'],
    ['`git ls-files .sdo/` = 0', '台账不被跟踪'],
    ['sha256sum', '哈希工具'],
    ['diff -rq', '中文标签会骗出假 0'],
    ['`--test-reporter=tap`', '完成计数的来源'],
    ['第 **37** 行', '`scripts/run-tests.mjs` 自拼 spawnSync 的位置'],
  ]
  for (const [literal, why] of PROJECT) assert.ok(docs.includes(literal), `docs/README.md 缺项目侧项「${literal}」（${why}）`)
  for (const file of ['README.md', 'presets/', 'tsconfig.json', 'client.d.ts', 'CHANGELOG.md', 'client.js', 'package.json', 'package-lock.json']) {
    assert.ok(docs.includes(file), `docs/README.md 的 15 项清单缺「${file}」`)
  }
  assert.deepEqual(missingProjectPrecisions(docs), [], `docs/README.md 缺 R22 的项目侧部分：${missingProjectPrecisions(docs).join(' / ')}`)
  // **两份不同源**（第十二批 §0-2 作废了"四份同哈希"）
  const docsHash = createHash('sha256').update(docs.slice(docs.indexOf('## 变异与交付产物的纪律'))).digest('hex')
  assert.notEqual(cardHash(cards[0] as string), docsHash, '项目侧与交付侧不该同源（`DEF-102` 就是同源灌出来的）')
})

test('M184-04 §3.4（R22）三处精确化**单点可红**：按落点逐处删 ⇒ 只报那一处（并点名）', () => {
  const card = readFileSync(join(ROOT, 'skills', 'role-developer.md'), 'utf8')
  assert.deepEqual(missingCardPrecisions(card), [], '现盘随包卡该节必须齐备（缺任一处 ⇒ 这里先红并点名）')
  for (const item of R22_CARD) {
    const legacy = card.replace(item.literal, '')
    assert.notEqual(legacy, card, `变异必须真的改了字节：${item.id}`)
    assert.deepEqual(missingCardPrecisions(legacy), [item.id], `删/改 ${item.id} ⇒ 只报它一处`)
  }
  const docs = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8')
  assert.deepEqual(missingProjectPrecisions(docs), [], '现盘项目侧该节必须齐备（缺任一处 ⇒ 这里先红并点名）')
  for (const item of R22_PROJECT) {
    const legacy = docs.replace(item.literal, '')
    assert.notEqual(legacy, docs, `变异必须真的改了字节：${item.id}`)
    assert.deepEqual(missingProjectPrecisions(legacy), [item.id], `删/改 ${item.id} ⇒ 只报它一处`)
  }
})

test('M184-05 §3.2（`DEF-103`）：语言包示例去项目化 —— 不许出现具体命令 / 具体数字例子', () => {
  for (const rel of ['src/data/lang/zh-CN.yml', 'src/data/lang/en.yml']) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    const hits = text.match(/\bnpm\b|\btsc\b|\b420\b|lib\/x\.js|node --test/u)
    assert.equal(hits, null, `${rel} 的示例不许出现具体命令 / 具体数字（命中了「${hits?.[0]}」）—— 改成工具无关占位（\`DEF-103\`）`)
  }
  // 占位形态在位（中英同义；两包的键集与结构由既有 `m7` / `m36` 守）
  const zh = readFileSync(join(ROOT, 'src/data/lang', 'zh-CN.yml'), 'utf8')
  const en = readFileSync(join(ROOT, 'src/data/lang', 'en.yml'), 'utf8')
  assert.ok(zh.includes('＜项目的测试命令＞') && zh.includes('＜产物路径＞'), '中文包要给出工具无关占位（测试命令 / 产物路径）')
  assert.ok(en.includes("<the project's test command>") && en.includes('<artifact path>'), '英文包要给出同义的占位')
})
