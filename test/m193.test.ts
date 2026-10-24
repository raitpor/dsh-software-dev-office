/**
 * **增量 193：L3 阶段纪律的**真机形态**（第十二批 §3.3 `DEF-104`）—— 绝对路径 + 项目声明的实现代码面。**
 *
 * 病根（V23 实测）：`discipline.ts` 用 `path.startsWith('src/')` 判"写实现代码"，而宿主传给 `write`/`edit`
 * 的 `file_path` 是**绝对路径** ⇒ 真机**恒 false**（纪律形同空转）。同族的第二处：实现代码面写死在代码里，
 * 项目不是 `src/` + `test/` 布局（`cmd/`、`internal/`）就永远拦不到 —— 这正是 `AC-241`（`REQ-060`）禁止的
 * "某个具体项目的固定布局"。
 *
 * 修法：① 路径先按工作区根归一（复用写范围纪律的 `normalizeWorkspacePath`）；② 实现代码面**项目可声明**
 * （`.sdo/config.yml` 的 `discipline.codePaths`，`src/`+`test/` 降为默认值）；③ **用默认值时回执必须明说**。
 *
 * 本文件的用例都是**真机形态的输入**（绝对路径 / 非 `src/` 布局），不是相对路径夹具。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { DEFAULT_CODE_PATHS, evaluateDiscipline } from '../src/domain/discipline.js'
import type { DisciplineInput } from '../src/domain/discipline.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WS = '/tmp/ws/proj'
const base = (over: Partial<DisciplineInput> = {}): DisciplineInput => ({
  gateLevel: 'strict', phase: 'requirements', role: 'developer', tool: 'write',
  paths: [], initialized: true, root: WS, ...over,
})

test('M193-01 §3.3（`DEF-104`）真机形态：**绝对路径** + 默认实现代码面 ⇒ 拦并点名，且回执明说"默认"', () => {
  // ① 绝对路径写 `src/` ⇒ 拦（修前恒 false）
  const abs = evaluateDiscipline(base({ paths: [`${WS}/src/a.ts`] }))
  assert.equal(abs.kind, 'deny', '绝对路径写实现代码必须被拦（真机形态）')
  assert.match(abs.reason, /src\/a\.ts/u, '点名必须是归一后的相对路径（读得懂）')
  assert.match(abs.reason, /默认/u, '用默认实现代码面时回执**必须明说**（不许静默 —— AC-241）')
  assert.match(abs.reason, /discipline\.codePaths/u, '必须给出改法（在项目配置里声明自己的布局）')
  // ② 绝对路径写 `test/` ⇒ 同样拦（默认面含 test/）
  assert.equal(evaluateDiscipline(base({ paths: [`${WS}/test/x.test.ts`] })).kind, 'deny', '默认面含 test/')
  // ③ 绝对路径写文档 ⇒ 放行
  assert.equal(evaluateDiscipline(base({ paths: [`${WS}/docs/a.md`] })).kind, 'allow', '文档不在实现代码面上')
  // ④ 前缀**不许越界命中**：`/tmp/ws/projx/src/a.ts` 不是 `/tmp/ws/proj` 下的路径
  assert.equal(evaluateDiscipline(base({ paths: ['/tmp/ws/projx/src/a.ts'] })).kind, 'allow', '工作区根前缀不许假命中')
  // ⑤ 反斜杠分隔（Windows 形态）归一后同样拦
  assert.equal(evaluateDiscipline(base({ paths: [`${WS}\\src\\a.ts`] })).kind, 'deny', '反斜杠路径必须归一后判定')
  // ⑥ `.sdo/journal.jsonl` 用绝对路径给也一样拦（真源只由 SDO 追加）
  const journal = evaluateDiscipline(base({ paths: [`${WS}/.sdo/journal.jsonl`] }))
  assert.equal(journal.kind, 'deny', '绝对路径的 journal 也必须拦')
  // ⑦ 相对路径的既有行为不许变（回归；**不给 root** 时按原样比）
  const noRoot: DisciplineInput = { gateLevel: 'strict', phase: 'requirements', role: 'developer', tool: 'write', paths: ['src/a.ts'], initialized: true }
  assert.equal(evaluateDiscipline(noRoot).kind, 'deny', '相对路径照旧拦')
  assert.equal(evaluateDiscipline({ ...noRoot, paths: ['docs/a.md'] }).kind, 'allow', '相对路径照旧放行')
  // ⑧ 阶段 / 等级 / 角色三道放行面（回归）
  assert.equal(evaluateDiscipline(base({ phase: 'construction', paths: [`${WS}/src/a.ts`] })).kind, 'allow', '开发阶段放行')
  assert.equal(evaluateDiscipline(base({ gateLevel: 'enforce', paths: [`${WS}/src/a.ts`] })).kind, 'allow', '非 strict 只观察不拦')
  assert.equal(evaluateDiscipline(base({ role: 'cockpit', paths: [`${WS}/src/a.ts`] })).kind, 'allow', '驾驶舱不拦')
})

test('M193-02 §3.3（`DEF-104`）**项目声明**实现代码面：非 `src/` 布局可拦；声明替换默认面；默认值只作兜底', () => {
  // ① 自定义布局 **声明后**必须被拦（`cmd/` 这种非 src/ 布局 —— 修前永远拦不到）
  const cmd = evaluateDiscipline(base({ codePaths: ['cmd/', 'internal/'], paths: [`${WS}/cmd/main.go`] }))
  assert.equal(cmd.kind, 'deny', '声明了 cmd/ ⇒ 写 cmd/ 必须被拦')
  assert.match(cmd.reason, /cmd\/main\.go/u, '点名归一后的路径')
  assert.equal(/默认/u.test(cmd.reason), false, '用了项目声明 ⇒ 不许说"默认"（回执要与实际一致）')
  // ② **声明替换默认面**：声明只有 cmd/ 时，`src/` 就不该再按"实现代码面"拦（由声明说了算）
  assert.equal(evaluateDiscipline(base({ codePaths: ['cmd/'], paths: [`${WS}/src/a.ts`] })).kind, 'allow', '声明替换默认面（项目自己说了算）')
  // ③ 默认值的形状是**导出常量**（可被引用/展示，不是散落的字面量）
  assert.deepEqual([...DEFAULT_CODE_PATHS], ['src/', 'test/'], '默认面是导出常量（`src/` + `test/`）')
  // ④ 声明为空数组 / 全空白 ⇒ 回落到默认面（并在回执里明说"默认"）
  const fallback = evaluateDiscipline(base({ codePaths: ['', '  '], paths: [`${WS}/src/a.ts`] }))
  assert.equal(fallback.kind, 'deny', '空声明回落到默认面')
  assert.match(fallback.reason, /默认/u, '回落到默认面时要明说')
})

test('M193-03 §3.3（`DEF-104`）接线与"死配置"回归：输入由唯一出口给 root + 项目声明；两个声明面必须真被读', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  // ① 调用面真的把 root 与项目声明传下去（标识符存在性，不读措辞）
  for (const needle of ['disciplineRoot', "readYaml<{ discipline?: { codePaths?: unknown } }>('config.yml')", 'codePaths: declaredCodePaths', 'root: disciplineRoot']) {
    assert.ok(index.includes(needle), `L3 纪律的调用面缺「${needle}」（DEF-104 的接线）`)
  }
  // ② 两个曾被判"死配置"的声明面**真的被读**，而且读出来的值**真的进了判定**（不是只被提到）
  assert.ok(index.includes('guardedTools: settings.disciplineTools'), '`disciplineTools` 必须进写范围纪律的判定')
  // **由 ADR-031 导致的预期口径变更（TASK-189）**：公共面按角色裁一次（office ⇒ `.sdo/`+`docs/`）——
  // 这条守卫的意图（配置必须真的被读、真的进判定）不变，只把锚点换成新形态。
  assert.ok(
    index.includes('office.publicWritePaths(attributed.role, settings.disciplineAllowPaths)'),
    'disciplineAllowPaths must enter the public allow face (narrowed per role)',
  )
  const writeScope = readFileSync(join(ROOT, 'src', 'domain', 'writeScope.ts'), 'utf8')
  assert.ok(writeScope.includes('guardedTools'), '`writeScope` 必须声明受管辖工具（`guardedTools`）')
  assert.ok(writeScope.includes('sharedPaths'), '`writeScope` 必须声明公共放行面（`sharedPaths`）')
})
