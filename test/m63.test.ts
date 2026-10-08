/**
 * 第二轮整体评审 §2.5a / §2.5b（minor，两条都亲手复现）：
 *
 * **§2.5a `file-history/` 无界**：每次直接 `write`/`edit` `.sdo/` 真源都会在
 * `.sdo/evidence/file-history/` 留一份 `<slug>.<ISO 时间戳>.bak`，**没有任何上限**。
 * 我的探针还查到同一处的第二个（更尖的）缺陷：时间戳只到**毫秒**，同一毫秒内的连写
 * **互相覆盖** —— 探针里 `25 次写入 ⇒ 盘上只剩 5 份`，即"防止正文丢失的机制"自己在丢正文。
 * 修法：名字带**同毫秒内单调的序号**（不再互撞）+ 每个真源只保留最近 {@link FILE_HISTORY_KEEP} 份。
 *
 * **§2.5b `docs/DESIGN.md` 手改无人察觉**：这条我只采信一半 ——
 *   · "**不一致**无人察觉"是**反证**：C-25（`design.doc`）把整份文件与"当前真源的重渲染结果"
 *     逐字节比对，手改正文必判红（`M19 N-8 反例③` 就是这条，本文件 M63-04 再钉一次）；
 *   · 但"手改内容被下一次渲染**静默销毁**"是真的：`renderDesign` 直接覆盖，既没有副本、
 *     `design/rendered` 事件里也没有任何"覆盖了谁"的痕迹（探针：`手改内容还在盘上吗 = false`，
 *     载荷键只有 `kind,seq,bytes,phase`）。修法：覆盖前若盘上那份**不是上次渲染写下的**，
 *     就先按同一套快照口径留副本，并在渲染事件里记下 `snapshot`。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { FILE_HISTORY_KEEP, SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm63')
const HISTORY = ['evidence', 'file-history']

let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal
const call = { sessionId: 's1', cwd: BASE }

const historyNames = (): string[] => {
  const dir = join(BASE, '.sdo', ...HISTORY)
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', BASE)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M63-01 §2.5a：同一毫秒的连写不许互相覆盖，且旧稿份数有上限（不无界增长）', () => {
  const rounds = FILE_HISTORY_KEEP + 5
  for (let index = 0; index < rounds; index++) {
    store.writeYaml(['design', 'deviations.yml'], { deviations: { n: index } })
    office.snapshotTruthFile(call, '.sdo/design/deviations.yml')
  }
  const names = historyNames()
  assert.equal(new Set(names).size, names.length, '名字必须唯一（旧实现同毫秒覆盖 ⇒ 份数少于写入次数）')
  assert.equal(names.length, FILE_HISTORY_KEEP, `旧稿份数必须收敛到上限 ${FILE_HISTORY_KEEP}，实际 ${names.length}`)
  // 上限是"丢最旧"，最近这一批必须在（尤其**同毫秒**那几份）
  const newest = readFileSync(join(BASE, '.sdo', ...HISTORY, names[names.length - 1]!), 'utf8')
  assert.match(newest, new RegExp(`n: ${rounds - 1}\\b`, 'u'), `最新一份必须是最后一次写入前的内容：${newest}`)
  const secondNewest = readFileSync(join(BASE, '.sdo', ...HISTORY, names[names.length - 2]!), 'utf8')
  assert.match(secondNewest, new RegExp(`n: ${rounds - 2}\\b`, 'u'), '同毫秒写入的相邻两份都要在（这正是旧实现丢掉的那批）')
})

test('M63-02 §2.5a：上限**按真源各自计** —— 刷爆一个文件不许挤掉另一个文件的历史', () => {
  for (let index = 0; index < FILE_HISTORY_KEEP + 5; index++) {
    store.writeYaml(['design', 'deviations.yml'], { deviations: { n: index } })
    office.snapshotTruthFile(call, '.sdo/design/deviations.yml')
  }
  store.writeYaml(['risks', 'atam.yml'], { assessment: { note: '只有一份' } })
  office.snapshotTruthFile(call, '.sdo/risks/atam.yml')

  const names = historyNames()
  assert.equal(names.filter((name) => name.includes('deviations')).length, FILE_HISTORY_KEEP)
  const risks = names.filter((name) => name.includes('atam'))
  assert.equal(risks.length, 1, `另一个真源的旧稿不该被挤掉：${names.join(' | ')}`)
  assert.match(readFileSync(join(BASE, '.sdo', ...HISTORY, risks[0]!), 'utf8'), /只有一份/u)
})

test('M63-03 §2.5b：手改的 DESIGN.md 被下一次渲染覆盖前必须留副本 + 在事件里留痕；正常重渲染不留噪声', () => {
  office.init(call, { name: 'P', scale: 'normal', stakeholders: ['业务方'] })
  office.renderDesign(call)
  const path = join(BASE, 'docs', 'DESIGN.md')
  const rendered = readFileSync(path, 'utf8')

  // ① 正常重渲染（内容由真源而来、没人动过）⇒ 不产生副本（否则每次渲染都堆垃圾）
  office.renderDesign(call)
  assert.equal(historyNames().length, 0, '没人手改时不留副本')

  // ② 手改（人加的批注）⇒ 下一次渲染覆盖前必须先留副本，并记进渲染事件
  writeFileSync(path, `${rendered}\n人工批注：这里的风险缓解不够，需补一条\n`, 'utf8')
  office.renderDesign(call)
  const names = historyNames()
  assert.equal(names.length, 1, `手改内容被覆盖前必须留一份副本：${names.join(' | ')}`)
  assert.match(readFileSync(join(BASE, '.sdo', ...HISTORY, names[0]!), 'utf8'), /人工批注/u, '副本里必须是手改后的原文')
  const events = journal.read().events.filter((event) => event.type === 'design/rendered' && event.data.kind === 'DESIGN.md')
  const last = events.at(-1)
  assert.equal(typeof last?.data.snapshot, 'string', `渲染事件要记下"覆盖了哪份副本"：${JSON.stringify(last?.data)}`)
  assert.match(String(last?.data.snapshot), /file-history/u)

  // ③ 又一次正常渲染 ⇒ 仍然不新增副本（留痕机制不许把每次渲染都变成一次备份）
  office.renderDesign(call)
  assert.equal(historyNames().length, 1, '正常重渲染不新增副本')

  // ④ **等长**手改（字节数一字不差）⇒ 也必须认出来：判据是内容哈希，不是字节数/时间戳
  const current = readFileSync(path, 'utf8')
  const equalLength = current.replace('## ', '##-')
  assert.equal(Buffer.byteLength(equalLength, 'utf8'), Buffer.byteLength(current, 'utf8'), '前置：字节数确实没变')
  assert.notEqual(equalLength, current, '前置：内容确实变了')
  writeFileSync(path, equalLength, 'utf8')
  office.renderDesign(call)
  const names2 = historyNames()
  assert.equal(names2.length, 2, `等长手改也必须留副本：${names2.join(' | ')}`)
  assert.match(readFileSync(join(BASE, '.sdo', ...HISTORY, names2[names2.length - 1]!), 'utf8'), /##-/u, '副本里是等长手改后的原文')

  // ⑤ 再正常渲染一次 ⇒ 依然不新增
  office.renderDesign(call)
  assert.equal(historyNames().length, 2, '正常重渲染不新增副本（清理后仍成立）')
})

test('M63-04 §2.5b 反驳"无人察觉"：手改正文（渲染头合法）⇒ C-25 逐字节比对判红', () => {
  office.init(call, { name: 'P', scale: 'normal', stakeholders: ['业务方'] })
  office.renderDesign(call)
  const path = join(BASE, 'docs', 'DESIGN.md')
  const doc = readFileSync(path, 'utf8')
  const edited = doc.replace(/\n/u, '\n<!-- 人改的 -->\n')
  assert.notEqual(edited, doc, '前置：确实改了')
  writeFileSync(path, edited, 'utf8')

  const c25 = office.evaluate(call, 'G3').criteria.find((criterion) => criterion.id === 'C-25')
  assert.ok(c25 !== undefined, 'G3 必须有 C-25')
  assert.equal(c25.ok, false, `手改 DESIGN.md 必须被察觉（C-25 判红）：${JSON.stringify(c25)}`)
  assert.equal(c25.na, undefined)

  // 双向：重新渲染 ⇒ 转绿（判据不是"一红到底"）
  office.renderDesign(call)
  const after = office.evaluate(call, 'G3').criteria.find((criterion) => criterion.id === 'C-25')
  assert.equal(after?.ok, true, `重渲染后必须转绿：${JSON.stringify(after)}`)
})
