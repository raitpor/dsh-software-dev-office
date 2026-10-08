/**
 * **增量 79：sdo-test-new 22:46 构建的复测残留（R-17 / R-18 / R-19）** —— 回归 + 变异自证。
 *
 *   · **R-17（major）**：R-8 的"取最近一对"把**新鲜度**与**同一次实验**合并了 —— `fail` 与 `pass` **各自**
 *     取最新 ⇒ 红灯取本卡的 `TR-053`、绿灯取**别人 4 小时后**的 `TR-070`（`env` 里带会话/角色标记，必然不同）
 *     ⇒ 判据必然红、越往后越红。更根本的一条（本轮读真机数据才看清楚）：**`env` 是自由文本**
 *     （同一张卡红灯写「断言面=/tmp/tc003-harness.mjs（…）」、绿灯写「断言面=TC-003（31 条…）」——
 *     同一次实验却文字不同）⇒ 拿它当"逐字必须相等"的硬判据，本项目 **46 张卡全红**。
 *     修：① 配对**锚在最近一次红灯**上、找其后**第一条同实验的绿灯**（没有就拿紧随的那条 pass 作诊断对）；
 *     ② 只有**长得像指纹**的 `env`（`k=v; k=v`、无中文）才参与"同实验"判定；散文 env 一律不判；
 *     ③ `tdd-artifact-unchanged` 也必须先由某个可比指纹确立"同一次实验"才谈得上。
 *     真机验收（只读副本 + 不给任何豁免）：**46 张全净 / 0 张判红**（修前 0 全净 / 46 红）。
 *   · **R-18（minor）**：复合参数 schema 说 `string`、描述说「JSON 数组」⇒ 模型按描述传数组时被宿主拒
 *     （"must be a string"），宽松路径下数组又会被插件 `typeof === 'string'` **静默丢弃**。
 *     修：描述与 schema 对齐（明说 **JSON 文本** + 例子）；`compositeArg` 两种形态都收；
 *     `parseList` 认 JSON 数组文本（不再被逗号切碎）；`parseJson` 也接受已解好的对象/数组。
 *   · **R-19（minor，可追溯性）**：A 同一 `(评审, 发现)` 再次核实**静默覆盖**（真机：先代核、后实现者核，
 *     视图只留后写的那条；相反判定会由写入顺序决定采纳结论）⇒ 默认**拒绝**并说清"已由谁、判成什么"，
 *     要覆盖必须显式 `revise: true`，覆盖留痕 `revisedFrom`。
 *     B 有 `sessionId` 却把 `by` 缺省成 `human`（与同行的 `sessionId`/`ownerChecked: session` 自相矛盾）
 *     ⇒ 缺省按会话+角色生成（`subagent:<role>:<id8>`），`human` 只留给真的人工通道；回执直接印核实者。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { redGreenGaps } from '../src/domain/construction.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import type { Review } from '../src/domain/records.js'
import { verifyReviewFinding } from '../src/domain/reviewVerification.js'
import { compositeArg, parseJson, parseList } from '../src/interface/tools.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm79')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function fresh(name: string): { store: SdoStore; journal: Journal } {
  const dir = join(BASE, name)
  mkdirSync(join(dir, '.sdo', 'tests', 'results'), { recursive: true })
  return { store: new SdoStore(join(dir, '.sdo')), journal: new Journal(new SdoStore(join(dir, '.sdo'))) }
}

const task = (): TaskCard => ({ id: 'TASK-022', requirements: ['REQ-001'] } as unknown as TaskCard)

// ————————————————————————— R-17 —————————————————————————

test('M79-01 R-17：配对锚在"最近一次红灯" —— 别人更晚的绿灯不再污染本卡的判定', () => {
  const { store, journal } = fresh('r17-anchor')
  const tc = recordTestCase(store, journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  // 真机形状：本卡红灯 TR-053 + 8 秒后同 env 的绿灯 TR-054；再往后是**别人**（env 不同）的 TR-070
  recordTestResult(store, journal, { caseId: tc.id, status: 'fail', evidence: '红', env: 'node=26; python3=3.14.7' })
  recordTestResult(store, journal, { caseId: tc.id, status: 'pass', evidence: '绿', env: 'node=26; python3=3.14.7', artifact: 'lib/x.js', artifactSha256: 'h2' })
  recordTestResult(store, journal, { caseId: tc.id, status: 'pass', evidence: '别人更晚的绿', env: 'node=26; python3=3.14.7; os=linux; sandbox=none', artifact: 'lib/x.js', artifactSha256: 'h9' })
  assert.deepEqual(redGreenGaps(store, journal, task()), [], '同实验的那一对在，就不该被别人更晚的绿灯搅红')

  // ② 反向（不许拦错的反面）：**最新一次红灯**之后环境变了却转绿 ⇒ 照红 —— 这一条同时钉住"锚在最近一次红灯"
  //    （若锚在**最早**那次红灯，就会拿老那对同实验的结论掩盖最新这次异常）
  const newer = fresh('r17-newest')
  const tc2 = recordTestCase(newer.store, newer.journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  recordTestResult(newer.store, newer.journal, { caseId: tc2.id, status: 'fail', evidence: '老红', env: 'node=20; python3=3.14.7' })
  recordTestResult(newer.store, newer.journal, { caseId: tc2.id, status: 'pass', evidence: '老绿', env: 'node=20; python3=3.14.7', artifact: 'lib/x.js', artifactSha256: 'h1' })
  recordTestResult(newer.store, newer.journal, { caseId: tc2.id, status: 'fail', evidence: '新红', env: 'node=26; python3=3.14.7' })
  recordTestResult(newer.store, newer.journal, { caseId: tc2.id, status: 'pass', evidence: '新绿（换了环境）', env: 'node=26; python3=3.14.7; os=linux', artifact: 'lib/x.js', artifactSha256: 'h2' })
  assert.deepEqual(
    redGreenGaps(newer.store, newer.journal, task()).map((gap) => gap.check),
    ['tdd-env-changed'],
    '最新一次红灯换了环境才转绿 ⇒ 必须报（锚在最近一次红灯）',
  )
})

test('M79-02 R-17：**散文 env 不参与判定**（真机的 `env` 是人写的，同一次实验也会文字不同）', () => {
  const { store, journal } = fresh('r17-prose')
  const tc = recordTestCase(store, journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  // 真机原文形状：都有中文、都不含稳定的 k=v 全貌
  recordTestResult(store, journal, { caseId: tc.id, status: 'fail', evidence: '红', env: 'node=v26.10.0; python3=3.14.7（legacy 基线）; 断言面=/tmp/tc003-harness.mjs（先于实现写好）' })
  recordTestResult(store, journal, { caseId: tc.id, status: 'pass', evidence: '绿', env: 'node=v26.10.0; python3=3.14.7（legacy 基线）; 断言面=TC-003（31 条，本次重放）', artifact: 'lib/x.js', artifactSha256: 'h2' })
  assert.deepEqual(redGreenGaps(store, journal, task()), [], '散文 env 不许把判据判死（这正是 46 张卡全红的原因）')
  // 反向：指纹形状的 env 不同 ⇒ 照红
  const other = fresh('r17-fingerprint')
  const tc2 = recordTestCase(other.store, other.journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  recordTestResult(other.store, other.journal, { caseId: tc2.id, status: 'fail', evidence: '红', env: 'node=20; python3=3.14.7' })
  recordTestResult(other.store, other.journal, { caseId: tc2.id, status: 'pass', evidence: '绿', env: 'node=26; python3=3.14.7', artifact: 'lib/x.js', artifactSha256: 'h2' })
  assert.deepEqual(redGreenGaps(other.store, other.journal, task()).map((gap) => gap.check), ['tdd-env-changed'])
})

test('M79-03 R-17：产物判据只在"同一次实验"由指纹确立后才生效（散文 env 下不判）', () => {
  const { store, journal } = fresh('r17-artifact')
  const tc = recordTestCase(store, journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  // 散文 env + 产物 sha 相同 ⇒ **不判**（无法确立同一次实验；真机验证/冻结类卡就长这样）
  recordTestResult(store, journal, { caseId: tc.id, status: 'fail', evidence: '红', env: 'python3=3.14.7（冻结基线）', artifact: 'legacy/x.py', artifactSha256: 'frozen' })
  recordTestResult(store, journal, { caseId: tc.id, status: 'pass', evidence: '绿', env: 'python3=3.14.7（冻结基线，复跑）', artifact: 'legacy/x.py', artifactSha256: 'frozen' })
  assert.deepEqual(redGreenGaps(store, journal, task()), [])
  // 有 `harness`（机器指纹）且相同 + 产物 sha 相同 ⇒ 判 `tdd-artifact-unchanged`
  const mac = fresh('r17-artifact-machine')
  const tc2 = recordTestCase(mac.store, mac.journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  recordTestResult(mac.store, mac.journal, { caseId: tc2.id, status: 'fail', evidence: '红', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'same' })
  recordTestResult(mac.store, mac.journal, { caseId: tc2.id, status: 'pass', evidence: '绿', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'same' })
  assert.deepEqual(redGreenGaps(mac.store, mac.journal, task()).map((gap) => gap.check), ['tdd-artifact-unchanged'])
})

// ————————————————————————— R-18 —————————————————————————

test('M79-04 R-18：复合参数两种形态都收，且 JSON 数组文本不被逗号切碎', () => {
  // 字符串原样、数组转 JSON 文本（宿主宽松路径下数组不被静默丢弃）
  assert.equal(compositeArg('["a","b"]'), '["a","b"]')
  assert.equal(compositeArg(['a', 'b']), '["a","b"]')
  assert.equal(compositeArg(undefined), undefined)
  assert.equal(compositeArg(42), undefined)
  // `parseList` 认 JSON 数组文本
  assert.deepEqual(parseList('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseList(['a', 'b']), undefined, '数组由 compositeArg 归一，不直接进 parseList')
  assert.deepEqual(parseList('a, b；c'), ['a', 'b', 'c'], '旧口径（逗号/分号）不许变')
  assert.deepEqual(parseList('[]'), undefined, '空数组文本 ⇒ undefined（与空串同义）')
  // `parseJson` 也接受已经解好的对象/数组
  assert.deepEqual(parseJson<{ a: number }>({ a: 1 }), { a: 1 })
  assert.deepEqual(parseJson<string[]>(['a']), ['a'])
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 })
  assert.equal(parseJson('not json'), undefined)
  // 接线与文案：schema 是 string ⇒ 描述必须说"JSON 文本"，别再说"JSON array"
  const tools = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.match(tools, /dod: \{ type: 'string', description: 'update: JSON \*\*text\*\*/u, 'description 要与 schema 对齐（JSON 文本）')
  assert.doesNotMatch(tools, /description: 'update: JSON array of DoD items\.'/u)
  assert.match(tools, /dod: compositeArg\(args\.dod\)/u, '复合参数要走 compositeArg')
  assert.match(tools, /findings: compositeArg\(args\.findings\)/u)
  const zh = readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8')
  assert.match(zh, /findings: .*JSON 文本/u, 'findings 的描述也要说清是 JSON 文本')
})

// ————————————————————————— R-19 —————————————————————————

test('M79-05 R-19 A：默认拒绝"再次核实"，覆盖要显式 revise 且留痕', () => {
  const { store, journal } = fresh('r19-revise')
  store.writeYaml(['tasks', 'TASK-001.yml'], {
    task: { id: 'TASK-001', role: 'developer', status: 'done', requirements: [], writeScopes: ['lib/'], revision: 1 },
  })
  const review: Review = { id: 'REV-001', taskId: 'TASK-001', taskRole: 'developer', reviewer: 'human', verdict: 'pass', findings: ['f1'], at: 'x' }
  store.writeYaml(['reviews', 'REV-001.yml'], { review })
  journal.append('task/claimed', { id: 'TASK-001', owner: 'd', sessionId: 'dev-1', revision: 1 })
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'dev-2', role: 'developer', tools: 9 })

  const first = verifyReviewFinding(store, journal, { reviewId: 'REV-001', index: 0, outcome: 'reproduced', evidence: 'e1', sessionId: 'dev-2' })
  assert.equal(first.ok, true, JSON.stringify(first))
  const second = verifyReviewFinding(store, journal, { reviewId: 'REV-001', index: 0, outcome: 'refuted', evidence: 'e2', sessionId: 'dev-2' })
  assert.equal(second.ok, false, '默认必须拒绝再次核实（旧实现静默覆盖）')
  assert.equal(second.ok ? '' : second.code, 'already-verified')
  assert.match(second.ok ? '' : second.detail, /reproduced/u, '要说清已被判成什么')
  // 显式覆盖 ⇒ 放行 + 留痕
  const revised = verifyReviewFinding(store, journal, { reviewId: 'REV-001', index: 0, outcome: 'refuted', evidence: 'e3', sessionId: 'dev-2', revise: true })
  assert.equal(revised.ok, true, JSON.stringify(revised))
  assert.equal(revised.ok ? revised.disposition.revisedFrom?.outcome : '', 'reproduced')
  // 读回：覆盖后的判定生效，且 revisedFrom 读得回来
  const readBack = store.readYaml<{ verifications: { revisedFrom?: { outcome: string } }[] }>('reviews', 'verified.yml')
  assert.equal(readBack?.verifications[0]?.revisedFrom?.outcome, 'reproduced', '留痕要落盘且读得回')
  const after = verifyReviewFinding(store, journal, { reviewId: 'REV-001', index: 0, outcome: 'refuted', evidence: 'e4', sessionId: 'dev-2' })
  assert.match(after.ok ? '' : after.detail, /refuted/u, '回执要反映覆盖后的那条')
})

test('M79-06 R-19 B：缺省 `by` 不许把子会话写成 `human`；回执直接印核实者', () => {
  const { store, journal } = fresh('r19-by')
  store.writeYaml(['tasks', 'TASK-001.yml'], { task: { id: 'TASK-001', role: 'developer', status: 'done', requirements: [], writeScopes: ['lib/'], revision: 1 } })
  store.writeYaml(['reviews', 'REV-001.yml'], {
    review: { id: 'REV-001', taskId: 'TASK-001', taskRole: 'developer', reviewer: 'human', verdict: 'pass', findings: ['f1'], at: 'x' },
  })
  journal.append('task/claimed', { id: 'TASK-001', owner: 'd', sessionId: 'dev-1', revision: 1 })
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: '4d6be6fe-aaaa', role: 'developer', tools: 9 })
  // 有 sessionId、没传 by ⇒ 不许落成 human（真机就是这条被标错，且去重后存活的恰好是它）
  const auto = verifyReviewFinding(store, journal, { reviewId: 'REV-001', index: 0, outcome: 'reproduced', evidence: 'e', sessionId: '4d6be6fe-aaaa' })
  assert.equal(auto.ok, true, JSON.stringify(auto))
  assert.notEqual(auto.ok ? auto.disposition.by : 'human', 'human', '有会话就不许标成 human')
  assert.match(auto.ok ? auto.disposition.by : '', /subagent:developer:4d6be6fe/u, `要能看出是谁（实际 ${auto.ok ? auto.disposition.by : ''}）`)
  // 真的人工通道（不传 sessionId）⇒ 仍然是 human
  const humanReview: Review = { id: 'REV-002', taskId: 'TASK-001', taskRole: 'developer', reviewer: 'human', verdict: 'pass', findings: ['f2'], at: 'x' }
  store.writeYaml(['reviews', 'REV-002.yml'], { review: humanReview })
  const human = verifyReviewFinding(store, journal, { reviewId: 'REV-002', index: 0, outcome: 'reproduced', evidence: 'e' })
  assert.equal(human.ok ? human.disposition.by : '', 'human')
  assert.equal(human.ok ? human.disposition.roleMatch : '', 'unknown')
  // 回执要印核实者与依据（真机教训：按 `by` 读会得出错误结论）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /uiIndex\.kReviewVerifierLine/u)
  assert.match(index, /result\.disposition\.ownerChecked/u)
})

test('M79-07 R-20：复合参数的描述必须与 schema 同口径（不许再出现「schema 是 string、描述说 JSON 数组」）', () => {
  const tools = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  // ① 报告给的验收口径：字面量 "JSON array" 归零（含"Not a JSON array"这种否定句 —— 统一写成 not an array）
  assert.doesNotMatch(tools, /JSON array/u, 'tools.ts 里不许再有 "JSON array"')
  for (const file of ['zh-CN.yml', 'en.yml']) {
    const pack = readFileSync(join(ROOT, 'src', 'data', 'lang', file), 'utf8')
    assert.doesNotMatch(pack, /JSON array|JSON 数组/u, `${file} 里也不许再有"JSON 数组/JSON array"`)
  }
  // ② 更强的口径：凡是 `type: 'string'` 且描述里带 JSON 例子的参数，描述必须说清是 **文本**
  const offenders: string[] = []
  let aligned = 0
  for (const [index, line] of tools.split('\n').entries()) {
    if (!/type: 'string'/u.test(line) || !/description/u.test(line)) continue
    // 触发条件要**精确**：描述里给了 JSON **字面量**例子（`[{` / `[\"` ⇒ 源码里是 `[\"`）才算复合参数。
    // `enum: ['append','replace']` 这类不是 JSON 例子 —— 用宽条件会造出假阳性（守卫也会逼人写废话）。
    if (!/\[\\?["{]/u.test(line)) continue
    if (/(JSON \*\*text\*\*|JSON text|JSON 文本)/iu.test(line)) {
      aligned += 1
      continue
    }
    offenders.push(`${index + 1}: ${line.trim().slice(0, 90)}`)
  }
  assert.deepEqual(offenders, [], `这些 string 参数的描述没说是 JSON 文本：\n${offenders.join('\n')}`)
  // 下限守卫：口径对了才可能数出这么多；否则说明触发条件失效（守卫变成永远通过的空壳）
  assert.ok(aligned >= 12, `对齐的复合参数至少要 12 个（实际 ${aligned}）—— 少了说明这条守卫自己失效了`)
  // ③ 运行时两形态都收（R-18 的机制仍然在）
  assert.equal(compositeArg(['a']), '["a"]')
  assert.deepEqual(parseList('["a"]'), ['a'])
})
