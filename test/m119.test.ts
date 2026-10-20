/**
 * **增量 119：C-64 四处 desc 的句尾收口（不得停在悬空从句）**。
 *
 * 病灶（TASK-123，2026-10-20 现验）：`src/data/processes/{waterfall,agile,prototype,spiral}.yml` 的
 * C-64 `desc` 句尾停在 `**存量不追溯**：两个风险豁免字段是本轮新增` —— 后半句被切掉
 * （对照 C-63 同类尾巴「…是本轮新增字段，新字段生效前建的卡读回来是空集」），
 * 读者看到的是一个**没说完的条件**：既读不出"存量为什么不追溯"，也读不出"读回来是空集算不算判据没电"。
 *
 * 与 `test/m136.test.ts#M136-01` 的分工（同一批文案，两把尺子）：
 * · **M136-01** 守**形态判别口径**（三件套在、旧的「现读全库为空」不在、四处逐字一致）——
 *   那批工作已在 `dab49d5`（2026-10-14 17:13，机制缺陷批 §3D）落地；
 * · **本文件**守**句尾完整性**：`M119-03` 是本卡**唯一**实际要修的东西（改前必红、改后转绿），
 *   ① ② ④ 与 M136-01 判据同源（刻意重叠），作用是"收口时别把口径改回去"。
 *
 * 不做的事：不读判据实现（`gates.ts`）、不判断流程对不对 —— 只把这四处**自述文案的形状**钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PROCESSES = ['waterfall', 'agile', 'prototype', 'spiral'] as const

/** 全称否定：判据早已改成**形态判别**，再写"全库为空"就与判据口径相左。 */
const WHOLE_EMPTY = /现读全库为空|全库为空|两格全空|全是空数组/u

/** 判据同源三件套（`gates.ts` 的 C-64 口径：DEF-064 / REV-043）。 */
const SAME_SOURCE = ['形态判别', '路径形态', '逐条回显'] as const

function fileOf(name: string): string {
  return `src/data/processes/${name}.yml`
}

/** 从盘上读出某份流程 YAML 里 C-64 那一行的 `desc`（`- { id: C-64, check: ..., desc: "..." }`）。 */
function c64Desc(name: string): string {
  const file = fileOf(name)
  const line = readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .find((item) => item.includes('- { id: C-64,'))
  assert.ok(line !== undefined, `${file} 里找不到 C-64 的声明行`)
  const matched = /desc: "([\s\S]*)" \}$/u.exec(line as string)
  assert.ok(matched !== null, `${file} 的 C-64 行没有可解析的 desc（期望形如 \`desc: "…" }\`）`)
  return matched[1] as string
}

function all(): { file: string; desc: string }[] {
  return PROCESSES.map((name) => ({ file: fileOf(name), desc: c64Desc(name) }))
}

test('M119-01 C-64 四处 desc 从盘上读回后逐字相等', () => {
  const entries = all()
  const head = entries[0] as { file: string; desc: string }
  for (const entry of entries) {
    assert.equal(
      entry.desc,
      head.desc,
      `${entry.file} 的 C-64 desc 与 ${head.file} 不逐字一致（四处门禁文档不许分叉；差异请 diff 两份 yml 里 C-64 那行）`,
    )
  }
})

test('M119-02 C-64 四处 desc 不含全称否定（判据早已改成形态判别）', () => {
  for (const { file, desc } of all()) {
    const hit = WHOLE_EMPTY.exec(desc)
    assert.equal(
      hit,
      null,
      `${file} 的 C-64 desc 仍写全称否定「${hit === null ? '' : hit[0]}」：判据是**形态判别**（DEF-064 / REV-043），不是"恰好为空"`,
    )
  }
})

test('M119-03 C-64 四处 desc 不得以悬空从句结尾（本卡唯一的实际修复）', () => {
  for (const { file, desc } of all()) {
    assert.doesNotMatch(
      desc,
      /本轮新增\s*$/u,
      `${file} 的 C-64 desc 句尾断在半句「…本轮新增」：请补齐后半句（对照 C-63 同类尾巴的写法）`,
    )
  }
})

test('M119-04 C-64 四处 desc 含判据同源三件套（形态判别 / 路径形态 / 逐条回显）', () => {
  for (const { file, desc } of all()) {
    const missing = SAME_SOURCE.filter((token) => !desc.includes(token))
    assert.equal(
      missing.length,
      0,
      `${file} 的 C-64 desc 缺判据同源表述：${missing.join('、')}（判据口径见 gates.ts 的 C-64，DEF-064 / REV-043）`,
    )
  }
})
