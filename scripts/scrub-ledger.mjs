#!/usr/bin/env node
/**
 * **`sdo_scrub` 的命令面**（`TASK-173`，0.1.7 批4）：台账脱敏 ＋ 证据随版本归档 ＋ 入库读数。
 *
 * ## 为什么是脚本、不是 MCP 工具
 *
 * 这两件事都是**改历史**（脱敏改写已写下的事件与真源正文；归档删除 700 MB 级的过程产物），
 * 而 `src/types.ts` / `src/index.ts`（工具注册面）**不在本卡写范围**。所以本卡交出的是
 * **域层能力 + 一条可被人工在终端上跑的命令面**：谁跑、跑什么、批准人是谁，都在命令行上留痕。
 * 工具面包装留给后续卡（与 `dispatchFace` 里事件类型待登记同一处置）。
 *
 * ## 三条使用纪律（脚本自己兜住，不靠人记）
 *
 *   ① **缺省是演练**：不带 `--apply` 就只读——一个字节不写、一个文件不删；
 *   ② **执行必须带 `--approved-by human`**：`ADR-022` 裁决①同档，批准权只认人类（驾驶舱不得代批）。
 *      缺了直接 exit 1，域层也会再拦一道（`approval-missing`）；
 *   ③ **演练报告不许含本机坐标**：域层报告的每一条路径都是**相对**台账根的，哈希是裸十六进制。
 *      —— 报告要能贴进证据、提交信息与用户批文里，它自己不能二次泄漏。
 *
 * ## 用法
 *
 *   node scripts/scrub-ledger.mjs                        # 台账脱敏**演练**（缺省，只读）
 *   node scripts/scrub-ledger.mjs --json                 # 同上，JSON 形态
 *   node scripts/scrub-ledger.mjs --apply --approved-by human       # 真执行（写盘 + 审计事件）
 *   node scripts/scrub-ledger.mjs evidence               # 证据归档**演练**
 *   node scripts/scrub-ledger.mjs evidence --keep-task TASK-163     # 在飞任务的证据不归档
 *   node scripts/scrub-ledger.mjs evidence --apply --approved-by human
 *   node scripts/scrub-ledger.mjs verify                 # 只读读数（残余泄漏 / 体量）
 *
 * 可选 `--root <dir>` 指定工作区（缺省=本脚本所在包根）、`--include-evidence` 让脱敏面也覆盖
 * `evidence/`（归档后留存的摘要同样要脱敏，建议在归档之后跑一次）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/[\\/]+$/u, '')

/** 体积的人读形态（报告里只用这一处换算）。 */
const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`

function usage(stream = process.stdout) {
  stream.write(
    'sdo_scrub（台账脱敏 / 证据归档 / 入库读数）\n'
    + '  node scripts/scrub-ledger.mjs [ledger|evidence|verify] [选项]\n'
    + '    --root <dir>          工作区根（缺省=本脚本所在的包根）\n'
    + '    --include-evidence    脱敏面也覆盖 evidence/（建议在归档之后跑）\n'
    + '    --keep-task <TASK-id> 证据归档时点名"仍在飞"的卡（可重复）\n'
    + '    --apply               真执行（缺省=演练，一个字节都不动）\n'
    + '    --approved-by <who>   执行时的批准人；只接受 human（ADR-022 裁决①）\n'
    + '    --json                机器可读输出\n',
  )
}

function parseArgs(argv) {
  const options = { command: 'ledger', root: ROOT, includeEvidence: false, keepTasks: [], apply: false, approvedBy: '', json: false }
  let command = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') { options.root = resolve(argv[index + 1] ?? ''); index += 1; continue }
    if (arg === '--keep-task') { options.keepTasks.push(String(argv[index + 1] ?? '').trim()); index += 1; continue }
    if (arg === '--approved-by') { options.approvedBy = String(argv[index + 1] ?? '').trim(); index += 1; continue }
    if (arg === '--include-evidence') { options.includeEvidence = true; continue }
    if (arg === '--apply') { options.apply = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--help' || arg === '-h') { options.command = 'help'; continue }
    if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`)
    if (command !== '') throw new Error(`子命令只能给一个：${command} / ${arg}`)
    command = arg
  }
  if (command !== '') options.command = command
  if (!['ledger', 'evidence', 'verify', 'help'].includes(options.command)) throw new Error(`未知子命令：${options.command}`)
  return options
}

function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : '?'
}

/** 目录的现算体积（只读读数用；不解符号链接）。 */
function bytesOf(dir) {
  let total = 0
  let files = 0
  const walk = (at) => {
    let entries
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(at, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(path); continue }
      try { total += statSync(path).size; files += 1 } catch { /* 读不到就不计 */ }
    }
  }
  walk(dir)
  return { bytes: total, files }
}

function printLedgerReport(report) {
  const lines = []
  lines.push('══ 台账脱敏演练（未写盘）══')
  lines.push(`真源面：扫描 ${report.surface.scannedFiles} 个文件 / ${mb(report.surface.scannedBytes)}`
    + `；排除 ${report.surface.excluded.length} 项（${report.surface.excluded.map((item) => item.path).join(' ') || '无'}）`
    + `；未归类 ${report.surface.unclassified.length}；符号链接 ${report.surface.symlinks.length}`)
  lines.push(`要改：${report.totals.files} 个文件 ＋ ${report.totals.journalEvents} 条 journal 事件（${mb(report.totals.bytes)}）`
    + `；命中 workspace=${report.totals.hits.workspace} home=${report.totals.hits.home} host=${report.totals.hits.host}`)
  for (const row of report.files) {
    lines.push(`  · ${row.path}（${row.bytes} B，命中 w=${row.hits.workspace} h=${row.hits.home} s=${row.hits.host}）`
      + ` ${short(row.beforeHash)} → ${short(row.afterHash)}`)
  }
  for (const row of report.journal?.rows ?? []) {
    lines.push(`  · ${report.journal.path} seq=${row.seq}（行 ${row.line}，命中 w=${row.hits.workspace} h=${row.hits.home} s=${row.hits.host}）`
      + ` ${short(row.beforeHash)} → ${short(row.afterHash)}`)
  }
  if (report.refusals.length === 0) {
    lines.push('被拒：无')
  } else {
    lines.push(`被拒 ${report.refusals.length} 项：`)
    for (const row of report.refusals) lines.push(`  · ${row.path}${row.line === undefined ? '' : `:${row.line}`} 「${row.code}」${row.detail === undefined ? '' : ` ${row.detail}`}`)
  }
  if (report.impacts.length === 0) {
    lines.push('已记录指纹影响：无（没有评审的内容指纹会因此失效）')
  } else {
    lines.push(`已记录指纹影响 ${report.impacts.length} 条（脱敏后会被判 tampered）：`)
    for (const row of report.impacts) lines.push(`  · ${row.id}（${row.path}）记 ${short(row.recorded)} → 现 ${short(row.after)}`)
  }
  lines.push(`演练时间：${report.generatedAt}；工具：${report.tool}`)
  lines.push('未写盘。真执行：node scripts/scrub-ledger.mjs --apply --approved-by human（需用户批准）')
  return lines.join('\n')
}

function printEvidenceReport(plan, targetLabel) {
  const lines = []
  const why = {}
  for (const row of plan.keepRows) why[row.why] = (why[row.why] ?? 0) + 1
  lines.push('══ 证据随版本归档演练（未删任何文件）══')
  lines.push(`现算体积 ${mb(plan.totals.beforeBytes)}：保留 ${plan.totals.keepFiles} 个文件 / ${mb(plan.totals.keptBytes)}，`
    + `删除 ${plan.totals.deleteFiles} 个文件 / ${mb(plan.totals.deletedBytes)}`)
  lines.push(`保留按类：${Object.entries(why).map(([key, count]) => `${key}=${count}`).join(' ') || '无'}`)
  lines.push(`保留口径：report.md（任意深度）＋ 包根 ≤2 层且 ≤${plan.rules.summaryMaxBytes} B 的摘要（${plan.rules.summaryExtensions.join('/')}）`
    + `＋ 产品读取的原件（child-tools.jsonl / file-history / child-reports）`)
  lines.push(`归档后 ${mb(plan.totals.beforeBytes - plan.totals.deletedBytes)}，目标 ${mb(plan.totals.targetBytes)}`
    + ` ⇒ ${plan.totals.withinTarget ? '达标' : '未达标（仍有大体积项，需扩大口径或另立卡）'}`)
  lines.push('保留清单：')
  for (const row of plan.keepRows) lines.push(`  · ${row.path}（${row.bytes} B，${row.why}）`)
  if (plan.refusals.length > 0) {
    lines.push(`被拒 ${plan.refusals.length} 项：`)
    for (const row of plan.refusals) lines.push(`  · ${row.path} 「${row.code}」`)
  }
  lines.push(`演练时间：${plan.generatedAt}；工具：${plan.tool}；台账：${targetLabel}`)
  lines.push('未删任何文件。真执行：node scripts/scrub-ledger.mjs evidence --apply --approved-by human（需用户批准）')
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') { usage(); return 0 }

  // 域层能力从**已编译产物**取（`scripts/*.mjs` 与 `test/*.mjs` 的既有约定：先 `npm run build`）。
  let scrub
  let evidence
  let SdoStore
  let Journal
  try {
    scrub = await import('../lib/src/domain/scrub.js')
    evidence = await import('../lib/src/domain/evidence.js')
    ;({ SdoStore } = await import('../lib/src/infra/store.js'))
    ;({ Journal } = await import('../lib/src/infra/journal.js'))
  } catch (error) {
    process.stderr.write(`✗ 读不到编译产物（先跑 npm run build）：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const store = new SdoStore(join(options.root, '.sdo'))
  if (!scrub.ledgerPresent(store)) {
    process.stderr.write(`✗ ${store.root} 下没有台账（journal.jsonl）—— 这台机器/这个副本没有可脱敏的真源\n`)
    return 1
  }
  if (options.apply && options.approvedBy !== scrub.SCRUB_APPROVER) {
    process.stderr.write('✗ 真执行必须带 --approved-by human（脱敏/归档是对历史的改写，批准权只认人类）\n')
    return 1
  }

  if (options.command === 'verify') {
    const secrets = scrub.scrubSecretsOf(options.root)
    const ledgerLeaks = scrub.leakCounts(scrub.residualLeaks(store, secrets))
    const evidenceLeaks = scrub.leakCounts(scrub.residualLeaks(store, secrets, { includeEvidence: true }))
    const reading = {
      ledger: { leaks: ledgerLeaks, bytes: bytesOf(store.root).bytes - evidence.evidenceBytes(store) },
      evidence: { leaks: evidenceLeaks, bytes: evidence.evidenceBytes(store) },
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`真源层：残余 home=${ledgerLeaks.home} workspace=${ledgerLeaks.workspace} host=${ledgerLeaks.host}`
      + `（DoD 读数：/home/ 类出现次数应为 0）\n`)
    process.stdout.write(`evidence/：约 ${mb(evidence.evidenceBytes(store))}；残余 home=${evidenceLeaks.home}（归档后留存的摘要同样要脱敏）\n`)
    return 0
  }

  if (options.command === 'ledger') {
    const plan = scrub.planLedgerScrub(store, { workspace: options.root, includeEvidence: options.includeEvidence, journal: new Journal(store) })
    if (options.json && !options.apply) {
      process.stdout.write(`${JSON.stringify(plan.report, null, 2)}\n`)
      return 0
    }
    if (!options.apply) {
      process.stdout.write(`${printLedgerReport(plan.report)}\n`)
      return 0
    }
    const receipt = scrub.applyLedgerScrub(store, plan, { approvedBy: options.approvedBy, journal: new Journal(store) })
    const secrets = scrub.scrubSecretsOf(options.root)
    const after = scrub.leakCounts(scrub.residualLeaks(store, secrets, { includeEvidence: options.includeEvidence }))
    const reading = { receipt, after }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`)
      return 0
    }
    process.stdout.write('══ 台账脱敏执行完毕 ══\n')
    process.stdout.write(`改了 ${receipt.files} 个文件 ＋ ${receipt.journalEvents} 条 journal 事件（${mb(receipt.bytes)}），批准人 ${receipt.approvedBy}\n`)
    process.stdout.write(`链式摘要：before ${short(receipt.beforeDigest)} → after ${short(receipt.afterDigest)}；审计事件 seq=${receipt.eventSeq ?? '?'}\n`)
    process.stdout.write(`复核读数：残余 home=${after.home} workspace=${after.workspace} host=${after.host}\n`)
    return 0
  }

  const plan = evidence.planEvidenceArchive(store, { keepTasks: options.keepTasks })
  if (options.json && !options.apply) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return 0
  }
  if (!options.apply) {
    process.stdout.write(`${printEvidenceReport(plan, store.root)}\n`)
    return 0
  }
  const receipt = evidence.applyEvidenceArchive(store, plan, { approvedBy: options.approvedBy, journal: new Journal(store) })
  const after = evidence.evidenceBytes(store)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ receipt, after }, null, 2)}\n`)
    return 0
  }
  process.stdout.write('══ 证据归档执行完毕 ══\n')
  process.stdout.write(`删除 ${receipt.deletedFiles} 个文件 / ${mb(receipt.deletedBytes)}；保留 ${receipt.keptFiles} 个 / ${mb(receipt.keptBytes)}`
    + `；批准人 ${receipt.approvedBy}；审计事件 seq=${receipt.eventSeq ?? '?'}\n`)
  process.stdout.write(`evidence/ 现算体积 ${mb(after)}\n`)
  return 0
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    const detail = error && typeof error === 'object' && 'code' in error ? ` [${String(error.code)}]` : ''
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}${detail}\n`)
    if (error && typeof error === 'object' && 'detail' in error) {
      const extra = error.detail
      if (extra && typeof extra === 'object' && Array.isArray(extra.paths)) {
        for (const path of extra.paths) process.stderr.write(`  · ${path}\n`)
      }
    }
    process.exitCode = 1
  },
)
