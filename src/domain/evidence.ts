/**
 * **完成证据的对账**（A1）：`sdo_task action=done` 时，把"执行者交上来的证据"与"卡上声明的证据要求"
 * 以及"工作区里真实存在的东西"对上。
 *
 * 为什么需要它：`done` 此前只校验「证据数组非空」——卡上写 `evidenceRequired: [command, artifact]`，
 * 交一条 `artifact` 也能过；`artifact` 指向一个根本不存在的路径也能过；`command` 是一条退出码 1 的
 * 输出也能过。于是"完成"退化成自述。这里做三条**机械**检查（都不看模型怎么说）：
 *
 *   ① **种类覆盖**：`task.evidenceRequired` ⊆（已挂证据 ∪ 本次证据）的 kind 集合；
 *   ② **产物落地**：`artifact` 的 `detail` 取路径（可带 `sha256=<hex>` 后缀），路径必须存在；
 *      带哈希时按文件内容复算比对（不符即判红）；
 *   ③ **命令成立**：`command` 若给了 `exitCode`，必须为 0（非 0 不算完成证据）。
 *
 * 不做的事（有意为之）：不去猜证据"够不够好"（那是评审员的活）；不校验 `command` 的输出格式
 * （没有可机械判定的约定，硬编会变成逼人编造）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import type { EvidenceItem } from '../types.js'

export type EvidenceAuditCode = 'evidence-kind-missing' | 'evidence-artifact-missing' | 'evidence-artifact-outside' | 'evidence-artifact-hash' | 'evidence-command-failed'

export type EvidenceAudit = { ok: true } | { ok: false; code: EvidenceAuditCode; detail: string }

/**
 * 证据条目里取出路径与可选哈希：`path`、`path sha256=<hex>`、`path sha256:<hex>`、`path #<hex>` 都认。
 *
 * 三种返回形态要分清：**没给哈希**（`sha256`/`invalidHash` 都空）、**给了合法哈希**（`sha256`）、
 * **写了哈希但不是 64 位十六进制**（`invalidHash`，报错时要说清是写法不对，而不是"产物不存在"）。
 */
export function parseArtifactDetail(detail: string): { path: string; sha256?: string; invalidHash?: string } {
  const text = detail.trim()
  for (const pattern of [/\s+sha256[=:]([0-9a-fA-F]{64})\s*$/u, /\s+#([0-9a-fA-F]{64})\s*$/u]) {
    const hit = pattern.exec(text)
    if (hit !== null) return { path: text.slice(0, hit.index).trim(), sha256: (hit[1] as string).toLowerCase() }
  }
  const broken = /\s+(?:sha256[=:]|#)(\S+)\s*$/u.exec(text)
  if (broken !== null) return { path: text.slice(0, broken.index).trim(), invalidHash: broken[1] as string }
  return { path: text }
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 对账一份 `done` 证据。
 *
 * @param task 任务卡（读 `evidenceRequired` 与已挂证据）
 * @param incoming 本次交上来的证据
 * @param workspace 工作区根（`artifact` 路径相对它解析；越出工作区的路径判红）
 */
export function auditDoneEvidence(task: { id: string; evidenceRequired: EvidenceItem['kind'][]; evidence: EvidenceItem[] }, incoming: EvidenceItem[], workspace: string): EvidenceAudit {
  const all = [...task.evidence, ...incoming]

  // ① 种类覆盖
  const provided = new Set(all.map((item) => item.kind))
  const missing = task.evidenceRequired.filter((kind) => !provided.has(kind))
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'evidence-kind-missing',
      detail: `${task.id} 要求证据种类 ${task.evidenceRequired.join(' / ')}，缺 ${missing.join(' / ')}（现有：${[...provided].join(' / ') || '（空）'}）`,
    }
  }

  // ② 产物落地（只看本次交上来的；历史证据在它自己那次 done/block 时已过账）
  for (const item of incoming) {
    if (item.kind !== 'artifact') continue
    const { path, sha256, invalidHash } = parseArtifactDetail(item.detail)
    if (path === '') return { ok: false, code: 'evidence-artifact-missing', detail: 'artifact 证据没有给出产物路径（写 `相对路径` 或 `相对路径 sha256=<64 位十六进制>`）' }
    if (invalidHash !== undefined) {
      return { ok: false, code: 'evidence-artifact-hash', detail: `artifact 的哈希不是 64 位十六进制：${invalidHash}（写 sha256=<hex> 或 #<hex>；不打算给哈希就干脆不写）` }
    }
    const absolute = isAbsolute(path) ? path : resolve(workspace, path)
    const rel = relative(workspace, absolute)
    if (rel.startsWith('..')) {
      return { ok: false, code: 'evidence-artifact-outside', detail: `artifact 路径 ${path} 在工作区之外（证据必须指向本工作区里的产物）` }
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      return { ok: false, code: 'evidence-artifact-missing', detail: `artifact 证据指向的产物不存在：${path}（补真实路径，或改用 command / workspace-changes）` }
    }
    if (sha256 !== undefined) {
      const actual = sha256Of(absolute)
      if (actual !== sha256) {
        return { ok: false, code: 'evidence-artifact-hash', detail: `artifact 哈希不符：${path} 现算 ${actual.slice(0, 12)}…，证据写的是 ${sha256.slice(0, 12)}…（产物改过就重算哈希，别改证据）` }
      }
    }
  }

  // ③ 命令成立
  for (const item of incoming) {
    if (item.kind !== 'command') continue
    if (item.exitCode !== undefined && item.exitCode !== 0) {
      return { ok: false, code: 'evidence-command-failed', detail: `command 证据的退出码是 ${item.exitCode}（非 0 的命令不能作为完成证据；修好重跑，或改用 block 说明卡在哪）` }
    }
  }

  return { ok: true }
}
