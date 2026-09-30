#!/usr/bin/env node
/**
 * CI 的依赖安装器：**两段式**，让 CI 既不需要锁文件、也不假设 `@deepseek-ai/*` 在公开 registry 上。
 *
 *   ① 从 `vendor/` **离线**安装运行时闭包（`dependencies + peerDependencies` 的传递闭包）——
 *      这一半可能只存在于私有 registry，所以随仓库带下来（20 个包 / ~1.7MB）；
 *   ② 再从**公开 registry** 安装 `devDependencies`（`typescript` / `@types/node`）——
 *      这两个包必然在公开源上，而且 `typescript@7` 需要**当前平台**的二进制包
 *      （`@typescript/typescript-<os>-<arch>`）：随仓库存 19 个平台不现实，让 npm 自己按平台取最省事，
 *      也顺带让 Windows runner 能正常编译。
 *
 * 用法（CI 与本地都用同一条）：
 *   node scripts/ci-install.mjs                 # ① + ②
 *   node scripts/ci-install.mjs --runtime-only  # 只装运行时闭包（不装 typescript，不编译）
 *
 * 注意：两段都用 `--no-save --no-package-lock` —— CI 只装不写清单，仓库里不会多出锁文件。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeOnly = process.argv.includes('--runtime-only')
const vendorDir = join(root, 'vendor')
const tarballDir = join(vendorDir, 'tarballs')
const cacheDir = join(vendorDir, 'npm-cache')
const log = (message) => console.log(`[ci-install] ${message}`)
const fail = (message) => {
  console.error(`[ci-install] ✗ ${message}`)
  process.exit(1)
}

if (!existsSync(tarballDir)) fail(`缺少 vendor/tarballs（先在有网络的开发机跑 npm run vendor:ci 并提交 vendor/）`)
const tarballs = readdirSync(tarballDir).filter((name) => name.endsWith('.tgz')).map((name) => join(tarballDir, name))
if (tarballs.length === 0) fail('vendor/tarballs 是空的')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmEnv = {
  ...process.env,
  npm_config_cache: cacheDir,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
}


/**
 * 在**临时前缀**里装，再把结果合并进仓库。
 *
 * 为什么不在仓库里直接 `npm install`：npm 会对 `package.json` 做一次完整 reconcile，**离线时**
 * 只要有一个 devDependency（`@types/node`）取不到就整体失败（实测 `ENOTCACHED`，连
 * `--omit=dev` 都拦不住）。临时前缀里的 package.json 没有任何依赖，npm 只装我们给的那些 tgz。
 */
function installIntoScratch(specs, { offline }) {
  const scratch = join(root, '.ci-scratch')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  writeFileSync(join(scratch, 'package.json'), `${JSON.stringify({ name: 'sdo-ci-scratch', private: true, version: '0.0.0' }, null, 2)}\n`)
  const args = ['install', '--legacy-peer-deps', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--cache', cacheDir]
  if (offline) args.push('--offline')
  else args.push('--prefer-online')
  args.push(...specs)
  const ok = spawnSync(npm, args, { cwd: scratch, env: npmEnv, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0
  if (!ok) return false
  const from = join(scratch, 'node_modules')
  const to = join(root, 'node_modules')
  mkdirSync(to, { recursive: true })
  let merged = 0
  for (const entry of readdirSync(from)) {
    if (entry === '.package-lock.json' || entry === '.bin') continue
    const target = join(to, entry)
    if (existsSync(target)) continue // 已有就不覆盖（CI 里可能被上层缓存复用）
    cpSync(join(from, entry), target, { recursive: true })
    merged += 1
  }
  rmSync(scratch, { recursive: true, force: true })
  log(`合并 ${merged} 项到 node_modules`)
  return true
}

function run(args, label) {
  log(`${label}：npm ${args.slice(0, 4).join(' ')} …`)
  const result = spawnSync(npm, args, { cwd: root, env: npmEnv, stdio: 'inherit', shell: process.platform === 'win32' })
  return result.status === 0
}

// ① 运行时闭包：**不经过 npm**，直接把 vendor 里的 tgz 解成 `node_modules/<包名>`。
// 为什么不用 `npm install --offline <tgz...>`：npm 解析每个 tarball 的依赖时仍会去 registry 拿元数据，
// 即使那个包就在同一批 tgz 里（实测 @deepseek-ai/cosmokit ENOTCACHED）。直接铺目录最简单也最确定。
log(`① 直接解包运行时闭包（${tarballs.length} 个 tgz → node_modules/）`)
const nodeModules = join(root, 'node_modules')
mkdirSync(nodeModules, { recursive: true })
const stage = join(root, '.ci-unpack')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
let placed = 0
for (const tarball of tarballs) {
  const manifestRaw = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' })
  if (manifestRaw.status !== 0) fail(`读不出 ${tarball} 里的 package.json（需要系统 tar；Win10+ 自带）`)
  const meta = JSON.parse(manifestRaw.stdout)
  const target = join(nodeModules, meta.name)
  if (existsSync(target)) continue // 已有就不覆盖
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const extract = spawnSync('tar', ['-xzf', tarball, '-C', stage], { stdio: 'inherit' })
  if (extract.status !== 0) fail(`解包失败：${tarball}`)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(join(stage, 'package'), target, { recursive: true })
  placed += 1
}
rmSync(stage, { recursive: true, force: true })
log(`① 完成：铺设 ${placed} 个包`)


if (runtimeOnly) {
  log('--runtime-only：跳过 devDependencies')
  process.exit(0)
}

// ② devDependencies：公开 registry（typescript 会按平台取自己的二进制包）
const plugin = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const devSpecs = Object.entries(plugin.devDependencies ?? {}).map(([name, range]) => `${name}@${range}`)
if (devSpecs.length === 0) {
  log('package.json 没有 devDependencies，跳过 ②')
  process.exit(0)
}
log(`② 安装 devDependencies（${devSpecs.join(', ')}）—— 走公开 registry，在临时前缀里装后合并`)
if (!installIntoScratch(devSpecs, { offline: false })) {
  fail('devDependencies 安装失败：CI 需要能访问公开 registry（typescript / @types/node）')
}
log('② 完成：依赖就绪，可以 npm run build / npm test')
