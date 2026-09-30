#!/usr/bin/env node
/**
 * 离线安装器（被打包器复制进离线包，成为包内的 `install.mjs`）。
 *
 * 用法（Linux/macOS 用 ./install.sh，Windows 用 .\install.ps1，都是它的薄包装）：
 *   node install.mjs --profile web            # 安装
 *   node install.mjs --profile web --dry-run  # 只打印计划，不落盘
 *   node install.mjs --profile web --verify   # 只校验
 *   node install.mjs --profile web --uninstall
 *   常用参数：--dsh-home <instances/<ver>/home>（目录不标准时显式给）
 *
 * 设计要点（都有真机教训背书）：
 *   1. **离线**：只用包内 `npm-cache/` 与 `tarballs/`，npm 一律带 `--offline --cache <包内缓存>`；
 *      全局 npm 缓存在受限环境可能只读（实测 `error writing to the directory: /home/…/.npm/_logs`）。
 *   2. **`--legacy-peer-deps`**：插件的 `peerDependencies` 由**宿主**提供。不加这个参数，npm 会去
 *      联网解析 peer ⇒ 离线必失败；加了它 npm 只装 tarballs 里的东西。
 *   3. **peer 链接**：插件自己的 peer（`@deepseek-ai/*`）由宿主的 dsh 安装树提供。安装器把宿主
 *      store 里的实例**软链**到 `<profile>/node_modules/`，让 Node 从插件位置向上解析时能命中
 *      **同一个实例** —— 绝不能拷一份 `@deepseek-ai/cordis` 进来：那会产生第二份服务注册表，
 *      `Service`/服务查找会静默错乱（这是本项目最贵的一类 bug）。
 *   4. **登记 bundle**：改 `<profile>/package.json` 的 `dsh.profile.bundles` 前先留
 *      `.bak-offline-<时间戳>` 备份；卸载时按备份语义恢复（只摘自己加的那一条）。
 */
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const bundleRoot = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
/**
 * 取参数值：**同时支持 `--flag=value` 与 `--flag value`**。
 * 只认前者是真机踩过的坑：空格写法被静默忽略 → 回退到 `DSH_HOME` 环境变量 →
 * 差点往**真实例**里装（被只读沙箱拦下才没出事）。参数解析错 = 装错地方，必须两种都认。
 */
const valueOf = (flag, fallback) => {
  const inline = argv.find((item) => item.startsWith(`${flag}=`))
  if (inline !== undefined) return inline.slice(flag.length + 1)
  const index = argv.indexOf(flag)
  if (index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) return argv[index + 1]
  return fallback
}

const profileName = valueOf('--profile', 'web')
const dryRun = has('--dry-run')
const uninstall = has('--uninstall')
const verifyOnly = has('--verify')
const linkPeers = !has('--no-peer-links')

const installedEntries = [] // 我们这次装进去的路径（卸载时精确回收）
const say = (message) => console.log(`[install-offline] ${message}`)
const warn = (message) => console.warn(`[install-offline] ⚠ ${message}`)
const die = (message) => {
  console.error(`[install-offline] ✗ ${message}`)
  process.exit(1)
}

const manifestPath = join(bundleRoot, 'manifest.json')
if (!existsSync(manifestPath)) die(`这不是离线包目录（缺少 manifest.json）：${bundleRoot}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const tarballDir = join(bundleRoot, 'tarballs')
const cacheDir = join(bundleRoot, 'npm-cache')
const tarballs = readdirSync(tarballDir).filter((name) => name.endsWith('.tgz')).map((name) => join(tarballDir, name))

/** 候选 dsh home：`<instances>/<ver>/home`（各平台默认位置都扫一遍）。 */
function dshHomeCandidates() {
  const roots = []
  const local = process.env['LOCALAPPDATA']
  if (local !== undefined) roots.push(join(local, 'hdsl', 'instances'))
  roots.push(join(homedir(), '.local', 'share', 'hdsl', 'instances'))
  const out = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const version of readdirSync(root)) {
      const home = join(root, version, 'home')
      if (existsSync(join(home, 'profiles'))) out.push(home)
    }
  }
  // 版本目录按名字升序，取最后一个（最新）
  return out.sort()
}

function resolveDshHome() {
  const explicit = valueOf('--dsh-home', process.env['DSH_HOME'])
  if (explicit !== undefined && explicit !== '') {
    const home = resolve(explicit)
    if (!existsSync(join(home, 'profiles'))) die(`--dsh-home 指向的目录没有 profiles/：${home}`)
    return home
  }
  const candidates = dshHomeCandidates().filter((home) => existsSync(join(home, 'profiles', profileName)))
  if (candidates.length === 0) {
    die(`找不到含 profiles/${profileName} 的 dsh home。请用 --dsh-home <instances/<ver>/home> 或设置 DSH_HOME`)
  }
  return candidates[candidates.length - 1]
}

const dshHome = resolveDshHome()
const profileDir = join(dshHome, 'profiles', profileName)
const instanceDir = dirname(dshHome)
const hostCli = join(instanceDir, 'dsh', 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const statePath = join(profileDir, '.dsh-offline-state.json')

say(`dsh home ：${dshHome}`)
say(`profile  ：${profileName} → ${profileDir}`)
say(`离线包   ：${manifest.name}@${manifest.version}（闭包 ${Object.keys(manifest.closure).length} 个包，peer ${manifest.peers.length} 个）`)

if (uninstall) {
  const state = readState()
  if (state === undefined) warn('没有找到安装记录（.dsh-offline-state.json），只按名字清理')
  const recorded = state?.installedEntries ?? [join(profileDir, 'node_modules', manifest.name)]
  plan(`回收本次安装写入的 ${recorded.length} 条路径（含闭包与 peer 链接）`)
  plan(`从 package.json 的 dependencies 与 dsh.profile.bundles 摘掉 ${manifest.name}`)
  if (!dryRun) {
    for (const target of recorded) rmSync(target, { recursive: true, force: true })
    // 剪掉空目录（例如删空后的 @deepseek-ai）
    for (const dir of [join(profileDir, 'node_modules', '@deepseek-ai')]) {
      try {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 剪不掉就算了 */
      }
    }
    for (const link of state?.peerLinks ?? []) {
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
      } catch {
        /* 链接已不在就算了 */
      }
    }
    const pkg = readProfilePackage()
    if (pkg !== undefined) {
      delete pkg.dependencies?.[manifest.name]
      if (Array.isArray(pkg.dsh?.profile?.bundles)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((item) => item !== manifest.name)
      }
      writeProfilePackage(pkg)
    }
    rmSync(statePath, { force: true })
  }
  say(dryRun ? '（dry-run，未改动）' : '✓ 已卸载；重启 dsh 生效')
  process.exit(0)
}

if (verifyOnly) {
  const ok = verifyInstall()
  process.exit(ok ? 0 : 1)
}

// ── 安装 ────────────────────────────────────────────────────────────────
plan(`用离线 npm 把 ${tarballs.length} 个 tgz 装进 ${profileDir}`)
const peerPlan = linkPeers ? findPeerLinks() : []
for (const item of peerPlan) plan(`链接宿主 peer：${item.name} → ${item.target}`)
plan(`把 ${manifest.name} 登记进 package.json 的 dsh.profile.bundles（改前留备份）`)
if (dryRun) {
  say('（dry-run：以上计划未执行）')
  process.exit(0)
}

// 可写性前置检查：只读目标要**早失败**并说清楚，而不是装到一半留半成品
try {
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  accessSync(profileDir, constants.W_OK)
} catch (error) {
  die(`目标 profile 不可写：${profileDir}（${error instanceof Error ? error.message : String(error)}）\n  本地验证请用 --dsh-home 指向一个可写的假实例`)
}
installTarballs()
linkPeerInstances(peerPlan)
registerBundle()
const state = {
  name: manifest.name,
  version: manifest.version,
  at: new Date().toISOString(),
  peerLinks: peerPlan.map((item) => item.link),
  installedEntries: [...installedEntries],
}
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
const ok = verifyInstall()
say(ok ? `✓ 安装完成；**请重启 dsh**，然后在新建会话时选择 SDO 研发办公室（驾驶舱）preset` : '⚠ 安装脚本跑完了，但校验未通过（见上）')
process.exit(ok ? 0 : 1)

// ── 实现细节 ────────────────────────────────────────────────────────────
function plan(message) {
  console.log(`[install-offline]   · ${message}`)
}

function readProfilePackage() {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function writeProfilePackage(pkg) {
  const target = join(profileDir, 'package.json')
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    cpSync(target, `${target}.bak-offline-${stamp}`)
    say(`已备份原 package.json → package.json.bak-offline-${stamp}`)
  }
  writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`)
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 在**临时前缀**里离线装，再把结果**合并**进 profile。
 *
 * 为什么不在 profile 里直接装：npm 会对整个前缀做一次 "reify"（重建整棵树），
 * 连**别人的** `file:` 依赖也想动（实测它去 rename `<profile>/node_modules/dsh-memory-layer` ✗）。
 * 离线安装器**只该影响自己那几个包**，所以先在 scratch 里装好，再逐项拷贝（已存在就跳过并告警）。
 */
function installTarballs() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const scratch = join(bundleRoot, '.scratch-install')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  writeFileSync(join(scratch, 'package.json'), `${JSON.stringify({ name: 'sdo-offline-scratch', private: true, version: '0.0.0' }, null, 2)}\n`)
  const args = [
    'install',
    '--offline', // 只用包内缓存，绝不联网
    '--legacy-peer-deps', // peer 由宿主提供：不加这个参数会去联网解析 peer
    '--no-audit',
    '--no-fund',
    '--prefix',
    scratch,
    '--cache',
    cacheDir,
    ...tarballs,
  ]
  say(`执行：npm install --offline --legacy-peer-deps …（${tarballs.length} 个 tgz，装在临时前缀里）`)
  const result = spawnSync(npm, args, {
    cwd: scratch,
    env: { ...process.env, npm_config_cache: cacheDir, npm_config_audit: 'false', npm_config_fund: 'false' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) die(`npm 离线安装失败（退出码 ${result.status}）。若提示缺包，说明离线包不完整`)
  mergeInto(join(scratch, 'node_modules'), join(profileDir, 'node_modules'))
  rmSync(scratch, { recursive: true, force: true })
}

/** 把 scratch 里装好的包合并进 profile：**已存在的一律跳过并告警**（不覆盖现有安装）。 */
function mergeInto(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    if (entry === '.package-lock.json' || entry === '.bin') continue
    const target = join(to, entry)
    if (existsSync(target)) {
      warn(`已存在，跳过（不覆盖）：${entry}`)
      continue
    }
    cpSync(join(from, entry), target, { recursive: true })
    installedEntries.push(target) // 只有**我们新建**的路径才登记（卸载时精确回收，不碰别人的东西）
  }
  say(`已合并 ${manifest.name} 及其闭包到 ${to}（新增 ${installedEntries.length} 项）`)
}

/**
 * 找到宿主的 peer 实例：`<instance>/dsh/node_modules/.pnpm/<name→+>@<版本>/node_modules/<name>`。
 * 链接（而不是拷贝）保证与宿主共用**同一个**实例。
 */
function findPeerLinks() {
  const store = join(instanceDir, 'dsh', 'node_modules', '.pnpm')
  const out = []
  if (!existsSync(store)) {
    warn(`找不到宿主 store（${store}），跳过 peer 链接`)
    return out
  }
  const entries = readdirSync(store)
  for (const name of manifest.peers) {
    const prefix = name.replace('/', '+')
    const hits = entries.filter((entry) => entry.startsWith(`${prefix}@`)).sort()
    if (hits.length === 0) {
      warn(`宿主 store 里没有 ${name}（可能是宿主版本不同）`)
      continue
    }
    const target = join(store, hits[hits.length - 1], 'node_modules', name)
    if (!existsSync(join(target, 'package.json'))) continue
    out.push({ name, target, link: join(profileDir, 'node_modules', name) })
  }
  return out
}

function linkPeerInstances(items) {
  for (const item of items) {
    if (existsSync(item.link)) {
      say(`peer 已存在，跳过：${item.name}`)
      continue
    }
    mkdirSync(dirname(item.link), { recursive: true })
    try {
      // Windows 目录链接用 junction：不需要管理员权限
      symlinkSync(item.target, item.link, process.platform === 'win32' ? 'junction' : 'dir')
      say(`已链接 peer：${item.name}`)
    } catch (error) {
      warn(`链接 ${item.name} 失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
}

function registerBundle() {
  const pkg = readProfilePackage() ?? {}
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [manifest.name]: `file:${join(profileDir, 'node_modules', manifest.name)}` }
  const dsh = { ...(pkg.dsh ?? {}) }
  const profile = { ...(dsh.profile ?? {}) }
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles] : []
  if (!bundles.includes(manifest.name)) bundles.push(manifest.name)
  profile.bundles = bundles
  dsh.profile = profile
  pkg.dsh = dsh
  writeProfilePackage(pkg)
  say(`已登记 bundle：${bundles.join(', ')}`)
}

function verifyInstall() {
  const entry = join(profileDir, 'node_modules', manifest.name, 'lib', 'src', 'index.js')
  if (!existsSync(entry)) {
    warn(`模块入口不存在：${entry}`)
    return false
  }
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('import-ok')`],
    { cwd: profileDir, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const probeOut = `${probe.stdout?.toString() ?? ''}${probe.stderr?.toString() ?? ''}`
  if (probe.status !== 0 || !probeOut.includes('import-ok')) {
    warn(`模块 import 失败：${probeOut.trim().split('\n').slice(0, 3).join(' | ')}`)
    return false
  }
  say('✓ 模块可 import')
  if (existsSync(hostCli)) {
    const dump = spawnSync(hostCli, ['--profile', profileName, '--dump-config'], { cwd: profileDir, stdio: ['ignore', 'pipe', 'pipe'] })
    const text = `${dump.stdout?.toString() ?? ''}${dump.stderr?.toString() ?? ''}`
    if (dump.status === 0 && text.includes(manifest.name)) {
      say('✓ 组合树里能看到本插件')
    } else if (/EROFS|EACCES|read-only/iu.test(text)) {
      warn('dump-config 因目录只读失败（环境限制，不算安装失败）')
    } else {
      warn('dump-config 没看到本插件；重启 dsh 后再用 `dsh --profile ' + profileName + ' --dump-config` 复核')
    }
  }
  return true
}
