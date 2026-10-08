/**
 * 第二轮整体评审 §3.4（minor）：**红队问题的"引用原文"判据形同虚设**。
 *
 * 旧实现：只要问题文本里出现需求陈述的**任意一个 2-gram** 就算"引用了原文用词"。
 * 中文里"系统/功能/增加/支持"这类两字通用词几乎每句都有 ⇒ 与需求毫不相干的问题也能过闸。
 * 评审探针（`.review/probes/p4-redteam-keyword.mjs`，我原样复跑）：
 *
 * ```text
 * 需求：系统须支持增加导出功能，导出 100 万行时内存占用不超过 512 兆
 * accepted = ["增加导入功能会不会让运维更复杂？", "系统会不会因此更难维护？", "导出时内存真的不超过 512 兆吗？"]
 * ```
 *
 * 修后口径：**至少一处原文片段命中** —— 中文 **连续 4 字以上**，或 ASCII **≥3 字符**的 token；
 * 单个两字词（「系统」「功能」「增加」…）不再是通行证。方向是**收紧**，所以同时要证明没拦错：
 * 真切题的问题（含 4 字原文片段、或原文里的数字/英文 token）必须照旧放行。
 *
 * 为什么中文门槛是 4 而不是 3：这条无关问题与"系统须支持**增加导**出功能"恰好共有 `增加导`
 * （"增加" + 下一个字），3 字门槛会把它当成"引用了原文"（我第一版就是 3，被自己的用例打回）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { quotedFragments, statementKeywords, validateProposed } from '../src/domain/grill.js'

const STATEMENT = '系统须支持增加导出功能，导出 100 万行时内存占用不超过 512 兆'

test('M64-01 §3.4：两字通用词命中不算"引用原文"（评审探针里那两条无关问题必须被拒）', () => {
  const out = validateProposed(
    [
      { text: '增加导入功能会不会让运维更复杂？' },
      { text: '系统会不会因此更难维护？' },
    ],
    STATEMENT,
    [],
    10,
  )
  assert.equal(out.accepted.length, 0, `与需求无关的问题不得过闸：${JSON.stringify(out.accepted.map((q) => q.text))}`)
  assert.equal(out.rejected.length, 2)
  assert.ok(out.rejected.every((item) => item.reason === 'noKeyword'), `拒绝理由要指向"没引用原文"：${JSON.stringify(out.rejected)}`)

  // 反证方向：这两个词**确实**在需求原文里（所以旧实现才放行）—— 不是"关键词表没收录"的问题
  assert.ok(statementKeywords(STATEMENT).includes('增加'))
  assert.ok(statementKeywords(STATEMENT).includes('系统'))
})

test('M64-02 §3.4 不许拦错：真切题的问题（4 字以上原文片段 / 原文里的数字）照样放行', () => {
  const out = validateProposed(
    [
      { text: '导出时内存占用会不会超过 512 兆？' }, // 「内存占用」4 字原文片段 + 512
      { text: '100 万行的导出峰值有没有实测？' }, // 原文里的数字 token
    ],
    STATEMENT,
    [],
    10,
  )
  assert.equal(out.accepted.length, 2, `切题问题被误拦：${JSON.stringify(out.rejected)}`)
  assert.equal(quotedFragments('导出时内存占用会不会超过 512 兆？', STATEMENT).includes('内存占用'), true)
})

test('M64-03 §3.4：ASCII 侧同口径 —— 英文 token 要 ≥3 字符（两字符缩写不算引用原文）', () => {
  const statement = 'Export must stream 1000000 rows within 512 MB and never buffer the full set'
  // ① 只命中 2 字符的 "MB" ⇒ 不算引用原文（旧实现会把这类放行）
  const weak = validateProposed([{ text: 'Is 512 MB enough?' }], statement, [], 10)
  assert.equal(weak.accepted.length, 1, '数字 token 512 是原文里的 ≥3 字符片段 ⇒ 该放行')
  const weakOnly = validateProposed([{ text: 'Is MB a problem here?' }], statement, [], 10)
  assert.equal(weakOnly.accepted.length, 0, `只有 2 字符 token 不算引用原文：${JSON.stringify(weakOnly.rejected)}`)
  // ② 命中 ≥3 字符 token（Export / rows / buffer…）⇒ 放行
  const strong = validateProposed([{ text: 'Does Export handle rows without buffering?' }], statement, [], 10)
  assert.equal(strong.accepted.length, 1, `≥3 字符 token 命中必须放行：${JSON.stringify(strong.rejected)}`)
})
