/**
 * **增量 176：DEF-077（major，第四批 §3.2）—— `unfrozen` 只有文本形态可用；根因是"一处归一"被做成白名单**。
 *
 * 现象（复验 V6）：`sdo_task action=done` 的 `unfrozen` 参数**描述**写着 `JSON **text** (or a real array)`，
 * 但 schema 是 `type:'string'` ⇒ 传真数组时**宿主在 schema 阶段就拒**：
 * `invalid arguments: "unfrozen" must be a string`（插件 `execute` 从未被调用）。
 *
 * 根因：注册出口的"一处归一"是**白名单**（`LIST_PARAM_NAMES` + 注册前升级）——
 * 「名单内 + 纯 `string`」才升 `oneOf:[string,array]` ⇒ **每新增一个列表型参数，不加名单就静默退回纯 string**。
 * 同族的 `impact`/`landing` 因为手写联合而逃过名单（而且在名单**外**）；`defects`（第三批 `DEF-075` 新增）
 * 也正是这么漏的 —— 它的注释写着"数组 / JSON 文本二选一"，schema 却是 `type:'string'`。
 *
 * 为什么本批自己的守卫（`m174`）没抓住（`escaped=true`）：它只断言"参数在注册面"，且夹具直调 `tool.execute`、
 * **跳过宿主 schema 校验** ⇒ 走的是比真机**更宽**的路（`tq_ff348198`："参数在注册面 ≠ 真机可用"）。
 * 所以本用例**必须喂真形态给真注册的工具**，并用宿主的 `validateJsonSchemaValue` 复现那道门。
 *
 * 修法（第四批 §3.2 的 (b)：**按声明推导**，不是往名单里补一行）：列表形态在**参数声明处**由 `listDecl`
 * 声明，`listParamNames` 从已声明的 `properties` 反推调用面归一集合 ⇒ schema 面与调用面同源，没有第二份名单。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { createOfficeTools, listParamNames } from '../src/interface/tools.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm176')
const WORKSPACE = join(BASE, 'proj')

/** 第三批 `DEF-073` 的名单（已删除）覆盖的名字：本批转换后**一个都不许掉**（反回归下界，不是实现）。 */
const LEGACY_LIST_NAMES = [
  'sourceRaw', 'dimensions', 'acceptance', 'packages', 'scope', 'derivedFrom', 'exempt', 'dod',
  'writeScopes', 'addWriteScopes', 'blockedBy', 'evidenceRequired', 'reportedFiles', 'requirements',
  'fixes', 'mitigates', 'mitigatesWaiver', 'runsRequired', 'artifacts', 'alternatives', 'links',
  'findings', 'suggestions',
]

interface ToolDefinition {
  name: string
  parameters: { properties?: Record<string, Record<string, unknown>> }
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
const call = { sessionId: 's-dev-a', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, status: TaskCard['status']): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    owner: 'dev-a', blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'small', revision: 1,
    status, requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task })
}

/** 真装配：走 `apply()` 的 `tools.register` 面（真注册的工具定义），**不过滤**参数。 */
function toolHarness(): void {
  tools = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
}

function registered(name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  return tool
}

/** **宿主那一跳**：注册面的 schema 校验（`unfrozen` 曾被拒的正是这处）。 */
function hostViolations(tool: ToolDefinition, args: Record<string, unknown>): string[] {
  return validateJsonSchemaValue(tool.parameters as never, args)
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const exec = { agent: { id: 's-dev-a', session: { header: { id: 's-dev-a', cwd: WORKSPACE, delegationDepth: 1, parentSession: 'cockpit' } } } }
  return String(await registered(name).execute(args, exec))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev-a', WORKSPACE)
  office.init(call, { name: 'M176 列表参数声明', scale: 'normal', stakeholders: ['业务方'] })
  card('TASK-001', 'in-progress')
  toolHarness()
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M176-01 宿主 schema 面：真注册的工具里，每个列表参数的**真数组**都不被拒（含 `unfrozen`/`defects`）', () => {
  let derivedTotal = 0
  for (const tool of tools) {
    assertSupportedJsonSchema(tool.parameters)
    const properties = tool.parameters.properties ?? {}
    const derived = listParamNames(properties)
    derivedTotal += derived.length
    for (const name of derived) {
      const violations = hostViolations(tool, { [name]: ['x'] })
      const aboutThis = violations.filter((violation) => new RegExp(`"value\\.${name}(?![\\w])`, 'u').test(violation))
      assert.deepEqual(aboutThis, [], `真数组必须过宿主 schema 校验：${tool.name}.${name} ⇒ ${JSON.stringify(violations)}`)
    }
  }
  assert.ok(derivedTotal >= 24, `推导出的列表参数应覆盖旧名单（实际 ${derivedTotal}）`)
  // `unfrozen`（本条的现场）与 `defects`（第三批新增、同样漏在名单外）：三态都过宿主校验
  const task = registered('sdo_task')
  for (const [label, args] of [
    ['真数组', { action: 'done', id: 'TASK-001', unfrozen: ['TASK-002'] }],
    ['JSON 文本', { action: 'done', id: 'TASK-001', unfrozen: '["TASK-002"]' }],
    ['都不给', { action: 'done', id: 'TASK-001' }],
  ] as const) {
    assert.deepEqual(hostViolations(task, { ...args }), [], `unfrozen 的${label}形态不许被宿主拒`)
  }
  const testTool = registered('sdo_test')
  assert.deepEqual(hostViolations(testTool, { action: 'record', defects: ['DEF-001'] }), [], '`defects` 的真数组不许被宿主拒')
})

test('M176-02 行为（真数组 == JSON 文本）：`done` 的 `unfrozen` 两形态落进同一处，且真数组真的到达域层', async () => {
  card('TASK-002', 'in-progress')
  const viaArray = await callTool('sdo_task', {
    action: 'done', id: 'TASK-001', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
    unfrozen: ['TASK-002'],
  })
  assert.match(viaArray, /局部绿/u, `真数组必须到达域层（回执说"局部绿"）：${viaArray.slice(0, 300)}`)
  assert.match(viaArray, /TASK-002/u, '未冻结清单要出现在回执里')
  const stored = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  assert.deepEqual(stored?.unfrozen, ['TASK-002'], '真数组形态必须真的落进卡（不是被静默丢掉）')

  // 文本形态（后向兼容）：同一张卡、同一件事，读数必须一致
  card('TASK-003', 'in-progress')
  const viaText = await callTool('sdo_task', {
    action: 'done', id: 'TASK-003', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
    unfrozen: '["TASK-002"]',
  })
  assert.match(viaText, /局部绿/u, `文本形态照旧可用：${viaText.slice(0, 300)}`)
  const storedText = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-003.yml')?.task
  assert.deepEqual(storedText?.unfrozen, stored?.unfrozen, '两种形态的落盘读数必须等价')

  // 都不给 ⇒ 不写这个键（存量形状不变）。为了不受"有在飞兄弟卡"影响，先把前面的卡收口
  card('TASK-002', 'done')
  card('TASK-004', 'in-progress')
  const viaNone = await callTool('sdo_task', {
    action: 'done', id: 'TASK-004', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
  })
  assert.equal(/局部绿/u.test(viaNone), false, '没声明未冻结 ⇒ 不是局部绿')
  const storedNone = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-004.yml')?.task
  // **形状变化（第四批 §7.7 预告）**：卡一旦被回写，`unfrozen` 会以**空数组**落盘（读端白名单的缺省），
  // 这是**形状**变化、不是行为变化 —— 语义仍是"本次没有未冻结的卡"。
  assert.deepEqual(storedNone?.unfrozen ?? [], [], '不给 ⇒ 语义上是空清单（落盘可能是 [] 或缺键）')
})

test('M176-03 反例：真数组的**假声明**照样可读拒绝、零写盘（形态不改变判定）', async () => {
  card('TASK-002', 'in-progress')
  const bad = await callTool('sdo_task', {
    action: 'done', id: 'TASK-001', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
    unfrozen: ['TASK-999'],
  })
  assert.match(bad, /TASK-999/u, `拒因必须点名那条交代不清的 id：${bad.slice(0, 300)}`)
  assert.match(bad, /没有写入/u, '拒因必须说清零写盘')
  const stored = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  assert.equal(stored?.status, 'in-progress', '被拒时卡状态不许变')
  assert.equal(stored?.unfrozen, undefined, '被拒时不许落键')
})

test('M176-04 机械判据（DoD ④）：承诺数组就必须声明联合；声明了联合就必须进归一集合；名单不存在', () => {
  // ① **声明承诺数组却仍是纯 string ⇒ 判红**（这正是 `unfrozen`/`defects` 当初漏掉的形态）
  const promised: string[] = []
  const promise = /real array|两种形态都收|array of|as an array/iu
  for (const tool of tools) {
    for (const [name, param] of Object.entries(tool.parameters.properties ?? {})) {
      const description = typeof param['description'] === 'string' ? param['description'] : ''
      const oneOf = param['oneOf']
      const declaredUnion = Array.isArray(oneOf)
        && (oneOf as { type?: unknown }[]).some((branch) => branch?.type === 'array')
      if (promise.test(description)) {
        promised.push(`${tool.name}.${name}`)
        assert.equal(declaredUnion, true, `描述承诺了数组形态，声明就必须是联合（否则宿主在 schema 阶段拒签）：${tool.name}.${name}`)
      }
      if (declaredUnion) {
        assert.ok(listParamNames(tool.parameters.properties ?? {}).includes(name), `声明了联合却不在推导集合里（两处判据分叉）：${tool.name}.${name}`)
      }
    }
  }
  assert.ok(promised.length >= 5, `夹具前提：承诺数组的参数应有多处（实际 ${promised.length}）`)
  assert.ok(promised.includes('sdo_task.unfrozen'), '本条的现场必须在被守之列')

  // ② 反回归：旧名单覆盖的名字**一个都不许掉**（转换只许等价或更宽）
  const allNames = new Set<string>()
  for (const tool of tools) for (const name of listParamNames(tool.parameters.properties ?? {})) allNames.add(name)
  const missing = LEGACY_LIST_NAMES.filter((name) => !allNames.has(name))
  assert.deepEqual(missing, [], `旧名单覆盖的列表参数不得在推导中掉队：${missing.join(' ')}`)
  assert.ok(allNames.has('unfrozen') && allNames.has('defects'), '本条新增覆盖的两个参数必须在推导集合里')

  // ③ 人工名单必须删除（只在**代码行**上扫：注释里会引用这个名字讲历史）
  const text = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  const code = text.split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line)).join('\n')
  assert.equal(/LIST_PARAM_NAMES/u.test(code), false, '人工名单是"会漏"的那一层，必须删除')

  // ④ `defects` 的**注释与 schema 一致**（`src/index.ts` 写着"数组 / JSON 文本二选一"）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /数组 \/ JSON 文本二选一/u, '夹具前提：`defects` 的注释确实承诺两形态（第四批 §3.2 点名的就是这处）')
  const testTool = registered('sdo_test')
  const defectsDecl = (testTool.parameters.properties ?? {})['defects'] as Record<string, unknown>
  assert.ok(Array.isArray(defectsDecl['oneOf']), '注释承诺两形态 ⇒ schema 必须是联合（否则注释是假陈述）')
})


/**
 * **R11（第五批 §3.3）：把"列表参数"的集合**从消费面推导**，而不是从描述文本猜。
 *
 * 第四批复验 V7 的反例（当场构造并实测）：把 `sdo_task.unfrozen` 的描述改成**不提数组**（一个最自然的写法）
 * ⇒ `listParamNames` 推导数 31→**30**、宿主实测 `"value.unfrozen" must be a string`（**与 `DEF-077` 原始现场逐字相同**），
 * 而 `M176-04`（按描述文本命中）**4/4 全绿** —— 也就是说那条"防未来再漏"只覆盖**次要形态**（描述与声明互相打脸）。
 * 根因是 DoD 太窄：它把"防漏"寄托在**描述文本**这个启发式上。
 *
 * 现在的判据**从使用点推导**（`ADR-016`）：扫消费面里的
 *   ① `compositeArg(args.X)` —— 工具 execute 映射里"两种形态都收"的**唯一归一出入口**；
 *   ② `Array.isArray(args.X)` —— 调用面显式的数组分支；
 * 凡被这两类写法当列表用的 `X`，**声明处必须是 `listDecl(`**（这就是那个**显式记号**），
 * 且真注册工具的 schema **必须真的**同时收 string 与 array（`listParamNames` 面）。
 *
 * **洞（DoD ④：写进判据里、可读）**：本判据**故意不认**下面这些写法 ——
 *   · `parseList(args.X)`：它同样被列表参数用，但也**大量**被"逗号分隔文本"参数用（`scopeIn` / `stakeholders` /
 *     `surfaces` / `ids`…）—— 那些参数**本就只收文本**（不是列表联合），当列表信号会造出大批假阳性；
 *   · `jsonOr(args.X)` / `json<T>(args.X)` / `parseJson(args.X)`：它们被列表参数用，也被 **JSON 对象**参数用
 *     （`oracle` / `mutation` / `contractTest`）—— 对象不是列表。
 *   · 而且"扫描面"本身有边界：`src/index.ts` 里**只**认 `compositeArg`（钩子里的 `args.X` 是**宿主**参数，
 *     不是本插件声明的参数；实测 `Array.isArray(args.paths)` 就在钩子那一侧）。
 *   **后果（如实）**：新参数若只走 `jsonOr` 而不走 `compositeArg`，本判据**不会**拦住它 ——
 *   `DEF-077` 的原始形态仍可能从那条路漏过去。补法是让那条路也留下可识别的写法（例如统一走 `compositeArg`），
 *   而不是在这里再造一份名单（`ADR-016` 明令：别造人工名单）。
 */
test('M176-05 消费面推导（R11）：凡被当列表用的参数，声明处必须是 `listDecl`、schema 必须真收两种形态', () => {
  // —— 扫消费面（**代码行**才算：注释里会引用这些名字讲历史）——
  const codeLines = (rel: string): string[] =>
    readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
  // **扫描面**：`src/interface/tools.ts`（工具 execute 映射，两种形态都扫）+ `src/index.ts`
  // **只扫 `compositeArg`** —— 因为钩子里 `exec.arguments` 是**宿主**工具的参数（`args.paths` 之类），
  // 不是本插件声明的参数；把它当列表信号会造出假阳性（实测：`Array.isArray(args.paths)` 就在钩子那一侧）。
  const forms = [
    { label: 'compositeArg(args.X)', re: /compositeArg\(args\.([A-Za-z_$][\w$]*)\)/gu, files: ['src/interface/tools.ts', 'src/index.ts'] },
    { label: 'Array.isArray(args.X)', re: /Array\.isArray\(args\.([A-Za-z_$][\w$]*)\)/gu, files: ['src/interface/tools.ts'] },
  ]
  const consumers = new Map<string, string[]>()
  for (const form of forms) {
    for (const file of form.files) {
      for (const line of codeLines(file)) {
        for (const match of line.matchAll(form.re)) {
          const name = match[1] as string
          consumers.set(name, [...(consumers.get(name) ?? []), `${file} · ${form.label}`])
        }
      }
    }
  }
  // **非空下界（反空转）**：V7 的现场必须在被扫到之列，且扫出来的集合要有实际规模
  assert.ok(consumers.has('unfrozen'), '夹具前提：`compositeArg(args.unfrozen)` 必须被扫到（V7 的反例就是它）')
  assert.ok(consumers.size >= 10, `消费面推导出的列表参数应 ≥10 个（实际 ${consumers.size}）—— 少了说明扫描器自己失效了`)

  // —— 判据 ①（源码面记号）：被当列表用 ⇒ 声明处必须是 `listDecl(` ——
  const toolsSrc = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  const missingMarker = [...consumers.keys()].filter((name) => !new RegExp(`\\b${name}: listDecl\\(`, 'u').test(toolsSrc))
  assert.deepEqual(
    missingMarker,
    [],
    `这些参数在消费面被当列表用，声明处却不是 \`listDecl(\`（${forms.map((form) => form.label).join(' / ')}）：${missingMarker.join(' ')}`,
  )

  // —— 判据 ②（行为面同源，**按工具块**判）：真注册工具的 schema 必须真的收两种形态 ——
  // ⚠️ **必须按工具块判**，不能只按名字：`defectId` 在 `sdo_review` 上是列表、在 `sdo_test` 上是单个 id；
  // `impact` 在 `sdo_task` 上是列表、在 `sdo_risk` 上是普通字符串。按名字判会把这些**同名不同义**的参数误报
  // （本判据第一版就是这么红的 —— 如实记录在第五批报告里）。
  const toolsSrcText = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  const starts = [...toolsSrcText.matchAll(/^ {6}name: '([a-z_]+)',$/gmu)].map((match, index) => ({
    name: String(match[1]),
    from: match.index ?? 0,
    index,
  }))
  const blocks = starts.map((item, index) => ({
    name: item.name,
    from: item.from,
    to: index + 1 < starts.length ? (starts[index + 1]?.from ?? toolsSrcText.length) : toolsSrcText.length,
  }))
  assert.ok(blocks.length >= 20, `夹具前提：应切出二十来个工具块（实际 ${blocks.length}）`)
  const perTool = new Map<string, string[]>()
  for (const block of blocks) {
    const body = toolsSrcText.slice(block.from, block.to)
    const consumedHere = [...body.matchAll(/compositeArg\(args\.([A-Za-z_$][\w$]*)\)|Array\.isArray\(args\.([A-Za-z_$][\w$]*)\)/gu)]
      .map((match) => String(match[1] ?? match[2]))
    for (const name of consumedHere) perTool.set(`${block.name}.${name}`, [name, block.name] as [string, string])
  }
  const defs = createOfficeTools({} as never) as unknown as { name: string; parameters: { properties?: Record<string, unknown> } }[]
  const offenders: string[] = []
  for (const [key, entry] of perTool) {
    const name = entry[0] ?? ''
    const toolName = entry[1] ?? ''
    const def = defs.find((item) => item.name === toolName)
    if (def === undefined || name === '') continue
    const properties = def.parameters.properties ?? {}
    if (properties[name] === undefined) continue   // 该工具真有这个参数才判（块内消费点必然对应本工具的参数）
    if (!listParamNames(properties).includes(name)) offenders.push(key)
  }
  // 判据 ① 的**跨文件补网**：`src/index.ts` 里也有 `compositeArg(args.X)`（`deps.*` 的映射），
  // 那里按名字核对"**某个**工具把它声明成 listDecl"即可（避免同名不同义的误报）。
  const declaredNames = new Set([...toolsSrcText.matchAll(/^\s*([A-Za-z_$][\w$]*): listDecl\(/gmu)].map((match) => match[1] as string))
  const coveredByIndex = new Set([...codeLines('src/index.ts').flatMap((line) => [...line.matchAll(/compositeArg\(args\.([A-Za-z_$][\w$]*)\)/gu)].map((match) => match[1] as string))])
  for (const name of coveredByIndex) if (!declaredNames.has(name)) offenders.push(`src/index.ts · ${name}`)
  assert.deepEqual(
    offenders,
    [],
    `这些参数消费面收数组、声明却不是 listDecl ⇒ 真机在**宿主 schema 阶段**就被拒（DEF-077 的原始现场）：${offenders.join(' ')}`,
  )

  // —— 判据 ③（洞的边界部分，name-free）：认不出的 `compositeArg` 形态必须**报出来**，不许静默漏过 ——
  const allCompositeSites = codeLines('src/index.ts').concat(codeLines('src/interface/tools.ts'))
    // **排除定义行**：`export function compositeArg(value: unknown)` 的参数是声明，不是调用点
    .filter((line) => !/function compositeArg\(/u.test(line))
    .flatMap((line) => [...line.matchAll(/compositeArg\(([^()]*)\)/gu)].map((match) => String(match[1]).trim()))
  const nonParamSites = allCompositeSites.filter((expr) => !expr.startsWith('args.'))
  for (const expr of nonParamSites) {
    assert.equal(
      /^[A-Za-z_$][\w$]*$/u.test(expr),
      true,
      `出现了本判据认不出的 \`compositeArg(...)\` 形态（要么把它纳入识别、要么把这条洞写进判据文案）：${expr}`,
    )
  }
  // 判据①覆盖的调用点必须与"看起来像参数用法"的调用点数量一致（少了就是扫描器漏了）
  const paramSites = allCompositeSites.filter((expr) => expr.startsWith('args.'))
  assert.ok(paramSites.length >= consumers.size, `扫到的参数调用点（${paramSites.length}）不得少于参数个数（${consumers.size}）`)
})
