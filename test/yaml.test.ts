import assert from 'node:assert/strict'
import { test } from 'node:test'

import { YamlSubsetError, parseYaml, stringifyYaml } from '../src/infra/yaml.js'

test('解析：注释、嵌套映射、序列、序列项内联映射', () => {
  const text = [
    '# 项目台账',
    'id: PRJ-001',
    'name: 示例项目',
    'phase: requirements   # 当前阶段',
    'scope:',
    '  in:',
    '    - 需求审讯',
    '    - 架构设计',
    '  out: []',
    'requirements:',
    '  - id: REQ-001',
    '    title: 用户可创建项目',
    '    priority: must',
    '    acceptance:',
    '      - 空名称被拒',
    '  - id: REQ-002',
    '    title: 支持导出',
    '    priority: should',
    '',
  ].join('\n')
  assert.deepEqual(parseYaml(text), {
    id: 'PRJ-001',
    name: '示例项目',
    phase: 'requirements',
    scope: { in: ['需求审讯', '架构设计'], out: [] },
    requirements: [
      { id: 'REQ-001', title: '用户可创建项目', priority: 'must', acceptance: ['空名称被拒'] },
      { id: 'REQ-002', title: '支持导出', priority: 'should' },
    ],
  })
})

test('解析：标量类型（null / 布尔 / 数字 / 引号）', () => {
  const parsed = parseYaml(
    [
      'a: null',
      'b: ~',
      'c: true',
      'd: FALSE',
      'e: 42',
      'f: -7',
      'g: 3.5',
      'h: 007',
      'i: "含 \\"转义\\" 的串"',
      "j: 'it''s ok'",
      'k: 2026-09-29',
      'l: 带 空格 的普通串',
    ].join('\n'),
  ) as Record<string, unknown>
  assert.equal(parsed.a, null)
  assert.equal(parsed.b, null)
  assert.equal(parsed.c, true)
  assert.equal(parsed.d, false)
  assert.equal(parsed.e, 42)
  assert.equal(parsed.f, -7)
  assert.equal(parsed.g, 3.5)
  assert.equal(parsed.h, '007', '前导零应保持字符串，避免被当成八进制')
  assert.equal(parsed.i, '含 "转义" 的串')
  assert.equal(parsed.j, "it's ok")
  assert.equal(parsed.k, '2026-09-29')
  assert.equal(parsed.l, '带 空格 的普通串')
})

test('解析：流式集合（含嵌套）', () => {
  assert.deepEqual(parseYaml('a: [1, 2, three]\nb: {x: 1, y: [a, b]}\n'), {
    a: [1, 2, 'three'],
    b: { x: 1, y: ['a', 'b'] },
  })
})

test('解析：块标量 literal / folded / chomping', () => {
  const literal = parseYaml(['text: |-', '  第一行', '  第二行', ''].join('\n')) as { text: string }
  assert.equal(literal.text, '第一行\n第二行')

  const clip = parseYaml(['text: |', '  第一行', '  第二行', ''].join('\n')) as { text: string }
  assert.equal(clip.text, '第一行\n第二行\n')

  const folded = parseYaml(['text: >-', '  第一段', '  续行', '', '  第二段', ''].join('\n')) as { text: string }
  assert.match(folded.text, /第一段 续行/)
  assert.match(folded.text, /第二段/)
})

test('往返：stringify → parse 得到等价结构', () => {
  const value = {
    id: 'PRJ-001',
    name: '示例：带冒号 与 # 号',
    scale: 'normal',
    waivers: [] as unknown[],
    nested: { a: 1, b: 'true', c: null, d: '' },
    list: [{ id: 'TASK-001', dod: ['能编译'] }, { id: 'TASK-002', dod: [] }],
    multiline: '第一行\n第二行',
    '带空格的键': '值',
  }
  const round = parseYaml(stringifyYaml(value))
  assert.deepEqual(round, value)
})

/**
 * **DEF-003 守卫**（读端必须认「引号包裹的键」）。
 *
 * 为什么单独开一条而不是塞进上面那条往返：上面那条的键是**带空格的键**，
 * 它**不触发** `NEEDS_QUOTE`（写端不加引号）⇒ 正好绕过"读端认不认引号键"这个分支，
 * 这正是本缺陷能长期存活的原因（知识库 `tq_097f952d`：只堵报告里那一个复现手法不算修）。
 *
 * 写端 `quoteIfNeeded` 对**以减号开头**的键会加单引号（CSS 变量 `--sdo-accent` 这类令牌键），
 * 所以读端必须成为同一口径的另一端：认单引号与双引号包裹的键，并解掉既有转义
 * （单引号 `''` ⇒ `'`；双引号按 JSON 转义）。
 */
test('往返：会被引号的键（以减号开头等）必须能读回（DEF-003）', () => {
  const value = {
    tokens: { '--sdo-accent': '#111', '--sdo-fg': '#222', plain: 'ok' },
  }
  // 先确认写端**确实**给这些键加了引号（否则本用例就不在守这个分支，等于白测）
  const text = stringifyYaml(value)
  assert.match(text, /'--sdo-accent':/, '写端应当给减号开头的键加单引号（本用例的前提）')
  // 再确认读端能整份读回
  assert.deepEqual(parseYaml(text), value)
})

test('往返：双引号包裹的键与键内转义也能读回（DEF-003）', () => {
  // 手工真源：双引号键 + 单引号键内含转义（'' ⇒ '）
  const doc = ["'--a': 1", 'b: 2', '"quoted key": 3', "'it''s': 4"].join('\n')
  assert.deepEqual(parseYaml(doc), { '--a': 1, b: 2, 'quoted key': 3, "it's": 4 })
})

/**
 * **DEF-061 / REV-041 守卫**（读端 `splitKey` 必须**跳过引号段**）。
 *
 * 上一轮（DEF-003）只堵住了"键以**减号**开头"这一个触发字符，却在交付里写了
 * 「读端已与写端同一口径」这句**过强**的结论 —— 写端 `NEEDS_QUOTE` 还有其它触发支
 * （键内含「冒号+空格」、内含「空格+井号」、以冒号结尾、含引号），而读端只在
 * `unwrapQuotedKey` 里认引号、`splitKey` 的扫描循环**照样在引号段里找冒号/井号**，
 * 并不加区分地拒绝任何含 `\` 的行。于是"写端会加引号的键"与"读端认得的键"
 * 并没有逐支对齐（教训见 `tq_097f952f` / `tq_097f952d`：只堵报告里那一个复现手法不算修）。
 *
 * 本组三条（分别对应 REV-041 的主发现与发现 7、8）：
 *   ① 主发现：写端会加引号的键，**读端必须整份读回**（手写真源逐形态）；
 *   ② 发现 7：**双引号键含转义**的真样本，让 `splitKey` 的"转义跳过"分支第一次可达；
 *   ③ 发现 8：控制组从"只钉两个减号前缀"改成**逐字比对手写期望文本**的一般断言，
 *      防换一个触发字符后控制组再次失效。
 */
test('往返：写端会加引号的键（减号/冒号+空格/空格+井号/冒号结尾）都必须能整份读回（DEF-061 主发现）', () => {
  // 手写真源：每个键都是写端 `NEEDS_QUOTE` 的**独立触发支**（不是同一个分支的重复样本）
  const doc = [
    "'--token': 1",      // 首字符是减号（DEF-003 已覆盖的支，留作回归）
    "'a:b': 2",          // 键内含「冒号 + 空格」
    "'a #b': 3",         // 键内含「空格 + 井号」
    "'a:': 4",           // 键以冒号结尾
    "'a b': 5",          // 键内含空格（普通引号键）
  ].join('\n')
  assert.deepEqual(parseYaml(doc), {
    '--token': 1,
    'a:b': 2,
    'a #b': 3,
    'a:': 4,
    'a b': 5,
  })

  // ⚠️ **诚实标注（REV-041 主发现的现状复核）**：上面这四个"会加引号的键"样本，**在我改之前
  // 就已经能读回** —— 因为 `splitKey` 判不出键值时返回 `undefined`，整行被当成**标量**返回，
  // 于是"冒号/井号在引号段内"这件事**从未被真正考验过**。也就是说卡上"主发现已机械复现"这句
  // 在当前盘上**不成立**：它描述的是 DEF-003 时代的读端（见 yaml.ts 的注释）。
  // 真正**依赖**"跳过引号段"这个新扫描态的是下一条（引号段内出现 `\` 时，旧实现在**任何**引号
  // 段内都会 `return undefined`，不论引号是否闭合）。本用例保留作**回归**（防这几个支再次退化），
  // 但**不是**本卡的绿条件 —— 卡上把主发现与发现 7 分开列，正是这个意思。
})

test('往返：双引号键内含**转义**也能读回（DEF-061 发现 7：让转义跳过分支第一次可达）', () => {
  // 为什么必须用**双引号 + 反斜杠转义**的样本：`splitKey` 里有一个"读到 `\` 就跳到下一个字符"
  // 的分支，此前**没有任何样本**能让它执行（单引号键不含反斜杠；写端又不会给键加转义引号），
  // 于是它是一段**死支** —— 死支既不被守卫生效，也掩盖了"引号段里还有转义"这件事。
  // 这里的 `"a\"b"` 是**合法 YAML**：键的字面值是 `a"b`（含一个双引号），转义跳过必须被执行。
  const doc = ['"a\\"b": 1', "'it''s': 2", '"quoted key": 3'].join('\n')
  assert.deepEqual(parseYaml(doc), { 'a"b': 1, "it's": 2, 'quoted key': 3 })

  // 对照（**存量写端缺口，本卡明确不并进**）：写端 `quoteIfNeeded` 只看 `NEEDS_QUOTE`、
  // **不看 `NEEDS_ESCAPE_QUOTE`** ⇒ 含反斜杠/双引号的键被写成**裸键**（既不该裸，也不可读回）。
  // 卡上的边界写明"不并进同族残留"，所以这里只**记录**它没被顺手改掉，不把它当本卡的绿条件。
  const raw = stringifyYaml({ 'a\\b': 1 }).trim()
  assert.equal(raw, 'a\\b: 1', '写端此刻仍把含反斜杠的键写成裸键（残留，另行处置）')
})

test('往返：不触发引号的普通键仍走原路径（反向对照，防「所有键都当引号键」）', () => {
  // **控制变量**：这里的键**一个都不触发** `NEEDS_QUOTE`（无减号开头、无冒号/井号、无引号方括号，
  // 也没有**行尾**空白）—— 所以它们必须走**原生 plain 路径**：写端不加引号、读端也不做引号解包。
  // 反例（不要放进本条）：`nested: { '--x': 'y' }` 里的 `'--x'` 是**会被引号**的键，
  // 放进来就把"反向对照"变成"又一条引号键用例"，控制作用随之消失。
  const value = { plain: 'v', 'with space': 'w', nested: { inner: 'y' } }
  const text = stringifyYaml(value)
  // **REV-041 发现 8**：控制组不能只钉"两个减号前缀"（那只挡得住紧邻历史的那一个触发字符，
  // 换个触发字符就再次失效）。改成**整份逐字比对手写期望文本** —— 于是"样本里没有任何键
  // 被写端引号"这条不变量由**一般断言**守，而不是由某一个前缀守。
  assert.equal(text, 'plain: v\nwith space: w\nnested:\n  inner: y\n')
  assert.equal(text.includes("'"), false, '控制组样本里不该出现任何被引号的键/值')
  assert.deepEqual(parseYaml(text), value)
})

test('往返：确定性输出（同输入两次结果逐字节相同）', () => {
  const value = { b: 1, a: [{ z: 'x', y: 'w' }] }
  assert.equal(stringifyYaml(value), stringifyYaml(value))
  assert.equal(stringifyYaml(parseYaml(stringifyYaml(value))), stringifyYaml(value))
})

test('错误：Tab 缩进 / 锚点 / 多文档 / 缩进不一致', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), YamlSubsetError)
  assert.throws(() => parseYaml('a: &anchor 1\n'), /锚点/)
  assert.throws(() => parseYaml('---\na: 1\n'), /多文档/)
  assert.throws(() => parseYaml('a: 1\n    b: 2\n'), /缩进/)
  assert.throws(() => parseYaml('a: [1, 2\n'), YamlSubsetError)
})

test('空文档与空集合', () => {
  assert.equal(parseYaml(''), null)
  assert.equal(parseYaml('# 只有注释\n'), null)
  assert.deepEqual(parseYaml('a:\n'), { a: null }, '键后为空且无嵌套 → 该键的值为 null')
  assert.deepEqual(parseYaml('a: {}\n'), { a: {} })
  assert.deepEqual(parseYaml('a: []\n'), { a: [] })
})
