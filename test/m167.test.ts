/**
 * **增量 167：DEF-028（§3.11 受审载荷集合去重）+ DEF-039 ②③（§3.14）**。
 *
 * **DEF-028** 修前现盘：`readReviewPayload` 就是 `collections.map(...)` 逐段读 ⇒
 * `['tests','tests','decisions']` **3 段全收**（真机就是这么调进来的）。修法：按首次出现顺序**去重**。
 *
 * **DEF-039 ②** 修前现盘：`G3 + project/environment` ⇒ 失效 **true**（黑名单口径），而环境登记是**纯元数据**
 * （`environment` 在 `design.ts`/`derivedDocs.ts` 零命中、`DESIGN.md` 一字不变）⇒ 登记一次环境就把 G3
 * 设计签字判失效。修法：`project/environment` 进**中性表** ⇒ 两侧都不作废（G2 侧由 R7 已修）。
 *
 * **DEF-039 ③** 现盘：`trace/linked{kind: req-des}` ⇒ G2 **false** / G3 **true**。**这不是错**（G2 的四类真源
 * 里没有设计侧追溯边，而这条边会进 `DESIGN.md` §8）⇒ 按 DoD 的"差异有据"处置：把据写进代码，并用本文件
 * 的三态矩阵机械钉住（改动任一侧都红）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { payloadIndex, readReviewPayload, reviewFingerprint } from '../src/domain/reviewPayload.js'
import { SoftwareDevOffice } from '../src/office.js'
import { G2_SIGNATURE_INVALIDATING_EVENTS, SIGNATURE_NEUTRAL_EVENTS, isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m167/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-batch3', cwd: WORKSPACE } as unknown as OfficeCall

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-batch3', WORKSPACE)
  office.init(call, { name: 'M167 去重与签字口径', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M167-01（DEF-028 三态）重复集合名只出一段；无重复原样；空 ⇒ 空；且**指纹不受去重影响**', () => {
  const store = office.storeFor(WORKSPACE)
  const dup = readReviewPayload(store, ['tests', 'tests', 'decisions'])
  assert.deepEqual(dup.map((section) => section.collection), ['tests', 'decisions'], '重复项只出**一段**（按首次出现顺序）')
  const plain = readReviewPayload(store, ['tests', 'decisions'])
  assert.deepEqual(plain.map((section) => section.collection), ['tests', 'decisions'], '无重复 ⇒ 原样（顺序不变）')
  assert.deepEqual(readReviewPayload(store, []), [], '空 ⇒ 空')
  // **判据（为什么不掩盖东西）**：逐条索引里本来就出现不了重复的 collection/id；
  // 整篇指纹按 (collection,id,hash) 算 ⇒ 去重前后**指纹一致**（否则签字会莫名其妙失效）
  assert.equal(reviewFingerprint('G3', dup), reviewFingerprint('G3', plain), '去重前后整篇指纹必须相同')
  const keys = payloadIndex(dup).map((entry) => `${entry.collection}/${entry.id}`)
  assert.equal(new Set(keys).size, keys.length, '逐条索引里不得出现重复的 collection/id')
})

test('M167-02（DEF-039 三态矩阵 + 结构）环境登记两侧都不作废；追溯边的差异**有据**；真源变更两侧都作废', () => {
  // ① 环境登记：两侧都不作废（②）
  assert.equal(SIGNATURE_NEUTRAL_EVENTS.includes('project/environment'), true, '环境登记必须在**中性表**里（G3 黑名单口径的唯一出口）')
  assert.equal((G2_SIGNATURE_INVALIDATING_EVENTS as readonly string[]).includes('project/environment'), false, 'G2 白名单同样不得含它（R7 已修，两侧同口径）')
  assert.equal(isSignatureInvalidatingEvent('G2', 'project/environment'), false)
  assert.equal(isSignatureInvalidatingEvent('G3', 'project/environment'), false)
  // ② 追溯边：设计侧边 F/T（**差异有据**）；施工期覆盖边两侧都不作废（反例）
  assert.equal(isSignatureInvalidatingEvent('G2', 'trace/linked', { kind: 'req-des' }), false, 'G2 不读设计侧追溯边 ⇒ 不作废')
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/linked', { kind: 'req-des' }), true, '设计侧边进 DESIGN.md §8 ⇒ 作废 G3')
  assert.equal(isSignatureInvalidatingEvent('G2', 'trace/linked', { kind: 'req-task' }), false, '施工期覆盖边：G2 不作废')
  assert.equal(isSignatureInvalidatingEvent('G3', 'trace/linked', { kind: 'req-task' }), false, '施工期覆盖边：G3 也不作废（既有口径）')
  // ③ 真源变更：两侧都作废（一致）
  assert.equal(isSignatureInvalidatingEvent('G2', 'requirement/updated'), true)
  assert.equal(isSignatureInvalidatingEvent('G3', 'requirement/updated'), true)
  // ④ 差异必须**写在盘上**（不许靠人记得）：注释里要有 DEF-039 ③ 的"据"
  const types = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
  assert.equal(types.includes('DEF-039 ③'), true, 'G2/G3 差异的"据"必须写在 `isSignatureInvalidatingEvent` 附近')
  assert.equal(/G2 = false \/ G3 = true/u.test(types), true, '注释要点明"哪一侧是哪一侧"（三态矩阵逐条）')
  assert.equal(types.includes('DEF-039 ②'), true, '环境登记进中性表的理由也要写（含条号）')
})

test('M167-03（DEF-039 ② 行为）真实路径两态：签 G3 → 登记环境 ⇒ 签字仍 valid；改设计真源 ⇒ stale', () => {
  office.recordContract(call, { name: '订单服务导出接口', producer: '订单服务', consumer: '外部对账', schema: 'v1' })
  office.signGate(call, { gate: 'G3', by: '张三', basis: '我确认这次设计可以放行', channel: 'command' })
  assert.equal(office.signatureState(call, 'G3').status, 'valid', '前置：G3 签字有效')

  // ① 登记环境（纯元数据）⇒ **不得**作废设计签字（修前这里就是 stale）
  const registered = office.noteEnvironment(call, { env: 'jdk=21.0.2; probe=run_checks.py@v3', note: '换 JDK' })
  assert.equal(registered.ok, true, '夹具前提：环境登记成功')
  const afterEnv = office.signatureState(call, 'G3')
  assert.equal(afterEnv.status, 'valid', `环境登记是纯元数据 ⇒ G3 必须仍有效：${afterEnv.reason}`)

  // ② 反例（判据没被放宽）：改一条**设计真源** ⇒ 必须失效
  office.recordContract(call, { name: '订单服务导出接口', producer: '订单服务', consumer: '外部对账', schema: 'v2' })
  const afterDesign = office.signatureState(call, 'G3')
  assert.equal(afterDesign.status, 'stale', `设计真源变更必须让 G3 失效（否则这条判据被放宽了）：${afterDesign.reason}`)
})

test('M167-04（TC-109 结构半）受审载荷集合名只有一个出口，`office.ts` 里没有第二处硬编码', () => {
  const officeText = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  // **性质**（不是枚举一处）：`office.ts` 的**代码行**里不许再出现报告真源的字面量。
  // 注释行可以（那正是"为什么不能在这里写死"的据），所以先把注释剥掉再扫。
  const code = officeText
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .map((line) => line.trimStart())
    .filter((line) => !line.startsWith('*') && !line.startsWith('/*'))
    .filter((line) => line.includes('testing/report.yml'))
  assert.deepEqual(code, [], `office.ts 的代码里不许硬编码报告真源：${code.join(' | ')}`)

  // 注释里恰好一处（把口径写在写死的地方旁边，读者才看得到）
  const comments = officeText.split('\n').filter((line) => line.includes('testing/report.yml') && /^\s*(\/\/|\*)/u.test(line))
  assert.equal(comments.length, 1, `报告真源的唯一注释应恰好一处（实际 ${comments.length}）：${comments.join(' | ')}`)

  // 常量统一出口：定义一次、字面量只出现在那一行
  const reviewDoc = readFileSync(join(ROOT, 'src', 'domain', 'reviewDoc.ts'), 'utf8')
  assert.equal((reviewDoc.match(/export const TEST_REPORT_PAYLOAD_COLLECTION/gu) ?? []).length, 1, '集合名常量必须只有一处定义')
  assert.equal((reviewDoc.match(/'testing\/report\.yml'/gu) ?? []).length, 1, '这个字面量只许出现在常量定义那一行')

  // 集合名取自**流程数据**：office.ts 至少两处从 `phase.reviewPayload` 取（① 载荷 ② 判据），且没有字面量数组
  const fromPhase = (officeText.match(/phase\?\.reviewPayload/gu) ?? []).length
  assert.ok(fromPhase >= 2, `集合名必须从流程数据取（现有 ${fromPhase} 处，至少两处）`)
  assert.equal(/reviewPayload\s*:\s*\[/u.test(officeText), false, '不许把集合名写成字面量数组（那是第二处硬编码）')
})
