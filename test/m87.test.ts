/**
 * **增量 87：宿主版本兼容守卫（0.1.4 起）**
 *
 * 事故背景（2026-10-09）：插件把 5 个 `@deepseek-ai/dsh-*` peer **钉死成精确版本 `0.2.0-rc.1`**，
 * 于是换到 `0.2.1-alpha.1` 宿主时被装配层**硬拒绝**——宿主的判据是
 * `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`：只筛 `@deepseek-ai/dsh` / `dsh-*`
 * 前缀的 peer，用 `semver.satisfies(runtime, range, { includePrerelease: true })`；不匹配则
 * 安装前置检查直接 `installation rejected … nothing was installed`，已装的则启动时拒绝加载，
 * 直到给出精确版本豁免。实测：放宽成 `^0.2.0-rc.1 || ^0.2.1-alpha.1` 后新旧两个 runtime 都通过。
 *
 * 本文件把这次的教训固化成**机械守卫**（不需要联网、也不需要另一个实例）：
 *   · **M87-01** 任何 `dsh-*` peer 都不得写成精确版本（本轮事故的直接成因）；
 *   · **M87-02** peer 范围必须同时满足两件**互相拉扯**的事：
 *     ① **扛未来的 dsh 更新**——宿主的**闸门**（带 `includePrerelease`）必须接受未来版本
 *        （`0.2.2-alpha.1`、`0.3.0-alpha.1`、`0.4.0-rc.1`、`1.0.0` …），否则每次 dsh 升级插件都被硬拒；
 *     ② **已核验的宿主线**（含预发布，如 `0.2.1-alpha.1`）还要过**普通 semver 语义**（包管理器用的那套），
 *        否则装配层会把新宿主判成不满足、给插件私装一份**旧副本**（同进程两份库）。
 *     这两条只能靠"**宽分支 + 逐条列出已验证的预发布线**"同时满足：宽分支扛未来，
 *     显式分支把当前这条预发布线拉进普通语义（稳定版本来就被宽分支覆盖）。
 *   · 同时必须**拒绝** `0.1.x`（本项目只保 0.2 线，不做双版本适配）与 `2.x`（下一个大版本未核验）；
 *   · **M87-03** 插件**自己 `ctx.plugin` 挂载**的两个宿主包（`dsh-plan-mode` / `dsh-session-projection`）
 *     必须列在 peer 而不是 dependencies —— 否则它们会钉死成私有一份，与宿主版本漂移；
 *   · **M87-04** `package-lock.json` 与 `package.json` 的版本/peer/dependencies 必须一致（CI 用 `npm ci`）；
 *   · **M87-05** 守卫自证：拿**旧的**（钉死版本）peer 表跑同一个匹配器，必须在 0.2.1-alpha.1 上判不通过；
 *   · **M87-06** 声明式形状：preset 的 `planning` 组（`cordis:group` + `isolate: { planMode: true }`）里
 *     必须同时有**提供者** plan-mode 与**消费者** `sdo`（isolate 让服务成为组私有实例，组外取不到），
 *     且 `section` 非空。
 *   · **M87-07** 泄漏形状不可复现：插件源码里**没有任何** `ctx.plugin(`/`isolate(` —— 真机事故
 *     （自挂在 root realm 注册服务 ⇒ `Preset services require isolate realms`）的路径已被声明式取代。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'


const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
  version: string
  packages: Record<string, { version?: string; peerDependencies?: Record<string, string>; dependencies?: Record<string, string> }>
}

// —————————————————————— 极简 semver（只为"版本是否落在声明范围内"服务） ——————————————————————

interface Parsed {
  nums: [number, number, number]
  pre: string[]
}

function parse(version: string): Parsed {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u.exec(version.trim())
  assert.ok(match !== null, `版本号解析失败：${version}`)
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** semver 优先级比较（预发布 < 正式；数字段 < 字母段）。 */
function compare(a: string, b: string): number {
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i]! !== y.nums[i]!) return x.nums[i]! < y.nums[i]! ? -1 : 1
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1
  if (y.pre.length === 0) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/u.test(p)
    const qn = /^\d+$/u.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** `^X.Y.Z[-pre]` 的上界（caret 对 0.x 有特例）。 */
function caretUpper(p: Parsed): string {
  const [major, minor, patch] = p.nums
  if (major > 0) return `${major + 1}.0.0`
  if (minor > 0) return `0.${minor + 1}.0`
  return `0.0.${patch + 1}`
}

/**
 * 某个宿主版本是否落在声明范围内。
 *
 * `includePrerelease` 对应宿主闸门的取法（它给 `semver.satisfies` 传了这个开关）；
 * 默认（false）对应包管理器的普通语义 —— **两者都要过**：前者决定"能不能加载"，
 * 后者决定"装配层会不会把宿主那一份包解析给插件"（不认就会另装一份旧副本）。
 *
 * 比较子是**与**关系（空格分隔），分支之间是**或**关系（`||`）。
 */
function rangeAccepts(range: string, version: string, options: { includePrerelease?: boolean } = {}): boolean {
  const v = parse(version)
  const hasPre = v.pre.length > 0
  const ge = (a: string, b: string): boolean => compare(a, b) >= 0
  for (const branch of range.split('||').map((item) => item.trim()).filter((item) => item !== '')) {
    const comparators: { op: string; raw: string; parsed: Parsed }[] = []
    let bad = false
    for (const token of branch.split(/\s+/u).filter((item) => item !== '')) {
      const match = /^(\^|>=|<=|>|<|=)?(.*)$/u.exec(token)
      const op = match?.[1] ?? '='
      const rest = (match?.[2] ?? '').trim()
      if (rest === '' || rest === '*') {
        if (rest === '*') comparators.push({ op: '*', raw: rest, parsed: { nums: [0, 0, 0], pre: [] } })
        else bad = true
        continue
      }
      comparators.push({ op, raw: rest, parsed: parse(rest) })
    }
    if (bad || comparators.length === 0) continue
    // 预发布准入（普通语义）：只有**同一 [major,minor,patch] 元组**的边界带预发布时，预发布版本才被允许
    if (hasPre && options.includePrerelease !== true) {
      const unlocked = comparators.some((item) => item.parsed.pre.length > 0
        && item.parsed.nums[0] === v.nums[0] && item.parsed.nums[1] === v.nums[1] && item.parsed.nums[2] === v.nums[2])
      if (!unlocked) continue
    }
    const holds = comparators.every((item) => {
      switch (item.op) {
        case '*': return true
        case '>=': return ge(version, item.raw)
        case '>': return compare(version, item.raw) > 0
        case '<=': return compare(version, item.raw) <= 0
        case '<': return compare(version, item.raw) < 0
        case '=': return compare(version, item.raw) === 0
        case '^': return ge(version, item.raw) && compare(version, caretUpper(item.parsed)) < 0
        default: return false
      }
    })
    if (holds) return true
  }
  return false
}

/** **已核验**的宿主版本（真机/类型面/契约三层都跑过；每核验一个就加进来）。 */
const VERIFIED_HOSTS = ['0.2.0-rc.1', '0.2.1-alpha.1']
/** 未来版本：**闸门语义**必须接受（dsh 更新不该把插件硬拒）。 */
const FUTURE_GATE_OK = ['0.2.2-alpha.1', '0.2.5', '0.3.0-alpha.1', '0.3.0', '0.4.0-rc.1', '1.0.0', '1.2.3']
/** 未来**稳定版**：普通语义也要接受（装配层才会把宿主那一份包解析给插件）。 */
const FUTURE_PLAIN_OK = ['0.2.2', '0.2.5', '0.3.0', '1.0.0', '1.2.3']
/** 明确**不**声明支持的线：0.1.x（本项目只保 0.2 线）与 2.x（下一个大版本未核验）。 */
const MUST_REJECT = ['0.1.5-rc.2', '0.1.6-alpha.2', '0.1.5', '2.0.0-alpha.1', '2.0.0', '3.0.0']

const dshPeers = (): [string, string][] =>
  Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

// ————————————————————————————— 守卫本体 —————————————————————————————

test('M87-01 任何 `dsh-*` peer 都不许写成精确版本（0.1.3 被 0.2.1 拒绝的直接成因）', () => {
  const peers = dshPeers()
  assert.ok(peers.length >= 5, `要覆盖插件真正 import 的宿主包，当前 ${peers.length} 个`)
  const pinned = peers.filter(([, range]) => !/[\^~]|>=|\*|\|\|/u.test(range))
  assert.deepEqual(pinned, [], `这些 peer 是精确版本（换小版本就会被装配层拒）：${JSON.stringify(pinned)}`)
})

test('M87-02 peer 范围：扛未来 dsh 版本（闸门语义）+ 已核验宿主线过普通语义 + 拒绝 0.1.x/2.x', () => {
  for (const [name, range] of dshPeers()) {
    for (const host of VERIFIED_HOSTS) {
      assert.ok(
        rangeAccepts(range, host),
        `${name} 的范围「${range}」在**普通** semver 语义下不接受已核验的 ${host}`
        + `（宿主闸门带 includePrerelease 会放行，但包管理器会另装一份旧副本 ⇒ 同进程两份库；`
        + `请把这条预发布线显式列进并集，例如 || ^${host.replace(/-.*$/u, '')}-alpha.1）`,
      )
      assert.ok(rangeAccepts(range, host, { includePrerelease: true }), `${name} 的范围「${range}」在宿主的闸门语义下不接受 ${host}`)
    }
    // ① 扛未来：闸门语义必须接受未来版本，否则每次 dsh 更新都会被硬拒
    for (const future of FUTURE_GATE_OK) {
      assert.ok(
        rangeAccepts(range, future, { includePrerelease: true }),
        `${name} 的范围「${range}」不接受未来的 ${future} —— dsh 一升级插件就会被装配层拒绝，`
        + `应写成宽分支（如 >=0.2.0-rc.1 <2.0.0-0）扛住未来 0.x/1.x`,
      )
    }
    // 未来**稳定版**还要过普通语义（装配层才会把宿主那一份包解析给插件）
    for (const future of FUTURE_PLAIN_OK) {
      assert.ok(rangeAccepts(range, future), `${name} 的范围「${range}」在普通语义下不接受未来的稳定版 ${future}`)
    }
    for (const bad of MUST_REJECT) {
      assert.ok(!rangeAccepts(range, bad, { includePrerelease: true }), `${name} 不该接受 ${bad}（范围「${range}」）`)
      assert.ok(!rangeAccepts(range, bad), `${name} 不该接受 ${bad}（普通语义，范围「${range}」）`)
    }
  }
})

test('M87-03 插件自己挂载的两个宿主包必须是 peer（不得钉成私有一份的 dependencies）', () => {
  const peers = manifest.peerDependencies ?? {}
  const deps = manifest.dependencies ?? {}
  for (const name of ['@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-session-projection']) {
    assert.ok(name in peers, `${name} 必须在 peerDependencies 里（要与宿主同版本）`)
    assert.ok(!(name in deps), `${name} 不得留在 dependencies（会钉死成私有一份 ⇒ 与宿主版本漂移）`)
  }
})

test('M87-04 package-lock.json 与 package.json 一致（CI 用 `npm ci`，不一致会直接失败）', () => {
  const root = lock.packages['']
  assert.ok(root !== undefined, 'lock 里必须有根包条目')
  assert.equal(root.version, manifest.version, 'lock 根包的 version 必须与 package.json 一致')
  assert.equal(lock.version, manifest.version, 'lock 顶层 version 必须与 package.json 一致')
  assert.deepEqual(root.peerDependencies ?? {}, manifest.peerDependencies ?? {}, 'lock 根包的 peerDependencies 必须与 package.json 一致')
  assert.deepEqual(root.dependencies ?? {}, manifest.dependencies ?? {}, 'lock 根包的 dependencies 必须与 package.json 一致')
})

test('M87-05 守卫自证：旧的"钉死版本"peer 表必须在 0.2.1-alpha.1 上被判不通过', () => {
  const legacy = '0.2.0-rc.1' // 0.1.3 的实际声明
  assert.equal(rangeAccepts(legacy, '0.2.0-rc.1'), true, '旧声明在旧宿主上本来就该通过')
  assert.equal(rangeAccepts(legacy, '0.2.1-alpha.1'), false, '旧声明在新宿主上必须不通过 —— 这正是本轮事故')
  // 换片段式修补（只把上界放开、不逐线列预发布）也要被抓：闸门过了，包管理器仍不认
  const sneaky = '>=0.2.0-rc.1 <0.3.0'
  assert.equal(rangeAccepts(sneaky, '0.2.1-alpha.1', { includePrerelease: true }), true, '闸门语义下放行（这就是它看起来"改了"的原因）')
  assert.equal(rangeAccepts(sneaky, '0.2.1-alpha.1'), false, '普通语义下仍不认 ⇒ 守卫必须按普通语义判（否则漏掉两份库的风险）')
  // 只放宽、不逐条列预发布线（宽分支）：闸门过、普通不过 —— 这正是"两台机器两种结论"的坑
  const broad = '>=0.2.0-rc.1 <2.0.0-0'
  assert.equal(rangeAccepts(broad, '0.2.1-alpha.1', { includePrerelease: true }), true, '宽分支在闸门语义下放行')
  assert.equal(rangeAccepts(broad, '0.2.1-alpha.1'), false, '宽分支在普通语义下不认当前这条预发布线 ⇒ 必须再补一条显式分支')
  // 现声明必须两种语义都过
  const current = '>=0.2.0-rc.1 <2.0.0-0 || ^0.2.1-alpha.1'
  assert.equal(rangeAccepts(current, '0.2.0-rc.1'), true)
  assert.equal(rangeAccepts(current, '0.2.1-alpha.1'), true)
  assert.equal(rangeAccepts(current, '0.2.1-alpha.1', { includePrerelease: true }), true)
  assert.equal(rangeAccepts(current, '0.3.0'), true, '宽分支要扛住整条 0.x')
  assert.equal(rangeAccepts(current, '1.2.3'), true, '1.x 稳定版也在宽分支内')
  assert.equal(rangeAccepts(current, '2.0.0-alpha.1'), false, '下一个大版本要拒')
  assert.equal(rangeAccepts(current, '2.0.0'), false)
})

test('M87-06 声明式形状：preset 的 `planning` 组必须 isolate planMode，且**消费者与提供者同组**', () => {
  const preset = readFileSync(join(ROOT, 'presets', 'sdo-office.patch.yml'), 'utf8')
  const lines = preset.split('\n')
  const indentOfLine = (index: number): number => (lines[index] as string).length - (lines[index] as string).trimStart().length
  const groupLine = lines.findIndex((line) => line.trim() === '- id: planning')
  assert.ok(groupLine > 0, 'preset 必须有一个 `planning` 组（plan-mode 的 isolate realm）')
  const groupIndent = indentOfLine(groupLine)
  // ① 组行必须是 cordis:group + group: true + isolate planMode
  const groupHead = lines.slice(groupLine, groupLine + 6).map((line) => line.trim())
  assert.ok(groupHead.includes("name: cordis:group"), `组行必须是 cordis:group：${groupHead.join(' | ')}`)
  assert.ok(groupHead.includes('group: true'), '组行必须写 group: true')
  assert.ok(
    groupHead.some((line) => /^planMode:\s*true$/u.test(line)),
    '组行必须声明 isolate: { planMode: true }（0.2.1 的 preset 泄漏审计要求：'
    + 'preset 子树里注册的服务必须写在 isolate realm 里，否则报 `Preset services require isolate realms: planMode` 并整个 preset 注册失败）',
  )
  // ② 提供者（plan-mode）与**消费者**（sdo）都必须在同一个组里（isolate 让 planMode 成为组私有实例：
  //    组外的消费者取不到它 ⇒ 历史缺陷"架构阶段永久阻塞"复发）
  const inGroup = (id: string): boolean => {
    const row = lines.findIndex((line) => line.trim() === `- id: ${id}`)
    return row > groupLine && indentOfLine(row) > groupIndent
  }
  assert.ok(inGroup('plan-mode'), 'plan-mode 行必须在 planning 组之内')
  assert.ok(inGroup('sdo'), '`sdo` 行必须在**同一个** planning 组之内（消费者与提供者同 realm）')
  // ③ plan-mode 行的 section 非空（空配置会让装载在子 fiber 静默失败、服务永不注册 —— 历史事故）
  const planRow = lines.findIndex((line) => line.trim() === '- id: plan-mode')
  const sectionLine = lines.findIndex((line, index) => index > planRow && line.trim() === 'section: |')
  assert.ok(sectionLine > planRow, 'plan-mode 行必须给 `section: |`')
  const sectionIndent = indentOfLine(sectionLine)
  const body = lines.slice(sectionLine + 1).filter((line) => line.trim() !== '' && indentOfLine(lines.indexOf(line)) > sectionIndent)
  assert.ok(body.length >= 1 && body.join('').trim().length > 100, 'section 不能为空（且要有结构化计划要求）')
})

test('M87-07 泄漏形状不可复现：插件**不再自挂任何服务**，也不再自己建 realm（改由 preset 声明）', () => {
  // 真机事故的形状：插件在 preset 子树里 `ctx.plugin(...)` 挂服务、注册进 root realm ⇒
  // 0.2.1 的 mountPreset/leakedServices 判 `Preset services require isolate realms: planMode`。
  // 声明式改造后这条路径不存在：源码里既没有 `ctx.plugin(`，也没有 `isolate(`。
  const raw = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  // **只扫真正的代码行，不扫注释**（注释里会写到"以前那种 `ctx.plugin(...)` 自挂"这类说明，
  // 把它当调用是误报 —— 与本项目 test/m7 扫 preset 时的既有规矩一致）。
  const source = raw.split('\n').filter((line) => {
    const trimmed = line.trimStart()
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
  }).join('\n')
  const selfMounts = [...source.matchAll(/ctx\.plugin\(|realm\.plugin\(/gu)].map((match) => match[0])
  assert.deepEqual(selfMounts, [], `插件不得自挂宿主插件（真机事故的形状）：${selfMounts.join('、')}`)
  assert.equal(/ctx\.isolate\(/u.test(source), false, '不得在代码里自建 realm（改由 preset 的 `isolate:` 声明）')
  // 只保留"消费"侧的接线：拿不到服务时退回两条手动出口
  assert.match(source, /ctx\.inject\(\['planMode'\]/u, '仍要现取 planMode（拿不到就退回 sdo_design action=review|waive-plan）')
})
