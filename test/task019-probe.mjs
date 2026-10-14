/**
 * TASK-019 的**同一条探针**（红/绿两态共用一个断言面）。
 *
 * 断言面（红绿必须逐字相同）：`src/domain/regression.ts` 的导出面 + 两个具体性质：
 *   ① 图空 ⇒ `impact.derivable === false`（不许把"图里没写"读成"无影响"）；
 *   ② 有图且影响集含 TC-001/TC-002、回归集只有 TC-001 ⇒ `missing === ['TC-002']`（漏跑要点名）。
 *
 * 跑法：`node test/task019-probe.mjs [被测模块路径]`
 *   · 缺省 = `lib/src/domain/regression.js`（当前实现 ⇒ 绿）；
 *   · 红态 = 把该文件挪走（或指到一个不含 `assessRegression` 的模块）⇒ 加载失败即非 0 退出；
 *   · 变异态 = 指到把 `derivable = unique.length > 0 && !graphEmpty && unconnected.length === 0`
 *     改成 `unique.length > 0` 的副本 ⇒ 缺省那一项判红。
 *
 * 放在 `test/` 下（公共面）：探针是**证据本身**，要留在盘上可复跑，而不是跑完即弃的一次性脚本。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const WS = join(ROOT, 'node_modules', '.sdo-test', 'task019-probe-ws')
const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? join(ROOT, 'lib', 'src', 'domain', 'regression.js')

rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
const BODY = 'TASK-019 probe artifact\n'
writeFileSync(join(WS, 'artifact.txt'), BODY)
const hash = createHash('sha256').update(BODY).digest('hex')

let mod
try {
  mod = await import(pathToFileURL(target).href)
} catch (error) {
  // 红态（模块根本不在）：如实退出非 0 并印出原因 —— 不许静默当成"判据不成立"
  console.log(`PROBE_LOAD_FAILED=${error instanceof Error ? error.message : String(error)}`)
  process.exit(3)
}

const changeSet = { items: [{ id: 'REQ-001', file: '', from: 'CR-003' }], sources: { changes: 1, defects: 0, workspaceFiles: 0 }, rawFileCount: 0 }
const cases = [{ case: 'TC-001', result: 'pass', artifact: hash, artifactPath: 'artifact.txt' }]
const one = (edges) => mod.assessRegression({ workspace: WS, changeSet, source: { cases }, edges })
const open = one([])
const closed = one([
  { from: 'REQ-001', to: 'TC-001', kind: 'req-tc' },
  { from: 'REQ-001', to: 'TC-002', kind: 'req-tc' },
])

const checks = {
  emptyGraphIsUndecidable: open.impact.derivable === false,
  undecidableIsSpoken: open.violations.some((issue) => issue.code === 'impact-underivable'),
  derivedCases: closed.impact.byPrefix.cases.join(','),
  missingNotRunCases: closed.missing.join(','),
}
console.log(`PROBE=${JSON.stringify(checks)}`)
const ok = checks.emptyGraphIsUndecidable === true
  && checks.undecidableIsSpoken === true
  && checks.derivedCases === 'TC-001,TC-002'
  && checks.missingNotRunCases === 'TC-002'
console.log(`PROBE_VERDICT=${ok ? 'green' : 'red'}`)
process.exit(ok ? 0 : 1)
