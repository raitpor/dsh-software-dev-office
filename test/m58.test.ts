/**
 * **§4.1 / §4.2（第二轮评审 HIGH）**：
 *   · 写出侧把多行串写成块标量，而**列表项**那种形状（`- |-`）解析侧不认 ⇒ 真源写成**永久不可读**
 *     （真机路径：`sdo_quality action=evaluate` 的 risks/sensitivities 元素含换行），台账还记"已记录"；
 *   · 块标量里的**空行**在读取时被丢掉 ⇒ 多段正文往返掉空行。
 * 修法：写出侧收口到**转义双引号**（解析侧本来就支持），解析侧另补列表块标量以读**存量/手写**文件。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { SdoStore } from '../src/infra/store.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm58')
let store: SdoStore

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('§4.1：含换行的**列表元素**写出去必须能读回来（真源不得写成永久不可读）', () => {
  const payload = { assessment: { risks: ['a\nb', 'single'], note: 'ok' } }
  store.writeYaml(['quality', 'atam.yml'], payload)
  const text = store.readText('quality', 'atam.yml') ?? ''
  assert.doesNotMatch(text, /- \|-/u, '不得再写出解析侧读不了的列表块标量')
  assert.deepEqual(store.readYaml('quality', 'atam.yml'), payload, '写读往返必须一致')
})

test('§4.2：多段正文的空行必须保住（不得静默丢空行）', () => {
  const payload = { adr: { context: 'para1\n\npara2\n\n\npara3', quote: 'x"y\\z\ttab' } }
  store.writeYaml(['adr', 'A-1.yml'], payload)
  assert.deepEqual(store.readYaml('adr', 'A-1.yml'), payload, '空行与特殊字符都要原样往返')
})

test('§4.1（兼容）：存量/手写的列表块标量（`- |-` / `- >`）仍要能读', () => {
  writeFileSync(join(BASE, '.sdo', 'legacy.yml'), 'risks:\n  - |-\n      p\n      q\n  - plain\n  - >\n      folded text\n')
  const legacy = store.readYaml<{ risks: string[] }>('legacy.yml') ?? { risks: [] }
  assert.deepEqual(legacy.risks.slice(0, 2), ['p\nq', 'plain'], '`- |-` 与普通项都要读对')
  // 折叠样式（`- >`）按 fold 语义读回，末尾换行由 chomp 决定 —— 这里只要求内容正确
  assert.match(legacy.risks[2] ?? '', /^folded text\n?$/u, `折叠块标量要读出来：${JSON.stringify(legacy.risks[2])}`)
})
