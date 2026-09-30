#!/usr/bin/env node
/**
 * 离线安装包打包器（CI 与本地共用）。
 *
 * 产物（默认落在 `dist/offline/`）：
 *   · `dsh-software-dev-office-<version>-offline.tar.gz`
 *   · `dsh-software-dev-office-<version>-offline.zip`    ← store-only ZIP，自写，不依赖外部 `zip` 命令
 *   · `SHA256SUMS`（外层，校验两个归档）
 *
 * 包内结构：
 *   tarballs/            插件本体 + **运行时依赖闭包**（npm pack 出来的 tgz）
 *   npm-cache/           构建期用 `npm cache add` 预填的 npm 缓存（装机器上 `--offline` 才有东西可用）
 *   install.mjs          跨平台安装器（Node，无第三方依赖）
 *   install.sh            POSIX 包装（Linux/macOS）
 *   install.ps1           PowerShell 包装（Windows）
 *   manifest.json        版本、Node 要求、闭包清单、peer 清单、构建信息
 *   SHA256SUMS           包内校验（校验 tarballs/）
 *   README-offline.md    安装 / 卸载 / 校验说明
 *
 * 关键设计（都是踩坑得到的）：
 *   1. **只打包 `dependencies` 的传递闭包，排除 `peerDependencies`** —— peer 由宿主（dsh 安装树）提供。
 *      把 peer（尤其 `@deepseek-ai/cordis`）也打进来会造成**第二份服务注册表**，插件的
 *      `Service`/服务查找会静默错乱。安装器改为把宿主的 peer 实例**链接**进 profile。
 *   2. **不带网络假设**：打包与安装全程 `--cache <工作区内目录>`，npm 默认的 `~/.npm` 在受限环境
 *      可能只读（实测报 `error writing to the directory: /home/…/.npm/_logs`）。
 *   3. **不依赖 tar/zip 可执行文件**：ZIP 由本脚本手写（store-only）；tar.gz 优先用系统 `tar`
 *      （Windows 10+ 自带 `tar.exe`），失败时报错而不是产出半成品。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback) => {
  const hit = argv.find((item) => item.startsWith(`${flag}=`))
  return hit === undefined ? fallback : hit.slice(flag.length + 1)
}

const outDir = resolve(root, valueOf('--out', 'dist/offline'))
const workDir = join(outDir, '.work')
const staging = join(workDir, 'bundle')
const tarballs = join(staging, 'tarballs')
const npmCache = join(staging, 'npm-cache')
const buildCache = resolve(root, '.pack-cache') // npm 自身缓存：必须在工作区内可写
const wantZip = !has('--no-zip')

const log = (message) => console.log(`[pack-offline] ${message}`)
const fail = (message) => {
  console.error(`[pack-offline] ✗ ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, npm_config_cache: options.cache ?? buildCache, npm_config_audit: 'false', npm_config_fund: 'false' },
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    const detail = options.capture === true ? `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`.trim() : ''
    fail(`${command} ${args.join(' ')} 失败（退出码 ${result.status}）${detail === '' ? '' : `\n${detail}`}`)
  }
  return options.capture === true ? result.stdout.toString() : ''
}

/** 读一个包目录的 package.json。 */
const readPkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

/**
 * 定位一个依赖的安装目录。依次尝试：调用方的 node_modules → 仓库 node_modules → pnpm store。
 * 三种布局都要支持：npm 扁平、pnpm 隔离（`.pnpm/<name>@<ver>/node_modules/<name>`）、workspace 提升。
 */
function locateDependency(name, fromDirs) {
  const candidates = []
  for (const from of fromDirs) candidates.push(join(from, 'node_modules', name))
  candidates.push(join(root, 'node_modules', name))
  const pnpm = join(root, 'node_modules', '.pnpm')
  if (existsSync(pnpm)) {
    const prefix = name.replace('/', '+')
    for (const entry of readdirSync(pnpm)) {
      if (entry.startsWith(`${prefix}@`)) candidates.push(join(pnpm, entry, 'node_modules', name))
    }
  }
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
}

/** 解析运行时闭包：`dependencies` 递归展开，**跳过 peerDependencies**（宿主提供）。 */
function runtimeClosure() {
  const plugin = readPkg(root)
  const closure = new Map()
  const missing = []
  const walk = (name, fromDirs) => {
    if (closure.has(name)) return
    const dir = locateDependency(name, fromDirs)
    if (dir === undefined) {
      missing.push(name)
      return
    }
    const pkg = readPkg(dir)
    closure.set(name, { version: pkg.version, dir })
    for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, [dir])
  }
  for (const dep of Object.keys(plugin.dependencies ?? {})) walk(dep, [root])
  if (missing.length > 0) {
    // **不许静默缺包**：缺一个依赖就会让装机器上的插件加载失败（真机踩过）
    fail(`运行时闭包缺这些包，无法离线安装：${missing.join(', ')}（先在联网环境 npm install）`)
  }
  return { plugin, closure }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 生成 store-only ZIP（不压缩）：跨平台、零依赖，Windows 用户可右键解压。 */
function writeZip(zipPath, baseDir) {
  const files = []
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) collect(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  collect(baseDir)
  const chunks = []
  const central = []
  let offset = 0
  const crcTable = (() => {
    const table = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c
    }
    return table
  })()
  const crc32 = (buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  for (const file of files) {
    const name = relative(baseDir, file).split('\\').join('/')
    const data = readFileSync(file)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)
    central.push({ nameBuf, crc, size: data.length, offset })
    offset += local.length + nameBuf.length + data.length
  }
  const centralChunks = []
  let centralSize = 0
  for (const entry of central) {
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0, 8)
    head.writeUInt16LE(0, 10)
    head.writeUInt16LE(0, 12)
    head.writeUInt16LE(0, 14)
    head.writeUInt32LE(entry.crc, 16)
    head.writeUInt32LE(entry.size, 20)
    head.writeUInt32LE(entry.size, 24)
    head.writeUInt16LE(entry.nameBuf.length, 28)
    head.writeUInt16LE(0, 30)
    head.writeUInt16LE(0, 32)
    head.writeUInt16LE(0, 34)
    head.writeUInt16LE(0, 36)
    head.writeUInt32LE(0, 38)
    head.writeUInt32LE(entry.offset, 42)
    centralChunks.push(head, entry.nameBuf)
    centralSize += head.length + entry.nameBuf.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  writeFileSync(zipPath, Buffer.concat([...chunks, ...centralChunks, end]))
}

// ── 主流程 ────────────────────────────────────────────────────────────────
log(`插件根：${root}`)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(tarballs, { recursive: true })
mkdirSync(npmCache, { recursive: true })
mkdirSync(buildCache, { recursive: true })

const { plugin, closure } = runtimeClosure()
log(`运行时闭包：${closure.size} 个包（不含 peer）`)

// ① 打插件本体（遵守 package.json 的 `files` 白名单）
run('npm', ['pack', root, '--pack-destination', tarballs])
for (const [name, info] of closure) {
  // ② 打闭包里的每个包（用本地已安装目录，等价于发布内容）
  run('npm', ['pack', info.dir, '--pack-destination', tarballs])
  log(`  · ${name}@${info.version}`)
}

// ③ 预填 npm 缓存：装机器 `--offline` 时才有东西可用
const tgzFiles = readdirSync(tarballs).filter((name) => name.endsWith('.tgz'))
for (const file of tgzFiles) run('npm', ['cache', 'add', join(tarballs, file), '--cache', npmCache])
// 去掉 npm 自己的日志与 notifier 标记：既没用又会让包体积/噪音变大
rmSync(join(npmCache, '_logs'), { recursive: true, force: true })
rmSync(join(npmCache, '_update-notifier-last-checked'), { force: true })
log(`缓存已预填：${tgzFiles.length} 个 tgz`)

// ④ 安装器与说明
for (const name of ['install-offline.mjs']) {
  const source = join(here, name)
  if (!existsSync(source)) fail(`缺少安装器脚本：${name}`)
  cpSync(source, join(staging, 'install.mjs'))
}
writeFileSync(join(staging, 'install.sh'), `#!/bin/sh\n# POSIX 包装：把参数原样交给跨平台安装器\nexec node "$(dirname "$0")/install.mjs" "$@"\n`)
writeFileSync(join(staging, 'install.ps1'), `# PowerShell 包装：把参数原样交给跨平台安装器\r\n$ErrorActionPreference = 'Stop'\r\nnode "$PSScriptRoot/install.mjs" @args\r\nexit $LASTEXITCODE\r\n`)

const manifest = {
  name: plugin.name,
  version: plugin.version,
  node: plugin.engines?.node ?? '>=20',
  builtAt: new Date().toISOString(),
  builtFrom: process.platform,
  tarballs: tgzFiles.sort(),
  closure: Object.fromEntries([...closure].map(([name, info]) => [name, info.version])),
  peers: Object.keys(plugin.peerDependencies ?? {}),
  install: 'node install.mjs --profile web   （Linux/macOS 也可 ./install.sh；Windows 也可 .\\install.ps1）',
}
writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(
  join(staging, 'README-offline.md'),
  `# ${plugin.name} 离线安装包（v${plugin.version}）

- 适用：已安装 **dsh** 的机器，**无需联网**。
- Node 要求：${manifest.node}。
- 内容：\`tarballs/\`（插件 + 运行时闭包 ${closure.size} 个包）、\`npm-cache/\`（离线安装用的 npm 缓存）、\`install.mjs\`、\`manifest.json\`。

## 安装

Linux / macOS：
\`\`\`sh
./install.sh --profile web
# 或：node install.mjs --profile web
\`\`\`

Windows（PowerShell）：
\`\`\`powershell
.\\install.ps1 --profile web
# 或：node install.mjs --profile web
\`\`\`

先看要做什么而不落盘：加 \`--dry-run\`。安装目录不标准时显式指定：\`--dsh-home /path/to/instances/<ver>/home\`。

安装器做四件事：① 用**离线 npm** 把插件与闭包装进 \`<profile>/node_modules\`；② 把**宿主的 peer 实例**
（\`@deepseek-ai/*\`）链接进 profile，避免出现第二份服务注册表；③ 把插件登记进 profile 的
\`dsh.profile.bundles\`（改前留 \`.bak-offline-<时间戳>\` 备份）；④ 校验（模块可 import + \`--dump-config\` 能看到 preset）。

安装完**重启 dsh**，然后在新建会话时选择 **SDO 研发办公室（驾驶舱）** preset。

## 卸载 / 校验

\`\`\`sh
node install.mjs --uninstall --profile web    # 摘掉本插件（含它自己建的 peer 链接）
node install.mjs --verify    --profile web    # 只校验，不改动
\`\`\`

## 校验完整性

\`\`\`sh
sha256sum -c SHA256SUMS        # Linux / macOS
certutil -hashfile <file> SHA256   # Windows 单文件
\`\`\`
`,
)

// ⑤ 包内 SHA256SUMS
const inner = tgzFiles
  .sort()
  .map((file) => `${sha256(join(tarballs, file))}  tarballs/${file}`)
  .join('\n')
writeFileSync(join(staging, 'SHA256SUMS'), `${inner}\n`)

// ⑥ 归档
const base = `${plugin.name}-${plugin.version}-offline`
const tarPath = join(outDir, `${base}.tar.gz`)
run('tar', ['-czf', tarPath, '-C', workDir, 'bundle'])
log(`✓ ${relative(root, tarPath)}（${(statSync(tarPath).size / 1048576).toFixed(2)} MB）`)

const archiveFiles = [join(outDir, `${base}.tar.gz`)]
if (wantZip) {
  const zipPath = join(outDir, `${base}.zip`)
  writeZip(zipPath, staging)
  archiveFiles.push(zipPath)
  log(`✓ ${relative(root, zipPath)}（${(statSync(zipPath).size / 1048576).toFixed(2)} MB）`)
}

writeFileSync(
  join(outDir, 'SHA256SUMS'),
  `${archiveFiles.map((file) => `${sha256(file)}  ${relative(outDir, file)}`).join('\n')}\n`,
)
log(`✓ ${relative(root, join(outDir, 'SHA256SUMS'))}`)
rmSync(workDir, { recursive: true, force: true })
log(`完成：${archiveFiles.map((file) => relative(root, file)).join(', ')}`)
