/**
 * **增量 163：DEF-031（major，第三批 §3.12，优先级最高）—— 交付哈希缺 `asOf` 时刻**。
 *
 * 修前现盘读数：`grep -rn asOf src/ test/ lib/src/` = **0**；`DeliveryArtifact` 只有 `path/kind/sha256`，
 * 只有清单头有 `manifest.at` ⇒ 事后发现产物与哈希不符时**分不清"签完之后漂移了"与"从来就没一致过"**。
 * 用户 2026-10-13 追认 13 条「不修历史」时依据的正是"后续由 DEF-031 的修法承担"⇒ 本条是兑现那句话。
 *
 * 修法：产物条目逐条带 **`asOf`**（打包那一刻**现算**哈希的同一轮取时刻，ISO 8601）；
 * 读端宽容（旧清单没有该键 ⇒ 空串，**不回写历史**）；交付回执逐条可读（旧清单显式标「未记时刻」）。
 *
 * 验收（任务书 §3.12）：**行为 + 结构**（字段在 + 回执可见 + 时刻晚于写盘）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { listManifests, readManifest, readManifestFileChecked } from '../src/domain/records.js'
import { SoftwareDevOffice } from '../src/office.js'
import { describeManifest } from '../src/interface/describe.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m163/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')
const ARTIFACT = 'dist/app.bin'

let office: SoftwareDevOffice
const call = { sessionId: 's-batch3', cwd: WORKSPACE } as unknown as OfficeCall

function packageOnce(): ReturnType<SoftwareDevOffice['packageDelivery']> {
  return office.packageDelivery(call, {
    by: '验收人',
    artifacts: [{ path: ARTIFACT, kind: 'docs' }],
    acceptance: [],
    rollbackPoint: 'git commit deadbee',
  })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'dist'), { recursive: true })
  writeFileSync(join(WORKSPACE, ARTIFACT), 'deliverable body\n')
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-batch3', WORKSPACE)
  office.init(call, { name: 'M163 交付 asOf', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M163-01 结构：产物条目带 `asOf`（写端逐条、读端不丢）', () => {
  const result = packageOnce()
  assert.equal(result.manifest.artifacts.length, 1, '夹具前提：一条产物')
  const artifact = result.manifest.artifacts[0]
  assert.ok(artifact !== undefined)
  assert.equal(typeof artifact.asOf, 'string', '条目必须有 asOf 字段')
  assert.notEqual(artifact.asOf, '', '新建的清单必须记下"截至何时"（空串是留给旧清单的）')

  // 读端白名单不得把它吃掉（真源往返）
  const read = readManifest(office.storeFor(WORKSPACE))
  assert.equal(read?.artifacts[0]?.asOf, artifact.asOf, '从 YAML 读回来必须逐字相等（读白名单不能丢字段）')
  assert.equal(listManifests(office.storeFor(WORKSPACE)).length > 0, true, '清单确实落盘了')
  // 结构（源码面）：字段定义与写端都在
  const source = readFileSync(join(ROOT, 'src', 'domain', 'records.ts'), 'utf8')
  assert.equal(/interface DeliveryArtifact[\s\S]*?asOf: string/u.test(source), true, '类型定义必须有 asOf')
  assert.equal(/sha256: hashArtifact\(input\.workspace, artifact\.path\),[\s\S]{0,200}asOf: new Date\(\)\.toISOString\(\)/u.test(source), true, '写端必须与现算哈希同一轮取时刻')
})

test('M163-02 行为：`asOf` 是合法 ISO 且**晚于产物写盘**（这就是"截至时刻"的可核对含义）', () => {
  const result = packageOnce()
  const asOf = result.manifest.artifacts[0]?.asOf ?? ''
  const parsed = Date.parse(asOf)
  assert.equal(Number.isFinite(parsed), true, `asOf 必须是可解析的时刻：${asOf}`)
  const mtimeMs = statSync(join(WORKSPACE, ARTIFACT)).mtimeMs
  assert.equal(parsed >= mtimeMs, true, `asOf（${asOf}）必须不早于产物的最后写盘时刻（${new Date(mtimeMs).toISOString()}）`)
  // 反例：删掉产物再读清单 —— `asOf` 仍在（它不是"文件此刻的 mtime"，而是**打包那一刻的现算时刻**）
  rmSync(join(WORKSPACE, ARTIFACT))
  const reread = readManifest(office.storeFor(WORKSPACE))
  assert.equal(reread?.artifacts[0]?.asOf, asOf, '`asOf` 必须留在真源里（不随文件消失而消失）')
})

test('M163-03 回执可见：每条产物印出「截至何时」；旧清单显式标「未记时刻」（不许假装有）', () => {
  const result = packageOnce()
  const asOf = result.manifest.artifacts[0]?.asOf ?? ''
  const receipt = describeManifest(result.manifest)
  assert.equal(receipt.includes(asOf), true, `交付回执必须能读到截至时刻：${receipt.slice(0, 400)}`)

  // 旧清单（手写、没有 asOf）⇒ 空串 + 回执标「未记时刻」；且**不回写历史**
  const store = office.storeFor(WORKSPACE)
  const legacy = ['delivery', 'DLV-900.yml']
  store.writeYaml(legacy, {
    manifest: { id: 'DLV-900', at: '2026-10-01T00:00:00.000Z', by: '旧人', artifacts: [{ path: 'dist/app.bin', kind: 'docs', sha256: 'a'.repeat(64) }], acceptance: [], rollbackPoint: 'r', prototypeExcluded: false, notes: '' },
  })
  const before = readFileSync(join(WORKSPACE, '.sdo', 'delivery', 'DLV-900.yml'), 'utf8')
  const read = readManifestFileChecked(store, 'DLV-900.yml', 'DLV-900')
  assert.equal(read.manifest?.artifacts[0]?.asOf, '', '旧条目读出来是空串（宽容读）')
  const legacyReceipt = describeManifest(read.manifest!)
  assert.match(legacyReceipt, /未记时刻/u, `回执必须显式标未记时刻：${legacyReceipt.slice(0, 300)}`)
  assert.equal(readFileSync(join(WORKSPACE, '.sdo', 'delivery', 'DLV-900.yml'), 'utf8'), before, '只读不得改写历史清单（逐字节比较）')
})


/**
 * **R9（第四批 §3.8）**：守卫必须走**真机面**。
 *
 * 复验（V4）指出：`m163` 不过 `sdo_deliver` 的注册/execute ⇒ `asOf` 的**工具面回执路径**没有机械守卫
 * （已被钉住的只是**数据源** `describeManifest`）。删掉 `src/index.ts` 里那次 `describeManifest` 调用，
 * 交付回执就不再印「截至何时」而**没有用例会红**。这一格补上。
 */
test('M163-04 工具面（真注册）：交付回执里必须能读到「截至何时」（R9）', async () => {
  // 先真机面打一次包（包体走的是**工具面**，不是直接调 office）
  const tools: { name: string; execute: (args: Record<string, unknown>, exec: unknown) => unknown }[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: never) => { tools.push(tool); return () => {} } } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const tool = tools.find((item) => item.name === 'sdo_deliver')
  assert.ok(tool !== undefined, '工具面缺少 sdo_deliver')
  const exec = { agent: { id: 's-batch3', session: { header: { id: 's-batch3', cwd: WORKSPACE, delegationDepth: 0 } } } }
  const receipt = String(await tool.execute({
    action: 'package', by: '验收人',
    artifacts: '[{"path":"dist/app.bin","kind":"docs"}]',
    acceptance: '[]',
    rollbackPoint: 'git commit deadbee',
  }, exec))
  const manifest = readManifest(office.storeFor(WORKSPACE))
  const asOf = manifest?.artifacts[0]?.asOf ?? ''
  assert.notEqual(asOf, '', '夹具前提：新清单必须记了 asOf')
  // **关键那一跳**：交付回执必须把「截至何时」印出来（删掉 index.ts 里那次 describeManifest ⇒ 这里红）
  assert.equal(receipt.includes(asOf), true, `工具面回执必须逐条印出截至时刻（${asOf}）：${receipt.slice(0, 400)}`)
  assert.match(receipt, /截至/u, '回执要有可读的"截至"字样，而不是一串裸时刻')
})
