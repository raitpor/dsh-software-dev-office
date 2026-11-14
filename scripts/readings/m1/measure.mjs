/**
 * M1-G · 七条判死读数的测量实现（卡 plan/cards/M1-G.md）。
 *
 * 纪律：
 * - 全部在 `withTempDb` 的临时目录新库上跑，不碰 `~/.local/state/sdo/`；
 * - 每条读数都记录“命令 + 原始输出 + verdict + caveat”，verdict 不靠“配置为真”凑绿；
 * - 读数 ④ 没有真实外部意图样本（A3），verdict 固定 `partial`，只证“机制可用”；
 * - 读数 ⑤ 用**真 append**（D-038 已 closed）；作废口径是 M1 有效集合差（D-037），写进 caveat。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { alignmentGate, disposeDiff, proposeRestatement } from '../../../lib/src/align/index.js';
import { canonicalJson } from '../../../lib/src/core/fold/canonical.js';
import { fold } from '../../../lib/src/core/fold/index.js';
import { validateBaseline } from '../../../lib/src/core/baseline/index.js';
import { registerCriterion } from '../../../lib/src/core/criteria/register.js';
import { GENESIS_PREV, computeEventHash, readEvents } from '../../../lib/src/core/verify-events.js';
import { append, chainHead } from '../../../lib/src/db/write.js';
import { importClaims, expectedClaimRow } from '../../../lib/src/claim/gateway.js';
import { readExportFile } from '../../../lib/src/importer/parse.js';
import { collectInvalidatedWorkUnits, previewChange } from '../../../lib/src/preview/index.js';
import { PASSPHRASE, withTempDb } from '../fixtures.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(dirname(dirname(SCRIPT))));

const AT = '2026-11-13T09:00:00.000Z';

function seed(id, kind, subject, payload, at = AT) {
  return { id, at, actor: 'm1-g-fixture', kind, subject, payload, request_id: `rq-${id}` };
}

/** 按链头补 prev/hash（不落库）；用于 previewChange 的事件批。 */
function signedSeeds(db, seeds) {
  let prev = chainHead(db);
  return seeds.map((item) => {
    const unsigned = {
      id: item.id,
      at: item.at ?? AT,
      actor: item.actor ?? 'm1-g-fixture',
      kind: item.kind,
      subject: item.subject,
      payload: item.payload,
      caused_by: item.caused_by ?? [],
      request_id: item.request_id ?? `rq-${item.id}`,
      prev,
      hash: '',
    };
    const hash = computeEventHash(unsigned);
    prev = hash;
    return { ...unsigned, hash };
  });
}

/** 按链头补 prev/hash 后经 `append()` 真写入；返回写入的事件。 */
function appendSeeds(db, seeds) {
  const events = signedSeeds(db, seeds);
  const result = append(db, events);
  if (!result.ok) {
    throw new Error(`append rejected: ${String(result.reason_code)} ${result.message ?? ''}`);
  }
  return events;
}

function intentSeeds(contentHash, at = AT) {
  return [
    seed('m1g-d-int-valid', 'decision.valid', 'd-int', {
      decision_kind: 'intent',
      payload_hash: 'ph-intent',
      frontier: 'f-1',
      payload: { statement: '把返工前移' },
    }, at),
    seed('m1g-d-int-signed', 'decision.signed', 'd-int', {
      payload_hash: 'ph-intent',
      signature: 'sig',
      key_id: 'k-1',
      signer: 'alice',
    }, at),
    seed('m1g-intent', 'intent.signed', 'INT-1', {
      decision_id: 'd-int',
      statement: '把返工前移',
      owner: 'alice',
      strength: 'explicit',
      baseline_hash: 'h-1',
      content_hash: contentHash,
    }, at),
  ];
}

function requirementSeed(at = AT) {
  return seed('m1g-spec', 'spec.defined', 'SPEC-1', {
    intent_id: 'INT-1',
    clause: '变更预览必须带 rework_units',
    kind: 'requirement',
    content_hash: 'ch:spec-1',
  }, at);
}

const FIXTURES = [
  { polarity: 'positive', input: 'positive-a', expected_status: 'pass' },
  { polarity: 'positive', input: 'positive-b', expected_status: 'pass' },
  { polarity: 'negative', input: 'negative-a', expected_status: 'fail' },
];

function criterionSeed(id, specId = 'SPEC-1', at = AT) {
  return seed(`m1g-${id}`, 'criterion.registered', id, {
    spec_id: specId,
    kind: 'acceptance',
    remedy: '补证据',
    fixtures: FIXTURES,
  }, at);
}

function evidenceSeed(id, criterionId, at = AT) {
  return seed(`m1g-${id}`, 'evidence.attached', id, {
    criterion_id: criterionId,
    artifact_uri: `artifact://m1-g/${id}.json`,
    artifact_sha256: `sha256:${'0'.repeat(64)}`,
    command: 'node --test',
  }, at);
}

function count(db, sql) {
  return db.prepare(sql).get().n;
}

function tableExists(db, name) {
  return (
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).n > 0
  );
}

function runCheckCli(dbPath, args) {
  const run = spawnSync(process.execPath, [join(ROOT, 'lib/src/check/cli.js'), ...args, '--db', dbPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SDO_DB_PASSPHRASE: PASSPHRASE, SDO_DB_PATH: dbPath },
    timeout: 60_000,
  });
  return {
    args,
    status: run.status,
    stdout: run.stdout.trim(),
    stderr: run.stderr.trim(),
    json: safeJson(run.stdout),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// ① claim 重建 20/20（6 列逐字段 + as_of_frontier 只校验事件 id 存在）
// ---------------------------------------------------------------------------
export function measureR1() {
  return withTempDb(({ db }) => {
    const parsed = readExportFile(join(ROOT, 'test/fixtures/v1-export.json'));
    const imported = importClaims(db, parsed.claims);
    const rows = parsed.claims.map((claim) => {
      const claimId = `claim:${claim.claim_no}`;
      const stored = db.prepare('SELECT * FROM claim WHERE id = ?').get(claimId);
      const v1 = {
        subject: claim.task_id,
        predicate: claim.predicate,
        value: canonicalJson({ code: claim.predicate, value: claim.value }),
        derived_by: claim.renderer,
        actor: claim.actor,
        at: claim.at,
      };
      const rebuilt = stored === undefined
        ? null
        : {
            subject: stored.subject,
            predicate: stored.predicate,
            value: stored.value,
            derived_by: stored.derived_by,
            actor: stored.actor,
            at: stored.at,
          };
      const equal = rebuilt !== null && canonicalJson(v1) === canonicalJson(rebuilt);
      // as_of_frontier 不参与 6 列逐字段比较；只校验：非空数组、每个 id 都能在 event 表找到。
      let frontierIds = null;
      let frontierOk = false;
      if (stored !== undefined) {
        try {
          const parsedFrontier = JSON.parse(String(stored.as_of_frontier));
          if (Array.isArray(parsedFrontier) && parsedFrontier.length > 0) {
            frontierIds = parsedFrontier;
            frontierOk = parsedFrontier.every(
              (id) => typeof id === 'string' && db.prepare('SELECT 1 AS ok FROM event WHERE id = ?').get(id) !== undefined,
            );
          }
        } catch {
          frontierOk = false;
        }
      }
      return { claim_no: claim.claim_no, claim_id: claimId, v1, rebuilt, equal, frontier_ok: frontierOk, frontier_ids: frontierIds };
    });
    const claimRows = count(db, 'SELECT count(*) AS n FROM claim');
    const allEqual = rows.length === 20 && rows.every((row) => row.equal) && claimRows === 20;
    const allFrontierOk = rows.every((row) => row.frontier_ok);
    return {
      id: 'R1',
      question: '抽 20 条 v1 结论型回执，在 claim 表能重建 20/20（6 列逐字段相等；as_of_frontier 只校验事件 id 存在）',
      command: 'node scripts/m1-readings.mjs --only R1',
      measured: {
        import: {
          ok: imported.ok,
          reason_code: imported.reason_code ?? null,
          claims_written: imported.claims_written,
          events_written: imported.events_written,
        },
        claimRows,
        rows,
        allEqual,
        allFrontierOk,
      },
      verdict: imported.ok && allEqual && allFrontierOk ? 'pass' : 'fail',
      caveat:
        '20 条样本来自 test/fixtures/v1-export.json（A2 已确认，夹具非真实 v1 导出）；6 列=subject/predicate/value/derived_by/actor/at，as_of_frontier 只校验“非空数组且每个事件 id 在 event 表存在”，不要求与 v1 的原 frontier 值逐 id 相等（v1 导出未保存 frontier 映射）。',
    };
  });
}

// ---------------------------------------------------------------------------
// ② 唯一写路径：append 一条 2 正 0 反的判据 ⇒ 被拒且一行不写
// ---------------------------------------------------------------------------
export function measureR2() {
  return withTempDb(({ db }) => {
    // 非空库：先写一条合法任务，让 before ≥ 1，“一行没写”才有意义。
    appendSeeds(db, [
      seed('m1g-r2-task', 'task.created', 'T0', { seq: 1, title: '基线任务', kind: 'implement' }),
    ]);
    const before = {
      events: count(db, 'SELECT count(*) AS n FROM event'),
      criteria: count(db, 'SELECT count(*) AS n FROM criterion'),
    };
    const badSeed = seed('m1g-r2-bad', 'criterion.registered', 'CRIT-BAD', {
      spec_id: 'SPEC-1',
      remedy: '缺负例仍想注册',
      fixtures: [
        { polarity: 'positive', input: 'positive-a', expected_status: 'pass' },
        { polarity: 'positive', input: 'positive-b', expected_status: 'pass' },
      ],
    });
    const writeResult = append(db, signedSeeds(db, [badSeed]));
    const after = {
      events: count(db, 'SELECT count(*) AS n FROM event'),
      criteria: count(db, 'SELECT count(*) AS n FROM criterion'),
    };
    const noWrites = before.events === after.events && before.criteria === after.criteria;
    const registerApi = registerCriterion(
      {
        criterion_id: 'alignment.examples_present',
        guarantee: '1',
        remedy: '补 2 正 1 反再注册',
        fixtures: [
          { polarity: 'positive', input: 'positive-a', expected_status: 'pass' },
          { polarity: 'positive', input: 'positive-b', expected_status: 'pass' },
        ],
      },
      () => 'pass',
    );
    const rejectedByWritePath =
      writeResult.ok === false &&
      writeResult.reason_code === 'materialize_failed' &&
      String(writeResult.message ?? '').includes('requires fixtures[]');
    return {
      id: 'R2',
      question: '新增判据无负例 ⇒ 唯一写路径 append 被拒（materialize_failed + requires fixtures[]），且失败时一行不写',
      command: 'node scripts/m1-readings.mjs --only R2',
      measured: {
        before,
        after,
        append_result: {
          ok: writeResult.ok,
          reason_code: writeResult.reason_code ?? null,
          message: writeResult.message ?? null,
          attempted: writeResult.attempted,
          written: writeResult.written,
          skipped: writeResult.skipped,
          rolled_back: writeResult.rolled_back,
          eventCount: writeResult.eventCount,
        },
        register_api_result: {
          ok: registerApi.ok,
          reason_code: registerApi.reason_code ?? null,
          note: '附带证据：注册 API 同样拒；verdict 以 append 为准',
        },
        noWrites,
        rejectedByWritePath,
      },
      verdict: rejectedByWritePath && noWrites && before.events > 0 ? 'pass' : 'fail',
      caveat:
        '主证据走唯一写路径 append（fold 在 criterion.registered 的机械门拒绝 2 正 0 反），库非空（先写 task.created）以排除“空库恒 0”的空证明；registerCriterion 纯函数返回只作附带证据，不作为 verdict 依据。',
    };
  });
}

// ---------------------------------------------------------------------------
// ③ 字段无消费者 ⇒ dead_field 红；补消费者 ⇒ 绿
// ---------------------------------------------------------------------------
export function measureR3() {
  return withTempDb(({ db, dbPath }) => {
    const red = runCheckCli(dbPath, ['--criterion', 'dead_field']);
    const redReport = red.json?.criterion;
    const redFields = (redReport?.reasons ?? [])
      .filter((reason) => reason.code === 'dead_field' && reason.level !== 'info')
      .map((reason) => reason.detail);
    const redInfo = (redReport?.reasons ?? []).filter(
      (reason) => reason.code === 'dead_field' && reason.level === 'info',
    ).length;
    const insert = db.prepare(
      'INSERT OR IGNORE INTO field_consumer (field, consumer_kind, consumer_id) VALUES (?, ?, ?)',
    );
    for (const field of redFields) insert.run(field, 'view', 'board');
    const green = runCheckCli(dbPath, ['--criterion', 'dead_field']);
    const greenReport = green.json?.criterion;
    const greenInfo = (greenReport?.reasons ?? []).filter(
      (reason) => reason.code === 'dead_field' && reason.level === 'info',
    ).length;
    const summarize = (run) => ({
      exit: run.status,
      mode: run.json?.mode ?? null,
      result: run.json?.criterion?.result ?? null,
      preview: run.json?.criterion?.preview ?? null,
      judged: run.json?.criterion?.judged ?? null,
      baseline: run.json?.baseline ?? null,
    });
    return {
      id: 'R3',
      question: '新增真源字段无消费者 ⇒ dead_field 红；补消费者（field_consumer）⇒ 绿',
      command: 'node scripts/m1-readings.mjs --only R3',
      measured: {
        red: { ...summarize(red), fields: redFields, info: redInfo, total: redFields.length + redInfo },
        green: { ...summarize(green), fields: [], info: greenInfo },
        consumersWritten: redFields.length,
      },
      verdict:
        redReport?.result === 'fail' && redFields.length > 0 && greenReport?.result === 'pass' ? 'pass' : 'fail',
      caveat:
        '红/绿都是同一临时库上 sdo_check CLI 的真实输出；红=fail 列表（逐列），info 行是“无写入方”列（scenario/claim 等，D-024/M1-6），不判 fail；绿靠补 field_consumer 目录行（不是改产品写入方清单）。',
    };
  });
}

// ---------------------------------------------------------------------------
// ④ 对齐可用（机制）——无真实外部意图样本，partial
// ---------------------------------------------------------------------------
const CODE_EVENT_KINDS_CHECKED = ['task.created(payload.kind=implement)'];

function firstCodeEventAt(db) {
  const rows = db.prepare('SELECT at, kind, payload FROM event ORDER BY rowid').all();
  for (const row of rows) {
    if (row.kind !== 'task.created') continue;
    let payload;
    try {
      payload = JSON.parse(String(row.payload));
    } catch {
      continue;
    }
    if (payload !== null && typeof payload === 'object' && payload.kind === 'implement') {
      return { at: String(row.at), kind: 'task.created(kind=implement)' };
    }
  }
  return null;
}

function dispositionRows(db, restatementId) {
  const problems = [];
  const events = readEvents(db, problems);
  if (problems.length > 0) throw new Error(`cannot read event chain: ${String(problems[0].code)}`);
  return events
    .filter((event) => event.kind === 'restatement.diff_dispositioned')
    .map((event) => {
      const payload = event.payload;
      if (payload === null || typeof payload !== 'object') return null;
      const record = payload;
      if (record['restatement_id'] !== restatementId) return null;
      return {
        target_ref: String(record['target_ref']),
        disposition: String(record['disposition']),
        at: event.at,
      };
    })
    .filter((row) => row !== null)
    .sort((left, right) => String(left.target_ref).localeCompare(String(right.target_ref)));
}

export function measureR4(options = {}) {
  const codeEventAt = options.codeEventAt ?? null;
  const d3Disposition = options.d3Disposition ?? 'reject';
  return withTempDb(({ db }) => {
    const T0 = '2026-11-13T09:00:00.000Z';
    const THUMAN = '2026-11-13T09:05:00.000Z';
    const TSPEC = '2026-11-13T09:10:00.000Z';
    appendSeeds(db, intentSeeds('ch:intent-1', '2026-11-13T08:55:00.000Z'));
    if (codeEventAt !== null) {
      appendSeeds(db, [
        seed('m1g-code-marker', 'task.created', 'T-CODE', { seq: 99, title: '代码标记', kind: 'implement' }, codeEventAt),
      ]);
    }
    const proposed = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [
        { id: 'd1', clause: '变更前给影响面' },
        { id: 'd2', clause: '返工量给数字' },
        { id: 'd3', clause: '自动批准' },
      ],
      inputs: [{ kind: 'intent', id: 'INT-1', hash: 'ch:intent-1' }],
      actor: 'alice',
      at: T0,
      restatementId: 'RST-1',
      eventId: 'm1g-restatement',
      requestId: 'rq-m1g-restatement',
    });
    if (!proposed.ok) throw new Error(`proposeRestatement failed: ${proposed.reason_code ?? ''}`);
    for (const [targetRef, disposition] of [
      ['d1', 'accept'],
      ['d2', 'accept'],
      ['d3', d3Disposition],
    ]) {
      const disposed = disposeDiff(db, {
        restatementId: 'RST-1',
        targetRef,
        kind: targetRef === 'd3' ? 'conflict' : 'agree',
        disposition,
        reason: targetRef === 'd3' ? '自动批准违反人签' : '同意',
        actor: 'alice',
        actorKind: 'human',
        at: THUMAN,
        eventId: `m1g-diff-${targetRef}`,
        requestId: `rq-m1g-diff-${targetRef}`,
      });
      if (!disposed.ok) throw new Error(`disposeDiff failed: ${disposed.reason_code ?? ''}`);
    }
    appendSeeds(db, [requirementSeed(TSPEC), criterionSeed('CRIT-1', 'SPEC-1', TSPEC)]);
    const gate = alignmentGate(db);
    const rows = dispositionRows(db, 'RST-1');
    const codeEvent = firstCodeEventAt(db);
    const codeWrittenAt = codeEvent === null ? null : codeEvent.at;
    const total = rows.length;
    const beforeCode =
      codeWrittenAt === null
        ? rows.length
        : rows.filter((row) => Date.parse(String(row.at)) < Date.parse(String(codeWrittenAt))).length;
    const rate = total === 0 ? 0 : beforeCode / total;
    return {
      id: 'R4',
      question: '一个真实意图走完复述 + 2 正 1 反，人能在第一次写代码前说“对/不对”；分歧前移率 ≥80%（现算）',
      command: 'node scripts/m1-readings.mjs --only R4',
      measured: {
        sample: {
          intent: 'INT-1',
          restatement_at: T0,
          human_verdict_at: THUMAN,
          requirement_written_at: TSPEC,
          code_written_at: codeWrittenAt,
          code_event_kinds_checked: CODE_EVENT_KINDS_CHECKED,
          diff_dispositions: rows,
        },
        gate: { ok: gate.ok, reason_code: gate.reason_code ?? null, pending: gate.pending, specIds: gate.specIds },
        divergence: {
          total,
          before_code: beforeCode,
          rate,
          formula: '对齐阶段发现的分歧数 ÷ 总分歧数；before_code = 处置 at 早于首次代码事件的条数',
        },
      },
      verdict: 'partial',
      caveat:
        '样本由本脚本合成（A3：不是真实外部意图；拿本项目自己的卡评“分歧前移”是循环论证）⇒ 只证“机制可用”，不证返工真的减少。diff_dispositions 从事件流现算；code_written_at 由事件链现查（当前可识别的代码事件 kind：task.created(payload.kind=implement)），M1 没有 ⇒ null（不是常量）；无代码事件时 before_code=total。',
    };
  });
}

// ---------------------------------------------------------------------------
// ⑤ 返工可见：两个场景 × 3 次真 append 抽样对账
// ---------------------------------------------------------------------------
function seedUnitTasks(db, specs) {
  appendSeeds(db, intentSeeds('ch:intent-1', '2026-11-13T08:55:00.000Z'));
  appendSeeds(db, [requirementSeed('2026-11-13T08:56:00.000Z')]);
  const specIds = [...new Set(specs)];
  for (const specId of specIds) {
    if (specId === 'SPEC-1') continue;
    appendSeeds(db, [
      seed(`m1g-spec-${specId}`, 'spec.defined', specId, {
        intent_id: 'INT-1',
        clause: `${specId} 的条款`,
        kind: 'requirement',
        content_hash: `ch:${specId}`,
      }, '2026-11-13T08:56:30.000Z'),
    ]);
  }
  for (const n of [1, 2, 3]) {
    const specId = specs[n - 1];
    appendSeeds(db, [
      seed(`m1g-task-${n}`, 'task.created', `T${n}`, {
        seq: n,
        title: `任务 ${n}`,
        kind: 'implement',
      }, '2026-11-13T08:57:00.000Z'),
      seed(`m1g-claim-${n}`, 'task.claimed', `T${n}`, { owner: 'alice' }, '2026-11-13T08:58:00.000Z'),
      criterionSeed(`CRIT-${n}`, specId, '2026-11-13T08:58:30.000Z'),
      evidenceSeed(`EV-${n}`, `CRIT-${n}`, '2026-11-13T08:59:00.000Z'),
      seed(`m1g-done-${n}`, 'task.done', `T${n}`, {
        criterion_id: `CRIT-${n}`,
        evidence_id: `EV-${n}`,
      }, '2026-11-13T08:59:30.000Z'),
    ]);
  }
}

function runChangeScenario({ id, specs, reviseSpecs, samples }) {
  const results = [];
  for (let run = 1; run <= samples; run += 1) {
    results.push(withTempDb(({ db }) => {
      seedUnitTasks(db, specs);
      const problems = [];
      const before = fold(undefined, readEvents(db, problems));
      if (problems.length > 0) throw new Error(`fixture chain unreadable: ${String(problems[0].code)}`);
      const batchSeeds = reviseSpecs.map((specId, index) =>
        seed(`m1g-revise-${id}-${run}-${index}`, 'spec.revised', specId, {
          reason: 'M1-G 抽样变更',
          clause: `变更后的条款 ${specId}/${run}`,
        }, `2026-11-13T10:0${run}:00.000Z`),
      );
      const batch = signedSeeds(db, batchSeeds);
      let preview;
      try {
        preview = previewChange(db, batch);
      } catch (error) {
        throw new Error(`previewChange failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const appended = appendSeeds(db, batchSeeds);
      const after = fold(undefined, readEvents(db, problems));
      if (problems.length > 0) throw new Error(`post-append chain unreadable: ${String(problems[0].code)}`);
      const actualUnits = collectInvalidatedWorkUnits(before, after);
      return {
        run,
        before_units: Object.keys(before.tables.work_unit).length,
        preview: preview.reworkUnits,
        actual: actualUnits.length,
        equal: preview.reworkUnits === actualUnits.length,
        invalidated: actualUnits.map((unit) => ({ task_id: unit.task_id, criterion_id: unit.criterion_id, spec_id: unit.spec_id, changed_refs: unit.changed_refs })),
        appended_event: appended.map((event) => event.id),
        work_unit_rows_after: count(db, 'SELECT count(*) AS n FROM work_unit'),
      };
    }));
  }
  return results;
}

export function measureR5() {
  const scenarioA = runChangeScenario({
    id: 'a',
    specs: ['SPEC-1', 'SPEC-1', 'SPEC-1'],
    reviseSpecs: ['SPEC-1'],
    samples: 3,
  });
  const scenarioB = runChangeScenario({
    id: 'b',
    specs: ['SPEC-1', 'SPEC-1', 'SPEC-2'],
    reviseSpecs: ['SPEC-1'],
    samples: 3,
  });
  const allEqualA = scenarioA.every((sample) => sample.equal && sample.before_units === 3 && sample.actual === 3);
  const allEqualB = scenarioB.every((sample) => sample.equal && sample.before_units === 3 && sample.actual === 2);
  return {
    id: 'R5',
    question: '每次变更的 preview 带 rework_units，且与事后实际作废数一致（两个场景各抽 3 次）',
    command: 'node scripts/m1-readings.mjs --only R5',
    measured: {
      scenarios: [
        { scenario: 'revise-sole-source', spec_per_task: ['SPEC-1', 'SPEC-1', 'SPEC-1'], revise: ['SPEC-1'], expected_actual: 3, samples: scenarioA, allEqual: allEqualA },
        { scenario: 'revise-one-of-two-sources', spec_per_task: ['SPEC-1', 'SPEC-1', 'SPEC-2'], revise: ['SPEC-1'], expected_actual: 2, samples: scenarioB, allEqual: allEqualB },
      ],
      allEqual: allEqualA && allEqualB,
    },
    verdict: allEqualA && allEqualB ? 'pass' : 'fail',
    caveat:
      '每次都是真 append（D-038 已 closed）后重新 fold 算“实际”；作废口径=M1 有效集合差（D-037，不是 v1 删除行）。两个场景故意让作废数不同（3 vs 2），避免“恒 3 全 equal”的常量通过；样本是引擎内夹具变更，不是真实项目变更。',
  };
}

// ---------------------------------------------------------------------------
// ⑥ P15 静态校验可用
// ---------------------------------------------------------------------------
export function measureR6() {
  const cases = [
    { id: 'criteria-empty', expect: 'gate_empty', allowed: ['gate_empty', 'core_not_effective'], label: 'criteria: []' },
    { id: 'core-unbound-stage', expect: 'core_not_effective', allowed: ['stage_no_gate', 'core_not_effective'], label: 'core 三条未有效绑定' },
    { id: 'missing-engine', expect: 'engine_missing', allowed: ['engine_missing'], label: '缺 engine' },
  ];
  const results = cases.map((item) => {
    const file = join(ROOT, 'test/fixtures/baseline', `${item.id}.json`);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const result = validateBaseline(parsed);
    const expectedPresent = result.reason_codes.includes(item.expect);
    const unexpected = result.reason_codes.filter((code) => !item.allowed.includes(code));
    return {
      fixture: `test/fixtures/baseline/${item.id}.json`,
      label: item.label,
      expect: item.expect,
      allowed: item.allowed,
      ok: result.ok,
      reason_codes: result.reason_codes,
      unexpected_codes: unexpected,
      hit: result.ok === false && expectedPresent && unexpected.length === 0,
    };
  });
  return {
    id: 'R6',
    question: '空 gate ⇒ gate_empty；core 未有效绑定 ⇒ core_not_effective；缺 engine ⇒ engine_missing（且不夹带未列出的码）',
    command: 'node scripts/m1-readings.mjs --only R6',
    measured: { results, allHit: results.every((item) => item.hit) },
    verdict: results.every((item) => item.hit) ? 'pass' : 'fail',
    caveat:
      '每份夹具断言“期望码必须在 + 允许的伴随码集合 + 不允许的码不得出现”：criteria-empty 实际 gate_empty+core_not_effective、core-unbound-stage 实际 stage_no_gate+core_not_effective。只证静态校验器能拒这三类，不证真实 baseline 覆盖度。',
  };
}

// ---------------------------------------------------------------------------
// ⑦ 判定行零产出（gate 表不存在 ⇒ 本读数 partial，不空过）
// ---------------------------------------------------------------------------
export function measureR7() {
  return withTempDb(({ db, dbPath }) => {
    seedUnitTasks(db, ['SPEC-1', 'SPEC-1', 'SPEC-1']);
    const runs = [
      runCheckCli(dbPath, ['--criterion', 'provenance.present']),
      runCheckCli(dbPath, ['--criterion', 'spec_set.signed']),
      runCheckCli(dbPath, ['--gate', 'req', '--preset', 'waterfall']),
    ];
    const tables = ['stage_run', 'gate', 'gate.judged'];
    const counts = tables.map((name) => ({
      table: name,
      exists: tableExists(db, name),
      rows: tableExists(db, name) ? count(db, `SELECT count(*) AS n FROM "${name}"`) : 0,
    }));
    const zero = counts.every((item) => item.rows === 0);
    // gate 表在 001–005 不存在：0 行是平凡真，不能算 pass（评审 P2-2）。
    const missingGateTable = counts.some((item) => (item.table === 'gate' || item.table === 'gate.judged') && item.exists === false);
    return {
      id: 'R7',
      question: 'M1 跑完 sdo_check 后 gate.judged（gate/stage_run 承载判定的表）行数为 0',
      command: 'node scripts/m1-readings.mjs --only R7',
      measured: {
        runs: runs.map((run) => ({
          args: run.args,
          status: run.status,
          mode: run.json?.mode ?? null,
          result: run.json?.mode === 'gate' ? run.json?.gate?.result : run.json?.criterion?.result,
          preview: run.json?.preview ?? null,
          judged: run.json?.judged ?? null,
          baseline: run.json?.baseline ?? null,
        })),
        counts,
        zero,
        missing_gate_table: missingGateTable,
      },
      verdict: zero && !missingGateTable ? 'pass' : 'partial',
      caveat:
        '`stage_run` 表在 001 存在，0 行是真断言；`gate`/`gate.judged` 在当前迁移（001–005）不存在 ⇒ 0 行是平凡真，本读数因此记 **partial**（不是空过 pass），M2 建表后必须复跑；sdo_check 只跑 3 个真实入口（provenance/spec_set/gate req）。',
    };
  });
}

export const MEASURES = {
  R1: measureR1,
  R2: measureR2,
  R3: measureR3,
  R4: () => measureR4(),
  R5: measureR5,
  R6: measureR6,
  R7: measureR7,
};
