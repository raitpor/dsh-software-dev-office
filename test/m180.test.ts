/**
 * **增量 180：R14（第五批 §3.6）—— 两处文档面尾巴。**
 *
 * ① `src/index.ts` 的注释原写「`git log -S 'findProjectRoot(call.cwd' -- src/index.ts` **一笔可查**」，
 *    而第四批 `R10` ④ 已确立事实是**两笔**（`dab49d5` 加、`cca0ca0` 减）；准确说法是
 *    「**引入**它的只有 `dab49d5`」（"现盘代码行计数 0"为真）。本轮改正并**加机械守卫**（否则下次又会漂）。
 * ② 第四批 `R10` 把四条口径更正追加进第三批任务书（§9.1/§9.7 的行内补注 + §9.11 汇总），
 *    当时**没有任何机械守卫**（删掉那些块不会有用例转红）。R14 要求在"补轻量守卫"与"明确记为有意不加守卫"
 *    之间二选一 —— 这里选**补守卫**：它便宜、可读，而且让"更正块"不会被后来者顺手删掉。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { createOfficeTools, listParamNames } from '../src/interface/tools.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const THIRD = 'docs/plan/2026-10-14-交接-给创造模式会话-第三批.md'

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

test('M180-01 R14①：`src/index.ts` 的 `git log -S` 注释与现盘一致（两笔 / 引入它的只有 `dab49d5`）', () => {
  const index = read('src/index.ts')
  // 旧措辞必须消失（它就是被更正的那句）
  assert.equal(index.includes('一笔可查'), false, '「一笔可查」这句已更正，不许再出现')
  assert.match(index, /现盘实为\*\*两笔\*\*/u, '必须写清现盘是两笔（`dab49d5` 加、`cca0ca0` 减）')
  assert.match(index, /引入\*\*它的只有 `dab49d5`/u, '必须给出准确说法：**引入**它的只有 `dab49d5`')
  // 反向：这句话必须仍在讲 DEF-054 的现场（别把注释改成别的东西）
  assert.match(index, /DEF-054（第三批 §3\.17）/u, '这段注释仍须是 DEF-054 的现场说明')
})

test('M180-02 R14②：第三批任务书里的四处更正块**逐条**在位（R10 的更正不许被静默删掉）', () => {
  const doc = read(THIRD)
  // ① §9.1 收尾：未提交 ⇒ 已提交为 `cca0ca0`
  assert.match(doc, /更正（第四批 §3\.9 \/ R10 ①）/u, '§9.1 收尾缺"R10 ①"更正块')
  assert.match(doc, /`cca0ca0`/u, '① 更正必须点名提交 `cca0ca0`')
  // ② 两处行为变更 ⇒ 三处（第三处是 R5 的 impactGaps）—— 在 §9.11 汇总里
  assert.match(doc, /第三处是 \*\*R5 的 `impactGaps`\*\*/u, '② 更正必须点出第三处是 R5 的 impactGaps')
  // ③ "4 个构造点" ⇒ 3 处赋值（+1 处接口声明，不是构造点）
  assert.match(doc, /赋值点只有 3 处/u, '③ 更正必须写清 `asOf` 的赋值点只有 3 处')
  // ④ §9.7 的 `git log -S`：两笔 / 引入它的只有 dab49d5
  // **§3.8（R16）修法**：这句读数原先**不是单点钉住**（全文两处：§9.7 与 §9.11 第 4 条）⇒
  // 只删一处时另一处会"喂饱"断言。现在**按块取值**：两块各带一次，**各自独立可红**（两次删除变体都实测过）。
  assert.match(doc, /更正（第四批 §3\.9 \/ R10 ④）/u, '§9.7 缺"R10 ④"更正块')
  const sec911 = doc.indexOf('### 9.11')
  assert.ok(sec911 > 0, '必须有 §9.11 汇总节')
  const inlineBlock = doc.slice(doc.indexOf('更正（第四批 §3.9 / R10 ④）'), sec911)
  const summaryBlock = doc.slice(sec911)
  assert.match(inlineBlock, /现盘实为\*\*两笔\*\*/u, '§9.7 那一块必须**自己**带"两笔"读数（单点钉住：删了它就红）')
  assert.match(summaryBlock, /现盘实为\*\*两笔\*\*/u, '§9.11 第 4 条必须**自己**带"两笔"读数（单点钉住：删了它就红）')
  // 顺带：`asOf` 计数口径的**追加式**更正（第六批 §3.8）也必须在位
  assert.match(summaryBlock, /2 处对象属性赋值/u, '§9.11 必须带上"2 处对象属性赋值 + 1 处声明 + 1 处消费"的精确口径（追加式更正）')
  // 汇总节也在位（四条同处可读）
  assert.match(doc, /### 9\.11/u, '四条口径更正必须有一个汇总节（§9.11）')
  // 反例：**原条保留**（不是把历史结论改写掉）—— 原句必须还在
  assert.match(doc, /`git log -S` 自证：定位调用点只剩 `dab49d5`/u, '原条必须保留（追加式真源，不重写历史）')
})

test('M180-03 R13①：`unfrozen` 的**参数描述与现盘行为一致**（漏声明是**拒绝**，不是回执点名）', () => {
  // 修前描述写 `…in-flight siblings you omit are named back to you in the receipt` —— 那是**第四批之前**的形态
  //（当时漏声明只提示、不拦）。现在漏声明**当场拒绝**（`unfrozen-undeclared`，零写盘）⇒ 描述必须跟着改。
  const tools = createOfficeTools({} as never)
  const task = tools.find((item) => item.name === 'sdo_task') as unknown as
    | { parameters: { properties: Record<string, { description?: string }> } }
    | undefined
  assert.ok(task !== undefined, '工具面必须有 sdo_task')
  const description = String(task.parameters.properties['unfrozen']?.description ?? '')
  assert.equal(description.includes('named back to you'), false, '描述不许再写"漏声明会回执点名"（现盘是**拒绝**）')
  assert.match(description, /rejected/u, '描述必须说清"漏声明 / 假声明 ⇒ 拒绝"')
  assert.match(description, /nothing is written/u, '描述必须说清"零写盘"')
  assert.match(description, /in-flight sibling/u, '描述仍须讲清管的是"在飞的兄弟卡"')
  // 行为面同源（描述不是空口）：真注册工具传真数组仍然可用 —— 描述改了不该把行为一起改坏
  assert.equal(listParamNames(task.parameters.properties as Record<string, unknown>).includes('unfrozen'), true, '`unfrozen` 仍必须是列表参数（schema 面）')
})
