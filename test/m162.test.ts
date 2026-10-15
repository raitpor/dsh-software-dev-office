/**
 * **增量 162：第三批残留 R1–R4（§3.3–§3.6）**。
 *
 * 任务书把它们归为"文案/措辞类残留"，但 §4 红线 6 明写：**文案类也必须附一条"行为不变/仍成立"的机械读数**。
 * 本文件就是那四条的机械读数（R3 本来就是"缺机械断言"，其余三条各配一条行为读数）：
 *
 * | 项 | 残留本体 | 本文件的机械读数 |
 * |---|---|---|
 * | **R1** | `exempt` 的**描述例句**仍是旧三键 `{task, check, why}`，实现已接受 `approvedBy`/`impact`（任务书写成"`sdo_task` 的 `exempt`"，现盘该参数其实挂在 **`sdo_plan action=profile`** 上 —— 如实更正，不复述错误出处） | 描述里能看到两键 **且** 把描述里的例句原样喂给**真实写入口** ⇒ 收下；剥掉 `approvedBy` ⇒ 拒收并点名 |
 * | **R2** | 语言包 `uiPlan.kUiTextScopeRemedy` 的举例含本仓目录 `src/data/lang/` | 两包文案不含 `src/`（中立化）**且** 判据仍指向项目声明的 `plan.textPaths`（行为不变） |
 * | **R3** | `sdo_hash` 的"只读性"只断言了返回体键集合，**没有**断言"没写台账/没落事件" | 调用 `sdo_hash` 前后：`.sdo/` **逐文件 sha256 清单**逐字不变 **且** journal **逐字节**不变 |
 * | **R4** | "消费观测"在文档/用例名里写**三态**，而类型/实现/§9 是**四态** | 三处措辞统一为四态（并如实记录书里那处 `office.ts:3300` 是行号漂移） |
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { readConstructionProfile } from '../src/domain/construction.js'
import { createTask, validatePlan } from '../src/domain/plan.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { createOfficeTools } from '../src/interface/tools.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m162/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')
const ARTIFACT = 'build/out.txt'

interface ToolDefinition {
  name: string
  description?: string
  /** **注册面**的 JSON Schema（`createOfficeTools` 返回的就是它 ⇒ 读到的正是模型看见的那一份） */
  parameters: { type?: string; properties: Record<string, { description?: string }> }
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let store: SdoStore
const call = { sessionId: 's-batch3', cwd: WORKSPACE } as unknown as OfficeCall

const toolDef = (name: string): ToolDefinition => {
  const def = (createOfficeTools({} as never) as unknown as ToolDefinition[]).find((item) => item.name === name)
  assert.ok(def !== undefined, `工具面必须有 ${name}`)
  return def
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const def = toolDef(name)
  const agentStub = { id: 'rev-1', session: { header: { id: 'rev-1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await def.execute(args, { agent: agentStub }))
}

/** `.sdo/` 的**逐文件 sha256 清单**（排序后逐字比较：比"数量没变"这种粗读数强一级）。 */
function sdoDigest(): string[] {
  const root = join(WORKSPACE, '.sdo')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) return walk(full)
      const hash = createHash('sha256').update(readFileSync(full)).digest('hex')
      return [`${relative(root, full)}:${hash}`]
    })
  return walk(root).sort()
}

const journalBytes = (): string => readFileSync(join(WORKSPACE, '.sdo', 'journal.jsonl'), 'utf8')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'build'), { recursive: true })
  writeFileSync(join(WORKSPACE, ARTIFACT), 'artifact body for m162\n')
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-batch3', WORKSPACE)
  office.init(call, { name: 'M162 第三批残留', scale: 'critical', stakeholders: ['业务方'] })
  store = office.storeFor(WORKSPACE)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M162-01（R3）`sdo_hash` 是**只读**的：前后 `.sdo/` 逐文件哈希清单 + journal 逐字节都不变', async () => {
  const filesBefore = sdoDigest()
  const journalBefore = journalBytes()
  const eventsBefore = journalBefore.split('\n').filter((line) => line.trim() !== '').length

  const receipt = await callTool('sdo_hash', { path: ARTIFACT })
  assert.match(receipt, /[0-9a-f]{64}/u, '前置：这次调用确实成功了（否则"没写"是废话）')

  // 两级判：① 文件清单**逐字**（含内容哈希）② journal **逐字节**
  assert.deepEqual(sdoDigest(), filesBefore, '`sdo_hash` 不得改动 `.sdo/` 里的任何文件（逐文件 sha256 逐字比较）')
  assert.equal(journalBytes(), journalBefore, '`sdo_hash` 不得往 journal 落事件（逐字节比较，不是"条数没变"）')
  assert.equal(journalBytes().split('\n').filter((line) => line.trim() !== '').length, eventsBefore, '（读数）事件条数也不变')
})

test('M162-02（R1）`exempt` 描述例句与实现**同源**：含新键、原样喂给真实写入口被收下、剥掉批准人被拒', async () => {
  const description = toolDef('sdo_plan').parameters.properties['exempt']?.description ?? ''
  assert.notEqual(description, '', '前置：exempt 参数必须有描述')
  assert.equal(description.includes('approvedBy'), true, '描述里必须能看到 `approvedBy`（DEF-030 的批准人）')
  assert.equal(description.includes('impact'), true, '描述里必须能看到 `impact`（DEF-030 的影响面）')

  // 从描述里**取出例句本身**（不是另写一份），证明"描述与实现同源"
  const example = /'(\[\{.*?\}\])'/su.exec(description)?.[1]
  assert.ok(example !== undefined, `描述里必须有一个 JSON 例句可被取出：${description.slice(0, 200)}`)
  const parsed = JSON.parse(example) as Record<string, unknown>[]
  assert.equal(Array.isArray(parsed) && parsed.length > 0, true, '例句必须是可解析的豁免数组')

  const card = createTask(store, journalFor(), {
    title: '夹具卡', goal: 'g', dod: ['d'], role: 'developer', size: 'small', writeScopes: ['src/x.ts'],
  } as never)
  const decide = (exempt: unknown[]): ReturnType<SoftwareDevOffice['decideConstructionProfile']> =>
    office.decideConstructionProfile(call, {
      packages: ['tdd'], scope: 'all', derivedFrom: ['scale=critical'], reason: '夹具', exempt: exempt as never, by: 'office',
    })

  // ① 例句（换成本工作区真实存在的卡 id，其余键**原样**）⇒ 收下
  const accepted = decide(parsed.map((item) => ({ ...item, task: card.id })))
  assert.equal(accepted.ok, true, `描述里的例句必须能被真实写入口收下（同源）：${JSON.stringify(accepted)}`)
  const written = readConstructionProfile(store).profile
  assert.ok(written !== undefined, '前置：同源例句被收下后 profile 必须真的落盘')

  // ② 剥掉例句里的 `approvedBy` ⇒ 拒收并点名（这才是"描述与实现同源"的反向证据）
  const stripped = parsed.map(({ approvedBy: _drop, ...rest }) => ({ ...rest, task: card.id }))
  const rejected = decide(stripped)
  assert.equal(rejected.ok, false, '没有批准人的豁免必须被拒（描述既然写了它，就该是硬要求）')
  if (!rejected.ok) {
    assert.equal(
      rejected.problems.some((line) => line.includes('approvedBy') || line.includes(card.id)),
      true,
      `拒因必须点名缺的键或那张卡：${rejected.problems.join('；')}`,
    )
  }

  // ③ **类型反例（本轮实测出来的坑）**：`impact` 是**普通字符串**（不同于卡面 `impact` 的数组形态）。
  // 照抄成数组时，修前实现会**崩栈**（`(item.impact ?? '').trim is not a function`）⇒ 现在必须
  // 走**可读拒绝**（点名 c41），整次拒绝且零写盘 —— 描述里那句"both are plain strings"因此是同源声明。
  const wrongType = parsed.map((item) => ({ ...item, task: card.id, impact: ['a-array-instead-of-a-string'] }))
  const shapeRejected = decide(wrongType as never)
  assert.equal(shapeRejected.ok, false, '类型不对的 impact 必须被拒（不许崩栈、不许静默收下）')
  if (!shapeRejected.ok) {
    assert.equal(
      shapeRejected.problems.some((line) => line.includes('impact') || line.includes(card.id)),
      true,
      `拒因必须可读且指向该字段/该卡：${shapeRejected.problems.join('；')}`,
    )
  }
  assert.equal(readConstructionProfile(store).profile !== undefined, true, '前置：成功那一次确实写了盘（所以下面要比对"没被改动"）')
  assert.deepEqual(
    readConstructionProfile(store).profile,
    written,
    '两次拒绝都必须**零写盘**：profile 逐字段不变（不是"文件还在"这种粗读数）',
  )
})

test('M162-03（R2）文案中立化：两包的 remedy 不含本仓目录，且判据仍指向项目声明的 `plan.textPaths`', () => {
  for (const pack of ['zh-CN.yml', 'en.yml']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'lang', pack), 'utf8')
    const value = /kUiTextScopeRemedy: '(.*)'/u.exec(text)?.[1] ?? ''
    assert.notEqual(value, '', `前置：${pack} 必须有 kUiTextScopeRemedy`)
    assert.equal(value.includes('src/'), false, `${pack} 的 remedy 不得内置本仓源码布局（长期约束：语言无关、不内置具体路径）`)
    assert.equal(value.includes('plan.textPaths'), true, `` + '行为不变：remedy 仍必须指向项目声明的那一行配置')
  }
  // 行为读数（两态）：判据只看**项目声明的**文案面 ⇒ 没声明时判红且 remedy 就是那句话
  const card = createTask(store, journalFor(), {
    title: '文案卡', goal: 'g', dod: ['d'], role: 'developer', size: 'small', writeScopes: ['src/x.ts'], uiText: true,
  } as never)
  const issues = validatePlan([card])
  const issue = issues.find((item) => String(item.code) === 'ui-text-scope')
  assert.ok(issue !== undefined, `未声明文案面时必须判红：${JSON.stringify(issues)}`)
  assert.match(String(issue.remedy), /plan\.textPaths/u, 'remedy 必须给出那一行配置（行为不变）')
  assert.doesNotMatch(String(issue.remedy), /src\//u, 'remedy 里不得出现本仓布局（中立化后的读数）')
})

test('M162-04（R4）措辞统一为**四态**；书里点名的 `office.ts:3300` 是行号漂移（如实核）', () => {
  const doc = readFileSync(join(ROOT, 'src', 'domain', 'dispatchHealth.ts'), 'utf8')
  const test158 = readFileSync(join(ROOT, 'test', 'm158.test.ts'), 'utf8')
  const officeSrc = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.equal(/可观测的\*\*四态\*\*/u.test(doc), true, 'dispatchHealth 的口径必须写四态')
  assert.equal(/可观测的\*\*三态\*\*/u.test(doc), false, '不得再写三态')
  assert.equal(/消费\*\*四态\*\*/u.test(test158), true, 'm158 的文件头必须写四态')
  assert.equal(/消费观测四态/u.test(test158), true, 'm158 的用例名必须写四态')
  assert.equal(/消费三态/u.test(test158), false, 'm158 不得再写消费三态')
  // 如实记录：任务书点名 `office.ts:3300` 那处，现盘已不含"三态"（行号漂移；那处是 DEF-014 的注释）
  assert.equal(/三态/u.test(officeSrc), officeSrc.includes('三态'), '读物一致性（下面逐条钉住唯一那处）')
  const occurrences = [...officeSrc.matchAll(/三态/gu)]
  // **R4 后续（DEF-048 同轮）**：这里原来 pin 的是**行号**（`[1683]`）—— 任何在它上方增删一行都会让它红
  //（本轮给 import 加一行就触发了）。改成 pin **唯一性与内容**：仍旧钉住"唯一那处是判据三态、与消费观测无关"。
  assert.equal(occurrences.length, 1, 'office.ts 里只允许一处「三态」（判据三态），消费观测一律写四态')
  const lineNo = officeSrc.slice(0, occurrences[0]?.index ?? 0).split('\n').length
  const lineText = officeSrc.split('\n')[lineNo - 1] ?? ''
  assert.match(lineText, /判据的三态判定/u, '唯一那处必须是「判据的三态判定」（✅/❌/➖），与消费观测无关 ⇒ 该处不改')
})

/** 与 office 同一份台账的 journal（测试里少量地方要建卡，统一走它）。 */
function journalFor(): Journal {
  return new Journal(store)
}
