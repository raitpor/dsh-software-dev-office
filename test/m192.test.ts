/**
 * **增量 192：随包面无关性判据（`REQ-060` / `AC-241` 的机械化，第十二批 §3.4 `DEF-105` ①）。**
 *
 * `AC-241` 逐字要求：凡判定依据是「某种文件格式的**内部结构**」或「某个具体项目的**固定布局**」⇒
 * 必须改成「**项目声明 + 格式无关的通用比较**」，否则方案被否决；且必须**点名这处格式依赖**。
 *
 * 这条判据把"随包面里混进某个具体工具链"这件事变成**可判定**的：
 *   · **扫描面从项目声明来**（`package.json#files` 里解析出的**目录**、且不在 `lib/` 下 —— `lib/` 是编译产物）：
 *     换一份 `files` ⇒ 面跟着变（证明不是手抄的第二份清单）；
 *   · **token 表每条都带理由**（`TOOL_TOKENS`：`id` / `pattern` / `reason`）—— 理由要说明"为什么这是**具体工具链**、
 *     为什么它对别的项目不成立"。**表里没有任何一个具体项目的名字**（只有工具/生态名）；
 *   · 命中即红并点名 **`file:line` + token + 理由**；
 *   · **布局类引用不判**（`docs/…`、`src/…`、`.sdo/` 是**插件自己的产品契约** —— 它本来就负责渲染那些文档；
 *     把它也算违反 `REQ-060` 就是另一条需求了，见本批《豁免面清单》）。
 *
 * 判据自身与语言/项目无关：面从声明来、token 是"工具生态名"这一类，不读任何措辞、不看具体项目。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKERS } from '../src/domain/gates.js'
import { SdoStore } from '../src/infra/store.js'
import type { GateContext } from '../src/domain/gates.js'
import { afterEach, beforeEach, test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm192')

interface TokenRule {
  id: string
  pattern: RegExp
  /** **为什么这是"具体工具链"**（每条必填；缺/空 ⇒ 判据表自检红）。 */
  reason: string
}

/** **工具链 token 表**（只放"工具/生态名"，**不放任何项目名**；每条都带理由）。 */
export const TOOL_TOKENS: readonly TokenRule[] = [
  { id: 'node-pkg-manager', pattern: /\b(?:npm|npx|pnpm|yarn|bun)\b/u, reason: '包管理器是项目选择：别的生态没有 npm，别的项目也可能用别的管理器' },
  { id: 'ts-toolchain', pattern: /\btsc\b|tsconfig|node_modules|package-lock\.json/u, reason: 'TypeScript/Node 的工具链与目录，只对 JS/TS 项目成立' },
  { id: 'js-test-runner', pattern: /\b(?:jest|mocha|vitest|karma|jasmine)\b/u, reason: 'JS 测试运行器是项目选择，别的语言用别的东西' },
  { id: 'python-toolchain', pattern: /\b(?:pytest|tox|pip|poetry)\b|setup\.py|requirements\.txt/u, reason: 'Python 的工具链与清单文件' },
  { id: 'rust-toolchain', pattern: /\bcargo\b|Cargo\.toml/u, reason: 'Rust 的工具链与清单文件' },
  { id: 'go-toolchain', pattern: /\bgo (?:test|build|mod)\b|go\.mod/u, reason: 'Go 的工具链与模块文件' },
  { id: 'java-toolchain', pattern: /\b(?:mvn|gradle|ant)\b|pom\.xml/u, reason: 'Java/JVM 的构建工具与清单文件' },
  { id: 'posix-utils', pattern: /\b(?:sha256sum|md5sum|xargs|cmp)\b|diff -rq/u, reason: 'POSIX 命令行工具：非 POSIX 环境（如纯 Windows）没有这些命令' },
]

export interface FaceIssue { path: string; line: number; token: string; reason: string; text: string }

/** **扫描面**：`files` 里解析出的**目录**（且不在 `lib/` 下 —— 那是编译产物），稳定排序。 */
export function publishedFaces(files: readonly string[], root: string): string[] {
  const out: string[] = []
  for (const entry of files) {
    if (entry === 'lib' || entry.startsWith('lib/')) continue // 编译产物：不是"文本/数据面"
    let isDir = false
    try {
      isDir = statSync(join(root, entry)).isDirectory()
    } catch {
      isDir = false // 不存在 ⇒ 不是面
    }
    if (isDir) out.push(entry)
  }
  return [...new Set(out)].sort()
}

const TEXT_EXT = /\.(?:md|markdown|ya?ml|json|txt|tsv)$/u

function walkText(base: string, dir: string = base, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walkText(base, full, out)
    } else if (TEXT_EXT.test(entry.name)) out.push(relative(base, full))
  }
  return out.sort()
}

/** **判据本体**：扫发布面，命中工具链 token 即记一条（点名 `file:line` + token + 理由）。 */
export function scanPackagingFaces(root: string): FaceIssue[] {
  const files = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files?: string[] }).files ?? []
  const issues: FaceIssue[] = []
  for (const face of publishedFaces(files, root)) {
    for (const rel of walkText(join(root, face))) {
      const path = join(root, face, rel)
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((line, index) => {
        for (const rule of TOOL_TOKENS) {
          if (!rule.pattern.test(line)) continue
          issues.push({ path: `${face}/${rel}`, line: index + 1, token: rule.id, reason: rule.reason, text: line.trim().slice(0, 120) })
        }
      })
    }
  }
  return issues
}

beforeEach(() => { rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true }) })
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M192-01 §3.4（`DEF-105` ①）随包面无关性：现盘零命中 + 面由 `files` 推导 + token 表每条有理由', () => {
  // ① 面不是手抄的：换一份 `files` ⇒ 面跟着变
  const fixture = join(BASE, 'faces')
  mkdirSync(join(fixture, 'a-face'), { recursive: true })
  mkdirSync(join(fixture, 'b-face', 'sub'), { recursive: true })
  mkdirSync(join(fixture, 'lib', 'src'), { recursive: true })
  mkdirSync(join(fixture, 'src', 'data'), { recursive: true })
  writeFileSync(join(fixture, 'a-face', 'x.md'), 'x\n')
  writeFileSync(join(fixture, 'b-face', 'sub', 'y.md'), 'y\n')
  writeFileSync(join(fixture, 'src', 'data', 'z.yml'), 'z: 1\n')
  writeFileSync(join(fixture, 'client.js'), 'x\n')
  assert.deepEqual(
    publishedFaces(['a-face', 'b-face/sub', 'lib/src', 'src/data', 'client.js'], fixture),
    ['a-face', 'b-face/sub', 'src/data'],
    '面必须是 `files` 里的**目录**、且排除 `lib/`（编译产物）与单文件；声明到子目录就按子目录扫',
  )
  // ② token 表自检：每条有 id / pattern / **非空理由**（理由要说明"为什么它对别的项目不成立"）
  assert.ok(TOOL_TOKENS.length >= 5, '工具链 token 表不能只有一两条（要覆盖多个生态，才是"语言无关"的判据）')
  for (const rule of TOOL_TOKENS) {
    assert.ok(rule.id.length > 3, `token 规则缺 id：${JSON.stringify(rule)}`)
    assert.ok(rule.pattern instanceof RegExp, `${rule.id} 的 pattern 必须是正则`)
    assert.ok(rule.reason.length >= 12, `${rule.id} 必须给理由（"为什么这是具体工具链"）`)
  }
  // ③ 现盘发布面**零命中**（本仓的清理结果；命中就会被点名到 file:line）
  assert.deepEqual(scanPackagingFaces(ROOT), [], '随包面不许出现任何具体工具链（命中项见上一条断言的消息）')
})

test('M192-02 §3.4 判据行为：注入一个 `npm test` ⇒ 红并点名 `file:line + token + 理由`；布局类不判', () => {
  const root = join(BASE, 'proj')
  mkdirSync(join(root, 'skills'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ files: ['skills'] }))
  writeFileSync(join(root, 'skills', 'card.md'), '# 卡\n\n1. 先跑 `npm test` 再交付。\n')
  const issues = scanPackagingFaces(root)
  assert.equal(issues.length, 1, `注入一个工具链命令 ⇒ 恰好一条：${JSON.stringify(issues)}`)
  assert.equal(issues[0]?.path, 'skills/card.md', '必须点名文件')
  assert.equal(issues[0]?.line, 3, '必须点名行号')
  assert.equal(issues[0]?.token, 'node-pkg-manager', '必须点名 token 类别')
  assert.ok((issues[0]?.reason ?? '').length >= 12, '必须带出理由（不是只喊"违规"）')
  // 反例①：**布局类引用不判**（`docs/…` / `.sdo/` 是插件自己的产品契约）
  writeFileSync(join(root, 'skills', 'card.md'), '# 卡\n\n1. 真源在 `.sdo/`，人读文档在 `docs/DESIGN.md`。\n')
  assert.deepEqual(scanPackagingFaces(root), [], '布局类引用不属本判据（AC-241 的一条豁免面）')
  // 反例②：别的生态一样被抓（判据不是只防 Node）
  writeFileSync(join(root, 'skills', 'card.md'), '# 卡\n\n1. 先 `cargo test` 再交付。\n')
  assert.deepEqual(scanPackagingFaces(root).map((issue) => issue.token), ['rust-toolchain'], '换一种工具链同样被抓（覆盖多生态）')
})

test('M192-03 §3.4（`DEF-105` ③）未覆盖的 must 需求：项目声明后门禁**红并点名**；有 `req-tc` 边即绿；未声明即 N/A', () => {
  const linksText = (rows: readonly { from: string; to: string; kind: string }[]): string =>
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  /**
   * **真 store**（临时目录）而不是打桩：`traceBadLinesFailure` 会走到 `report()` → `store.path()`，
   * 打桩会把"坏行必须上报"那一格骗绿（`DEF-105` 的反面教材：凑出形状 ≠ 真形态）。
   */
  const ctxOf = (
    requirements: readonly { id: string; priority: string }[],
    linksTextValue?: string,
    declared = true,
  ): GateContext => {
    const root = join(BASE, `store-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(root, 'trace'), { recursive: true })
    if (declared) writeFileSync(join(root, 'config.yml'), 'trace:\n  mustCoverage: true\n')
    if (linksTextValue !== undefined) writeFileSync(join(root, 'trace', 'links.jsonl'), linksTextValue)
    return { requirements, store: new SdoStore(root) } as unknown as GateContext
  }
  // ① 未声明 ⇒ N/A（判据与项目无关；要不要把它当门禁是**项目选择**，`AC-241`）
  const undeclared = CHECKERS['coverage.uncovered']?.(ctxOf([{ id: 'REQ-060', priority: 'must' }], undefined, false))
  assert.equal(undeclared?.na, true, '未在 `.sdo/config.yml` 声明 ⇒ N/A（不是红，也不是绿）')
  assert.match(undeclared?.naReason ?? '', /mustCoverage/u, 'N/A 的理由必须点名项目声明的那个键')
  // ② 已声明 + 一条 must **没有任何 `req-tc` 边** ⇒ 红并点名（`REQ-060` 就是现盘的第一个实例）
  const red = CHECKERS['coverage.uncovered']?.(ctxOf([{ id: 'REQ-060', priority: 'must' }]))
  assert.ok(red !== undefined)
  assert.equal(red.ok, false, '未覆盖的 must 需求必须红')
  assert.match(red.detail, /REQ-060/u, '必须点名那条 must 需求')
  assert.ok((red.remedy ?? '').includes('req-tc'), '修法要给出唯一出路：补 req-tc 边')
  // ③ 补上 `req-tc` 边 ⇒ 绿
  const green = CHECKERS['coverage.uncovered']?.(ctxOf([{ id: 'REQ-060', priority: 'must' }], linksText([{ from: 'REQ-060', to: 'TC-001', kind: 'req-tc' }])))
  assert.equal(green?.ok, true, '有 req-tc 边即绿')
  // ④ 非 must 不计（should / could 不需要用例覆盖）
  assert.equal(CHECKERS['coverage.uncovered']?.(ctxOf([{ id: 'REQ-100', priority: 'should' }]))?.na, true, '没有 must ⇒ N/A（不是红）')
  // ⑤ 多条 must 时只点名**缺的那条**（已覆盖的不许被点名）
  const partial = CHECKERS['coverage.uncovered']?.(ctxOf(
    [{ id: 'REQ-060', priority: 'must' }, { id: 'REQ-061', priority: 'must' }],
    linksText([{ from: 'REQ-061', to: 'TC-002', kind: 'req-tc' }]),
  ))
  assert.match(partial?.detail ?? '', /REQ-060/u, '点名缺的那条')
  assert.equal(/REQ-061/u.test(partial?.detail ?? ''), false, '已覆盖的那条不许被点名')
  // ⑥ 追溯边文件里的**坏行**必须如实上报（否则"覆盖率"会被静默缩短）
  const broken = CHECKERS['coverage.uncovered']?.(ctxOf([{ id: 'REQ-060', priority: 'must' }], 'not json\n'))
  assert.equal(broken?.ok, false, '坏行必须红（不许静默缩短边集合）')
  // **区分"坏行"与"没边"**：坏行走的是**坏行修法**（不含 `req-tc`），而不是把坏行当"未覆盖"报出去
  assert.equal(
    (broken?.remedy ?? '').includes('req-tc'),
    false,
    '坏行必须走坏行修法（`kTraceBadLinesRemedy`），不许混成"补 req-tc 边"',
  )
  // ⑦ 流程数据与代码里都真实存在（`DEF-105` ③ 的 DoD ④）
  const waterfall = readFileSync(join(ROOT, 'src', 'data', 'processes', 'waterfall.yml'), 'utf8')
  assert.match(waterfall, /check: "coverage\.uncovered"/u, 'waterfall 的 G2 必须声明 coverage.uncovered 判据')
  assert.match(waterfall, /id: C-must-coverage/u, '判据 id 必须是 C-must-coverage')
})
