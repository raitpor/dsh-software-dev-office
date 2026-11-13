import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { append, chainHead } from '../../src/db/write.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { fold } from '../../src/core/fold/index.js';
import type { Event } from '../../src/core/fold/types.js';
import { computeEventHash, readEvents } from '../../src/core/verify-events.js';
import { canonicalJson, sha256Hex } from '../../src/core/fold/canonical.js';
import {
  PreviewError,
  collectInvalidatedWorkUnits,
  previewChange,
} from '../../src/preview/index.js';
import type { PreviewResult } from '../../src/preview/index.js';
import { chain, fourDomainSeeds, seed, withWriteDb } from '../db/append-helpers.js';

let counter = 1000;
function ev(
  kind: string,
  subject: string,
  payload: unknown,
  overrides: Partial<Omit<Event, 'prev' | 'hash'>> = {},
): Omit<Event, 'prev' | 'hash'> {
  counter += 1;
  return seed(counter, kind, subject, payload, overrides);
}
function appendSeeds(db: SdoDatabase, seeds: readonly Omit<Event, 'prev' | 'hash'>[]): Event[] {
  const events = chain(seeds, chainHead(db));
  const result = append(db, events);
  assert.equal(result.ok, true);
  return events;
}

function seedThreeWorkUnits(db: SdoDatabase): void {
  // M1-7 后写网关已支持 task.* / evidence.attached，铺 work_unit 走真 append（生产口径）。
  appendSeeds(db, fourDomainSeeds());
  appendSeeds(db, [
    ev('task.created', 'T1', { seq: 1, title: 'task 1', kind: 'implement' }),
    ev('task.created', 'T2', { seq: 2, title: 'task 2', kind: 'implement' }),
    ev('task.created', 'T3', { seq: 3, title: 'task 3', kind: 'implement' }),
    ev('task.claimed', 'T1', { owner: 'dev-1' }),
    ev('task.claimed', 'T2', { owner: 'dev-1' }),
    ev('task.claimed', 'T3', { owner: 'dev-1' }),
    ev('task.done', 'T1', { evidence_id: 'EVID-T1', criterion_id: 'CRIT-1' }),
    ev('task.done', 'T2', { evidence_id: 'EVID-T2', criterion_id: 'CRIT-1' }),
    ev('task.done', 'T3', { evidence_id: 'EVID-T3', criterion_id: 'CRIT-1' }),
    ev('evidence.attached', 'EVID-T1', {
      criterion_id: 'CRIT-1',
      artifact_uri: 'file:///t1',
      artifact_sha256: 'sha256:t1',
      command: 'node --test',
      task_id: 'T1',
    }),
    ev('evidence.attached', 'EVID-T2', {
      criterion_id: 'CRIT-1',
      artifact_uri: 'file:///t2',
      artifact_sha256: 'sha256:t2',
      command: 'node --test',
      task_id: 'T2',
    }),
    ev('evidence.attached', 'EVID-T3', {
      criterion_id: 'CRIT-1',
      artifact_uri: 'file:///t3',
      artifact_sha256: 'sha256:t3',
      command: 'node --test',
      task_id: 'T3',
    }),
  ]);
}

function readState(db: SdoDatabase) {
  const problems: Parameters<typeof readEvents>[1] = [];
  const events = readEvents(db, problems);
  assert.deepEqual(problems, []);
  return { events, state: fold(undefined, events) };
}

function drainBatch(
  db: SdoDatabase,
  seeds: readonly Omit<Event, 'prev' | 'hash'>[],
): { batch: Event[]; result: PreviewResult } {
  const batch = chain(seeds, chainHead(db));
  return { batch, result: previewChange(db, batch) };
}

test('C1 一次调用同时返回 willChange / reworkUnits / payloadHash，reworkUnits 是整数 ≥0', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const { result } = drainBatch(db, [
      ev('spec.revised', 'SPEC-1', { reason: 'upstream change', clause: 'clause 1 v2' }),
    ]);
    const reworkUnits: number = result.reworkUnits;
    assert.equal(typeof reworkUnits, 'number');
    assert.ok(Number.isInteger(reworkUnits));
    assert.ok(reworkUnits >= 0);
    assert.ok(Array.isArray(result.willChange));
    assert.equal(typeof result.payloadHash, 'string');
    assert.match(result.payloadHash, /^sha256:[0-9a-f]{64}$/);
  });
});

test('C2 正例 1：spec 内容变 ⇒ 引用它的 3 条 work_unit 全部作废（逐行证据）', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const { result } = drainBatch(db, [
      ev('spec.revised', 'SPEC-1', { reason: 'upstream change', clause: 'clause 1 v2' }),
    ]);
    assert.equal(result.reworkUnits, 3);
    assert.deepEqual(result.invalidatedWorkUnits, [
      { task_id: 'T1', criterion_id: 'CRIT-1', spec_id: 'SPEC-1', changed_refs: ['spec:SPEC-1'] },
      { task_id: 'T2', criterion_id: 'CRIT-1', spec_id: 'SPEC-1', changed_refs: ['spec:SPEC-1'] },
      { task_id: 'T3', criterion_id: 'CRIT-1', spec_id: 'SPEC-1', changed_refs: ['spec:SPEC-1'] },
    ]);
    const unitPaths = result.willChange
      .filter((change) => change.kind === 'work_unit')
      .map((change) => `${change.id}:${change.change}`);
    assert.deepEqual(unitPaths, ['wu:T1:invalidated', 'wu:T2:invalidated', 'wu:T3:invalidated']);
  });
});

test('C2 正例 2：变更不碰 work_unit 的上游 ⇒ reworkUnits 为数字 0（非 null/undefined/"0"）', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    appendSeeds(db, [
      ev('spec.defined', 'SPEC-2', {
        kind: 'requirement',
        clause: 'unrelated clause',
        intent_id: 'INT-1',
        content_hash: 'sha256:spec-2',
      }),
    ]);
    const { result } = drainBatch(db, [
      ev('spec.revised', 'SPEC-2', { reason: 'title only', clause: 'unrelated clause v2' }),
    ]);
    assert.equal(result.reworkUnits, 0);
    assert.equal(typeof result.reworkUnits, 'number');
    assert.deepEqual(result.invalidatedWorkUnits, []);
  });
});

test('C2 换一条 spec 的用例：作废数按引用逐行算（硬编码 3 会红）', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    // SPEC-3 被一条独立 work_unit 引用：只应作废这一条。
    appendSeeds(db, [
      ev('spec.defined', 'SPEC-3', {
        kind: 'requirement',
        clause: 'third clause',
        intent_id: 'INT-1',
        content_hash: 'sha256:spec-3',
      }),
      ev('criterion.registered', 'CRIT-3', { spec_id: 'SPEC-3', kind: 'functional', remedy: 'fix', fixtures: [{ polarity: 'positive', input: 'p', expected_status: 'pass' }, { polarity: 'negative', input: 'n', expected_status: 'fail' }] }),
      ev('task.created', 'T4', { seq: 4, title: 'task 4', kind: 'implement' }),
      ev('evidence.attached', 'EVID-T4', {
        criterion_id: 'CRIT-3',
        artifact_uri: 'file:///t4',
        artifact_sha256: 'sha256:t4',
        command: 'node --test',
        task_id: 'T4',
      }),
    ]);
    const { result } = drainBatch(db, [
      ev('spec.revised', 'SPEC-3', { reason: 'content change', clause: 'third clause v2' }),
    ]);
    assert.equal(result.reworkUnits, 1);
    assert.deepEqual(result.invalidatedWorkUnits, [
      { task_id: 'T4', criterion_id: 'CRIT-3', spec_id: 'SPEC-3', changed_refs: ['spec:SPEC-3'] },
    ]);
  });
});

test('C2 交叉触发：同一 work_unit 因 task+spec 同时变只计 1 条，changed_refs 列两个原因', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const { result } = drainBatch(db, [
      ev('spec.revised', 'SPEC-1', { reason: 'content change', clause: 'clause 1 v7' }),
      ev('task.reopened', 'T1', { reason: 'upstream_changed' }),
    ]);
    assert.equal(result.reworkUnits, 3);
    const t1 = result.invalidatedWorkUnits.find((unit) => unit.task_id === 'T1');
    assert.deepEqual(t1, {
      task_id: 'T1',
      criterion_id: 'CRIT-1',
      spec_id: 'SPEC-1',
      changed_refs: ['task:T1', 'spec:SPEC-1'],
    });
    for (const unit of result.invalidatedWorkUnits.filter((item) => item.task_id !== 'T1')) {
      assert.deepEqual(unit.changed_refs, ['spec:SPEC-1']);
    }
  });
});

test('C2 对照：只改没有 work_unit 的 task ⇒ reworkUnits=0（不是一律全算作废）', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    appendSeeds(db, [ev('task.created', 'T9', { seq: 9, title: 'unrelated task', kind: 'implement' })]);
    const { result } = drainBatch(db, [
      ev('task.assigned', 'T9', { assignee: 'dev-9', reserved_until: '2026-11-14T00:00:00Z' }),
    ]);
    assert.equal(result.reworkUnits, 0);
    assert.deepEqual(result.invalidatedWorkUnits, []);
    assert.ok(result.willChange.some((change) => change.kind === 'task' && change.id === 'T9'));
  });
});

test('C3 静态扫描：src/preview 整个目录不自带事件语义、事件语义只经 src/core/fold', () => {
  const dir = join(process.cwd(), 'src', 'preview');
  const files = readdirSync(dir).filter((file) => file.endsWith('.ts'));
  assert.ok(files.length > 0);
  const forbidden = [/switch\s*\(\s*event\.kind/, /event\.kind/, /switch\s*\(/, /case\s+['"]/];
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${file} must not implement event semantics (matched ${String(pattern)})`,
      );
    }
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier?.startsWith('../core/fold/') ||
          specifier === '../core/verify-events.js' ||
          specifier === '../core/verify-types.js' ||
          specifier === '../db/write-envelope.js' ||
          specifier === './types.js' ||
          specifier === './rework.js',
        `${file} imports an unexpected module: ${String(specifier)}`,
      );
    }
  }
});
test('C4 手填不算：入参自带 rework_units / reworkUnits ⇒ 结构化 invalid_args', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const batch = chain(
      [ev('spec.revised', 'SPEC-1', { reason: 'x', clause: 'clause 1 v3' })],
      chainHead(db),
    );
    for (const options of [{ rework_units: 0 }, { reworkUnits: 2 }]) {
      assert.throws(
        () => previewChange(db, batch, options),
        (error: unknown) =>
          error instanceof PreviewError &&
          error.code === 'invalid_args' &&
          /never accepted from the payload/.test(error.message),
      );
    }
  });
});

test('C5 纯函数：预览前后 event/work_unit 行数与 hash 链不变', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const before = readState(db);
    const workUnitRows = db.prepare('SELECT count(*) AS n FROM work_unit').all() as { n: number }[];
    const beforeCount = workUnitRows[0]?.n;
    const beforeHashes = before.events.map((event) => event.hash);
    const { result } = drainBatch(db, [
      ev('spec.revised', 'SPEC-1', { reason: 'x', clause: 'clause 1 v4' }),
    ]);
    assert.equal(result.reworkUnits, 3);
    const after = readState(db);
    assert.equal(after.events.length, before.events.length);
    assert.deepEqual(after.events.map((event) => event.hash), beforeHashes);
    const afterRows = db.prepare('SELECT count(*) AS n FROM work_unit').all() as { n: number }[];
    assert.equal(afterRows[0]?.n, beforeCount, '预览不得改 work_unit 表');
    assert.equal(afterRows[0]?.n, 3, 'M1-7 后 work_unit 已物化，真 append 的 3 行是前置状态');
  });
});

test('C6 对账（append 真落库）：预览 0 == 落库后重放的事后 0', () => {
  withWriteDb((db) => {
    // 只用写网关支持的 kind 铺事件（spec/criterion/evidence），没有 task ⇒ 没有 work_unit。
    appendSeeds(db, fourDomainSeeds());
    const before = readState(db);
    const batch = chain(
      [ev('spec.revised', 'SPEC-1', { reason: 'upstream change', clause: 'clause 1 v5' })],
      chainHead(db),
    );
    const preview = previewChange(db, batch);
    assert.equal(preview.reworkUnits, 0);
    assert.equal(preview.payloadHash, `sha256:${sha256Hex(canonicalJson(batch))}`);

    const appended = append(db, batch);
    assert.equal(appended.ok, true);
    if (!appended.ok) {
      return;
    }
    assert.equal(appended.written, 1);

    const after = readState(db);
    assert.equal(after.events.length, before.events.length + 1);
    const beforeState = fold(undefined, after.events.slice(0, before.events.length));
    const actual = collectInvalidatedWorkUnits(beforeState, fold(undefined, after.events));
    assert.equal(actual.length, preview.reworkUnits);
    assert.deepEqual(actual, preview.invalidatedWorkUnits);
  });
});

test('C6 对账（非零样本，真 append）：预览 3 == 落库后实际作废 3，逐条集合相等', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const before = readState(db);
    // 行级快照：只断行数不足以排除“删掉再重插成不同内容”的物化破坏。
    const unitRows = () =>
      db
        .prepare('SELECT id, task_id, criterion_id, spec_id, evidence_id, at FROM work_unit ORDER BY id')
        .all() as Record<string, unknown>[];
    const unitsBefore = unitRows();
    assert.equal(unitsBefore.length, 3);
    // ① 生产口径：preview 同批事件真 append 落库，再从落库后的链重新 fold 数实际作废数。
    const batch = chain(
      [ev('spec.revised', 'SPEC-1', { reason: 'upstream change', clause: 'clause 1 v5' })],
      chainHead(db),
    );
    const preview = previewChange(db, batch);
    assert.equal(preview.reworkUnits, 3);
    const appended = append(db, batch);
    assert.equal(appended.ok, true);
    if (!appended.ok) return;
    assert.equal(appended.written, 1);
    const after = readState(db);
    const actual = collectInvalidatedWorkUnits(before.state, fold(undefined, after.events));
    assert.equal(actual.length, preview.reworkUnits);
    assert.deepEqual(actual, preview.invalidatedWorkUnits);
    // work_unit 行本身不删：作废是“上游 hash 变”派生的有效集合差；行内容必须与 append 前逐条相同
    // （只断 count=3 会被“删掉再重插不同内容”骗过，见变异记录）。
    assert.deepEqual(unitRows(), unitsBefore);

    // ② 同一批事件在变更前状态上 fold 重放：证明 preview 与 append 的语义一致。
    //    这不是替代路径——上段已用真 append 取证；本段只做对账。
    const replay = collectInvalidatedWorkUnits(before.state, fold(before.state, batch));
    assert.deepEqual(replay, actual);
  });
});

test('空批：willChange=[]、reworkUnits=0，payloadHash 仍稳定', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const first = previewChange(db, []);
    assert.deepEqual(first.willChange, []);
    assert.equal(first.reworkUnits, 0);
    const second = previewChange(db, []);
    assert.equal(second.payloadHash, first.payloadHash);
  });
});

test('批不接在当前链尾 / 事件 hash 不对 ⇒ invalid_args', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const good = chain(
      [ev('spec.revised', 'SPEC-1', { reason: 'x', clause: 'clause 1 v6' })],
      chainHead(db),
    );
    const brokenPrev = [{ ...(good[0] as Event), prev: 'sha256:wrong' }];
    assert.throws(
      () => previewChange(db, brokenPrev),
      (error: unknown) => error instanceof PreviewError && error.code === 'invalid_args',
    );
    const brokenHash = [{ ...(good[0] as Event), hash: 'sha256:wrong' }];
    assert.throws(
      () => previewChange(db, brokenHash),
      (error: unknown) => error instanceof PreviewError && error.code === 'invalid_args',
    );
  });
});

test('fold 拒绝的批（如给不存在的 task 派活）⇒ 结构化 invalid_args，不半途写库', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const before = readState(db);
    const batch = chain(
      [ev('task.claimed', 'T404', { owner: 'dev-1' })],
      chainHead(db),
    );
    assert.throws(
      () => previewChange(db, batch),
      (error: unknown) => error instanceof PreviewError && error.code === 'invalid_args',
    );
    assert.equal(readState(db).events.length, before.events.length);
  });
});



test('P2 重放批：append 之后再 preview / 再 append 同一批 ⇒ 两边都接受且 reworkUnits 一致', () => {
  withWriteDb((db) => {
    // 只用 M1-0 支持的 kind（task.* 会被物化安全网拒，见 D-031）；重放语义本身不依赖 work_unit。
    appendSeeds(db, fourDomainSeeds());
    const batch = chain(
      [ev('spec.revised', 'SPEC-1', { reason: 'x', clause: 'clause 1 v3' })],
      chainHead(db),
    );

    const beforeFirst = previewChange(db, batch);
    assert.equal(beforeFirst.reworkUnits, 0);

    const first = append(db, batch);
    assert.equal(first.ok, true);

    // 同一批现在是“重放”：preview 必须像 append 一样接受（幂等，不再产生作废）。
    const replay = previewChange(db, batch);
    assert.equal(replay.reworkUnits, beforeFirst.reworkUnits);
    assert.deepEqual(replay.invalidatedWorkUnits, []);
    assert.deepEqual(previewChange(db, batch), replay);

    const second = append(db, batch);
    assert.equal(second.ok, true);
    assert.equal(second.written, 0);
    assert.equal(second.skipped, batch.length);
  });
});
test('P2 批内重复 id：preview 与 append 都拒（不落到 UNIQUE 冲突）', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const [first] = chain(
      [ev('spec.revised', 'SPEC-1', { reason: 'dup', clause: 'clause 1 v4' })],
      chainHead(db),
    );
    assert.ok(first !== undefined);
    const duplicateBase = { ...first, prev: first.hash } as Event;
    const duplicate = { ...duplicateBase, hash: computeEventHash({ ...duplicateBase, hash: '' }) };
    const batch = [first, duplicate];

    assert.throws(
      () => previewChange(db, batch),
      (error: unknown) =>
        error instanceof PreviewError &&
        error.code === 'invalid_args' &&
        /more than once/.test(error.message),
    );
    assert.equal(append(db, batch).ok, false);
  });
});

test('P3 C4：原型链上的 rework_units 也拒（`in` 而非 own property）', () => {
  withWriteDb((db) => {
    seedThreeWorkUnits(db);
    const batch = chain(
      [ev('spec.revised', 'SPEC-1', { reason: 'x', clause: 'clause 1 v5' })],
      chainHead(db),
    );
    const protoOptions = Object.create({ rework_units: 1 }) as Record<string, unknown>;
    assert.throws(
      () => previewChange(db, batch, protoOptions),
      (error: unknown) => error instanceof PreviewError && error.code === 'invalid_args',
    );
  });
});


test('P2-1 重复的重放事件：[e6, e6] preview 与 append 都接受（幂等跳过）', () => {
  withWriteDb((db) => {
    const persisted = appendSeeds(db, fourDomainSeeds());
    const e6 = persisted[persisted.length - 1];
    assert.ok(e6 !== undefined);

    const preview = previewChange(db, [e6, e6]);
    assert.equal(preview.reworkUnits, 0);
    assert.deepEqual(preview.invalidatedWorkUnits, []);

    const result = append(db, [e6, e6]);
    assert.equal(result.ok, true);
    assert.equal(result.written, 0);
    assert.equal(result.skipped, 2);
  });
});

test('P2-2 重放事件也校验信封：删 caused_by ⇒ preview 与 append 都拒', () => {
  withWriteDb((db) => {
    const persisted = appendSeeds(db, fourDomainSeeds());
    const e6 = persisted[persisted.length - 1];
    assert.ok(e6 !== undefined);
    const broken = { ...e6, caused_by: undefined } as unknown as Event;

    assert.throws(
      () => previewChange(db, [broken]),
      (error: unknown) =>
        error instanceof PreviewError &&
        error.code === 'invalid_args' &&
        /caused_by/.test(error.message),
    );
    const result = append(db, [broken]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'invalid_field');
  });
});
