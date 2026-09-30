#!/usr/bin/env node
/**
 * 把 **CI 所需的全部依赖**打包进 `vendor/`，让 CI 不再依赖任何 registry 与锁文件。
 *
 * 为什么需要它：
 *   · 本仓库没有 `package-lock.json`（生成它需要联网），而 `npm ci` / `setup-node` 的 `cache: npm`
 *     都要求锁文件 ⇒ 公开仓库的 CI 在"装依赖"这一步就会失败；
 *   · 更要紧的是：本插件的 `dependencies`/`peerDependencies` 都是官方 `@deepseek-ai/*` 包，
 *     它们**未必在公开 registry 上**。靠 registry 的 CI 是"能不能跑看运气"，不是工程。
 *
 * 做法：把 `devDependencies + dependencies + peerDependencies` 的**传递闭包**（含各包的 peer）
 * 全部 `npm pack` 成 tgz，并预填一份 npm 缓存；CI 用
 *   `node scripts/ci-install.mjs`
 * 从 `vendor/` **离线安装**，从此不碰网络。
 *
 * 使用：`npm run vendor:ci`（在**已装好依赖**的开发机上跑一次，产物提交进仓库）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const vendorDir = join(root, 'vendor')
const tarballDir = join(vendorDir, 'tarballs')
const buildCache = join(root, '.pack-cache')
const log = (message) => console.log(`[vendor-ci] ${message}`)
const fail = (message) => {
  console.error(`[vendor-ci] ✗ ${message}`)
  process.exit(1)
}

const plugin = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
/**
 * 根集合 = `dependencies + peerDependencies`（**不含 devDependencies**）。
 *
 * 为什么把 devDependencies 排除在外：`typescript@7` 把编译器拆成 19 个**平台专属**可选包
 * （`@typescript/typescript-<os>-<arch>`），本机只有当前平台那一份 —— 想给 Windows runner 也 vendor
 * 就得把 win32 的二进制也搞到手（本地没有）。而 `typescript` / `@types/node` 是**公开 registry 上
 * 必然存在**的包，让 CI 自己去取既省体积（vendor 从几十 MB 降到几 MB），又能自动匹配各平台二进制。
 * `--with-dev` 可强制连 devDependencies 一起 vendor（想在完全隔离环境里跑时用）。
 */
const withDev = process.argv.includes('--with-dev')
const wanted = {
  ...(withDev ? Object.fromEntries(Object.entries(plugin.devDependencies ?? {}).map(([k, v]) => [k, `dev:${v}`])) : {}),
  ...Object.fromEntries(Object.entries(plugin.dependencies ?? {}).map(([k, v]) => [k, `dep:${v}`])),
  ...Object.fromEntries(Object.entries(plugin.peerDependencies ?? {}).map(([k, v]) => [k, `peer:${v}`])),
}

/**
 * 依赖搜索路径（按优先级）：
 *   ① 本包 node_modules ② monorepo 根 node_modules ③ 两侧的 pnpm store
 *   ④ 最后才看 dsh 安装树的 store（本机开发环境专用；命中会记进 manifest 以便复核）
 */
/**
 * 搜索路径优先级 —— **顺序即正确性**，踩过坑：
 * ① **宿主 dsh 安装树的 store 最优先**：它才是这套插件真正运行的依赖图（实测 `cosmokit`
 *    宿主是 1.8.5，而某个同级包的 node_modules 里躺着 1.8.3 —— 1.8.3 缺 `Binary` 导出，
 *    vendor 错了版本会让 CI 里 `schemastery` 一 import 就报符号错误）。
 * ② monorepo 根 → ③ 本包 node_modules → ④ 同级包的 node_modules（最后，仅作兜底）。
 */
function searchRoots() {
  const roots = []
  const dshHomes = []
  const explicit = process.env['DSH_HOME']
  if (explicit !== undefined && explicit !== '') dshHomes.push(resolve(explicit, '..'))
  for (const base of [join(homedir(), '.local', 'share', 'hdsl', 'instances')]) {
    if (!existsSync(base)) continue
    for (const version of readdirSync(base).sort()) dshHomes.push(join(base, version))
  }
  const localAppData = process.env['LOCALAPPDATA']
  if (localAppData !== undefined) {
    const base = join(localAppData, 'hdsl', 'instances')
    if (existsSync(base)) for (const version of readdirSync(base).sort()) dshHomes.push(join(base, version))
  }
  for (const instance of dshHomes.reverse()) {
    const store = join(instance, 'dsh', 'node_modules')
    if (existsSync(store)) roots.push(store)
  }
  const mono = resolve(root, '..', '..')
  if (existsSync(join(mono, 'node_modules'))) roots.push(join(mono, 'node_modules'))
  roots.push(join(root, 'node_modules'))
  // 同级包（monorepo 的兄弟）各自的 node_modules：只作最后兜底
  const packagesDir = resolve(root, '..')
  if (existsSync(packagesDir)) {
    for (const sibling of readdirSync(packagesDir)) {
      const dir = join(packagesDir, sibling, 'node_modules')
      if (dir !== join(root, 'node_modules') && existsSync(dir)) roots.push(dir)
    }
  }
  const pnpmStores = roots.filter((dir) => existsSync(join(dir, '.pnpm'))).map((dir) => join(dir, '.pnpm'))
  return { roots, pnpmStores }
}

const { roots, pnpmStores } = searchRoots()

function locate(name) {
  const prefix = name.replace('/', '+')
  // **按 root 顺序逐个查**：同一优先级里先看扁平目录，再看它自己的 pnpm store。
  // 不能"先把所有扁平目录扫完再扫所有 store" —— 那会让低优先级的兄弟包盖掉高优先级的宿主 store（踩过）。
  for (const dir of roots) {
    const flat = join(dir, name)
    if (existsSync(join(flat, 'package.json'))) return { dir: flat, source: dir }
    const store = join(dir, '.pnpm')
    if (!existsSync(store)) continue
    for (const entry of readdirSync(store).sort()) {
      if (!entry.startsWith(`${prefix}@`)) continue
      const candidate = join(store, entry, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return { dir: candidate, source: store }
    }
  }
  return undefined
}

/** 传递闭包：dependencies + peerDependencies + optionalDependencies（都要，否则 CI 里解析不到）。 */
const located = new Map()
const missing = []
/**
 * 遍历规则（与 CI 安装时用的 `--legacy-peer-deps` **同语义**）：
 *   · 根包的 `dependencies` + `peerDependencies` 都要（前者是运行时必需，后者由本插件直接 import）；
 *   · 依赖包的 `dependencies` 继续跟；
 *   · 依赖包的 `peerDependencies` **不跟** —— 跟了会把宿主/工具链的开发期包（cordis 插件、eslint、
 *     js-yaml 之类）整片拖进来，既臃肿又与 npm 实际安装结果不一致。
 */
const walk = (name, fromDir, followPeers) => {
  if (located.has(name)) return
  const hit = (fromDir === undefined ? undefined : (() => {
    const nested = join(fromDir, 'node_modules', name)
    return existsSync(join(nested, 'package.json')) ? { dir: nested, source: join(fromDir, 'node_modules') } : undefined
  })()) ?? locate(name)
  if (hit === undefined) {
    missing.push(name)
    return
  }
  const pkg = JSON.parse(readFileSync(join(hit.dir, 'package.json'), 'utf8'))
  located.set(name, { version: pkg.version, dir: hit.dir, source: hit.source })
  // optionalDependencies：**只收当前平台那一份**。
  // 为什么：`typescript@7` 把编译器按平台拆成 `@typescript/typescript-<os>-<arch>` 可选包，
  // 19 个平台的二进制既装不到（本机只有当前平台）也没必要 —— 收全了脚本会直接失败。
  const platformTag = `${process.platform}-${process.arch}`
  const optional = Object.keys(pkg.optionalDependencies ?? {}).filter((dep) => dep.includes(platformTag))
  // 依赖包的 peer：**只跟 `@deepseek-ai/*`**。
  // 为什么跟：`dsh-tools` 的 peer 里就有 `@deepseek-ai/dsh-sandbox`，缺了它运行时直接
  //   `ERR_MODULE_NOT_FOUND`（实测：CI 模拟里 m7/office 两个测试文件整个加载失败）。
  // 为什么不跟第三方：cordis 插件、eslint、js-yaml 这类是宿主/工具链的开发期 peer，
  //   跟进来既臃肿又与 npm 的实际安装结果不一致。
  const depPeers = Object.keys(pkg.peerDependencies ?? {}).filter((dep) => dep.startsWith('@deepseek-ai/'))
  for (const dep of Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(followPeers ? (pkg.peerDependencies ?? {}) : {}),
    ...Object.fromEntries(depPeers.map((dep) => [dep, true])),
    ...Object.fromEntries(optional.map((dep) => [dep, true])),
  })) {
    walk(dep, hit.dir, false)
  }
}

for (const name of Object.keys(wanted)) walk(name, undefined, true)
if (missing.length > 0) {
  fail(`这些包装不出来（CI 会缺依赖）：${missing.join(', ')}\n  提示：先在开发机跑 npm install 装好依赖，或把缺失包手工放进 node_modules`)
}
log(`闭包解析完成：${located.size} 个包`)

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(tarballDir, { recursive: true })
mkdirSync(buildCache, { recursive: true })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, npm_config_cache: options.cache ?? buildCache, npm_config_audit: 'false', npm_config_fund: 'false' },
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    const detail = options.capture === true ? `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`.trim() : ''
    fail(`${command} ${args.join(' ')} 失败${detail === '' ? '' : `\n${detail}`}`)
  }
}

for (const [name, info] of located) {
  run('npm', ['pack', info.dir, '--pack-destination', tarballDir, '--silent', '--ignore-scripts'])
  log(`  · ${name}@${info.version}${info.source.includes('.pnpm') ? '（pnpm store）' : ''}`)
}

// 不再预填 npm 缓存：CI 安装器是**直接把 tgz 解开铺成 node_modules**（见 scripts/ci-install.mjs），
// 完全不经过 npm，缓存只会是死重。
const tgzFiles = readdirSync(tarballDir).filter((name) => name.endsWith('.tgz'))

const manifest = {
  generatedAt: new Date().toISOString(),
  from: process.platform,
  node: process.version,
  root: Object.fromEntries(Object.entries(wanted).map(([name, spec]) => [name, spec])),
  packages: Object.fromEntries([...located].map(([name, info]) => [name, { version: info.version, via: info.source.includes('.pnpm') ? 'pnpm-store' : 'node_modules' }])),
  tarballs: tgzFiles.sort(),
}
writeFileSync(join(vendorDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(
  join(vendorDir, 'README.md'),
  `# vendor/ —— CI 的离线依赖

**不要手工改这里**。它由 \`npm run vendor:ci\`（\`scripts/vendor-ci.mjs\`）生成，内容是本插件
\`devDependencies + dependencies + peerDependencies\` 的**传递闭包**（含各包的 peer），共 **${located.size}** 个包。

CI 用 \`node scripts/ci-install.mjs\` 从这里**离线安装**，因此：

- **不需要 \`package-lock.json\`**（也就没有 \`npm ci\` / \`cache: npm\` 的锁文件前置）；
- **不需要 registry**（\`@deepseek-ai/*\` 就算不在公开源上也能构建与测试）；
- 换依赖后**重新生成**：\`npm install\`（联网开发机）→ \`npm run vendor:ci\` → 提交 \`vendor/\`。
`,
)

let total = 0
for (const file of tgzFiles) total += statSync(join(tarballDir, file)).size
log(`完成：${tgzFiles.length} 个 tgz，${(total / 1048576).toFixed(2)} MB → ${vendorDir}`)
