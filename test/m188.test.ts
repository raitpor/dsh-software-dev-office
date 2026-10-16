/**
 * **增量 188：第八批 §3.4（`DEF-087`）—— 同步面以 `package.json#files` 为准，并能报出"多出来的面"。**
 *
 * 全在**临时目录夹具**上测（DoD ③：不碰真实实例路径）；真实例的只读观测写在报告里。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { expectedFaces, reportFaces } from './syncFaces.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm188')

const filesOf = (): string[] => (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] }).files

beforeEach(() => { rmSync(BASE, { recursive: true, force: true }) })
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M188-01 结构：同步面**由 `files` 推导**（换一份 files ⇒ 面跟着变，说明它不是手抄的第二份清单）', () => {
  const files = filesOf()
  // ① 真 `files` 的推导结果
  assert.deepEqual(
    expectedFaces(files),
    ['CHANGELOG.md', 'LICENSE', 'README.md', 'client.d.ts', 'client.js', 'lib', 'presets', 'skills', 'src'],
    '顶层面必须由 files 逐条推导（`lib/src`⇒`lib`；`src/data`⇒`src`）',
  )
  // ② **推导性**证明：换一份完全不同的 files，输出必须跟着变（手抄清单做不到）
  assert.deepEqual(expectedFaces(['a/b', 'c', 'a/d', 'c']), ['a', 'c'], '换输入 ⇒ 跟着变（证明是推导）')
  assert.deepEqual(expectedFaces([]), [], '空 files ⇒ 空面（不是"一个默认清单"）')
  // ③ 结构：helper 的源码里**不许**再抄一份面清单（只许出现 PACKAGING_STANDARD 这一份"打包标准"）
  const source = readFileSync(join(ROOT, 'test', 'syncFaces.ts'), 'utf8')
  for (const face of ['lib/src', 'skills', 'presets', 'client.js']) {
    assert.equal(source.includes(`'${face}'`) || source.includes(`"${face}"`), false, `不许把 ${face} 抄进 helper（唯一来源是 files）`)
  }
})

test('M188-02 行为（夹具三态）：齐备 ⇒ 无 missing/extra；少一面 ⇒ missing；**多一面 ⇒ extra**（只报不删）', () => {
  const files = filesOf()
  const expected = expectedFaces(files)
  const dir = join(BASE, 'copy')
  // ① 齐备（造出所有面 + 打包标准条目）
  for (const face of expected) mkdirSync(join(dir, face), { recursive: true })
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}\n')
  assert.deepEqual(reportFaces(files, dir), { expected, missing: [], extra: [] }, '齐备 ⇒ 两面都空')
  // ② 少一面（删掉 skills）
  rmSync(join(dir, 'skills'), { recursive: true, force: true })
  assert.deepEqual(reportFaces(files, dir).missing, ['skills'], '少了面必须报出来')
  assert.deepEqual(reportFaces(files, dir).extra, [], '少面不影响 extra')
  // ③ **多一面**（这正是真实例上的 `docs/` 形态）——只报告、**不删**
  mkdirSync(join(dir, 'skills'), { recursive: true })
  mkdirSync(join(dir, 'docs', 'design'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'README.md'), 'stale\n')
  const report = reportFaces(files, dir)
  assert.deepEqual(report.extra, ['docs'], '多出来的面必须报出来（`docs` 不在 files 里）')
  assert.deepEqual(report.missing, [], '多面不影响 missing')
  assert.equal(readFileSync(join(dir, 'docs', 'README.md'), 'utf8'), 'stale\n', '**只报告不删**（helper 必须是只读观测）')
  // ④ 打包标准条目不算多余；隐藏条目也不算
  mkdirSync(join(dir, '.cache'), { recursive: true })
  writeFileSync(join(dir, '.package-lock.json'), '{}\n')
  assert.deepEqual(reportFaces(files, dir).extra, ['docs'], '标准/隐藏条目不许混进 extra')
  // ⑤ 目录不存在 ⇒ 全 missing，不抛
  assert.deepEqual(reportFaces(files, join(BASE, 'nope')).missing, expected, '目录不存在 ⇒ 全 missing（不抛）')
})

test('M188-03 §3.7（DEF-087）：判据下沉到**声明路径逐层对账** —— 面内多/少/内容不同各一格 + 未声明物化', () => {
  const source = join(BASE, 'repo')
  const dir = join(BASE, 'instance')
  // 源树：一条声明目录（`src/data`）+ 一条声明单文件（`client.js`）+ 一条未声明的面内兄弟目录
  mkdirSync(join(source, 'src', 'data'), { recursive: true })
  writeFileSync(join(source, 'src', 'data', 'a.yml'), 'a: 1\n')
  writeFileSync(join(source, 'client.js'), 'export const x = 1\n')
  mkdirSync(join(source, 'skills'), { recursive: true })
  writeFileSync(join(source, 'skills', 'k.md'), 'k\n')
  const faceFiles = ['src/data', 'client.js', 'skills']
  // 副本：面都齐备
  mkdirSync(join(dir, 'src', 'data'), { recursive: true })
  writeFileSync(join(dir, 'src', 'data', 'a.yml'), 'a: 1\n')
  writeFileSync(join(dir, 'client.js'), 'export const x = 1\n')
  mkdirSync(join(dir, 'skills'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'k.md'), 'k\n')
  // ① 齐备 ⇒ 三列都空
  const clean = reportFaces(faceFiles, dir, source)
  assert.deepEqual(clean.paths, [
    { path: 'src/data', missing: [], extra: [], drifted: [] },
    { path: 'client.js', missing: [], extra: [], drifted: [] },
    { path: 'skills', missing: [], extra: [], drifted: [] },
  ], '逐条声明路径必须都报到、且三列皆空')
  assert.deepEqual(clean.undeclared, [], '面内没有未声明文件 ⇒ 空')
  // ② **面内多一个文件**（顶层面齐备 ⇒ 第八批的旧判据完全看不见它）
  writeFileSync(join(dir, 'src', 'data', 'ghost.yml'), 'ghost: 1\n')
  const extra = reportFaces(faceFiles, dir, source)
  assert.deepEqual(extra.extra, [], '顶层面照旧不报（回归第八批口径）')
  assert.deepEqual(extra.paths?.[0]?.extra, ['ghost.yml'], '面内多出来的文件必须报出来')
  // ③ **面内少一个文件**
  rmSync(join(dir, 'src', 'data', 'a.yml'))
  assert.deepEqual(reportFaces(faceFiles, dir, source).paths?.[0]?.missing, ['a.yml'], '面内少的文件必须报出来')
  // ④ 两边都有但**内容不同** ⇒ drifted（只报告；helper 只读）
  rmSync(join(dir, 'src', 'data', 'ghost.yml'))
  writeFileSync(join(dir, 'src', 'data', 'a.yml'), 'a: 2\n')
  assert.deepEqual(reportFaces(faceFiles, dir, source).paths?.[0]?.drifted, ['a.yml'], '内容不同必须报出来')
  writeFileSync(join(dir, 'client.js'), 'export const x = 2\n')
  assert.deepEqual(reportFaces(faceFiles, dir, source).paths?.[1]?.drifted, [''], '单文件声明也要比内容')
  // ⑤ **面内未声明物化**（这正是真实例 `src/` 的 71 个文件的形态）：`files` 只声明 `src/data`
  mkdirSync(join(dir, 'src', 'domain'), { recursive: true })
  writeFileSync(join(dir, 'src', 'domain', 'adr.ts'), 'export const adr = 1\n')
  assert.deepEqual(reportFaces(['src/data'], dir, source).undeclared, ['src/domain/adr.ts'], '面内未声明文件必须报出来')
  // ⑥ 路径参数化：不传 sourceRoot ⇒ 形状与第八批**逐字相同**（没有 paths / undeclared 两个键）
  const legacy = reportFaces(faceFiles, dir)
  assert.deepEqual(Object.keys(legacy).sort(), ['expected', 'extra', 'missing'], '不传 sourceRoot ⇒ 旧形状不变（零破坏）')
  assert.equal('paths' in legacy, false)
  assert.equal('undeclared' in legacy, false)
})
