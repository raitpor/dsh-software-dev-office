/**
 * **增量 136：§3D 收口的两条文案/死键守卫（C-64 desc + REV-053 死键）**。
 *
 * **C-64 四处 desc**（交接文档 §3D）：`src/data/processes/{waterfall,agile,prototype,spiral}.yml` 的
 * C-64 `desc` 仍写「`inputs`/`outputs` 现读全库为空」，而判据早已改成**形态判别**（`gates.ts`：
 * ②③ 只核对**路径形态**的声明，散文形态不参与但**逐条回显**未参与的理由）⇒ 门禁文档与判据口径相左。
 *
 * **REV-053 死键**：`uiIndex.kScopeReleaseHint` 在 zh-CN.yml / en.yml **全仓零代码引用**，而
 * 活键是 `uiPlan.kScopeReleaseHint`（**跳段同名**：看起来"有这个键"，实际永远取不到那一份）⇒ 删死键。
 * 本次一并扫了两包：跨段同名多数是**正常设计**（不同段的同名键），真正的病灶是"跳段同名"这一种；
 * 零引用键另有 35 个（`uiSign*` 那批是**动态拼名**引用，盲删会坏事）⇒ 本轮只删已确证的那条，
 * 并用**棘轮**守住"死键不许再增长"。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PACKS = ['src/data/lang/zh-CN.yml', 'src/data/lang/en.yml'] as const
const PROCESSES = ['waterfall', 'agile', 'prototype', 'spiral'] as const

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** 段 → 键集合（顺带断言同段无重复键）。 */
function sections(pack: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  let section = '?'
  for (const line of read(pack).split('\n')) {
    const head = /^([a-zA-Z][\w]*):/u.exec(line)
    if (head !== null) {
      section = head[1] as string
      continue
    }
    const key = /^  ([A-Za-z][\w]*):/u.exec(line)
    if (key === null) continue
    const set = out.get(section) ?? new Set<string>()
    set.add(key[1] as string)
    out.set(section, set)
  }
  return out
}

/** 取某份 YAML 里 C-64 那一行的 `desc`（`- { id: C-64, check: ..., desc: "..." }`）。 */
function c64Desc(file: string): string {
  const line = read(file)
    .split('\n')
    .find((item) => item.includes('- { id: C-64,'))
  assert.ok(line !== undefined, `${file} 里找不到 C-64 的声明行`)
  const m = /desc: "([\s\S]*)" \}$/u.exec(line as string)
  assert.ok(m !== null, `${file} 的 C-64 行没有可解析的 desc`)
  return m[1] as string
}

test('M136-01 C-64 四处 desc 与判据同源（形态判别），且四处措辞一致', () => {
  const descs = PROCESSES.map((name) => c64Desc(`src/data/processes/${name}.yml`))
  for (const [index, desc] of descs.entries()) {
    const name = PROCESSES[index]
    assert.match(desc, /形态判别/u, `${name}.yml 的 C-64 desc 必须点明「形态判别」（判据口径：DEF-064 / REV-043）`)
    assert.match(desc, /路径形态/u, `${name}.yml 要说明只核对**路径形态**的声明`)
    assert.match(desc, /逐条回显/u, `${name}.yml 要说明散文形态的声明**逐条回显**未参与的理由（不静默放过）`)
    assert.equal(
      desc.includes('现读全库为空'),
      false,
      `${name}.yml 不得再写「inputs/outputs 现读全库为空」——那是判据改成形态判别之前的旧口径`,
    )
  }
  assert.equal(new Set(descs).size, 1, '四处 desc 必须**逐字一致**（否则四份门禁文档又会分叉）')
})

test('M136-02 REV-053：`uiIndex.kScopeReleaseHint` 死键已删，活键（`uiPlan`）两包都在', () => {
  for (const pack of PACKS) {
    const map = sections(pack)
    assert.equal(map.get('uiIndex')?.has('kScopeReleaseHint'), false, `${pack} 的 uiIndex 段仍有跳段同名死键`)
    assert.equal(map.get('uiPlan')?.has('kScopeReleaseHint'), true, `${pack} 的活键 uiPlan.kScopeReleaseHint 必须在`)
  }
})

test('M136-03 同段重复键 = 0（两包）—— 这是「新键被静默遮蔽」的直接成因', () => {
  for (const pack of PACKS) {
    let section = '?'
    const seen = new Map<string, Set<string>>()
    for (const line of read(pack).split('\n')) {
      const head = /^([a-zA-Z][\w]*):/u.exec(line)
      if (head !== null) {
        section = head[1] as string
        continue
      }
      const key = /^  ([A-Za-z][\w]*):/u.exec(line)
      if (key === null) continue
      const set = seen.get(section) ?? new Set<string>()
      assert.equal(set.has(key[1] as string), false, `${pack} 的 ${section}.${key[1]} 重复定义（后者会静默遮蔽前者）`)
      set.add(key[1] as string)
      seen.set(section, set)
    }
  }
})

test('M136-04 死键棘轮：零引用键总数不得增长（UI 签名面那批是动态拼名引用，不能盲删）', () => {
  const BASELINE = 35
  const walk = (path: string): string[] =>
    readdirSync(path).flatMap((name) => {
      const full = join(path, name)
      if (statSync(full).isDirectory()) return walk(full)
      return full.endsWith('.ts') ? [readFileSync(full, 'utf8')] : []
    })
  const code = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'test'))].join('\n')
  for (const pack of PACKS) {
    const dead: string[] = []
    for (const [section, keys] of sections(pack)) {
      for (const key of keys) if (!code.includes(key)) dead.push(`${section}.${key}`)
    }
    assert.ok(
      dead.length <= BASELINE,
      `${pack} 的零引用键从 ${BASELINE} 涨到 ${dead.length}（新增了死键）：${dead.slice(-5).join(' ')}`,
    )
  }
})
