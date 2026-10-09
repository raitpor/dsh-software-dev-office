#!/usr/bin/env node
/**
 * **宿主版本兼容核查**（三层，可重复运行；2026-10-09 首次用于 `0.2.1-alpha.1`）
 *
 * 用法：
 *   node scripts/host-compat.mjs --instance ~/.local/share/hdsl/instances/0.2.1-alpha.1
 *   node scripts/host-compat.mjs --instance <目录> --keep-temp   # 保留临时 tsconfig 便于排查
 *
 * 三层各查什么、为什么是这三层：
 *   ① **装配闸门**（硬）：直接调用**目标实例自带**的 `@deepseek-ai/dsh-app-boot` 的
 *      `evaluatePluginCompatibility`。宿主的判据是：只筛 `@deepseek-ai/dsh` / `dsh-*` 前缀的
 *      peerDependencies，用 `semver.satisfies(runtime, range, { includePrerelease: true })`；
 *      不匹配 ⇒ 安装前置检查直接拒绝安装、已装的启动时拒绝加载（除非给精确版本豁免）。
 *      为什么用它的函数而不是自己算：`includePrerelease` 与前缀筛选都是实现细节，自己算容易得出相反结论。
 *   ② **类型面**：拿目标实例里的宿主包类型，对 `src/` 全量 `--noEmit` 编译一遍。
 *      0 错误说明插件用到的类型面没变（比读 CHANGELOG 可靠）。
 *   ③ **运行期契约**：类型查不到字符串键 —— 从 `src/index.ts` 里抽出插件 `ctx.inject` 的服务名
 *      与 `ctx.on` 的事件名，逐个到目标实例的 lib/types 下所有 .d.ts 里找 `interface Context` /
 *      `interface Events` 的声明，缺一个就报出来。
 *
 * 退出码：三层全过 0；任一层不过 1（可直接用于 CI 或下一步决策）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const instanceArg = args.includes('--instance') ? args[args.indexOf('--instance') + 1] : undefined
const keepTemp = args.includes('--keep-temp')
if (instanceArg === undefined) {
  console.error('用法：node scripts/host-compat.mjs --instance <实例目录> [--keep-temp]')
  process.exit(2)
}
const instance = resolve(instanceArg.replace(/^~/u, homedir()))
const name = JSON.parse(readFileSync(join(instance, 'instance.json'), 'utf8')).version
const pnpm = join(instance, 'dsh', 'node_modules', '.pnpm')
if (!existsSync(pnpm)) {
  console.error(`找不到 ${pnpm}（--instance 要指向 dsh 实例目录，例如 …/instances/0.2.1-alpha.1）`)
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
console.log(`插件：${manifest.name}@${manifest.version}`)
console.log(`目标宿主：dsh ${name}（${instance}）\n`)

/** 在实例的 pnpm store 里找某个包的目录（版本前缀可省）。 */
function pkgDir(pkg, versionPrefix = name) {
  const exact = readdirSync(pnpm).filter((entry) => entry.startsWith(`@deepseek-ai+${pkg}@${versionPrefix}`))
  const dirs = exact.length > 0 ? exact : readdirSync(pnpm).filter((entry) => entry.startsWith(`@deepseek-ai+${pkg}@`))
  for (const dir of dirs) {
    const candidate = join(pnpm, dir, 'node_modules', '@deepseek-ai', pkg)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 深度收集 .d.ts。 */
function typeFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) typeFiles(path, out)
    else if (entry.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

let failures = 0
const fail = (layer, detail) => { failures += 1; console.log(`  ✗ ${detail}`) }
const layer = (title) => console.log(`① ${title}`.replace(/^① /u, `\n=== ${title} ===`))

// ————————————————————————— ① 装配闸门 —————————————————————————
console.log('=== ① 装配闸门（宿主自己的判据函数） ===')
const appBoot = pkgDir('dsh-app-boot')
if (appBoot === undefined) {
  fail(1, '实例里找不到 @deepseek-ai/dsh-app-boot，无法调用宿主的判据函数')
} else {
  const mod = await import(pathToFileURL(join(appBoot, 'lib', 'index.js')).href)
  const issue = mod.evaluatePluginCompatibility(manifest, {}, name)
  if (issue === undefined) {
    console.log('  ✓ 无兼容问题')
  } else {
    console.log(`  不匹配的 peer：${JSON.stringify(issue.peers, null, 2)}`)
    console.log(`  豁免状态：${String(issue.exempted)}`)
    fail(1, `宿主判为**不兼容** ⇒ ${name} 上会被拒绝安装/加载（除非给精确版本豁免）`)
    console.log(`  宿主原话：${mod.pluginCompatibilityWarning(issue).split('\n')[0]}`)
  }
}

// ①b 未来版本矩阵：用同一个宿主函数跑**合成**版本号 —— 回答"下次 dsh 升级会不会被硬拒"
if (appBoot !== undefined) {
  const mod = await import(pathToFileURL(join(appBoot, 'lib', 'index.js')).href)
  const future = ['0.2.2-alpha.1', '0.2.5', '0.3.0-alpha.1', '0.3.0', '0.4.0-rc.1', '1.0.0', '2.0.0-alpha.1']
  const rows = future.map((version) => [version, mod.evaluatePluginCompatibility(manifest, {}, version) === undefined])
  console.log('  未来版本（合成版本号，只看闸门）：')
  for (const [version, ok] of rows) console.log(`    ${ok ? '✓' : '✗'} ${version}`)
  const blocked = rows.filter(([, ok]) => !ok).map(([version]) => version)
  // 只在"下一个大版本被挡"时通过（这就是顶线的用意），其它未来版本被挡要报出来
  const unexpected = blocked.filter((version) => !version.startsWith('2.'))
  if (unexpected.length > 0) fail(1, `这些未来版本会被硬拒（应靠宽分支扛住）：${unexpected.join('、')}`)
  else console.log(`  ✓ 除顶线外的未来版本都不会被拒${blocked.length > 0 ? `（预期被挡：${blocked.join('、')}）` : ''}`)
}

// ————————————————————————— ② 类型面编译 —————————————————————————
console.log('\n=== ② 类型面（用目标宿主的类型编译 src/） ===')
const WANT = ['cordis', 'schemastery', 'dsh-tools', 'dsh-llm', 'dsh-session', 'dsh-commands', 'dsh-system-prompt', 'dsh-plan-mode', 'dsh-session-projection', 'dsh-skill', 'dsh-subagent', 'dsh-token-meter', 'dsh-user-questions', 'dsh-workspace-changes']
const paths = {}
const missing = []
for (const pkg of WANT) {
  const dir = pkgDir(pkg)
  if (dir === undefined) { missing.push(pkg); continue }
  const spec = `@deepseek-ai/${pkg}`
  paths[spec] = [join(dir, 'lib', 'types', 'index.d.ts')]
  paths[`${spec}/*`] = [join(dir, '*')]
}
if (missing.length > 0) fail(2, `实例里缺这些包，类型面无法全量核对：${missing.join('、')}`)
const temp = mkdtempSync(join(tmpdir(), 'sdo-host-compat-'))
const tsconfig = join(temp, 'tsconfig.json')
writeFileSync(tsconfig, JSON.stringify({
  extends: join(ROOT, 'tsconfig.json'),
  compilerOptions: { noEmit: true, outDir: join(temp, 'out'), paths, typeRoots: [join(ROOT, 'node_modules', '@types')] },
  include: [join(ROOT, 'src', '**', '*.ts')],
}, null, 2))
try {
  // TS 7 已移除 baseUrl：paths 用绝对路径（上面的 paths 就是）
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', tsconfig], { cwd: ROOT, stdio: 'pipe' })
  console.log('  ✓ 0 错误（插件用到的类型面在目标宿主上没变）')
} catch (error) {
  const output = String(error.stdout ?? '') + String(error.stderr ?? '')
  fail(2, `编译有错（真断点，逐条看）：\n${output.split('\n').slice(0, 20).join('\n')}`)
}
if (!keepTemp) rmSync(temp, { recursive: true, force: true })
else console.log(`  （临时 tsconfig 保留在 ${tsconfig}）`)

// ————————————————————————— ③ 运行期契约 —————————————————————————
console.log('\n=== ③ 运行期契约（服务名 / 事件名） ===')
const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
const services = new Set([...source.matchAll(/inject\(\s*\[([^\]]*)\]/gu)].flatMap((m) => [...m[1].matchAll(/'([A-Za-z][\w]*)'/gu)].map((x) => x[1])))
for (const m of source.matchAll(/\.get\??\.?\(\s*'([A-Za-z][\w]*)'/gu)) services.add(m[1])
const events = new Set([...source.matchAll(/\.on\(\s*'([a-z][\w-]*\/[\w/-]+)'/gu)].map((m) => m[1]))
const declared = { services: new Set(), events: new Set() }
for (const pkg of WANT) {
  const dir = pkgDir(pkg)
  if (dir === undefined) continue
  for (const file of typeFiles(join(dir, 'lib', 'types'))) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/interface Context\s*(?:extends[^{]*)?\{([\s\S]*?)\n\s*\}/gu)) {
      for (const line of m[1].split('\n')) {
        const hit = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?:]/u.exec(line)
        if (hit !== null) declared.services.add(hit[1])
      }
    }
    for (const m of text.matchAll(/^\s*'([a-z][\w-]*\/[\w/-]+)'\s*[?:(]/gmu)) declared.events.add(m[1])
  }
}
for (const service of [...services].sort()) {
  if (declared.services.has(service)) console.log(`  ✓ 服务 ${service}`)
  else fail(3, `服务 ${service} 在目标宿主的类型声明里找不到（可能是改名/移除）`)
}
for (const event of [...events].sort()) {
  if (declared.events.has(event)) console.log(`  ✓ 事件 ${event}`)
  else fail(3, `事件 ${event} 在目标宿主的类型声明里找不到（hook 改名不会有类型错误，必须这样查）`)
}

// ————————————————————————— ④ 自挂风险提示（三层查不到的那一类） —————————————————————————
// 本插件会 `ctx.plugin(...)` 自挂 host 插件（宿主层 disabled 的 plan-mode 等）。0.2.1 起
// preset 注册表会审计"preset 子树里注册进 root realm 的服务"（leakedServices），未隔离就整个 preset 注册失败。
// 这一条**不是判据**（隔离与否在运行期才看得见），只提示"换了宿主记得复核自挂路径"。
const selfMounts = [...source.matchAll(/ctx\.plugin\(|realm\.plugin\(|isolate\(/gu)].length
if (selfMounts > 0) {
  console.log(`\n=== ④ 自挂风险提示 ===`)
  console.log(`  本插件有 ${selfMounts} 处 \`ctx.plugin(\`/\`isolate(\` 调用：换宿主时请复核"自挂的服务是否写进了隔离 realm"`)
  console.log('  （真机事故：0.2.1 报 `preset services require isolate realms: planMode`；对应守卫 test/m87 的 M87-06/M87-07）')
}

console.log(`\n结论：${failures === 0 ? `兼容 ✅（${name}）` : `不兼容 ❌（${failures} 处，见上）`}`)
process.exit(failures === 0 ? 0 : 1)
