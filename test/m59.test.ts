/**
 * **§3.1（第二轮评审 HIGH）**：C-25 的缓存键用 `count:size:maxMtime` 做"真源版本" ⇒
 * **同字节数**的原地改写只要 mtime 不越过当时的最大值（git checkout / rsync / 备份还原 / 同毫秒两次写），
 * 键就完全不变 ⇒ 命中旧渲染（真机复现：281B 原地改写 + mtime 调回 ⇒ 真门禁 G3 仍 ok 的假绿）。
 * 现在取**内容哈希**：内容变则键必变；只动 mtime 不再产生假失配。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { truthRevision } from '../src/domain/design.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm59')
const FILE = join(BASE, '.sdo', 'requirements', 'REQ-001.yml')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'requirements'), { recursive: true })
  writeFileSync(FILE, 'requirement:\n  id: REQ-001\n  title: aaaa\n', 'utf8')
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('§3.1：同字节数原地改写 + mtime 不越顶，指纹也必须变（否则缓存命中旧渲染）', () => {
  const before = truthRevision(join(BASE, '.sdo'))
  const info = statSync(FILE)
  const original = 'requirement:\n  id: REQ-001\n  title: aaaa\n'

  // 同字节数的改写：`aaaa` → `bbbb`
  const rewritten = original.replace('aaaa', 'bbbb')
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original), '前置：两次内容必须等长')
  writeFileSync(FILE, rewritten, 'utf8')
  // 把 mtime 调回原值（模拟 git checkout / rsync / 备份还原）
  utimesSync(FILE, info.atime, info.mtime)

  const after = truthRevision(join(BASE, '.sdo'))
  assert.notEqual(after, before, '§3.1：内容变了，指纹必须变（旧实现的 count:size:maxMtime 在这里不变）')
})

test('§3.1：只动 mtime（内容不变）不应产生假失配', () => {
  const before = truthRevision(join(BASE, '.sdo'))
  const info = statSync(FILE)
  const future = new Date(Date.now() + 60_000)
  utimesSync(FILE, future, future)
  assert.equal(truthRevision(join(BASE, '.sdo')), before, '§3.1：内容没变 ⇒ 指纹不变（不该白重渲染）')
  utimesSync(FILE, info.atime, info.mtime)
})

test('§3.1：新增/删除真源文件同样改变指纹（数量与内容一起进键）', () => {
  const before = truthRevision(join(BASE, '.sdo'))
  writeFileSync(join(BASE, '.sdo', 'requirements', 'REQ-002.yml'), 'requirement:\n  id: REQ-002\n', 'utf8')
  const added = truthRevision(join(BASE, '.sdo'))
  assert.notEqual(added, before)
  rmSync(join(BASE, '.sdo', 'requirements', 'REQ-002.yml'))
  assert.notEqual(truthRevision(join(BASE, '.sdo')), added)
})
