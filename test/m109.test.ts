/**
 * M109 守卫（TASK-107 / DEF-065 落点三）：`suggestions` 与 `findings` 的**形态**与**两类失败的分流**。
 *
 * 缺陷原貌（DEF-065，驾驶舱现读源码复核 + 本文件所钉的现实）：
 *   · 两个参数原先都声明成 `type: 'string'` ⇒ **数组形态在宿主 schema 校验阶段就被拒**
 *     （`ToolArgsError: invalid arguments: "suggestions" must be a string`），**插件收不到那次调用**；
 *   · 而 `suggestions` 的取值映射早年还写成 `typeof args.suggestions === 'string' ? … : undefined`，
 *     于是**即便数组真到达了插件，也会被静默丢成 `undefined`**，回执里看不出被丢过。
 *
 * 因此本文件钉三件事，且**至少一条走真实注册的工具面**（`createOfficeTools` 拿到的
 * `tool.execute`，也就是宿主调用的那个入口 —— 不是另起一份手写的归一）：
 *   ① 数组原样到达时**不再被静默丢成 undefined**（落点三①，真实工具面）
 *   ② 字符串（JSON 文本）路径**行为不变**（落点三②，反向对照：下游拿到的字节与旧写法一致）
 *   ③ 坏 JSON 文本给出的文案与**宿主类型错**可区分（落点三③：一个带「形状不对 / 值被打断」，
 *      一个带 `invalid arguments` + `must be a string`，词面不重叠）
 *
 * 红绿绑同一份被检文件：`src/interface/tools.ts`（schema 的 `oneOf` 联合 + `compositeArg` 归一）。
 * 变异自证：把任一处的 `compositeArg(args.x)` 回退成 `typeof args.x === 'string' ? … : undefined`，
 * ①② 逐条转红（见 TASK-107 报告的 killed 记录）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { callOf, compositeArg, createOfficeTools } from '../src/interface/tools.js'
import type { OfficeToolDeps, PlanArgs, ReviewArgs } from '../src/interface/tools.js'
import { jsonOr } from '../src/index.js'
import type { OfficeCall } from '../src/office.js'

/** 真实工具面的运行上下文：工作目录只在 `agent.session.header.cwd`（真机 Agent 形状）。 */
const agentOf = (): unknown => ({ id: 's1', session: { header: { cwd: process.cwd() } } })
const execOf = (): unknown => ({ agent: agentOf() })

/** 观察型依赖：只记下**工具层真正交给了域层**的是什么，不自己归一。 */
interface Seen {
  suggestions: unknown[]
  findings: unknown[]
}
function recordingDeps(seen: Seen): OfficeToolDeps {
  return {
    plan: async (_call: OfficeCall, args: PlanArgs) => {
      seen.suggestions.push(args.suggestions)
      return 'PLAN-STUB'
    },
    review: async (_call: OfficeCall, args: ReviewArgs) => {
      seen.findings.push(args.findings)
      return 'REVIEW-STUB'
    },
  } as unknown as OfficeToolDeps
}

/** 取真实注册的工具（找不到就当场红 —— 工具改名时必须同步这个守卫）。 */
function toolOf(deps: OfficeToolDeps, name: string): { execute: (args: unknown, exec: unknown) => Promise<unknown>; parameters: unknown } {
  const found = createOfficeTools(deps).find((item) => item.name === name)
  assert.ok(found !== undefined, `真实工具面缺少 ${name}`)
  return found as unknown as { execute: (args: unknown, exec: unknown) => Promise<unknown>; parameters: unknown }
}

/** 声明的形态：把 schema 编译产物里的属性节点读出来（宿主校验用的就是它）。 */
function declaredShape(parameters: unknown, key: string): Record<string, unknown> {
  const properties = (parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const node = properties[key]
  assert.ok(node !== undefined && node !== null, `schema 里没有 ${key}`)
  return node as Record<string, unknown>
}

test('M109-01 ①（真实工具面）数组原样到达时不再被静默丢成 undefined —— suggestions', async () => {
  const seen: Seen = { suggestions: [], findings: [] }
  const plan = toolOf(recordingDeps(seen), 'sdo_plan')
  const cards = [{ title: '卡甲', dod: ['做甲'] }, { title: '卡乙' }]

  const receipt = await plan.execute({ action: 'decompose', suggestions: cards }, execOf())

  assert.equal(receipt, 'PLAN-STUB', '数组形态必须能真的走到域层（旧写法在校验前就被拒）')
  assert.equal(seen.suggestions.length, 1, '域层必须收到这一次调用')
  const got = seen.suggestions[0]
  assert.notEqual(got, undefined, '数组原样到达时**不得**被静默丢成 undefined（DEF-065 落点三①）')
  assert.equal(typeof got, 'string', '工具层的归一口径是「数组转 JSON 文本」交下游解析')
  assert.deepEqual(JSON.parse(got as string), cards, '转出来的 JSON 文本必须与到达的数组逐值相同（不得丢元素）')
})

test('M109-01 ①（真实工具面）数组原样到达时不再被静默丢成 undefined —— findings', async () => {
  const seen: Seen = { suggestions: [], findings: [] }
  const review = toolOf(recordingDeps(seen), 'sdo_review')
  const findings = ['第一条发现', '第二条发现']

  const receipt = await review.execute({ action: 'record', taskId: 'TASK-001', reviewer: 'REV-X', verdict: 'pass', findings }, execOf())

  assert.equal(receipt, 'REVIEW-STUB')
  assert.equal(seen.findings.length, 1)
  const got = seen.findings[0]
  assert.notEqual(got, undefined, '数组原样到达时不得被静默丢成 undefined')
  assert.deepEqual(JSON.parse(got as string), findings)
})

test('M109-02 ②（反向对照）字符串（JSON 文本）路径行为不变：下游拿到的字节与旧写法一致', async () => {
  const text = '[{"title":"卡甲","dod":["做甲"]}]'
  const seen: Seen = { suggestions: [], findings: [] }
  const plan = toolOf(recordingDeps(seen), 'sdo_plan')

  await plan.execute({ action: 'decompose', suggestions: text }, execOf())

  assert.equal(seen.suggestions[0], text, '字符串必须**原样**透传（不能被二次 stringify、也不能被 trim 掉）')
  // 反向对照的判据：旧的 `typeof === 'string' ? value : undefined` 分支对字符串给出的正是同一个值。
  assert.equal(seen.suggestions[0], typeof text === 'string' ? text : undefined)

  const seen2: Seen = { suggestions: [], findings: [] }
  const review = toolOf(recordingDeps(seen2), 'sdo_review')
  await review.execute({ action: 'record', taskId: 'TASK-001', reviewer: 'REV-X', verdict: 'pass', findings: '["f1","f2"]' }, execOf())
  assert.equal(seen2.findings[0], '["f1","f2"]')
})

test('M109-03 ③ 坏 JSON 文本的文案与宿主类型错可区分（两套词面不重叠）', () => {
  // 插件侧：`jsonOr` 的两类分流
  const shape = jsonOr('[{', 'suggestions')
  const quote = jsonOr('[{"a":"b}]', 'findings')
  const shapeError = shape.error
  const quoteError = quote.error
  assert.ok(shapeError !== undefined && quoteError !== undefined, '两类坏文本都必须给出错误（不得静默）')
  assert.match(shapeError, /形状不对/u, '形状类必须点名「形状不对」')
  assert.match(quoteError, /值被打断/u, 'ASCII 引号类必须点名「值被打断」并给字符位')
  assert.match(quoteError, /第 7 个字符/u, '必须点名第 N 个字符（第 7 位是那个未转义引号）')
  assert.doesNotMatch(shapeError, /第 \d+ 个字符/u, '形状类不得抢占「第 N 个字符」这条判据（否则两类又混了）')

  // 宿主侧：schema 校验的原文（落点一的对照样本①，逐字留档）
  const hostText = 'invalid arguments: "suggestions" must be a string'
  assert.match(hostText, /invalid arguments/u)
  assert.match(hostText, /must be a string/u)

  // 可区分：两类文案不共用判据词面（把宿主校验问题误报成插件解析问题会被这条钉住）
  for (const [label, error] of [['形状', shapeError], ['值被打断', quoteError]] as const) {
    assert.doesNotMatch(error, /invalid arguments/u, `插件侧 ${label} 文案不得出现宿主的 invalid arguments`)
    assert.doesNotMatch(error, /must be a string/u, `插件侧 ${label} 文案不得出现宿主的类型错判据`)
  }
  assert.doesNotMatch(hostText, /形状不对|值被打断/u, '宿主文案不应出现插件侧的两类分流词')
})

test('M109-04 schema 声明的是「字符串或数组」联合（宿主 schema 子集支持 oneOf）', () => {
  const deps = recordingDeps({ suggestions: [], findings: [] })
  const plan = toolOf(deps, 'sdo_plan')
  const review = toolOf(deps, 'sdo_review')

  for (const [tool, key] of [[plan, 'suggestions'], [review, 'findings']] as const) {
    const node = declaredShape(tool.parameters, key)
    assert.equal(node['type'], undefined, `${key} 不得再声明成单一 string 类型（那会把数组拒在宿主侧）`)
    const branches = node['oneOf'] as Record<string, unknown>[] | undefined
    assert.ok(Array.isArray(branches) && branches.length === 2, `${key} 必须声明两支联合：字符串 + 数组`)
    assert.equal(branches[0]?.['type'], 'string', `${key} 的第一支是 JSON 文本`)
    assert.equal(branches[1]?.['type'], 'array', `${key} 的第二支是数组`)
    assert.ok(
      typeof node['description'] === 'string' && (node['description'] as string).includes('数组'),
      `${key} 的参数描述必须把「两种形态都收」说清楚`,
    )
  }
})

test('M109-05 归一口径复用既有实现（不新造第二份）：compositeArg 是唯一入口', () => {
  // 契约锁定：字符串原样 / 数组转 JSON 文本 / 其余 undefined —— 放宽 jsonOr 入口时也用它。
  assert.equal(compositeArg('[]'), '[]')
  assert.equal(compositeArg([1, 'a']), '[1,"a"]')
  assert.equal(compositeArg(undefined), undefined)
  assert.equal(compositeArg({ a: 1 }), undefined, '对象形态不在这里归一（保持旧口径，避免悄悄放宽）')
  // `jsonOr` 现在经它归一：数组直接进来也能解析（不是被读成坏 JSON）。
  const ok = jsonOr<string[]>(['f1', 'f2'], 'findings')
  assert.equal(ok.error, undefined)
  assert.deepEqual(ok.value, ['f1', 'f2'])
})

test('M109-06 callOf 真机形状回归（本文件依赖它，别让它在别处被改成读 agent.cwd）', () => {
  const call = callOf(execOf() as never) as { cwd?: string }
  assert.equal(call.cwd, process.cwd())
})
