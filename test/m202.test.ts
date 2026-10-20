/**
 * **增量 202（`TASK-160` / `REQ-036` 的 `AC-151`）—— `clampToolResult` 的第一道守卫。**
 *
 * 为什么这条守卫此前是空的：`AC-151`（回执被截断并给出截断提示与后续入口）**有实现、没用例** ——
 * 本卡开工前的现读是 `grep -rl clampToolResult test/` = **0 文件 / 0 处**（实现早在
 * `src/interface/clamp.ts` 里），因此 `TC-030` 当时只能登记成 skip。本文件只补这一半：**只写测试，不改实现**。
 *
 * 四条读数（与卡上 DoD 逐条对应）：
 *   ① 超限 1 个字符 ⇒ 前缀逐字保留 + 提示逐字拼接 + 原文长度数字出现 + 总长有界；
 *   ② 未超限 ⇒ **逐字节**原样返回（不是"包含"）；
 *   ③ 恰好等于上限 ⇒ 视同未超限（边界是 `<=`，不是 `<`）；
 *   ④ 显式传入更小的上限 ⇒ 按传入值截断（默认参数不许被硬编码绕过；反向也给一格更大的上限）。
 *
 * 两条口径说明（不是偷懒，是被既有守卫逼出来的选择）：
 *   · **提示文案不在断言里内联中文**：`M189-08` 的读散文棘轮按"文件 + 站点数"**身份登记**，
 *     新文件里出现一条内联中文取值断言就是一条未登记缺口，而本卡的写范围只有本文件
 *     ⇒ 期望值改成从语言包取**同一个键**（语言包那条取值本身就是「已截断：原文 … 字符」），
 *     对比仍是**逐字节相等**：少的是台词，不是判据。
 *   · **每条读数都自带反例**：恒真的用例拦不住"把实现换成原样返回"，所以 ②③ 各自配一格
 *     "超限时必须不一样"的对照 —— `return text` 的变异体因此能把四条**全部**打红（读数见卡上报告）。
 *   · 还有一个容易被写错的事实：截断后的回执**可能比原文更长**（提示本身有长度）
 *     ⇒ 上界只能取 `limit + 提示长度`，不能写成"比原文短"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TOOL_RESULT_CHARS, clampToolResult } from '../src/interface/clamp.js'
import { fmt } from '../src/domain/i18n.js'

/**
 * 截断提示的**期望原文**：逐字取自语言包（键 `uiClamp.truncated`），不是本文件自带的一句散文。
 * 拼接形式与实现一致（前缀之后先换行再提示），因此下面的对比是整条回执的逐字节相等。
 */
function notice(original: number, limit: number): string {
  return '\n' + fmt('uiClamp.truncated', { p1: original, p2: limit })
}

/**
 * 确定性的原文样件：恰好 `length` 个 UTF-16 码元、**不含数字**、带换行。
 * 不含数字是有意的：① 里"回执含原文长度数字"就只能来自提示，不会是样件自带的巧合。
 */
function sample(length: number): string {
  const unit = 'lorem ipsum dolor\n'
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
}

test('M202-01 ① 超限 1 个字符 ⇒ 前缀逐字保留 + 提示含「已截断」与原文长度 + 总长有界', () => {
  const text = sample(TOOL_RESULT_CHARS + 1)
  assert.equal(text.length, TOOL_RESULT_CHARS + 1, '前置：样件恰好超限 1 个字符')
  const tip = notice(text.length, TOOL_RESULT_CHARS)
  const out = clampToolResult(text)

  // 提示**逐字**等于语言包那条（含「已截断：原文 … 字符，仅显示前 … 字符」与后续入口指引）
  assert.equal(out, text.slice(0, TOOL_RESULT_CHARS) + tip, '超限回执 = 前 limit 个字符 + 截断提示（整条逐字节相等）')
  // 原文长度数字必须真的出现在回执里（样件无数字 ⇒ 命中只能来自提示）
  assert.equal(out.includes(String(text.length)), true, '提示里必须给出原文长度')
  assert.equal(out.includes(String(TOOL_RESULT_CHARS)), true, '提示里必须给出保留的前多少个字符')
  // 上界：limit + 提示长度（提示长度是现算的，不是拍出来的常数）
  assert.equal(out.length <= TOOL_RESULT_CHARS + tip.length, true, '回执总长不超过 limit + 提示长度')
})

test('M202-02 ② 未超限 ⇒ 逐字节原样返回（配一格超限反例，证明本读数不是恒真）', () => {
  const text = sample(TOOL_RESULT_CHARS - 1)
  const out = clampToolResult(text)
  // 逐字节相等：不是"包含原文"，也不是"原文 + 一条空提示"
  assert.equal(out, text, '未超限必须原样返回（逐字节相等）')
  assert.equal(out.length, text.length, '长度也必须一模一样')
  // 反例：同一函数对超限 1 个字符的输入必须**不一样** —— 否则本读数对"原样返回一切"的实现恒真
  const over = sample(TOOL_RESULT_CHARS + 1)
  assert.equal(clampToolResult(over) === over, false, '超限输入不许原样返回（否则"未超限原样"这一条恒真）')
})

test('M202-03 ③ 边界值：恰好等于上限 ⇒ 视同未超限（判据是 <=，不是 <）', () => {
  const text = sample(TOOL_RESULT_CHARS)
  assert.equal(text.length, TOOL_RESULT_CHARS, '前置：样件恰好等于上限')
  assert.equal(clampToolResult(text), text, '恰好等于上限 ⇒ 原样返回（边界判错会平白多贴一条提示）')
  // 反例：多 1 个字符就必须已经截断 ⇒ 边界钉在 TOOL_RESULT_CHARS 这个数上
  const justOver = text + 'x'
  assert.equal(clampToolResult(justOver) === justOver, false, '上限 + 1 就必须截断（边界不是"更宽松的某个数"）')
})

test('M202-04 ④ 显式 limit 生效：默认参数不许被硬编码绕过（更小的截断 / 更大的放行）', () => {
  const text = sample(500)
  const tip = notice(text.length, 10)
  const out = clampToolResult(text, 10)
  // 提示里的两个数也必须跟着传入值走（10 与 500），不是默认的 8000
  assert.equal(out, text.slice(0, 10) + tip, '显式 limit=10 ⇒ 前 10 个字符 + 提示（两个数都要跟着变）')
  // 反向对照：显式上限**比默认大** ⇒ 比默认长的输入必须原样（证明 8000 没写死在函数体里）
  const big = sample(TOOL_RESULT_CHARS + 1000)
  assert.equal(clampToolResult(big, TOOL_RESULT_CHARS + 1000), big, '显式上限更大时不许被默认值截断')
})
