/**
 * **增量 164：DEF-011（major，第三批 §3.9）—— 产物哈希无直传入路**。
 *
 * 修前现盘读数：`grep -c artifactSha256 src/interface/tools.ts` = **0**（两条记录面都没有这个参数），
 * 而 `RunInput.artifactSha256` 早就在类型里 ⇒ **"传了却被静默丢弃"**：写端一律在记录时刻现算并覆盖。
 * 后果与「跑完必须逐字节恢复」的纪律冲突：调用方手里就有哈希（构建脚本刚算过），却没有通路交进来。
 *
 * 修法（唯一出口 + 两条记录面 + 工具面显式入口）：
 *   · 域层 `reconcileArtifactSha256(workspace, artifact, declared)` —— 给了就必须**可核对**：
 *     一致 ⇒ 记它；不一致 / 读不到产物 / 给了哈希却没给路径 ⇒ **可读拒绝并点名两值**（零写盘）；
 *     没给 ⇒ 照旧现算（零破坏）。
 *   · 串到 `recordRun`（域层）与 `recordTestResult`（域层 + `workspace` 上下文）两条面；
 *   · 工具面 `sdo_test action=record` 与 `sdo_deliver action=run` 各加一个参数（Args / schema / execute / index 透传）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { reconcileArtifactSha256 } from '../src/domain/records.js'
import { createOfficeTools } from '../src/interface/tools.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m164/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')
const ARTIFACT = 'dist/app.bin'

let office: SoftwareDevOffice
const call = { sessionId: 's-batch3', cwd: WORKSPACE } as unknown as OfficeCall

const truth = (): string => createHash('sha256').update(readFileSync(join(WORKSPACE, ARTIFACT))).digest('hex')
const FAKE = 'f'.repeat(64)

/** 记录一条用例结果（`sdo_test action=record` 的域层入口（`office.addTestResult`））。 */
const recordResult = (artifactSha256?: string): ReturnType<SoftwareDevOffice['addTestResult']> =>
  office.addTestResult(call, {
    caseId: 'TC-164',
    status: 'pass',
    evidence: 'jest 输出',
    artifact: ARTIFACT,
    ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
  } as never)

/** 记录一条真机运行（`sdo_deliver action=run` 的域层入口）。 */
const recordRunOne = (artifactSha256?: string): ReturnType<SoftwareDevOffice['recordRun']> =>
  office.recordRun(call, {
    target: 'desktop',
    command: './run.sh',
    outcome: 'pass',
    evidence: 'logs/latest.log',
    artifact: ARTIFACT,
    by: '验收人',
    ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
  } as never)

/** 两条记录面的落盘读数（零写盘断言用）。 */
function footprint(): { results: string[]; runs: string } {
  const resultsDir = join(WORKSPACE, '.sdo', 'tests', 'results')
  const results = ((): string[] => {
    try {
      return readdirSync(resultsDir).sort()
    } catch {
      return []
    }
  })()
  const runs = ((): string => {
    try {
      return readFileSync(join(WORKSPACE, '.sdo', 'delivery', 'runs.yml'), 'utf8')
    } catch {
      return ''
    }
  })()
  return { results, runs }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'dist'), { recursive: true })
  writeFileSync(join(WORKSPACE, ARTIFACT), 'artifact body for m164\n')
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-batch3', WORKSPACE)
  office.init(call, { name: 'M164 产物哈希直传', scale: 'normal', stakeholders: ['业务方'] })
  office.storeFor(WORKSPACE).writeYaml(['tests', 'TC-164.yml'], {
    testCase: { id: 'TC-164', title: '对账夹具', kind: 'unit', requirement: '', steps: [], expected: '输出差异清单', at: '' },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M164-01 两态（`record` 类两条面）：传入的哈希与现算一致 ⇒ 记它；不一致 ⇒ 可读拒绝并点名两值', () => {
  // ① `sdo_test action=record`
  const okResult = recordResult(truth())
  assert.equal(okResult.ok, true, `一致时必须收下：${JSON.stringify(okResult)}`)
  assert.equal(okResult.ok ? okResult.result.artifactSha256 : '', truth(), '落盘的哈希必须等于**调用方传入**那个（就是现算值）')

  const before = footprint()
  const badResult = recordResult(FAKE)
  assert.equal(badResult.ok, false, '不一致必须拒绝（修前是静默取现算值）')
  if (!badResult.ok) {
    assert.equal(badResult.code, 'artifact-hash-mismatch', '拒绝码必须自成一类（不能混用别的码）')
    assert.equal(badResult.detail.includes(FAKE), true, '拒因必须点名**声明值**')
    assert.equal(badResult.detail.includes(truth()), true, '拒因必须点名**现算值**')
  }
  assert.deepEqual(footprint(), before, '拒绝时零写盘（结果目录与 runs.yml 都不许动）')

  // ② `sdo_deliver action=run`
  const okRun = recordRunOne(truth())
  assert.equal(okRun.ok, true, `一致时必须收下：${JSON.stringify(okRun)}`)
  assert.equal(okRun.ok ? okRun.run.artifactSha256 : '', truth(), '运行记录里的哈希必须来自调用方声明（经核对）')

  const before2 = footprint()
  const badRun = recordRunOne(FAKE)
  assert.equal(badRun.ok, false, '不一致必须拒绝')
  if (!badRun.ok) {
    assert.equal(badRun.detail.includes(FAKE) && badRun.detail.includes(truth()), true, `拒因必须点名两值：${badRun.detail}`)
  }
  assert.deepEqual(footprint(), before2, '拒绝时零写盘')
})

test('M164-02 反例（零破坏）：不给 `artifactSha256` ⇒ 照旧现算（两条面行为与修前一致）', () => {
  const result = recordResult()
  assert.equal(result.ok, true, '不给哈希时照旧收下')
  assert.equal(result.ok ? result.result.artifactSha256 : '', truth(), '此时按现算值落盘（旧行为）')
  const run = recordRunOne()
  assert.equal(run.ok, true)
  assert.equal(run.ok ? run.run.artifactSha256 : '', truth(), '运行面同理')
})

test('M164-03 边界：给了哈希却没给路径 / 产物读不到 ⇒ 各自可读拒绝（不崩、不静默）', () => {
  assert.equal(reconcileArtifactSha256(WORKSPACE, '', FAKE).ok, false, '给了哈希却没路径 ⇒ 拒绝')
  const missing = reconcileArtifactSha256(WORKSPACE, 'dist/not-there.bin', FAKE)
  assert.equal(missing.ok, false, '产物不存在 ⇒ 拒绝')
  if (!missing.ok) assert.equal(missing.detail.includes('missing'), true, `拒因要说清"读不到"：${missing.detail}`)
  // 空声明 ⇒ 现算（未声明即旧口径）
  const none = reconcileArtifactSha256(WORKSPACE, ARTIFACT, undefined)
  assert.deepEqual(none, { ok: true, sha256: truth() }, '未声明 ⇒ 现算')
})

test('M164-04 结构：工具面两条记录面都有显式入口（Args / schema / execute / index 逐点钉住）', () => {
  const tools = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const defs = createOfficeTools({} as never) as unknown as {
    name: string
    parameters: { properties: Record<string, unknown> }
  }[]
  for (const tool of ['sdo_test', 'sdo_deliver']) {
    const def = defs.find((item) => item.name === tool)
    assert.ok(def !== undefined, `前置：${tool} 必须注册`)
    assert.ok(def.parameters.properties['artifactSha256'] !== undefined, `${tool} 的注册面必须有 artifactSha256（否则模型根本传不进来）`)
  }
  // execute 映射两处逐点钉住（计数不算判据）
  assert.equal(
    (tools.match(/artifactSha256: typeof args\.artifactSha256 === 'string' \? args\.artifactSha256 : undefined,/gu) ?? []).length,
    2,
    '两条记录面的 execute 各要一处映射',
  )
  assert.equal(index.includes('...(args.artifactSha256 === undefined ? {} : { artifactSha256: args.artifactSha256 }),'), true, 'sdo_test 那条要透传')
  assert.equal(index.includes('artifactSha256: args.artifactSha256,'), true, 'sdo_deliver 那条要透传')
})
