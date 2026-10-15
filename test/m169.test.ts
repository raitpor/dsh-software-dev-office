/**
 * **增量 169：DEF-061 残余面（第三批 §3.18）—— 裸键的合法面协商（写读对称 + 可读拒绝）**。
 *
 * 修前现盘（两半同源）：
 *   · 写端 `quoteIfNeeded`/`NEEDS_QUOTE` 只在**起始位置**命中 `- ? : , [ ] { } # & * ! | > % @ ` ' "`
 *     才加引号（`\` 更是完全不查 —— `NEEDS_ESCAPE_QUOTE` 只作用于**值**）；
 *   · 读端 `unwrapQuotedKey` 对**裸键**的合法面是"不含 `[ ] { } ' " , # & * ! | > % @ \`` 任一"
 *     ⇒ 键里**夹着**这些字符时（`a#b` / `a,b` / `a\b` / `a"b` / `a'b`）**写得出、读不回**：
 *     `splitKey` 返回 undefined ⇒ 整行被**静默读成字符串**（既不报错、也不还原）。
 *
 * 修法：① 键的合法面对齐到读端口径（`NEEDS_QUOTE_KEY`：**任意位置**命中那组字符就加引号）；
 * ② 手写成裸形态的"看得出的键值对"⇒**可读拒绝**并点名字符与修法（不再静默降级）；
 * ③ 流式集合（`- { id: X }`）与标量行（`don't stop`）**不误杀**（本轮实测出来的边界）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseYaml, stringifyYaml, YamlSubsetError } from '../src/infra/yaml.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 读端不认的那些字符（写端必须为夹着它们的键加引号）——**一处定义，两侧共用**。 */
const ILLEGAL_IN_BARE_KEY = ['[', ']', '{', '}', "'", '"', ',', '#', '&', '*', '!', '|', '>', '%', '@', '`', '\\']

test('M169-01 往返矩阵（≥5 类键形态）：写出去的一定读得回来（含此前静默丢失的五类）', () => {
  const cases: { key: string; written: string }[] = [
    { key: 'a#b', written: "'a#b': 1" },        // 键内含井号（旧：裸写，读回整行成字符串）
    { key: 'a,b', written: "'a,b': 1" },        // 键内含逗号
    { key: 'a\\b', written: "'a\\b': 1" },      // 键内含反斜杠（旧：裸写且读端直接判"不是键值对"）
    { key: 'a"b', written: `'a"b': 1` },        // 键内含双引号
    { key: "a'b", written: "'a''b': 1" },       // 键内含单引号（单引号自转义）
    { key: 'plain', written: 'plain: 1' },      // 反例：普通裸键仍走原路径（不许"所有键都加引号"）
    { key: 'a: b', written: "'a: b': 1" },      // 既有支：冒号+空格
    { key: '- a', written: "'- a': 1" },        // 既有支：起始减号
    { key: '#a', written: "'#a': 1" },          // 既有支：起始井号
    { key: 'a ', written: "'a ': 1" },          // 既有支：结尾空格
  ]
  for (const { key, written } of cases) {
    const doc = stringifyYaml({ [key]: 1 })
    assert.equal(doc, written + '\n', `键 ${JSON.stringify(key)} 的写出形态必须逐字钉住`)
    assert.deepEqual(parseYaml(doc), { [key]: 1 }, `键 ${JSON.stringify(key)} 必须读得回来`)
  }
})

test('M169-02 可读拒绝（三态）：手写的裸形态**不许静默降级成字符串**，且点名字符与修法', () => {
  // ① 读端不认的字符**逐个**验：写成裸形态 ⇒ 必须抛错（可读点名），而不是原样返回那个字符串
  for (const ch of ILLEGAL_IN_BARE_KEY) {
    const raw = `a${ch}b: 1`
    let thrown: unknown
    try {
      const parsed = parseYaml(raw)
      assert.fail(`裸键 ${JSON.stringify(raw)} 必须被拒绝，实际读成 ${JSON.stringify(parsed)}`)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof YamlSubsetError, `${JSON.stringify(raw)} 抛的必须是 YamlSubsetError`)
    assert.equal((thrown as Error).message.includes('第 1 行'), true, '拒因必须点名行号')
    assert.equal((thrown as Error).message.includes(': 值') || (thrown as Error).message.includes('加引号'), true, '拒因必须给可执行修法')
  }
  // ② 反例一：**引号写对了**就照旧读得回（拒绝不等于"这些字符一律不可用"）
  assert.deepEqual(parseYaml("'a#b': 1\n'a,b': 2"), { 'a#b': 1, 'a,b': 2 })
  // ③ 反例二：**标量行**含引号但没有"键: 值"形态 ⇒ 不许误杀
  assert.equal(parseYaml("don't stop"), "don't stop")
  assert.deepEqual(parseYaml('all: good'), { all: 'good' }, '值是普通标量时照旧')
  // ④ 反例三：**流式集合**里的 `{}`/`[]` 不是块映射的键 ⇒ 不许误杀（本轮实测出来的边界）
  assert.deepEqual(parseYaml('- { id: X, n: 1 }'), [{ id: 'X', n: 1 }])
  assert.deepEqual(parseYaml('items: [a, b]'), { items: ['a', 'b'] })
  // ⑤ 反例四：值里出现"冒号+空格"（`a: b: 1`）—— 第一个 `: ` 才是分隔符，键是 `a`
  assert.deepEqual(parseYaml('a: b: 1'), { a: 'b: 1' })
})

test('M169-03 结构：两端**同源**（写端加引号与读端拒认共用同一份字符集），不是各写一套', () => {
  const code = readFileSync(join(ROOT, 'src', 'infra', 'yaml.ts'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
    .join('\n')
  const uses = code.match(/NEEDS_QUOTE_KEY/gu) ?? []
  // 定义 1 处 + 写端 1 处 + 读端拒绝 2 处（键值分隔分支 / 反斜杠分支）——钉住"没有第二套字符表"
  assert.equal(uses.length >= 4, true, `NEEDS_QUOTE_KEY 必须被写读两端共用（实测出现 ${uses.length} 处）`)
  for (const ch of ILLEGAL_IN_BARE_KEY) {
    // 每个字符都要有行为证据：写端加引号 + 读端拒认（双向都由同一份字符集导出）
    assert.equal(stringifyYaml({ [`a${ch}b`]: 1 }).startsWith("'"), true, `键里的 ${JSON.stringify(ch)} 必须触发引号`)
    assert.throws(() => parseYaml(`a${ch}b: 1`), YamlSubsetError, `裸形态的 ${JSON.stringify(ch)} 必须被拒`)
  }
})
