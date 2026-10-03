/**
 * **角色卡技能（B2）**的回归用例：把随包的 8 张角色卡注册为**一个索引型 skill**。
 *
 * 口径（用户选定 B2）：
 *   · 只注册**一条**目录项（8 张卡都注册会让每个会话的系统提示多 8 行常驻 token）；
 *   · 索引正文**现算**自 `src/data/roles.yml` + 随包卡片（不许第三份手抄）；
 *   · 宿主没有 skills 服务时**静默降级**，绝不让装配失败；
 *   · 派发出去的执行者必须**够得着**这个技能 —— 8 个角色的工具白名单里要有 `skill`，
 *     否则"注册成功但不可达"（这是本轮最容易漏的一步）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ROLES } from '../src/domain/plan.js'
import { listRoleCards, maskAllows, roleCardPath } from '../src/domain/roles.js'
import {
  ROLE_CARDS_SKILL_NAME,
  buildRoleCardsContent,
  buildRoleCardsSkill,
  readRoleCard,
  registerRoleCardsSkill,
} from '../src/domain/skills.js'
import type { SkillRegistrationLike, SkillsServiceLike } from '../src/domain/skills.js'
import { t } from '../src/domain/i18n.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

test('M27-01 索引技能的形状符合宿主契约（kebab 名 / 描述非空 / 目录资源 / 可按需调用）', () => {
  const skill = buildRoleCardsSkill()
  // 宿主校验：技能名必须是 kebab-case（dsh-skill 的 SKILL_NAME 正则）
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `技能名必须 kebab-case：${skill.name}`)
  assert.equal(skill.name, ROLE_CARDS_SKILL_NAME)
  assert.ok(skill.description.trim().length > 0, '描述不能为空（宿主会校验）')
  assert.equal(/\{p\d\}/u.test(skill.description), false, '描述不得漏出占位符')
  assert.ok((skill.whenToUse ?? '').trim().length > 0, 'whenToUse 要写给模型看的触发条件')
  assert.equal(skill.source, 'bundled', '随包交付的技能 source 用 bundled')
  assert.equal(skill.resourceBase?.kind, 'directory')
  assert.ok(existsSync(skill.resourceBase?.path ?? ''), `资源目录必须真的存在：${skill.resourceBase?.path}`)
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(skill.content.trim().length > 0, true, '正文不能为空')
})

test('M27-02 索引正文覆盖全部 8 张卡、且每条路径都读得到（现算，不手抄）', () => {
  const cards = listRoleCards()
  const content = buildRoleCardsContent()
  assert.equal(cards.length, 8, '前置：8 个角色')
  for (const card of cards) {
    assert.ok(content.includes(card.code), `索引缺角色 ${card.code}`)
    assert.ok(content.includes(card.name), `索引缺角色名 ${card.name}`)
    assert.ok(content.includes(card.rationale), `索引缺掩码理由（${card.code}）：${card.rationale}`)
    assert.ok(content.includes(roleCardPath(card.code)), `索引缺卡片路径 ${roleCardPath(card.code)}`)
    // 可达性：正文点到的卡片必须真的能读到正文（不是"指向空气"）
    const body = readRoleCard(card.code)
    assert.ok(body.includes(card.name), `${roleCardPath(card.code)} 正文应含角色名`)
    assert.ok(body.trim().length > 0, `${roleCardPath(card.code)} 不能是空文件`)
  }
  // 反向：索引不得多出角色（多一行目录/多一张卡都要被看见）
  for (const role of ROLES) assert.ok(cards.some((card) => card.code === role), `角色集缺 ${role}`)
  // 索引自带执行协议（与派发提示同源）：认领→写范围→带证据 done→卡住就 block
  for (const token of ['sdo_task action=claim', 'expectedRevision', 'sdo_task action=done', 'sdo_task action=block']) {
    assert.ok(content.includes(token), `索引缺执行协议要素：${token}`)
  }
})

test('M27-03 注册成功路径：把索引交给宿主服务，并返回可注销的 disposer', () => {
  const seen: SkillRegistrationLike[] = []
  let disposed = 0
  const fake: SkillsServiceLike = {
    register(skill: SkillRegistrationLike): () => void {
      seen.push(skill)
      return () => {
        disposed += 1
      }
    },
  }
  const outcome = registerRoleCardsSkill(fake)
  assert.equal(outcome.registered, true, `应注册成功：${outcome.reason}`)
  assert.equal(seen.length, 1, '只注册**一条**目录项（8 张卡都注册会撑大每个会话的系统提示）')
  assert.equal(seen[0]?.name, ROLE_CARDS_SKILL_NAME)
  assert.equal(seen[0]?.content, buildRoleCardsContent(), '注册的正文应与现算结果一致')
  assert.equal(typeof outcome.dispose, 'function')
  outcome.dispose?.()
  assert.equal(disposed, 1, 'disposer 必须真的注销（插件卸载时不留残影）')
})

test('M27-04 宿主没有 skills 服务（或形状不对）→ 静默降级，不抛错、不阻塞装配', () => {
  for (const absent of [undefined, null, {}, { register: 1 }, { register: 'x' }]) {
    let outcome: ReturnType<typeof registerRoleCardsSkill> | undefined
    assert.doesNotThrow(() => {
      outcome = registerRoleCardsSkill(absent)
    }, `服务缺失/形状不对时不得抛错：${JSON.stringify(absent)}`)
    assert.equal(outcome?.registered, false)
    assert.ok((outcome?.reason ?? '').trim().length > 0, '降级要给出人读原因（供日志/自诊断）')
    assert.equal(outcome?.dispose, undefined)
  }
  // 降级文案不得漏出占位符（回执/debug 日志直接打它）
  const reason = registerRoleCardsSkill(undefined).reason
  assert.equal(/\{p\d\}/u.test(reason), false, `降级原因不得含占位符：${reason}`)
  // 服务侧校验（validateRuntimeSkill）抛错时同样不得冒泡进装配 —— "不阻塞装配"是承诺
  const hostile = {
    register(): () => void {
      throw new Error('skill name rejected by host')
    },
  }
  let hostileOutcome: ReturnType<typeof registerRoleCardsSkill> | undefined
  assert.doesNotThrow(() => {
    hostileOutcome = registerRoleCardsSkill(hostile)
  }, '服务抛错时不得冒泡')
  assert.equal(hostileOutcome?.registered, false)
  assert.match(hostileOutcome?.reason ?? '', /rejected by host/u, '降级原因要带上宿主给的原因，便于自诊断')
})

test('M27-05 可达性（必要条件一）：8 个角色的工具白名单里都必须有 `skill`，且不在 deny 里', () => {
  for (const role of ROLES) {
    assert.equal(maskAllows(role, 'skill'), true, `${role} 的掩码必须允许 skill 工具（角色卡按需加载的入口）`)
  }
  // `skill` 是只读工具：不得被任何角色的 deny 挡住（deny 优先于 allow）
  for (const card of listRoleCards()) {
    assert.equal(card.deny.includes('skill'), false, `${card.code} 不应把 skill 放进 deny`)
  }
})

test('M27-08 可达性（必要条件二，评审 blocker）：preset 必须挂载 `tool-skill`，否则注册成功但无人可见', () => {
  // 宿主层（dsh-web-app/cordis.patch.yml）**有意**把 `tool-skill` / `skill-filesystem` 关掉：
  // "tool-skill is what a preset mounts to give its agent the catalog and loader at all"。
  // 因此只在本插件的 preset 行里注册技能是不够的 —— 这一行才是"执行者够得着"的前提。
  const preset = readFileSync(join(ROOT, 'presets', 'sdo-office.patch.yml'), 'utf8')
  const lines = preset.split('\n')
  const presetRow = lines.findIndex((line) => line.includes('id: preset-sdo-office'))
  assert.ok(presetRow > 0, '前置：preset 文件里应有 preset-sdo-office 行')
  const skillRow = lines.findIndex((line) => line.trim() === "- id: tool-skill")
  assert.ok(skillRow > presetRow, '`tool-skill` 必须挂在 preset-sdo-office 之内（preset 层），不是 profile/宿主层')
  assert.equal(
    lines.slice(skillRow, skillRow + 2).some((line) => line.includes("name: '@deepseek-ai/dsh-tool-skill'")),
    true,
    'tool-skill 行的包名必须是 @deepseek-ai/dsh-tool-skill',
  )
  // 缩进即层位：该行必须比 `plugins:` 更深，确保它落在本 preset 的 config.plugins 里
  const pluginsLine = lines.findIndex((line) => line.trim() === 'plugins:')
  const indent = (line: string): number => line.length - line.trimStart().length
  assert.ok(pluginsLine > 0 && indent(lines[skillRow] ?? '') > indent(lines[pluginsLine] ?? ''), 'tool-skill 必须缩进在 plugins: 之下')
  // 反向：不得挂 `skill-filesystem`（那会把 skills/ 下 8 张卡各变成一个目录项，违背"只占 1 行"）
  assert.equal(/id: skill-filesystem/u.test(preset), false, '不要挂 skill-filesystem：SDO 走程序化注册，文件发现会撑大目录')
})

test('M27-06 README 必须写明这个技能（用法可见，避免"实现了但没人知道"）', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes(ROLE_CARDS_SKILL_NAME), `README 要提到技能名 ${ROLE_CARDS_SKILL_NAME}`)
  assert.ok(readme.includes('skills/role-'), 'README 要说明卡片位置')
})

test('M27-09 注册的 disposer 必须由本插件的 fiber 持有（评审 minor 1：register 的 effect 归服务 ctx）', () => {
  // `skills.register()` 返回的 disposer 由**技能服务自己的 ctx** 拥有（`this.layers.effect(this.ctx, …)`），
  // 因此把 `apply` / `inject` 回调的返回值当 disposer 很可能不被回收 —— 后果是插件热重载后目录里
  // 留旧正文（同层同名"首个胜出 + 告警"）。这里的结构守卫钉住"显式挂到 skillsCtx.effect"。
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const start = source.indexOf("ctx.inject(['skills']")
  assert.ok(start > 0, 'index.ts 里应有 skills 的 inject 接线')
  const block = source.slice(start, source.indexOf('\n  })', start))
  assert.ok(block.includes('skillsCtx.effect('), `必须用 skillsCtx.effect 持有 disposer：\n${block}`)
  assert.ok(block.includes("'sdo:role-cards-skill'"), 'effect 要有可诊断的标签')
  assert.ok(block.includes('outcome.dispose'), 'effect 体里要返回 register 给出的 disposer')
})

test('M27-07 描述取自语言包（中英都有），而不是硬编码中文', () => {
  const skill = buildRoleCardsSkill()
  assert.equal(skill.description, t('uiSkills.roleCardsDescription'))
  assert.equal(skill.whenToUse, t('uiSkills.roleCardsWhenToUse'))
  // 默认语言是 zh-CN：描述应是那句中文；且不得等于键名本身（键名=语言包缺键的典型症状）
  assert.notEqual(skill.description, 'uiSkills.roleCardsDescription')
})
