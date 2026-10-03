/**
 * 角色卡 ↔ 实现一致性守卫（用户诉求：卡片要与 0.1.2 的需求/设计阶段能力对齐）。
 *
 * 背景：8 张角色卡曾停在 0.1.2 之前——**几乎不提任何动作名**，于是模型拿到卡也不知道
 * 该调 `sdo_design action=confirm` 还是 `sdo_gate action=sign`。这一轮把卡片按实现重写后，
 * 用下面两个方向的断言把"卡片 ↔ 掩码 ↔ 代码"钉在一起，防止再次漂移：
 *
 *   ① **声称要做的**（`## 我实际要走的动作` 段）：提到的 `sdo_*` 必须在**本角色掩码**里；
 *      提到的 `action=x` 必须是该工具**真实存在**的动作。
 *   ② **声称做不到的**（`## 禁止事项` / `## 提示层与硬约束` 段的否定式提及）：
 *      被说成"不在我的工具面里 / 不可见"的工具，必须**真的**不在 allow 里。
 *
 * 另外校验卡片里引用的**判据 id / 产物名 / 门禁 id / 文档路径**都真实存在
 * （引用了不存在的判据会误导执行者）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { listRoleCards } from '../src/domain/roles.js'
import { ROLES } from '../src/domain/plan.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** `src/types.ts` 里的动作词表（键 = 工具名去掉 sdo_ 前缀）。 */
function actionVocabulary(): Record<string, string[]> {
  const types = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
  const table: Record<string, string[]> = {}
  for (const m of types.matchAll(/export const ([A-Z_]+)_ACTIONS = \[([\s\S]*?)\] as const/gu)) {
    table[(m[1] as string).toLowerCase()] = [...(m[2] as string).matchAll(/'([^']+)'/gu)].map((x) => x[1] as string)
  }
  return table
}

/** 按 `## ` 段落切分卡片（键 = 标题原文，可能带括号后缀）。 */
function sections(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let current = '(前言)'
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) current = line.slice(3).trim()
    out[current] = (out[current] ?? '') + line + '\n'
  }
  return out
}

/** 取某段落：标题按**前缀**匹配（标题里有"（给我什么才能开工）"这类后缀）。 */
function sectionOf(parsed: Record<string, string>, name: string): string | undefined {
  for (const [title, body] of Object.entries(parsed)) if (title.startsWith(name)) return body
  return undefined
}

const SECTIONS_REQUIRED = ['目标', '输入契约', '输出契约', '我实际要走的动作', '完成定义', '禁止事项', '提问 / 评审模板', '提示层与硬约束']
const cards = listRoleCards()
const VOCAB = actionVocabulary()
/** 工具 → 动作词表键（工具名去掉 sdo_ 前缀；无动作工具不在表里）。 */
const KEY_OF: Record<string, string | undefined> = {
  sdo_lang: 'lang', sdo_project: 'project', sdo_requirement: 'requirement', sdo_redteam: 'redteam',
  sdo_feasibility: 'feasibility', sdo_risk: 'risk', sdo_design: 'design', sdo_adr: 'adr', sdo_quality: 'quality',
  sdo_plan: 'plan', sdo_task: 'task', sdo_test: 'test', sdo_review: 'review', sdo_trace: 'trace',
  sdo_gate: 'gate', sdo_cost: 'cost', sdo_deliver: 'deliver',
}

test('M29-01 八张卡都具备七段结构（新增「我实际要走的动作」段）', () => {
  assert.equal(cards.length, 8)
  for (const card of cards) {
    const text = readFileSync(join(ROOT, 'skills', `role-${card.code}.md`), 'utf8')
    const parsed = sections(text)
    for (const section of SECTIONS_REQUIRED) {
      const chunk = sectionOf(parsed, section)
      assert.ok(chunk !== undefined, `role-${card.code}.md 缺段落「## ${section}」`)
      const body = (chunk ?? '').split('\n').slice(1).filter((line) => line.trim() !== '')
      assert.ok(body.length >= 1, `role-${card.code} 的「${section}」段是空的`)
    }
  }
})

test('M29-02 卡片声称要做的动作必须真实存在、且在角色掩码内（两个方向都要对）', () => {
  const problems: string[] = []
  for (const card of cards) {
    const text = readFileSync(join(ROOT, 'skills', `role-${card.code}.md`), 'utf8')
    const actions = sectionOf(sections(text), '我实际要走的动作') ?? ''
    // ① 工具必须在掩码里
    for (const m of actions.matchAll(/`(sdo_[a-z_]+)/gu)) {
      const tool = m[1] as string
      if (!card.allow.includes(tool)) problems.push(`role-${card.code}：动作段提到 ${tool}，但它不在掩码 allow 里`)
    }
    // ② action= 必须是该工具真实存在的动作
    for (const m of actions.matchAll(/`?(sdo_[a-z_]+)[^`\n]{0,40}?action=([a-z-]+)/gu)) {
      const tool = m[1] as string
      const act = m[2] as string
      const key = KEY_OF[tool]
      if (key === undefined) { problems.push(`role-${card.code}：${tool} 没有动作参数，却写了 action=${act}`); continue }
      const list = VOCAB[key] ?? []
      if (!list.includes(act)) problems.push(`role-${card.code}：${tool} 的 action=${act} 不存在（合法：${list.join('/')}）`)
    }
  }
  assert.deepEqual(problems, [], `卡片与实现不一致：\n${problems.join('\n')}`)
})

test('M29-03 卡片声称"做不到"的工具，必须真的不在掩码里（否定式提及也不能写错）', () => {
  const problems: string[] = []
  for (const card of cards) {
    const parsed = sections(readFileSync(join(ROOT, 'skills', `role-${card.code}.md`), 'utf8'))
    for (const section of ['禁止事项', '提示层与硬约束']) {
      for (const line of (sectionOf(parsed, section) ?? '').split('\n')) {
        if (!/不(在|可见)|没有|不可见/u.test(line)) continue
        for (const m of line.matchAll(/`(sdo_[a-z_]+)/gu)) {
          const tool = m[1] as string
          if (card.allow.includes(tool)) problems.push(`role-${card.code}：「${line.trim().slice(0, 40)}」把它说成不可用，但掩码里其实有 ${tool}`)
        }
      }
    }
  }
  assert.deepEqual(problems, [], `卡片的"做不到"说法与掩码不符：\n${problems.join('\n')}`)
})

test('M29-04 卡片引用的判据 id / 门禁 id / 产物名都必须真实存在', () => {
  const processes = readdirSync(join(ROOT, 'src', 'data', 'processes'))
    .map((file) => readFileSync(join(ROOT, 'src', 'data', 'processes', file), 'utf8'))
    .join('\n')
  const criteria = new Set([...processes.matchAll(/id: (C[0-9A-Za-z-]*)/gu)].map((m) => m[1] as string))
  const docs = new Set(['SRS.md', 'DESIGN.md', 'TESTPLAN.md', 'TESTREPORT.md', 'TRACE.md', 'DELIVERY.md', 'BOARD.md', 'SDD.md', 'DECISIONS.md', 'QUALITY.md', 'VISION.md', 'FEASIBILITY.md', 'PLAN.md', 'RISKS.md', 'BACKLOG.md'])
  const problems: string[] = []
  for (const card of cards) {
    const text = readFileSync(join(ROOT, 'skills', `role-${card.code}.md`), 'utf8')
    for (const m of text.matchAll(/\b(C[0-9A-Za-z]*-[A-Za-z0-9-]+)\b/gu)) {
      if (!criteria.has(m[1] as string)) problems.push(`role-${card.code}：引用了不存在的判据 ${m[1]}`)
    }
    for (const m of text.matchAll(/\bG([0-7])\b/gu)) if (!new Set(['0','1','2','3','4','5','6','7']).has(m[1] as string)) problems.push(`role-${card.code}：未知门禁 G${m[1]}`)
    for (const m of text.matchAll(/docs\/([A-Za-z0-9_.-]+\.md)/gu)) {
      const name = m[1] as string
      if (!docs.has(name) && !/^METHOD-/u.test(name)) problems.push(`role-${card.code}：引用了未知产物 docs/${name}`)
    }
  }
  assert.deepEqual(problems, [], `卡片引用了不存在的真源对象：\n${problems.join('\n')}`)
})

test('M29-05 角色集与卡片文件一一对应（不多不少）', () => {
  const files = readdirSync(join(ROOT, 'skills')).filter((f) => f.startsWith('role-')).map((f) => f.replace(/^role-/u, '').replace(/\.md$/u, '')).sort()
  assert.deepEqual(files, [...ROLES].sort(), 'skills/role-*.md 必须恰好对应八个角色')
})
