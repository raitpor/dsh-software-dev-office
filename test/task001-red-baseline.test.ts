/**
 * **TASK-001 红灯基线**：把"修正前"的两个真实缺陷**注入一份可 inspect 的历史修订**并现算，
 * 于是"红灯"不是一句"当时是红的"，而是一条**可复跑**的观察。
 *
 * 背景（本条卡实现期间实测踩到的两个真 bug，都先红后绿）：
 *   ① `renderStale` 曾把"全局 journal 序号前进"也算作过期理由 ⇒ 渲染完三份承重文档后，前两份立刻判过期。
 *      实测反例：`renderStale(plan) = {stale:true, sourceChanged:false, seqAdvanced:true, recordedSeq:8, currentSeq:11}`。
 *   ② `docHandEdited` 曾用 `sourceHashOf`（走 `contentHash` 的 JSON 规范化）去比 `docSha256`（归一化文本的
 *      字节摘要）记下的值 ⇒ 两者**永远不等** ⇒ 每次渲染都假报"有人手改"并留副本，噪声会盖掉真问题。
 *
 * 历史修订存在 `test/snapshots/task001/testingStore.before-fix.ts.txt`（纯文本，不参与 tsc 构建）。
 * 本用例把这份修订**物化**成一次真实的构建与运行：与当前 `src/` 组成一棵临时树 → `tsc` → 跑探针，
 * 并断言"探针在修订版上判红、在当前版上判绿"。任何一环不成立就判红。
 *
 * 复跑：`node --test lib/test/task001-red-baseline.test.js`
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SNAPSHOT = join(ROOT, 'test', 'snapshots', 'task001', 'testingStore.before-fix.ts.txt')
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'task001-red-baseline')

/**
 * 探针：两段**跨修订不变**的观察，各自断言"修正后必须成立"的性质。
 *
 *   · `staleAfterRenderAll`：按同一次渲染动作渲染三份承重文档后，再问 `renderStale(plan)` 是不是过期；
 *   · `handEditedOnUnchangedDoc`：对一份**没人改过**的文档连渲两次，第二次的 `handEdited`。
 */
const PROBE = `import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SdoStore } from './lib/src/infra/store.js'
import { Journal } from './lib/src/infra/journal.js'
import { currentJournalSeq, lastDocRecord, renderStale, writeTestingSource } from './lib/src/domain/testingStore.js'
import { writeTestingDoc } from './lib/src/domain/testingRender.js'

const WS = join(process.cwd(), 'probe-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(join(WS, '.sdo'), { recursive: true })
const store = new SdoStore(join(WS, '.sdo'))
const journal = new Journal(store)
writeTestingSource(store, 'plan', 'plan', {
  levels: [{ id: 'TL-001', level: '单元', entry: 'e', exit: 'x' }],
  exitCriteria: [{ id: 'XC-001', criterion: 'c', threshold: '80%', scope: 's' }],
}, journal)
for (const kind of ['plan', 'design', 'report']) {
  writeTestingDoc(store, kind, { store, seq: currentJournalSeq(store, journal), projectName: 'P' }, journal)
}
// 观察一：同一次渲染动作之后，plan 不该过期（全局序号前进了，但 plan 的真源没变）
const stale = renderStale(store, 'plan', journal)
console.log('STALE_AFTER_RENDER_ALL=' + String(stale.stale))
// 观察二：没人手改过的文档，第二次渲染不该报 handEdited
const again = writeTestingDoc(store, 'plan', { store, seq: lastDocRecord(store, 'plan').seq }, journal)
console.log('HAND_EDITED_ON_UNCHANGED=' + String(again.handEdited))
rmSync(WS, { recursive: true, force: true })
`

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 把当前 `src/` + `test/` 复制成一棵临时树，并按 `swapStore` 决定用哪一版 testingStore.ts 与模块图。 */
function buildTree(variant: 'before-fix' | 'current'): { build: ReturnType<typeof spawnSync> } {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  for (const entry of ['src', 'test', 'tsconfig.json']) {
    cpSync(join(ROOT, entry), join(BASE, entry), { recursive: true })
  }
  writeFileSync(join(BASE, 'probe.mjs'), PROBE, 'utf8')
  if (variant === 'before-fix') {
    // 把历史修订放回 testingStore.ts 的位置（探针 import 的就是这个模块）
    const legacy = readFileSync(SNAPSHOT, 'utf8')
    writeFileSync(join(BASE, 'src', 'domain', 'testingStore.ts'), legacy, 'utf8')
  }
  const build = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
    cwd: BASE,
    encoding: 'utf8',
  })
  return { build }
}

function runProbe() {
  const run = spawnSync(process.execPath, ['probe.mjs'], { cwd: BASE, encoding: 'utf8' })
  const out = `${run.stdout}${run.stderr}`
  const read = (key: string): boolean | undefined => {
    const matched = new RegExp(`${key}=(true|false)`, 'u').exec(out)
    return matched === null ? undefined : matched[1] === 'true'
  }
  return { out, staleAfterRenderAll: read('STALE_AFTER_RENDER_ALL'), handEditedOnUnchanged: read('HAND_EDITED_ON_UNCHANGED') }
}

test('红灯基线可用：历史修订里确实带着那两个缺陷，且与当前实现有实质差异', () => {
  assert.ok(existsSync(SNAPSHOT), `红灯基线快照必须在：${SNAPSHOT}`)
  const legacy = readFileSync(SNAPSHOT, 'utf8')
  const current = readFileSync(join(ROOT, 'src', 'domain', 'testingStore.ts'), 'utf8')

  // 缺陷标记必须真的在修订里（否则"红灯"是空口）
  assert.match(legacy, /stale: missing \|\| !sourceChanged,/u, '修订里必须带着缺陷①（序号当过期理由的反面）')
  assert.match(legacy, /sourceHashOf\(readFileSync/u, '修订里必须带着缺陷②（用错哈希口径）')
  assert.match(legacy, /return contentHash\(normalized\(text\)\)/u, '修订里 sourceHashOf 必须是另一套口径（否则缺陷②是空转）')
  // 当前实现不许再带着它们
  assert.doesNotMatch(current, /stale: missing \|\| !sourceChanged,/u, '当前实现不许带缺陷①')
  assert.doesNotMatch(current, /sourceHashOf\(readFileSync/u, '当前实现不许带缺陷②')
  assert.notEqual(sha256(legacy), sha256(current), '修订与当前实现必须是两份不同的产物')
})

test('红灯基线现算：修订版上两个观察都判红，当前版上都判绿', () => {
  const before = buildTree('before-fix')
  assert.equal(before.build.status, 0, `修订版必须能编译起来（否则探针跑不动）：${before.build.stdout ?? ''}${before.build.stderr ?? ''}`)
  const red = runProbe()
  assert.equal(red.staleAfterRenderAll, true, `修订版应判"渲染完三份文档后 plan 过期"（红灯①）：${red.out.slice(-400)}`)
  assert.equal(red.handEditedOnUnchanged, true, `修订版应判"没改过的文档也报手改"（红灯②）：${red.out.slice(-400)}`)

  const current = buildTree('current')
  assert.equal(current.build.status, 0, `当前版必须能编译起来：${current.build.stdout ?? ''}${current.build.stderr ?? ''}`)
  const green = runProbe()
  assert.equal(green.staleAfterRenderAll, false, `当前版必须判"不过期"：${green.out.slice(-400)}`)
  assert.equal(green.handEditedOnUnchanged, false, `当前版必须判"没手改"：${green.out.slice(-400)}`)

  rmSync(BASE, { recursive: true, force: true })
})
