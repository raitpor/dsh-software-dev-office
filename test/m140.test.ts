/**
 * **增量 140：G6/交付签字面必须内联**测试总结报告正文**（真机事故回归，2026-10-14）**。
 *
 * **事故**：本会话早前误用 `git checkout -- src/office.ts` 抹掉未提交改动，回放恢复时**漏了 TASK-007
 * （REQ-051）的落点** —— `signReview()` 里把测试报告渲染稿投影成受审段的那 16 行，以及两处 import
 * （`renderTestReportSignable` / `renderedDocReviewItem`）。后果：G6/交付签字时审核单里**不再内联
 * 报告正文**，而判据 C-59 只核"报告存在 + 指纹绑定" ⇒ 门禁**照样全绿、人看到的东西少了**。
 *
 * **为什么没有任何用例发现**：`test/m45` 直接测 `renderTestReportSignable` **这个函数**，
 * 从不断言 `office.signReview` 的载荷里调了它 ⇒ **缝本身无人守**（教科书级"自测只覆盖修好的那条路径"）。
 *
 * **本用例守的就是那条缝**：走 `office.signReview` 这个**真实签字面**，断言受审载荷里出现
 * 测试报告集合与**渲染稿正文**（不是只测函数）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { renderTestReportSignable } from '../src/domain/reviewDoc.js'
import { TEST_REPORT_PAYLOAD_COLLECTION } from '../src/domain/reviewDoc.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m140/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M140 签字面内联报告', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { a: 'b' } })
  // 只有 `verification` / `delivery` 阶段才追加报告段（与实现同一条件）
  office.journalFor(WORKSPACE).append('phase/entered', { phase: 'verification' })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M140-01 `signReview` 的受审载荷必须含测试报告集合，且内联的是**渲染稿正文**', () => {
  // 从同一个真源取"渲染稿正文"的标记（避免把断言写死成某段文案）
  const signable = renderTestReportSignable({ store: office.storeFor(WORKSPACE) })
  assert.ok(signable.payload.items.length > 0, '夹具前提：报告投影至少要有条目')
  const marker = String(signable.payload.items[0]?.content ?? '').slice(0, 40)
  assert.ok(marker !== '', '夹具前提：渲染稿必须有正文')

  const review = office.signReview(call, 'G6')
  const text = `${review.summary}\n${review.full}`
  assert.ok(
    text.includes(TEST_REPORT_PAYLOAD_COLLECTION),
    `受审载荷里必须出现报告集合（${TEST_REPORT_PAYLOAD_COLLECTION}）——事故后这里曾整段丢失：${text.slice(0, 300)}`,
  )
  assert.ok(
    text.includes(marker),
    `受审段要内联**渲染稿正文**（不是只报"报告存在"）：期望片段 ${JSON.stringify(marker.slice(0, 24))}`,
  )
})

test('M140-02 反向：非验证/交付阶段**不追加**报告段（不制造噪声）', () => {
  // 回到需求阶段再签：报告不是那个阶段的产物
  office.journalFor(WORKSPACE).append('phase/rolled-back', { to: 'requirements' })
  const review = office.signReview(call, 'G0')
  assert.equal(
    `${review.summary}${review.full}`.includes(TEST_REPORT_PAYLOAD_COLLECTION),
    false,
    '别的阶段不该被追加空报告段（恢复时要连这条条件一起保住）',
  )
})

test('M140-03 源码级防回退：`signReview` 那条链必须仍调用投影函数', async () => {
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(new URL('../../src/office.ts', import.meta.url), 'utf8')
  assert.match(text, /import \{[^}]*renderTestReportSignable[^}]*\} from '\.\/domain\/reviewDoc\.js'/u, 'TASK-007 的 import 不得再丢')
  assert.match(text, /import \{[\s\S]{0,200}renderedDocReviewItem[\s\S]{0,200}\} from '\.\/domain\/reviewPayload\.js'/u, 'TASK-007 的另一个 import 不得再丢')
  assert.match(text, /renderTestReportSignable\(\{ store \}\)/u, '签字链里的调用不得再丢')
  assert.match(text, /evaluation\.phase === 'verification' \|\| evaluation\.phase === 'delivery'/u, '只在验证/交付阶段追加的条件不得丢')
})
