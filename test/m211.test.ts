/**
 * `M211-01`（`DEF-153` 的防复发网）：**任何以真账为夹具的守卫，都必须声明「缺账时怎么办」**。
 *
 * 病：本仓 `.sdo/` 不入库（`.gitignore:30`），CI 是干净检出 ⇒ 没有真账。旧守卫直接
 * `readdirSync(join(ROOT,'.sdo'))` ⇒ CI 抛 `ENOENT`，而本地（有 `.sdo`）永远绿 ——
 * 「本地全量绿 ≠ CI 绿」正是 `DEF-153` 记的那个漏，一次就红了 7 格。
 *
 * 这一格写成**性质断言**，不列那 7 个文件：将来谁再写一条读真账的守卫，只要没走
 * `realLedgerSkip()`，这里就红并点名 `文件:行`。枚举式清单挡不住下一个人。
 *
 * 识别口径（**按"仓库根是怎么算出来的"判**，不按变量名猜）：
 *   · **仓库根** = `fileURLToPath(new URL('../../', import.meta.url))`（`lib/test/*.js` 往上一级是仓库根）；
 *   · 从那个根**够到真账**的四种形状（本仓实测用到的全部）：
 *       ① `join(<根>, '.sdo')`            —— 直接拼路径
 *       ② `storeFor(<根>)`                —— 走产品 API 取 store
 *       ③ `noteSession(…, <根>)` + 之后 `reviews({ cwd: <根> })` —— 走会话绑定的产品 API
 *       ④ `REPO_SDO`                       —— 直接写死仓库根台账常量
 *     ⚠️ **已知局限**：这是**文本形状**匹配，将来若出现第 5 种够法，这张网会漏。缓解手段是下面的
 *     「读者数下限」断言（口径被改瞎或新形状让读者数下降都会红），而不是假装这网无所不包。
 *   · **假阳**：`journal.test.ts` / `store.test.ts` 里的 `ROOT` 是 `rmSync` 掉的**临时夹具**目录
 *     （`join(ROOT,'node_modules','.sdo-test',…)`），不是仓库根 —— 上面按"根从哪来"判定自然排除；
 *   · **真例外**：`m38.test.ts` 那格标题就是「真源在盘上 / 不在盘上两态都必须判得出」，
 *     它**本来就带无账分支**（`assessRegressionFromStore` 对空账也给出结论）⇒ 无需 skip，
 *     但必须在下面 `EXEMPT` 里**写明理由**（带理由的例外，不是盲枚举）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { hasRealLedger, realLedgerSkip } from './support/real-ledger.js'

const TEST_DIR = join(fileURLToPath(new URL('../../', import.meta.url)), 'test')

/** 仓库根的算法（`const X = fileURLToPath(new URL('../../', import.meta.url))`）。 */
const REPO_ROOT_ASSIGN = /(?:const|let)\s+(\w+)\s*=\s*fileURLToPath\(\s*new URL\(\s*'\.\.\/\.\.\/'\s*,\s*import\.meta\.url\s*\)\s*\)/gu
const USES_SKIP = /realLedgerSkip\s*\(/u

/** 带理由的例外（**每一条都要说清为什么不需要 skip**）。 */
const EXEMPT: Readonly<Record<string, string>> = {
  'm38.test.ts': '该格标题即「真源在盘上 / 不在盘上两态都必须判得出可复算的结论」—— 它读真账但**本来就带无账分支**，干净检出里也给出结论（CI 实测未红）。',
}

test('M211-01 任何读取**仓库自身** `.sdo` 的守卫，都必须声明「缺账时怎么办」（`realLedgerSkip()`）', () => {
  const files = readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.ts')).sort()
  assert.ok(files.length > 50, `扫到的测试文件太少（${files.length}），检测口径可能失效`)

  const offenders: string[] = []
  let readers = 0
  for (const name of files) {
    const source = readFileSync(join(TEST_DIR, name), 'utf8')
    // ① 这里有没有「仓库根」这个变量
    const roots = new Set<string>()
    REPO_ROOT_ASSIGN.lastIndex = 0
    for (const match of source.matchAll(REPO_ROOT_ASSIGN)) if (match[1] !== undefined) roots.add(match[1])
    // ② 从那个根够到真账的四种形状（顺序即优先级；取**最早**出现的那个用来报行号）
    let hit: { index: number; text: string } | undefined
    const record = (found: RegExpExecArray | null): void => {
      if (found !== null && (hit === undefined || found.index < hit.index)) hit = { index: found.index, text: found[0] }
    }
    for (const root of roots) {
      const reach = [
        new RegExp(String.raw`join\(\s*` + root + String.raw`\s*,\s*'\.sdo'`, 'u'),
        new RegExp(String.raw`storeFor\(\s*` + root + String.raw`\s*\)`, 'u'),
        new RegExp(String.raw`noteSession\([^)]*\b` + root + String.raw`\b`, 'u'),
      ]
      for (const needle of reach) record(needle.exec(source))
    }
    record(/REPO_SDO/u.exec(source))
    if (hit === undefined) continue
    readers += 1
    if (USES_SKIP.test(source)) continue
    if (name in EXEMPT) continue
    const line = source.slice(0, hit.index).split('\n').length
    offenders.push(`${name}:${line}（${hit.text}）`)
  }

  assert.deepEqual(
    offenders,
    [],
    '这些守卫读了仓库自己的 .sdo，却没声明缺账时的行为（干净检出里会抛 ENOENT ⇒ CI 红）：\n  '
      + offenders.join('\n  ')
      + '\n修法：`import { realLedgerSkip } from \'./support/real-ledger.js\'`，然后 '
      + '`test(标题, realLedgerSkip() ?? {}, () => { … })`。**不许**把真账断言换成夹具断言'
      + '（那会把「存量零迁移」降级成同义反复，DEF-149 那族）。',
  )

  // 反向：这格不许退化成空断言 —— 现实里有 8 个真账读者，少于 7 就说明识别口径被改坏了。
  assert.ok(
    readers >= 9,
    `只识别出 ${readers} 个真账读者（应 ≥ 9（含 m177 的真账指纹对账）：TC-143/135/147/121/130/125 + M207-02 + m38）—— 识别口径或命名被改了，别把这张网改瞎`,
  )
})

/**
 * `M211-02`：**有真账的环境里，这些守卫不许静默跳过**。
 *
 * 为什么需要这一格：`M211-01` 允许「缺账 ⇒ skip」，可一旦有人把 `.sdo` 改名/搬走（或
 * `realLedgerSkip()` 被写成恒真），本地的真账守卫会**静默蒸发** —— 全量照样绿，但什么都没验。
 * 这里用同一份判定反过来钉住：有账 ⇒ `realLedgerSkip()` 必须是 `undefined`。
 */
test('M211-02 有真账的环境里 `realLedgerSkip()` 必须返回 undefined（缺账才准跳过）', realLedgerSkip() ?? {}, () => {
  assert.ok(hasRealLedger(), '走到这里说明本机有真账（journal.jsonl 在盘上）')
  assert.equal(
    realLedgerSkip(),
    undefined,
    '有真账时必须照常执行：skip 只允许出现在「本 clone 没有台账」的情形，否则真账守卫会静默蒸发',
  )
})
