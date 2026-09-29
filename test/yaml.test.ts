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
