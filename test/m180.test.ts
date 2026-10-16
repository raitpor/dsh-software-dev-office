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
  // **DEF-083（第七批 §3.5）**：`asOf` 的计数口径不许再以**字面量**形式钉住（上一版是"必须存在 `2 处对象属性赋值`"
  // ⇒ **谁把数字改对，反而把守卫弄红**）。现在改成**现算对账**：按三条机械口径从源码现算，与文档里写的数逐个比对。
  // 行号**不参与**判定（漂移不该红）；删掉一处赋值点 / 把文档里的数字改错 ⇒ 红。
  const marker = '二次更正（第七批 §3.5'
  const at = doc.lastIndexOf(marker)
  assert.ok(at > 0, '第三批 §9.11 必须有第七批的**二次更正**（追加式；上一版把对的数改成了错的）')
  const tail = doc.slice(at)
  const block = tail.slice(0, tail.indexOf(String.fromCharCode(10, 10)) < 0 ? undefined : tail.indexOf(String.fromCharCode(10, 10)))
  const docNumber = (pattern: RegExp, what: string): number => {
    const found = block.match(pattern)
    assert.ok(found !== null, `二次更正里必须给出「${what}」的计数（现算对账的锚）`)
    return Number(found[1])
  }
  const codeLines = (text: string): string[] => text.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/u.test(line))
  const records = read('src/domain/records.ts')
  const described = read('src/interface/describe.ts')
  // 口径①：**对象属性赋值**（行首或行内的 `asOf:`，排除接口声明的 `asOf: string` 与注释行）
  const assignments = codeLines(records).filter((line) => /(^|[\s{(,])asOf:/u.test(line) && !/asOf\??:\s*string/u.test(line)).length
  // 口径②：**接口声明**（`asOf: string` / `asOf?: string`）
  const declarations = (records.match(/^\s+asOf\??: string/mu) ?? []).length
  // 口径③：**消费行数**（`describe.ts` 里引用 `asOf` 的行）
  const consumed = described.split('\n').filter((line) => /asOf/u.test(line)).length
  assert.equal(docNumber(/\*\*对象属性赋值 (\d+) 处\*\*/u, '对象属性赋值'), assignments, `文档写的赋值点数必须等于**现算**值（现算 ${assignments}）`)
  assert.equal(docNumber(/\*\*接口声明 (\d+) 处\*\*/u, '接口声明'), declarations, `文档写的声明数必须等于**现算**值（现算 ${declarations}）`)
  assert.equal(docNumber(/\*\*消费 (\d+) 行\*\*/u, '消费'), consumed, `文档写的消费行数必须等于**现算**值（现算 ${consumed}）`)
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
