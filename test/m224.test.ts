/**
 * **增量 224：`DEF-179` —— `scripts/refresh-prose-gap.mjs` 的 `--write` 产物必须可编译、
 * 且重排整表不许吃掉表内历史注释。**
 *
 * 病根（`DEF-179`，`major`、`escaped`）：`TASK-184` 用脚本重生成 `test/m189.test.ts` 的
 * `KNOWN_PROSE_GAP`，拿到手的产物
 *   ① **多写一个闭合括号** —— `formatTable` 自带表尾 `  }`，调用方又接上 `source.slice(end + 1)`
 *      （该切片**以 `  }` 开头**）⇒ 产物里出现 `  }  }`，整份文件 `tsc` 直接 `TS1005`，
 *      当时只能由实现会话**手工补救**，脚本本身没修；
 *   ② **表内历史注释被静默丢弃** —— 重排只输出它认识的数据行，作者写在表里的登记说明
 *      （`TASK-163` 那条「登记同步」注释）至今不在表里。
 *
 * 两条都不是"谁忘了"，而是**缺守卫**：产物坏了只能等人撞到编译错，注释丢了根本不会报错。
 * 本文件把它们钉成**双态**守卫：
 *   M224-01 **坏产物必须判红** —— 修前的渲染模板原样留在这里当反例，真跑 `tsc`，必须 TS1005；
 *   M224-02 **修后产物必须能被 `tsc` 解析**（真调 `node_modules/typescript/bin/tsc`，不是"看起来像"）；
 *   M224-03 现盘真实表体（逐字节取自 `test/m189.test.ts`）与脚本对它重渲染后的表体都能被 `tsc` 解析；
 *   M224-04 **重排前后表内历史注释逐字相等**（以 `TASK-163` 的登记说明为样例）；
 *   M224-05 脚本对现盘登记表是**不动点**（用现盘自己的数字重渲染必须逐字节相等 ⇒ `--write` 不掀无意义 diff）。
 *
 * 全局"登记与现算恰好相等"那一条**不在这里重复断言**：`M199-07` 已经守着它（同一份读数，重复断言只会
 * 让"别的卡新增了带读散文断言的用例、还没重生成表"这件事把两条守卫一起顶红）。
 *
 * 断言消息一律用英文、中文只写在断言**之外**：本文件不进 `KNOWN_PROSE_GAP`
 * （本卡写范围不含 `test/m189.test.ts`），一写内联中文判据就会把散文棘轮顶红。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/** 编译后本文件落在 `lib/test/`，仓库根是上两级。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const M189 = join(ROOT, 'test', 'm189.test.ts')

/** `scripts/refresh-prose-gap.mjs` 的**受守卫面**（脚本本身不是 TS，这里给出最小契约）。 */
interface GapScript {
  formatTable(gap: Record<string, number>, comments?: readonly string[]): string
  readRegistered(source?: string): { registered: Record<string, number>; start: number; end: number; body: string; source: string }
  rewriteSource(source: string, gap: Record<string, number>): string
  tableComments(body: string): string[]
}

const script = (await import(new URL('../../scripts/refresh-prose-gap.mjs', import.meta.url).href)) as unknown as GapScript

/** 脚本认的表头（与 `scripts/refresh-prose-gap.mjs` 的 `HEAD` 同形；M224-01 里会机械核对）。 */
const HEAD = 'const KNOWN_PROSE_GAP: Record<string, number> = {'

/**
 * 修前（`DEF-179` 之前的 `main()`）的**原样**渲染：表尾 `  }` 由模板自带，再接 `source.slice(end + 1)`
 * —— 这一行就是"多写一个闭合括号"的病根。反例留在**被测脚本之外**，才不会被自己顺手一起修掉。
 */
function buggyRewrite(source: string, gap: Record<string, number>): string {
  const { start, end } = script.readRegistered(source)
  const keys = Object.keys(gap).sort()
  const lines: string[] = []
  for (let index = 0; index < keys.length; index += 4) {
    lines.push('  ' + keys.slice(index, index + 4).map((key) => `'${key}': ${gap[key]}`).join(', ') + ',')
  }
  return `${source.slice(0, start)}${HEAD}\n${lines.join('\n')}\n  }${source.slice(end + 1)}`
}

/**
 * 夹具：`test/m189.test.ts` 里那段表的**同形**缩样 —— 表装在**调用实参里的回调**中（真表就装在
 * `test('…', () => { … })` 里），因为多写的那个 `}` 会先关掉回调、让后面的代码落进实参表 ⇒ 才是 `TS1005`
 * （`',' expected`），与现场一致；表内历史注释**逐字**取自 `TASK-163` 的登记说明。
 */
const FIXTURE = `declare function run(name: string, body: () => void): void
run('fixture', () => {
  const KNOWN_PROSE_GAP: Record<string, number> = {
  // **\`TASK-163\` 登记同步**：m206 新增四条派发面守卫（① 复用 ② 桶计数 ③ 三条字段 ④ 逐字节复现），
  // 新增站点 9-2=7 个（现算 2447 站点 / 215 文件那一行可复算）。只改登记值，未动抽取器。
  'test/a.test.ts': 1, 'test/b.test.ts': 2,
  }
  const total = Object.values(KNOWN_PROSE_GAP).reduce((sum, count) => sum + count, 0)
  if (total < 0) throw new Error('unreachable')
})
`

/** 重排后的"现算"：键换了位置、数量变了（数据行必须重排，历史注释必须活着）。 */
const NEW_GAP: Record<string, number> = { 'test/b.test.ts': 7, 'test/a.test.ts': 1, 'test/c.test.ts': 3 }

/** 表尾闭合括号在原文里的形态（`readRegistered` 的 `end` 指向它的前导换行）。 */
const CLOSE = '\n  }'

interface TscRun { status: number; output: string }

/** 真跑 `tsc`：临时目录里只有这一个 `.ts`（没有 tsconfig），`status !== 0` 即"解析不了"。 */
function typecheck(source: string): TscRun {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m224-'))
  try {
    writeFileSync(join(dir, 'fixture.ts'), source, 'utf8')
    const run = spawnSync(
      process.execPath,
      [TSC, '--noEmit', '--strict', '--target', 'es2023', '--module', 'nodenext', 'fixture.ts'],
      { cwd: dir, encoding: 'utf8' },
    )
    return { status: run.status ?? 1, output: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 从一份 `m189.test.ts` 里**逐字节**切出表体（表头到表尾 `  }`），供"单独编译表体"用。 */
function tableRegion(source: string): string {
  const { start, end } = script.readRegistered(source)
  return source.slice(start, end + CLOSE.length)
}

test('M224-01 修前模板的产物必须判红：多写一个闭合括号 ⇒ tsc TS1005（DEF-179 ①）', () => {
  assert.ok(TSC.endsWith(join('typescript', 'bin', 'tsc')), 'the guard must run the repo own tsc binary')
  // 反例模板必须和脚本同头，否则"红"可能只是拼错了表头
  assert.ok(script.formatTable({ 'test/x.test.ts': 1 }).startsWith(HEAD), 'fixture head must match the script head')
  const broken = buggyRewrite(FIXTURE, NEW_GAP)
  // 病根的确切形状：同一行里两个闭合括号（表尾一个 + 切片带回来的一个）
  assert.equal((broken.match(/\}  \}/gu) ?? []).length, 1, 'the pre-fix renderer must emit the doubled brace exactly once')
  const run = typecheck(broken)
  assert.notEqual(run.status, 0, 'the broken product must NOT compile')
  assert.match(run.output, /TS1005/u, `the broken product must fail with TS1005, got: ${run.output}`)
})

test('M224-02 修后产物必须能被 tsc 解析（双态的另一半）', () => {
  const good = script.rewriteSource(FIXTURE, NEW_GAP)
  assert.equal((good.match(/\}  \}/gu) ?? []).length, 0, 'the fixed renderer must not emit a doubled brace')
  const run = typecheck(good)
  assert.equal(run.status, 0, `the fixed product must compile, got: ${run.output}`)
  assert.equal(run.output, '', `tsc must stay silent on the fixed product, got: ${run.output}`)
})

test('M224-03 现盘真实表体与脚本重渲染后的表体都能被 tsc 解析', () => {
  const live = readFileSync(M189, 'utf8')
  const wrap = (table: string): string => `function table(): Record<string, number> {\n${table}\n  return KNOWN_PROSE_GAP\n}\n`
  const before = typecheck(wrap(tableRegion(live)))
  assert.equal(before.status, 0, `the live table region must compile, got: ${before.output}`)
  // 真表 + 一条被扰动后的现算 ⇒ 走脚本真正的重渲染路径（不是夹具）
  const parsed = script.readRegistered(live)
  const rerendered = script.rewriteSource(live, { ...parsed.registered, 'test/m189.test.ts': 99 })
  assert.equal((rerendered.match(/\}  \}/gu) ?? []).length, 0, 're-rendering the live table must not add a brace')
  const after = typecheck(wrap(tableRegion(rerendered)))
  assert.equal(after.status, 0, `the re-rendered live table region must compile, got: ${after.output}`)
  assert.equal(script.readRegistered(rerendered).registered['test/m189.test.ts'], 99, 'the re-rendered table must carry the new number')
})

test('M224-04 重排前后表内历史注释逐字相等（TASK-163 的登记说明为例，DEF-179 ②）', () => {
  const before = script.tableComments(script.readRegistered(FIXTURE).body)
  assert.equal(before.length, 2, 'the fixture must carry two historical comment lines')
  const product = script.rewriteSource(FIXTURE, NEW_GAP)
  const after = script.tableComments(script.readRegistered(product).body)
  // 逐字相等（不是"包含"、不是"条数相同"）：文字、缩进、顺序都不许变
  assert.deepEqual(after, before, 'historical comments inside the table must survive the rewrite byte for byte')
  for (const line of before) {
    assert.ok(product.includes(line), `the product must contain the note verbatim: ${line}`)
  }
  // 数据行确实被重排了（否则"注释还在"可能只是整表没写盘）
  assert.deepEqual(Object.keys(script.readRegistered(product).registered).sort(), Object.keys(NEW_GAP).sort())
  // 反例：修前模板把这些注释整段吃掉 —— 守卫必须能指出这一点
  const broken = script.tableComments(script.readRegistered(buggyRewrite(FIXTURE, NEW_GAP)).body)
  assert.deepEqual(broken, [], 'the pre-fix renderer must be shown to drop every in-table comment')
})

test('M224-05 脚本对现盘登记表是不动点（重排不洗表、不加括号）', () => {
  const live = readFileSync(M189, 'utf8')
  const parsed = script.readRegistered(live)
  // 用现盘自己的数字重渲染 ⇒ 必须**逐字节**等于现盘（否则 `--write` 每次都会掀起无意义的大 diff）
  assert.equal(script.rewriteSource(live, parsed.registered), live, 're-rendering the live table with its own numbers must be a fixed point (run --write to canonicalise the table)')
  // 现盘里不许留 DEF-179 ① 的伤疤（表尾同一行两个闭合括号）
  assert.equal((live.match(/\}  \}/gu) ?? []).length, 0, 'the live file must not carry a doubled closing brace')
  // 现盘表体必须能被解析出登记（表尾/表头的形态没跑偏）
  assert.ok(Object.keys(parsed.registered).length > 100, 'the live table must still parse into a full registration map')
})
