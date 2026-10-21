/**
 * **增量 207：A1（`TC-092` / `DEF-029`）—— 守卫夹具不许写进项目自己的台账。**
 *
 * 病根（真机 `DEF-029`）：守卫把夹具根定成项目自己的 `.sdo`，54 条 `TC-060` 的夹具结果写进了真台账；
 * 因为 `verificationStats` 取 latest-wins，这些夹具结果**盖住了真实结论**。修是修了，但**没有守卫**。
 *
 * 本文件钉**两条性质断言**（不是枚举断言 —— 枚举只守一处，换个变量名就漏）：
 *   ① **静态**：`test/**\/*.test.ts` 里，任何 store / journal 的根都不许解析到**仓库自己的 `.sdo`**；
 *   ② **动态**：在 `node_modules/.sdo-test/` 下真跑一次缺陷追溯判据（`C-58`），项目台账的三路读数
 *      （结果文件名清单 / `TC-060` 记录条数 / `.sdo/` 树指纹）必须**逐字不变**。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TEST_DIR = join(ROOT, 'test')
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm207')
const WORKSPACE = join(BASE, 'proj')
const REPO_SDO = join(ROOT, '.sdo')

let office: SoftwareDevOffice
const call = { sessionId: 's-m207', cwd: WORKSPACE } as unknown as OfficeCall

/** 递归列出目录下的文件（相对路径，排序稳定）。 */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

/** `.sdo/` 目录树指纹：`相对路径 + 内容 sha256` 有序拼接后再 sha256。 */
function treeFingerprint(dir: string): string {
  const lines = walk(dir).map((rel) => {
    const full = join(dir, rel)
    const info = lstatSync(full)
    // 符号链接**不跟随**（真台账的 evidence 树里有指向已删目录的 link：跟随会 ENOENT）
    const digest = info.isSymbolicLink()
      ? `link:${readlinkSync(full)}`
      : info.isFile()
        ? createHash('sha256').update(readFileSync(full)).digest('hex')
        : 'dir'
    return `${rel}:${digest}`
  })
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 项目台账的三路读数（断言"跑守卫前后逐字不变"用）。 */
function ledgerReadings(): { results: string[]; tc060: number; fingerprint: string } {
  const resultsDir = join(REPO_SDO, 'tests', 'results')
  const results = readdirSync(resultsDir).filter((name) => name.endsWith('.yml')).sort()
  const tc060 = results.filter((name) => readFileSync(join(resultsDir, name), 'utf8').includes('caseId: TC-060')).length
  return { results, tc060, fingerprint: treeFingerprint(REPO_SDO) }
}

/** 单行/多行的 `const NAME = <expr>` 定义（expr 到括号配平为止，容忍换行）。 */
function constDefinitions(text: string): Map<string, string> {
  const defs = new Map<string, string>()
  for (const match of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^\n]+)/gu)) {
    const name = match[1] ?? ''
    let expr = match[2] ?? ''
    // 多行表达式（`join(\n  ROOT,\n  …,\n)`）：按括号配平继续吃后续行
    let depth = (expr.match(/\(/gu) ?? []).length - (expr.match(/\)/gu) ?? []).length
    if (depth > 0) {
      const start = (match.index ?? 0) + match[0].length
      for (const line of text.slice(start).split('\n')) {
        expr += ` ${line}`
        depth += (line.match(/\(/gu) ?? []).length - (line.match(/\)/gu) ?? []).length
        if (depth <= 0) break
      }
    }
    defs.set(name, expr)
  }
  return defs
}

/** 逐层展开表达式里的常量引用（最多 5 层）—— 否则 `BASE = join(ROOT, '.sdo')` 这类间接形态会漏。 */
function flatten(expr: string, defs: Map<string, string>, depth = 0): string {
  if (depth > 5) return expr
  let next = expr
  for (const [name, value] of defs) {
    next = new RegExp(`\\b${name}\\b`, 'gu').test(next) && !next.includes(`const ${name}`)
      ? next.replace(new RegExp(`\\b${name}\\b`, 'gu'), `(${value})`)
      : next
  }
  return next === expr ? expr : flatten(next, defs, depth + 1)
}

/** 该表达式是不是"仓库根"（`test/` 下的用例用 `../../` 指到仓库根）。 */
function isRepoRoot(expr: string): boolean {
  return /new URL\('\.\.\/\.\.\/'|new URL\("\.\.\/\.\.\/"/u.test(expr)
}

/** 该表达式是不是"安全根"（夹具目录 / 系统临时目录）。 */
function isSafeRoot(expr: string): boolean {
  return /sdo-test/u.test(expr) || /tmpdir|mkdtempSync/u.test(expr)
}

/**
 * **静态性质断言 ①**：遍历全部用例文件，凡把 store / journal 的根落在**仓库自己的 `.sdo`** 上、
 * 且在该文件里**写**（`ensureLayout` / `writeYaml` / `writeText` / `append` …）的，一律判红并点名 `文件:行`。
 *
 * 为什么把"写"写进性质里：`DEF-029` 的病是**写进真台账**（54 条 `TC-060` 夹具结果 latest-wins 盖住真结论）。
 * 只读地拿本仓台账当夹具（`m38` 的"真机接线"探针）没有这个病 —— 那样判红会逼人把只读探针也改掉，
 * 是另一种"做对即红"。**写**这个动作是限定性的，不是给它开口子：任何写入项目台账的用例都算违规。
 */
function findLedgerLeaks(): string[] {
  const leaks: string[] = []
  for (const name of readdirSync(TEST_DIR).filter((item) => item.endsWith('.test.ts')).sort()) {
    const text = readFileSync(join(TEST_DIR, name), 'utf8')
    const defs = constDefinitions(text)
    const lines = text.split('\n')
    // 逐**变量**判写：`const live = new SdoStore(join(ROOT,'.sdo'))` 只读时不算违规，
    // 而同一个文件里别的夹具（如 `store`）在写不算它头上。
    for (const [index, line] of lines.entries()) {
      const match = /new (?:SdoStore|Journal)\(([^)]*)\)/u.exec(line)
      if (match === null) continue
      const arg = match[1] ?? ''
      if (!arg.includes("'.sdo'") && !arg.includes('".sdo"')) continue
      const ids = [...arg.matchAll(/[A-Za-z_$][\w$]*/gu)].map((item) => item[0])
      const flatArg = flatten(arg, defs)
      const repoRoot = isRepoRoot(flatArg) || ids.some((id) => isRepoRoot(flatten(defs.get(id) ?? '', defs)))
      const safe = isSafeRoot(flatArg) || ids.some((id) => isSafeRoot(flatten(defs.get(id) ?? '', defs)))
      if (!repoRoot || safe) continue
      const bound = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new (?:SdoStore|Journal)/u.exec(line)
        ?? /([A-Za-z_$][\w$]*)\s*=\s*new (?:SdoStore|Journal)/u.exec(line)
      const holder = bound?.[1]
      if (holder === undefined) continue
      const writes = new RegExp(`\\b${holder}\\s*\\.\\s*(?:ensureLayout|writeYaml|writeText|writeJson|append|appendMany)\\s*\\(`, 'u').test(text)
      if (writes) leaks.push(`${name}:${index + 1} ${line.trim()}`)
    }
  }
  return [...new Set(leaks)]
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-m207', WORKSPACE)
  office.init(call, { name: 'M207 夹具不写项目台账', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M207-01 静态（性质断言）：任何用例的 store/journal 根都不许落在仓库自己的 `.sdo` 下', () => {
  const leaks = findLedgerLeaks()
  assert.deepEqual(leaks, [], `这些用例把夹具根指向了项目台账（DEF-029 的形态）：\n${leaks.join('\n')}`)
})

test('M207-02 动态（性质断言）：真跑一次缺陷追溯判据，项目台账三路读数逐字不变', () => {
  const before = ledgerReadings()
  // 夹具：一条已基线 must 需求 + 一条**没有任何 req-defect 边**的缺陷 ⇒ C-58 会判红（真的跑起来，不是空跑）
  office.storeFor(WORKSPACE).writeYaml(['requirements', 'REQ-001.yml'], {
    requirement: {
      id: 'REQ-001', title: '夹具需求', statement: 's', priority: 'must', status: 'baselined',
      acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    },
  })
  office.storeFor(WORKSPACE).writeYaml(['defects', 'DEF-001.yml'], {
    defect: { id: 'DEF-001', title: '夹具缺陷', severity: 'major', status: 'open', foundAt: 'fixture', at: '' },
  })
  const criterion = office.evaluate(call, 'G5').criteria.find((item) => item.id === 'C-58')
  assert.ok(criterion !== undefined, '前置：G5 必须声明 C-58（trace.defect-links）')
  assert.equal(criterion.ok, false, '夹具里那条缺陷没有任何追溯边 ⇒ 判据必须真的红（否则这次"跑"是空转）')
  assert.match(criterion.detail, /DEF-001/u, '判据要点名那条缺陷（证明它真的读了夹具台账）')

  const after = ledgerReadings()
  assert.deepEqual(after.results, before.results, '结果文件名清单必须逐项相等（不许新增/删除一条）')
  assert.equal(after.tc060, before.tc060, '`TC-060` 的记录条数必须不变（DEF-029 就是它被写成 54 条）')
  assert.equal(after.fingerprint, before.fingerprint, '`.sdo/` 树指纹必须不变（内容级，不是长度级）')
})

test('M207-03 三路读数必须**有判别力**：往台账里写一条，三档读数都得变（否则"不变"是空断言）', () => {
  // 用**临时副本**做实验，不碰真台账：把 `.sdo` 的结构复制一份到夹具目录，验证读数对"写入"敏感。
  const scratch = join(BASE, 'scratch-ledger')
  mkdirSync(join(scratch, 'tests', 'results'), { recursive: true })
  writeFileSync(join(scratch, 'project.yml'), 'project: {id: PRJ-001}\n', 'utf8')
  writeFileSync(join(scratch, 'tests', 'results', 'TR-901.yml'), 'result: {id: TR-901, caseId: TC-001, status: pass}\n', 'utf8')
  const readings = (): { results: string[]; tc060: number; fingerprint: string } => {
    const resultsDir = join(scratch, 'tests', 'results')
    const results = readdirSync(resultsDir).filter((name) => name.endsWith('.yml')).sort()
    const tc060 = results.filter((name) => readFileSync(join(resultsDir, name), 'utf8').includes('caseId: TC-060')).length
    return { results, tc060, fingerprint: treeFingerprint(scratch) }
  }
  const before = readings()
  writeFileSync(join(scratch, 'tests', 'results', 'TR-902.yml'), 'result: {id: TR-902, caseId: TC-060, status: pass}\n', 'utf8')
  const after = readings()
  assert.notDeepEqual(after.results, before.results, '结果文件名清单必须能察觉"多了一条"')
  assert.notEqual(after.tc060, before.tc060, '`TC-060` 条数必须能察觉"夹具写进来了"（DEF-029 的形态）')
  assert.notEqual(after.fingerprint, before.fingerprint, '树指纹必须能察觉"内容变了"（不是只看长度）')
  // 反面：内容改一个字也必须被指纹抓到（长度不变的改写）
  writeFileSync(join(scratch, 'tests', 'results', 'TR-901.yml'), 'result: {id: TR-901, caseId: TC-001, status: FAIL}\n', 'utf8')
  assert.notEqual(readings().fingerprint, after.fingerprint, '同长度改写也必须变（指纹按内容算）')
})
