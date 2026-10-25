/**
 * **增量 152：给评审者的只读窄哈希入口（DEF-017，§3E 族 3，minor）**。
 *
 * 缺陷原文（三份 re-verify 的现盘读数）：评审者的掩码 `deny` 逐字含 `bash`，而**唯一**产出产物 sha256 的
 * `sdo_test` 也在 deny 里 ⇒ 评审者拿不到任何**完整**哈希，只能看 done 回执里的**截断**指纹
 * （`e1cb2250387e…4053`）⇒「我核的是不是这份产物」无法自证。
 *
 * **先钉红**（修前现盘读数，可复算）：`src/data/roles.yml` 的 reviewer `allow` 只有
 * `[skill, read, grep, glob, sdo_review, sdo_task, sdo_trace]`（`sdo_*` 3 条，schema 里哈希类参数各 **0**）、
 * `deny: [write, edit, bash, ask_user_question, sdo_test]`；已注册 `sdo_*` 工具里**没有任何**哈希入口。
 *
 * **修法（关键词：不是开 `bash`）**：新增只读窄入口 `sdo_hash` —— 入参**只有** `path`，
 * 出参 = 现算**完整 64 位 sha256** + mtime + 字节数；**只读纯查询**（不写台账、不落事件）；
 * 越界/不存在/不是文件 ⇒ 可读拒绝；现算复用 `evidence.ts` 的 `sha256Of`。
 * 掩码面只把 `sdo_hash` 加进 **reviewer** 的 allow，**`deny` 一个字不动**（`bash` 仍被挡）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { createOfficeTools } from '../src/interface/tools.js'
import { digestArtifact } from '../src/domain/evidence.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m152/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')
const ARTIFACT = 'build/out.txt'

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

const tool = (): ToolDefinition | undefined =>
  (createOfficeTools({} as never) as unknown as ToolDefinition[]).find((item) => item.name === 'sdo_hash')

/** 以"评审者会话"的形态调用工具面（execute 只读，不碰 deps） */
async function callHash(path: string): Promise<string> {
  const def = tool()
  assert.ok(def !== undefined, '工具面必须有 sdo_hash（否则评审者没有只读哈希入口）')
  const agentStub = { id: 'rev-1', session: { header: { id: 'rev-1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await def.execute({ path }, { agent: agentStub }))
}

const truthOf = (relative: string): string => createHash('sha256').update(readFileSync(join(WORKSPACE, relative))).digest('hex')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'build'), { recursive: true })
  writeFileSync(join(WORKSPACE, ARTIFACT), 'artifact body for m152\n')
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M152-01 评审者能拿到**完整 64 位**（与独立现算逐字相等）—— 修前只能看截断指纹', async () => {
  const receipt = await callHash(ARTIFACT)
  const truth = truthOf(ARTIFACT)
  assert.ok(receipt.includes(truth), `回执必须含完整 64 位现算值：${receipt.slice(0, 240)}`)
  assert.match(receipt, /[0-9a-f]{64}/u, '必须出现完整的 64 位十六进制')
  assert.match(receipt, /bytes|字节/u, '顺带回显字节数（可核对产物大小）')
  // 反例：截断形态（前 12 位 + 省略号）不得是它给出的唯一信息
  assert.doesNotMatch(receipt, /[0-9a-f]{12}…/u, '不得只给截断指纹')
})

test('M152-02 只读性：纯查询，不写台账、不落事件（域层返回体里只有一个成功形态）', () => {
  const outcome = digestArtifact(WORKSPACE, ARTIFACT)
  assert.equal(outcome.ok, true)
  assert.deepEqual(Object.keys(outcome).sort(), ['bytes', 'mtime', 'ok', 'path', 'sha256'], '成功形态只回这四个读数（没有任何"已记录/已写入"字段）')
  assert.equal(outcome.ok ? outcome.path : '', ARTIFACT, '回显调用方给的相对路径')
  assert.equal(outcome.ok ? outcome.sha256 : '', truthOf(ARTIFACT), '与独立现算相等')
})

test('M152-03 边界可读拒绝：越出工作区 / 不存在 / 不是文件 / 没给路径 各一个原因码', async () => {
  // ⚠️ 断言必须落在**原因码本身**上（MUT-31 存活教的一课，与 tq_a3e6effc 同源）：拒绝文案里
  // 会把**全部**原因码列一遍，所以 `/outside/` 这种"提到某个词"的断言抓不住走错分支。
  const codeOf = (path: string): string => {
    const outcome = digestArtifact(WORKSPACE, path)
    return outcome.ok ? 'ok' : outcome.code
  }
  assert.equal(codeOf('../outside.txt'), 'outside', '越出工作区 ⇒ 原因码必须是 outside（不是 missing）')
  assert.equal(codeOf('build/nope.txt'), 'missing', '不存在 ⇒ missing')
  mkdirSync(join(WORKSPACE, 'build', 'adir'), { recursive: true })
  assert.equal(codeOf('build/adir'), 'not-file', '目录不是文件 ⇒ not-file')
  assert.equal(codeOf(''), 'no-path', '没给路径 ⇒ no-path')
  assert.equal(digestArtifact('', ARTIFACT).ok, false, '没有工作区 ⇒ no-workspace（fail-closed，不猜路径）')
  // 工具面：原因码要出现在回执的**判定位**里（`被拒（<code>）`），而不是混在原因码清单里
  assert.match(await callHash('../outside.txt'), /被拒（outside）/u, '回执的判定位必须打出真正的原因码')
  assert.match(await callHash('build/nope.txt'), /被拒（missing）/u, '不存在同样要打在判定位上')
})

test('M152-04 DoD ③：**allow/deny 面仍然最小** —— 只多一个 sdo_hash，deny 一个字没动', () => {
  const roles = readFileSync(join(ROOT, 'src', 'data', 'roles.yml'), 'utf8')
  const block = roles.slice(roles.indexOf('- code: reviewer'))
  const allow = /allow: \[([^\]]*)\]/u.exec(block)?.[1] ?? ''
  const deny = /deny: \[([^\]]*)\]/u.exec(block)?.[1] ?? ''
  const allowed = allow.split(',').map((item) => item.trim()).filter((item) => item !== '')
  const denied = deny.split(',').map((item) => item.trim()).filter((item) => item !== '')
  assert.deepEqual(
    allowed,
    ['skill', 'read', 'grep', 'glob', 'sdo_review', 'sdo_task', 'sdo_trace', 'sdo_hash'],
    '评审者的 allow 必须**恰好**是原有 7 项 + sdo_hash（多一项就是面被放宽了）',
  )
  assert.equal(denied.includes('bash'), true, '`bash` 必须仍在 deny 里（本条的修法不是开 bash）')
  assert.equal(denied.includes('sdo_test'), true, '`sdo_test` 仍留在 deny 里（窄入口不等于放开它）')
  assert.equal(denied.includes('write'), true, '只读评审：write 仍被挡')
})

test('M152-05 工具 schema 的参数面被钉死（防"顺手开成通用文件读取器"）', () => {
  const def = tool()
  assert.ok(def !== undefined)
  const parameters = def.parameters as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  const names = Object.keys(parameters.properties ?? {})
  /**
   * **`TASK-219` 收窄了这条钉子的形状，但**没有减弱否定面**。
   *
   * 旧形状：参数集合**恰好**是 `['path']`。而 `TASK-219` 的 DoD 明确要求 `sdo_hash` 支持**多路径**
   * （`paths`）与**关键标识在位探测**（`markers`）⇒ 旧形状的前提被改变了（与 `M168-01` 同型）。
   * 真正要防的是**"`sdo_hash` 变成通用文件读取器"**，所以现在钉的是：
   *   ① 参数集合**只能**落在这三个只读探针里（多一个都不行）；
   *   ② **不得**出现任何"通用读取器"形状的参数（编码/偏移/行数/正则…）—— 这一半一条都没放松。
   */
  const allowed = ['path', 'paths', 'markers']
  for (const name of names) {
    assert.equal(allowed.includes(name), true, `sdo_hash 只能有只读探针参数 ${allowed.join(' / ')}，实际多出：${name}`)
  }
  assert.equal(names.includes('path'), true, 'path 必须仍在（单路径旧回执的入口）')
  const forbidden = ['encoding', 'offset', 'limit', 'lines', 'grep', 'pattern', 'content', 'tail', 'head', 'exec']
  for (const bad of forbidden) {
    assert.equal(names.includes(bad), false, `不许把 sdo_hash 开成通用文件读取器：多出了 ${bad}`)
  }
  assert.equal(parameters.properties?.['path']?.type, 'string', 'path 是字符串')
  // `defineTool` 会把作者侧 DSL 编译成 JSON schema：`required: true` 落到**顶层数组**上。
  // 多路径化之后 `path` 不再是必填（给 `paths` 就够），但**必填集合仍不得超出** `['path']`。
  const required = parameters.required ?? []
  for (const name of required) assert.equal(name === 'path', true, `必填集合只允许 path，实际：${required.join(' / ')}`)
})

test('M152-06 只读入口不产生任何 DSH 工具面白名单外的东西：注册面只多这一个工具', () => {
  const names = (createOfficeTools({} as never) as unknown as ToolDefinition[]).map((item) => item.name)
  assert.equal(names.includes('sdo_hash'), true)
  assert.equal(names.filter((name) => name === 'sdo_hash').length, 1, '不得重复注册')
  const toolsSource = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.match(toolsSource, /digestArtifact/u, '工具实现必须走域层的现算出口（不新造第二个哈希实现）')
})
