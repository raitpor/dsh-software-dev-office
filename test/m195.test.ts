/**
 * **增量 195：交付绑定（第十二批 §3.5 `DEF-107`）—— 形态由项目声明，插件按声明核对。**
 *
 * 病根：全仓 **791** 行提交信息里含 40/64 位 hex = **0**，`lib/` 又不被 git 跟踪 ⇒ "交付产物绑到哪了"
 * 在插件侧**没有任何判据**（在册无守）。修法：项目在 `.sdo/config.yml` 声明形态 —
 *   · `delivery.bind: 'commit'`  ⇒ 最近一次提交信息里必须能查到 40/64 位 hex（关键产物的 sha256）；
 *   · `delivery.bind: 'manifest'` ⇒ `delivery.manifestPath` 的清单必须存在且含至少一个 hex；
 *   · 未声明 ⇒ N/A（插件不猜形态，`AC-241`）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { CHECKERS } from '../src/domain/gates.js'
import { deliveryBinding } from '../src/domain/records.js'
import { readLastCommitMessage } from '../src/infra/git.js'
import { SdoStore } from '../src/infra/store.js'
import type { GateContext } from '../src/domain/gates.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm195')
const HASH = 'a'.repeat(64)
let counter = 0

beforeEach(() => { rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true }) })
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

/** 真 store（`.sdo/`）+ 真工作区（可选 **真 git 仓库**）。 */
function workspaceOf(): { store: SdoStore; dir: string } {
  counter += 1
  const dir = join(BASE, `ws-${counter}`)
  const store = new SdoStore(join(dir, '.sdo'))
  mkdirSync(store.path(), { recursive: true })
  return { store, dir }
}

const git = (dir: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })

const ctxOf = (store: SdoStore, dir: string): GateContext =>
  ({ requirements: [], store, workspace: dir } as unknown as GateContext)

test('M195-01 §3.5（`DEF-107`）commit 形态：提交信息**缺哈希** ⇒ 红；带 64 位 sha256 ⇒ 绿；非仓库 ⇒ 红（读不动不算绿）', () => {
  // ① 未声明 ⇒ N/A（并点名项目声明的键）
  const undeclared = workspaceOf()
  const na = CHECKERS['delivery.bound']?.(ctxOf(undeclared.store, undeclared.dir))
  assert.equal(na?.na, true, '未声明 ⇒ N/A')
  assert.match(na?.naReason ?? '', /delivery\.bind/u, 'N/A 的理由要点名 `delivery.bind`')
  // ② 声明 `commit`：真 git 仓库里提交一条**不带哈希**的信息 ⇒ 红
  const repo = workspaceOf()
  writeFileSync(join(repo.dir, 'a.txt'), 'a\n')
  git(repo.dir, ['init', '-q'])
  git(repo.dir, ['add', '-A'])
  git(repo.dir, ['commit', '-qm', 'wip：改了点东西'])
  repo.store.writeYaml(['config.yml'], { delivery: { bind: 'commit' } })
  const red = CHECKERS['delivery.bound']?.(ctxOf(repo.store, repo.dir))
  assert.equal(red?.ok, false, '提交信息里没有哈希 ⇒ 必须红')
  assert.match(red?.detail ?? '', /没有/u, '回执要说清"没有 40/64 位十六进制"')
  // ③ 再提交一条**带 64 位 sha256** 的信息 ⇒ 绿
  writeFileSync(join(repo.dir, 'a.txt'), 'b\n')
  git(repo.dir, ['add', '-A'])
  git(repo.dir, ['commit', '-qm', `deliver: a.txt sha256=${HASH}`])
  assert.equal(readLastCommitMessage(repo.dir).ok, true, '真仓库里必须能读到提交信息')
  assert.equal(deliveryBinding(repo.store, repo.dir).ok, true, '带 64 位哈希 ⇒ 绑定成立')
  assert.equal(CHECKERS['delivery.bound']?.(ctxOf(repo.store, repo.dir))?.ok, true, '门禁判据同判')
  // ④ 反例：**不是 git 仓库**（必须真的在仓库之外 —— 放在仓库里的临时目录会让 `git log` 向上找到外层的提交）
  const outside = mkdtempSync(join(tmpdir(), 'sdo-m195-'))
  try {
    const notRepo = { store: new SdoStore(join(outside, '.sdo')), dir: outside }
    mkdirSync(notRepo.store.path(), { recursive: true })
    notRepo.store.writeYaml(['config.yml'], { delivery: { bind: 'commit' } })
    assert.equal(readLastCommitMessage(notRepo.dir).ok, false, '底层读不出时要如实报 ok=false（仓库之外）')
    const broken = CHECKERS['delivery.bound']?.(ctxOf(notRepo.store, notRepo.dir))
    assert.equal(broken?.ok, false, '读不到提交信息必须红（fail-open 只在钩子层，判据层不许放行）')
    assert.match(broken?.detail ?? '', /读不到/u, '回执要说明"读不到提交信息"，而不是"没有哈希"')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('M195-02 §3.5（`DEF-107`）manifest 形态：落点缺失/无哈希/缺路径 ⇒ 各红；清单含哈希 ⇒ 绿', () => {
  const { store, dir } = workspaceOf()
  // ① 声明了 manifest 但**没给落点** ⇒ 红
  store.writeYaml(['config.yml'], { delivery: { bind: 'manifest' } })
  assert.match(CHECKERS['delivery.bound']?.(ctxOf(store, dir))?.detail ?? '', /manifestPath/u, '缺落点要点名 `delivery.manifestPath`')
  // ② 落点**不存在** ⇒ 红
  store.writeYaml(['config.yml'], { delivery: { bind: 'manifest', manifestPath: 'DELIVERY-SHA256.txt' } })
  assert.match(CHECKERS['delivery.bound']?.(ctxOf(store, dir))?.detail ?? '', /不存在/u, '落点不存在必须点名')
  // ③ 落点存在但**没有哈希** ⇒ 红
  writeFileSync(join(dir, 'DELIVERY-SHA256.txt'), 'lib/src/index.js\nlib/client.js\n')
  assert.match(CHECKERS['delivery.bound']?.(ctxOf(store, dir))?.detail ?? '', /没有/u, '清单里没有 hex 必须红')
  // ④ 清单里写上「路径 + 哈希」 ⇒ 绿
  writeFileSync(join(dir, 'DELIVERY-SHA256.txt'), `lib/src/index.js  ${HASH}\n`)
  assert.equal(CHECKERS['delivery.bound']?.(ctxOf(store, dir))?.ok, true, '清单含 64 位哈希 ⇒ 绿')
  // ⑤ 短哈希 / 别的"像哈希"的串**不算**（40 位起；32 位 md5 不算）
  writeFileSync(join(dir, 'DELIVERY-SHA256.txt'), `lib/src/index.js  ${'b'.repeat(32)}\n`)
  assert.equal(CHECKERS['delivery.bound']?.(ctxOf(store, dir))?.ok, false, '32 位（md5）不算产物哈希')
  // ⑥ 流程数据里真的声明了这个 check（数据与代码都要有）
  const waterfall = readFileSync(join(ROOT, 'src', 'data', 'processes', 'waterfall.yml'), 'utf8')
  assert.match(waterfall, /check: "delivery\.bound"/u, 'G7 必须声明 delivery.bound')
  assert.match(waterfall, /id: C-delivery-bound/u, '判据 id 必须是 C-delivery-bound')
})
