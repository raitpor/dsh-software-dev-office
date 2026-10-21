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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseYaml, stringifyYaml, YamlSubsetError, YamlWriteError } from '../src/infra/yaml.js'

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
    // **第四批 §3.6 新增**：**前导**空格键 —— 旧实现裸写成 ` a: 1`，读端按 YAML 缩进读成键 `a`（**静默改名**）
    { key: ' a', written: "' a': 1" },
    { key: '   ', written: "'   ': 1" },        // 全空白键（同上，必须原样读回）
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

test('M169-03 结构：两端**同源**（写端加引号与读端拒认共用同一份字符集），且**逐条**核对用点', () => {
  // **第四批 §3.6（V6 的指出）**：原来这里只数 `uses.length >= 4` 就下结论，而注释把读端两处说成
  // "键值分隔分支 / 反斜杠分支"——**实际只有键值分隔分支**用这份字符集（反斜杠分支有自己的文案）。
  // 计数式断言既没钉住"用在哪"，注释也是错的 ⇒ 改成**逐条内容断言**（每一处用点的条件行/文案都要能指名）。
  const lines = readFileSync(join(ROOT, 'src', 'infra', 'yaml.ts'), 'utf8').split('\n')
  const code = lines.filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line)).join('\n')
  // ① 定义只有一处（没有第二套字符表）
  assert.equal(code.split('NEEDS_QUOTE_KEY =').length - 1, 1, '`NEEDS_QUOTE_KEY` 只许定义一次')
  // ② 写端：`quoteKeyIfNeeded` 的函数体里必须用它（而且是"任意位置命中"的那条判定）
  const writerStart = code.indexOf('function quoteKeyIfNeeded(')
  const writerBody = code.slice(writerStart, code.indexOf('\n}', writerStart))
  assert.match(writerBody, /NEEDS_QUOTE_KEY\.test\(key\)/u, '写端必须用这份字符集判断"键要不要加引号"')
  // ③ 读端：**键值分隔分支**里必须用它做可读拒绝（点名"裸形态"与修法）
  const readerGuard = code.split('\n').find((line) => line.includes('NEEDS_QUOTE_KEY.test(rawKey)'))
  assert.ok(readerGuard !== undefined, '读端必须有一处用 `NEEDS_QUOTE_KEY.test(rawKey)` 判裸键')
  assert.match(readerGuard as string, /key === undefined/u, '读端这一处判的是"键对不上"的那一态')
  // ④ 读端**反斜杠分支**是**另一处**、**不用**这份字符集（V6 指出的那处注释错误就在这）：
  //    它有自己的条件与文案，各自点名（逐条断言，不靠计数）
  const backslashGuard = code.split('\n').find((line) => line.includes('裸键里出现') || line.includes('裸键不允许反斜杠'))
  assert.ok(backslashGuard !== undefined, '读端必须保留"裸键不许反斜杠"的可读拒绝')
  assert.equal(backslashGuard.includes('NEEDS_QUOTE_KEY'), false, '反斜杠分支用的是自己的条件与文案（不是这份字符集）')
  // ⑤ 行为证据逐条：每个字符都要"写端加引号 + 读端拒认"两条
  for (const ch of ILLEGAL_IN_BARE_KEY) {
    assert.equal(stringifyYaml({ [`a${ch}b`]: 1 }).startsWith("'"), true, `键里的 ${JSON.stringify(ch)} 必须触发引号`)
    assert.throws(() => parseYaml(`a${ch}b: 1`), YamlSubsetError, `裸形态的 ${JSON.stringify(ch)} 必须被拒`)
  }
})

test('M169-04 空键（第四批 §3.6 新增）：**写端拒绝**（可执行提示），读端提示词**正确**（不再自相矛盾）', () => {
  // ① 写端：空键没有任何能读回来的写法 ⇒ **写的时候就拒**（不许写出读不回的东西）
  let writeError: unknown
  try {
    stringifyYaml({ '': 'v' })
    assert.fail('空键必须被写端拒绝（读端只认非空键）')
  } catch (error) {
    writeError = error
  }
  assert.ok(writeError instanceof YamlWriteError, `写端拒的是写端专属的那类错：${String(writeError)}`)
  const writeMessage = (writeError as Error).message
  assert.match(writeMessage, /键是空的/u, `提示词必须说清"键是空的"：${writeMessage}`)
  assert.match(writeMessage, /非空键/u, `提示词必须可执行（换一个非空键）：${writeMessage}`)
  assert.equal(/第 0 行/u.test(writeMessage), false, '写端错误不该假装有行号（那正是 YamlWriteError 存在的理由）')

  // ② 读端：手写进来的 `'': v` / `"": v` ⇒ 提示词必须**正确**（旧实现说"请写成引号形态"，可它本来就是引号形态）
  for (const raw of ["'': 1", '"": 1']) {
    let thrown: unknown
    try {
      parseYaml(raw)
      assert.fail(`${raw} 必须被拒绝`)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof YamlSubsetError, `${raw} 抛的必须是 YamlSubsetError`)
    const message = (thrown as Error).message
    assert.match(message, /键是空的/u, `必须点名真正的病根（空键）：${message}`)
    assert.match(message, /第 1 行/u, '仍要点名行号')
    assert.equal(message.includes('请写成'), false, `不许再出现"请写成引号形态"这种自相矛盾的提示：${message}`)
  }

  // ③ 反例：**非空**键与**空值**都不受这条影响（别把空键的判定扩散出去）
  assert.deepEqual(parseYaml("'a': ''"), { a: '' }, '空值照旧')
  assert.equal(stringifyYaml({ a: '' }), "a: ''\n", '空值照旧（写端只对键加引号）')
  assert.deepEqual(parseYaml("'a''b': 1"), { "a'b": 1 }, '含引号的键照旧（别被空键那条误伤）')
})

test('M169-05 TC-121：键形态矩阵补到 **16 类**，逐类"写得出 / 读得回 / 无坏结局"', () => {
  // `TC-121` 原文的 16 类：空键 / 前导 / 结尾 / 两端 / 全空白 / `a#b` / `a,b` / `a\b` /
  // `a"b` / `a'b` / `a: b` / 减号开头 / 井号开头 / 带引号形态（双）/ 带引号形态（单）/ 键内含空格（反例）
  const matrix: { name: string; key: string; written: string | 'REJECT' }[] = [
    { name: '空键', key: '', written: 'REJECT' },
    { name: '前导空白', key: ' a', written: "' a': 1" },
    { name: '结尾空白', key: 'a ', written: "'a ': 1" },
    { name: '两端空白', key: ' a ', written: "' a ': 1" },
    { name: '全空白', key: '   ', written: "'   ': 1" },
    { name: '含井号', key: 'a#b', written: "'a#b': 1" },
    { name: '含逗号', key: 'a,b', written: "'a,b': 1" },
    { name: '含反斜杠', key: 'a\\b', written: "'a\\b': 1" },
    { name: '含双引号', key: 'a"b', written: "'a\"b': 1" },
    { name: '含单引号', key: "a'b", written: "'a''b': 1" },
    { name: '含冒号空格', key: 'a: b', written: "'a: b': 1" },
    { name: '减号开头', key: '- a', written: "'- a': 1" },
    { name: '井号开头', key: '#a', written: "'#a': 1" },
    { name: '带引号形态（双）', key: '"a"', written: "'\"a\"': 1" },
    { name: '带引号形态（单）', key: "''", written: "'''''': 1" },
    { name: '键内含空格（反例：不该加引号）', key: 'a b', written: 'a b: 1' },
  ]
  assert.equal(matrix.length, 16, '矩阵必须恰好 16 类（TC-121 的基数）')
  const bad: string[] = []
  for (const row of matrix) {
    if (row.written === 'REJECT') {
      // 空键：写端**直接拒**（没有能读回来的写法），提示词要可执行
      assert.throws(() => stringifyYaml({ [row.key]: 1 }), YamlWriteError, `${row.name} 必须被写端拒绝`)
      continue
    }
    let written: string
    try {
      written = stringifyYaml({ [row.key]: 1 })
    } catch (error) {
      bad.push(`${row.name} 写失败：${String(error)}`)
      continue
    }
    if (written !== `${row.written}\n`) bad.push(`${row.name} 写出形态不符：${JSON.stringify(written)}`)
    let read: unknown
    try {
      read = parseYaml(written)
    } catch (error) {
      bad.push(`${row.name} 读失败：${String(error)}`)
      continue
    }
    if (JSON.stringify(read) !== JSON.stringify({ [row.key]: 1 })) bad.push(`${row.name} 读回不一致：${JSON.stringify(read)}`)
  }
  assert.deepEqual(bad, [], `16 类必须 16/16 无坏结局：${bad.join('；')}`)
})

test('M169-06 TC-121：**4000 抽样**随机扫地 —— 键由特殊字符随机拼成，往返 0 坏结局', () => {
  // 确定性 LCG（不用 `Math.random`：同一份代码两次跑出同一批键，红了才能照抄复现）
  let seed = 20261021
  const next = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % bound
  }
  const alphabet = [' ', '#', ',', '\\', '"', "'", ':', '-', '{', '}', '[', ']', '&', '*', '!', '|', '>', '%', '@', '`', 'a', 'b', '0']
  const bad: string[] = []
  let tested = 0
  for (let round = 0; round < 4000; round += 1) {
    const length = 1 + next(5)
    let key = ''
    for (let index = 0; index < length; index += 1) key += alphabet[next(alphabet.length)] ?? 'a'
    // 两端随机加空白（TC-121 原文：两端随机加空白）
    if (next(2) === 0) key = `${' '.repeat(next(3))}${key}`
    if (next(2) === 0) key = `${key}${' '.repeat(next(3))}`
    tested += 1
    try {
      const read = parseYaml(stringifyYaml({ [key]: 1 }))
      if (JSON.stringify(read) !== JSON.stringify({ [key]: 1 })) bad.push(`读回不一致：${JSON.stringify(key)} => ${JSON.stringify(read)}`)
    } catch (error) {
      bad.push(`往返失败：${JSON.stringify(key)} => ${String(error)}`)
    }
  }
  assert.equal(tested, 4000, '抽样必须是 4000 条')
  assert.equal(bad.length, 0, `4000 抽样必须 0 坏结局（前 5 例：${bad.slice(0, 5).join('；')}）`)
})

test('M169-07 TC-121：`.sdo` 存量 yml **全部读回 0 失败**（存量零破坏的机械读数）', () => {
  const root = join(ROOT, '.sdo')
  // **自己的遍历器**（不用 `readdirSync({recursive:true})`）：`.sdo/evidence/**` 里有历史快照树，
  // 其中带**悬空软链**（`readdirSync` 递归会跟着走 ⇒ ENOENT）。这里跳过软链、只收普通文件。
  const files: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = String(entry.name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(join(dir, name), rel)
        continue
      }
      if (entry.isFile() && /\.ya?ml$/u.test(name)) files.push(rel)
    }
  }
  walk(root, '')
  assert.ok(files.length > 100, `夹具前提：真台账里应有大量 yml（实际 ${files.length} 个）`)
  const failures: string[] = []
  for (const name of files) {
    try {
      parseYaml(readFileSync(join(root, name), 'utf8'))
    } catch (error) {
      failures.push(`${name}: ${(error as Error).message.slice(0, 80)}`)
    }
  }
  assert.deepEqual(failures, [], `${files.length} 个存量 yml 必须全部读得回（0 失败）：${failures.slice(0, 5).join('；')}`)
})
