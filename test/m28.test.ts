/**
 * preset 行覆盖守卫（复审 2026-10-02 22:48 的 §2 审计结论）。
 *
 * 根因（一条通用规则，本轮才被显式命名）：**宿主层有一批行被 `dsh-web-app/cordis.patch.yml`
 * 有意 `disabled: true`，必须由 preset 自己挂载**。宿主 patch 里这样的行有 24 条，
 * SDO 的 preset 一旦漏挂，症状是"该能力在该会话里根本不存在"，而插件自己的文案
 * （回执 / README / roles.yml 的 allow）却假定它存在 —— 死允许项、承诺落空。
 *
 * 本文件把这类缺口钉成两个方向的机械断言：
 *   ① 集合方向：`preset 挂载的行 ⊇ 宿主关闭且我们需要它` 的集合；
 *   ② 功能方向：`roles.yml` 里每个**非本插件**的工具名，都要有一个**已挂载**的提供行。
 *
 * 依据与复跑方式（三层，全部可复跑；dsh 安装路径按 `$DSH_HOME` 自行替换）：
 *   1. 宿主关闭清单：`<dsh>/node_modules/.pnpm/@deepseek-ai+dsh-web-app@<ver>/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml`
 *      （`grep -n 'disabled: true'` → 24 行；其中 `tool-fs-search` 在 472、`tool-subagent-control` 在 525）；
 *   2. 官方对照：同目录 `presets/standard.patch.yml` 与 `presets/ptc.patch.yml` 都挂这些行；
 *   3. 解析实测（关键：基准是 loader 自身，不是本包）：
 *      `createRequire('<dsh>/node_modules/.pnpm/@deepseek-ai+cordis-plugin-loader@<ver>/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js')`
 *      逐个 `resolve(name)`；本文件涉及的行全部 ✓，反证 `@deepseek-ai/dsh-tool-nonexistent` ✗。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { listRoleCards } from '../src/domain/roles.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const presetPath = join(ROOT, 'presets', 'sdo-office.patch.yml')
const presetText = (): string => readFileSync(presetPath, 'utf8')

/** preset 里出现的行 id（`- id: xxx`）。 */
function presetRowIds(text: string = presetText()): string[] {
  return [...text.matchAll(/^\s*- id:\s*([^\s]+)\s*$/gmu)].map((match) => match[1] as string)
}

/** preset 里某个 id 所在行的缩进（用于判层位）。 */
function indentOf(text: string, id: string): number | undefined {
  const line = text.split('\n').find((candidate) => candidate.trim() === `- id: ${id}`)
  return line === undefined ? undefined : line.length - line.trimStart().length
}

/**
 * **宿主层被有意关闭、因此必须由本 preset 补挂**的行。
 *
 * 每项都写明"为什么需要它"（SDO 的哪句话/哪个角色的 allow 依赖它），
 * 这样删行的人会先看到代价。
 */
const HOST_DISABLED_ROWS_REQUIRED: { id: string; name: string; why: string }[] = [
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', why: 'read / write / edit / read_image：所有角色的基本读写' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', why: 'glob / grep：八个角色的 allow 里都有（此前是死允许项）' },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', why: 'bash：developer / tester 等角色的执行能力' },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', why: 'ask_user_question：审讯/评审的提问通道' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill', why: 'skill：角色卡技能（sdo-role-cards）的目录与加载器' },
  { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', why: 'subagent：派发执行者（orchestrator: subagent）' },
  { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control', why: 'send_message / interrupt_agent：`k105` 与 README 都让流程官用 send_message 转交提示词' },
  { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents', why: 'list_agents：流程官观察已派发的子代理（与 standard preset 同源）' },
  { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', why: '上下文压缩：不装会让长会话撞上上下文上限' },
  { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact', why: '手动压缩命令' },
  { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', why: '工具结果剪枝' },
]

/**
 * `roles.yml` 的 allow 里出现的**非本插件**工具名 → 提供它的 preset 行。
 *
 * 本插件的工具（`sdo_*`）由自己注册，不在此表；表里每一项都必须有行，
 * 否则那个 allow 项在该会话里就是**死允许项**（角色以为能调，实际看不到）。
 */
const TOOL_PROVIDER: Record<string, string> = {
  read: 'tool-fs',
  write: 'tool-fs',
  edit: 'tool-fs',
  glob: 'tool-fs-search',
  grep: 'tool-fs-search',
  bash: 'tool-bash',
  skill: 'tool-skill',
  ask_user_question: 'tool-ask-user',
}
// 表里**只登记真的被角色用到的工具名**（M28-05 会强制这一点）。以下四个**有意不登记**：
//   `send_message` / `interrupt_agent` / `list_agents` / `subagent` / `read_image`
//   —— 被派发的角色没有它们，也不该有：卡片角色由设计元素类型映射（`plan.ts` 的
//   `VIEW_KIND_OF_ELEMENT`，兜底 `developer`），`office` 从不被派发；"派发 / 转交 / 观察子代理"
//   是**驾驶舱会话**的能力（主会话工具面里确实有它们，那几行被挂载由 M28-01 守住）。
// 复审（2026-10-02 23:24 §3）发现的类问题：表里登记了角色用不到的名字 ⇒ 断言循环永远碰不到它们
// ——"守卫表声称守住了、实际没守"。M28-05 就是为这个类立的规矩。

test('M28-01 preset 必须补挂"宿主有意关闭"的通用行（集合断言，含层位与包名）', () => {
  const text = presetText()
  const ids = presetRowIds(text)
  assert.equal(new Set(ids).size, ids.length, `preset 行 id 不得重复：${ids.join(', ')}`)
  const missing = HOST_DISABLED_ROWS_REQUIRED.filter((row) => !ids.includes(row.id))
  assert.deepEqual(
    missing.map((row) => row.id),
    [],
    `preset 漏挂宿主关闭的行（这些能力在该会话里会不存在）：${missing.map((row) => `${row.id}（${row.why}）`).join('；')}`,
  )
  const presetStart = text.split('\n').findIndex((line) => line.includes('id: preset-sdo-office'))
  const pluginsIndent = indentOf(text, ids[0] as string) ?? 0
  for (const row of HOST_DISABLED_ROWS_REQUIRED) {
    const line = text.split('\n').findIndex((candidate) => candidate.trim() === `- id: ${row.id}`)
    assert.ok(line > presetStart, `${row.id} 必须在 preset-sdo-office 之内（preset 层），不能落在宿主/profile 层`)
    assert.ok(
      (indentOf(text, row.id) ?? 0) >= pluginsIndent,
      `${row.id} 必须缩进在 config.plugins 之下（当前缩进低于同级行）`,
    )
    assert.ok(text.includes(`name: '${row.name}'`), `${row.id} 的包名必须是 ${row.name}`)
  }
})

test('M28-02 roles.yml 的每个非本插件工具名都要有"已挂载"的提供行（杀死允许项）', () => {
  const mounted = presetRowIds()
  const names = new Set<string>()
  for (const card of listRoleCards()) for (const tool of card.allow) names.add(tool)
  const foreign = [...names].filter((name) => !name.startsWith('sdo_')).sort()
  assert.ok(foreign.length >= 8, `前置：roles.yml 里应有一批宿主工具名（实际 ${foreign.length}）`)
  const problems: string[] = []
  for (const tool of foreign) {
    const provider = TOOL_PROVIDER[tool]
    if (provider === undefined) problems.push(`${tool}（没有登记提供者：新增角色工具时必须同时更新本文件的 TOOL_PROVIDER）`)
    else if (!mounted.includes(provider)) problems.push(`${tool} → ${provider}（该行未挂载）`)
  }
  assert.deepEqual(problems, [], `roles.yml 里的工具名在该会话里拿不到：${problems.join('；')}`)
})

/**
 * **行块级**提取：从 `- id: X` 起，取缩进更深的所有行。
 *
 * 为什么需要它：本轮的真实事故是"照抄了官方 preset 的 id/name 两行、**漏掉下面的 `config` 块**"，
 * 而此前的守卫全是正则逐行匹配 —— 行在、名字在，就通过了，config 缺失完全看不见。
 * 断言必须落在**整块**上，才能真正覆盖"这一行能不能挂起来"。
 */
function rowBlock(id: string, text: string = presetText()): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === `- id: ${id}`)
  if (start < 0) return ''
  const indent = (lines[start] as string).length - (lines[start] as string).trimStart().length
  const block: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim() === '') continue
    const current = line.length - line.trimStart().length
    if (current <= indent) break
    block.push(line.trim())
  }
  return [lines[start] as string, ...block].join('\n')
}

test('M28-04 必填 config 不得漏（本轮的真实事故：照抄 id/name 却漏了 config 块）', () => {
  // 实测报错原文（用户贴回）：`tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config:
  //   - $sampleOverCapGlobResult missing required value (at sampleOverCapGlobResult)`
  // ⇒ 该行挂载失败 ⇒ **整个 preset 注册失败**（会话里选不到 sdo-office）。
  const fsSearch = rowBlock('tool-fs-search')
  assert.ok(fsSearch.includes('config:'), `tool-fs-search 必须带 config 块（必填字段无默认值）：\n${fsSearch}`)
  assert.ok(
    /sampleOverCapGlobResults:\s*false/u.test(fsSearch),
    `tool-fs-search 的 config 必须给 sampleOverCapGlobResults: false（与官方 standard/ptc/cordis 三个 preset 一致）：\n${fsSearch}`,
  )
  // 另一个真正**必填**的字段（`provider: z.string().required()`）：它是既有行，但同样属于"漏了就挂不起来"。
  const subagent = rowBlock('tool-subagent')
  assert.ok(/provider:\s*\S+/u.test(subagent), `tool-subagent 必须给 provider（schema 里是 required）：\n${subagent}`)
  // 反向：这几行**不需要** config（官方也裸挂；schema 字段要么没有、要么全带默认值）。
  for (const id of ['tool-skill', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-fs', 'tool-bash', 'tool-ask-user']) {
    const block = rowBlock(id)
    assert.ok(block.length > 0, `前置：${id} 行应存在`)
    assert.equal(/^\s*config:/mu.test(block), false, `${id} 不需要 config（给多余配置会掩盖 schema 变更）`)
  }
})

test('M28-05 TOOL_PROVIDER 不得有惰性条目（表里每个工具名都必须真的被某个角色用到）', () => {
  // 复审发现的类问题：表里登记了 `send_message`/`list_agents`，但 roles.yml 里**没有任何角色**
  // 的 allow 含它们 ⇒ M28-02 的循环永远碰不到这两条 —— "守卫表声称守住了，实际没守"。
  // 规矩：TOOL_PROVIDER 的键集必须 ⊆ roles.yml 出现的工具名集合（不多不少，多了就是惰性条目）。
  const used = new Set<string>()
  for (const card of listRoleCards()) for (const tool of card.allow) used.add(tool)
  const dead = Object.keys(TOOL_PROVIDER).filter((tool) => !used.has(tool))
  assert.deepEqual(
    dead,
    [],
    `TOOL_PROVIDER 里有不会被断言用到的条目（要么加进某个角色的 allow 并接受 M28-02 的约束，要么删掉）：${dead.join(', ')}`,
  )
})

test('M28-03 反向：宿主关闭清单之外的行不必重复挂，且不许把文件发现挂上（目录会膨胀）', () => {
  const text = presetText()
  // 我们**有意不挂**的行：`skill-filesystem` 会把随包 skills/ 下每张卡变成一个目录项。
  assert.equal(/id: skill-filesystem/u.test(text), false, '不得挂 skill-filesystem（SDO 是程序化注册，文件发现会让目录膨胀）')
  // `skill-badge`（随包徽章技能）与 SDO 无关，同样不挂。
  assert.equal(/id: skill-badge/u.test(text), false, '不得挂 skill-badge（与 SDO 无关）')
  // 我们挂的行必须都能在本表或已知清单里说清用途 —— 防止"顺手加行"。
  const explained = new Set([
    ...HOST_DISABLED_ROWS_REQUIRED.map((row) => row.id),
    'preset-sdo-office',
    'sdo',
    'persona',
    'compaction',
    'delegation',
  ])
  const unexplained = presetRowIds(text).filter((id) => !explained.has(id))
  assert.deepEqual(unexplained, [], `preset 里有未说明用途的行：${unexplained.join(', ')}（加行前先想清为什么，并登记到本文件）`)
})
