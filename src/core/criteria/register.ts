/**
 * 判据注册门槛（M1-1 / C2/C3）。真源：`docs/04` §2「注册门槛（五条，缺一不许 active）」。
 *
 * 五条门槛：remedy 非空；至少 1 个正例夹具；至少 1 个负例夹具；单次实跑中位数 < 200ms；
 * `guarantee` ∈ {1,2,3,—}。夹具必须**实跑**：正例跑出 `pass`、负例跑出 `fail`，
 * 实跑结果与 `expected_status` 不符 ⇒ `fixture_mismatch`（"不该红的不红"）。
 *
 * 本函数只做判定、不写库；通过后调用方把同一批 `fixtures[]` 放进 `criterion.registered`
 * 事件载荷，由 fold/reducer 与 `append()` 在同一事务里落 `criterion` + `criterion_fixture`（C10）。
 *
 * 预算口径（A4 + P1-2）：**按夹具分别取中位数，再取这些中位数的 max**（最慢夹具 < 200ms）；
 * 生产路径不接受调用方传预算，`BUDGET_MS` 常量固定 200（测试用 `now` 注入时钟）。
 */

import { criterionMeta, isGuarantee } from './catalog.js';

export type FixturePolarity = 'positive' | 'negative';
export type FixtureStatus = 'pass' | 'fail' | 'na';

export interface Fixture {
  readonly polarity: FixturePolarity;
  readonly input: string;
  readonly expected_status: FixtureStatus;
}

export type RegistrationReason =
  | 'criterion_invalid'
  | 'guarantee_invalid'
  | 'fixtures_invalid'
  | 'no_positive_fixture'
  | 'no_negative_fixture'
  | 'fixture_mismatch'
  | 'budget_exceeded'
  | 'fixtures_missing'
  | 'unknown_criterion'
  | 'guarantee_mismatch';

export interface RegistrationRequest {
  readonly criterion_id: string;
  readonly guarantee: unknown;
  readonly remedy: string;
  readonly fixtures: readonly Fixture[];
}

export type FixtureRunner = (fixture: Fixture) => FixtureStatus;

export interface RegisterOptions {
  readonly now?: () => number;
  readonly samples?: number;
}

export interface RegistrationResult {
  readonly ok: boolean;
  readonly reason_code?: RegistrationReason;
  readonly message?: string;
  readonly elapsed_ms: number;
  readonly samples: readonly number[];
}

export const BUDGET_MS = 200;
export const BUDGET_SAMPLES = 3;

function isPolarity(value: unknown): value is FixturePolarity {
  return value === 'positive' || value === 'negative';
}

function isFixtureStatus(value: unknown): value is FixtureStatus {
  return value === 'pass' || value === 'fail' || value === 'na';
}

function reject(reason_code: RegistrationReason, message: string, elapsed_ms = 0): RegistrationResult {
  return { ok: false, reason_code, message, elapsed_ms, samples: [] };
}

function validateFixtures(fixtures: readonly Fixture[]): RegistrationResult | undefined {
  if (!Array.isArray(fixtures)) {
    return reject('fixtures_missing', 'registration requires fixtures[] with >=1 positive and >=1 negative');
  }
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (fixture === null || typeof fixture !== 'object') return reject('fixtures_invalid', 'fixture must be an object');
    if (!isPolarity(fixture.polarity)) return reject('fixtures_invalid', 'fixture.polarity must be positive|negative');
    if (typeof fixture.input !== 'string' || fixture.input.trim().length === 0) {
      return reject('fixtures_invalid', 'fixture.input must be a non-empty string');
    }
    if (!isFixtureStatus(fixture.expected_status)) {
      return reject('fixtures_invalid', 'fixture.expected_status must be pass|fail|na');
    }
    const key = `${fixture.polarity}\u0000${fixture.input}`;
    if (seen.has(key)) return reject('fixtures_invalid', `duplicate fixture ${fixture.polarity}:${fixture.input}`);
    seen.add(key);
  }
  if (!fixtures.some((fixture) => fixture.polarity === 'positive')) {
    return reject('no_positive_fixture', 'registration requires at least one positive fixture that runs pass');
  }
  if (!fixtures.some((fixture) => fixture.polarity === 'negative')) {
    return reject('no_negative_fixture', 'registration requires at least one negative fixture that runs fail');
  }
  return undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

/** 逐夹具实跑 `samples` 次，返回每夹具耗时中位数；同时校验实跑结果稳定且符合 polarity/expected。 */
function runFixtures(
  fixtures: readonly Fixture[],
  run: FixtureRunner,
  samples: number,
  now: () => number,
): { readonly medians: number[] } | RegistrationResult {
  const medians: number[] = [];
  for (const fixture of fixtures) {
    const elapsed: number[] = [];
    let observed: FixtureStatus | undefined;
    for (let index = 0; index < samples; index += 1) {
      const startedAt = now();
      const status = run(fixture);
      elapsed.push(now() - startedAt);
      if (!isFixtureStatus(status)) {
        return reject('fixture_mismatch', `fixture ${fixture.input}: runner returned non-verdict ${String(status)}`);
      }
      if (observed !== undefined && observed !== status) {
        return reject('fixture_mismatch', `fixture ${fixture.input}: runner is nondeterministic (${observed} vs ${status})`);
      }
      observed = status;
    }
    if (observed !== fixture.expected_status) {
      return reject(
        'fixture_mismatch',
        `fixture ${fixture.input}: expected_status=${fixture.expected_status} but runner returned ${observed ?? 'undefined'}`,
      );
    }
    if (fixture.polarity === 'positive' && observed !== 'pass') {
      return reject('fixture_mismatch', `positive fixture ${fixture.input} must run pass, got ${observed}`);
    }
    if (fixture.polarity === 'negative' && observed !== 'fail') {
      return reject('fixture_mismatch', `negative fixture ${fixture.input} must run fail, got ${observed}`);
    }
    // P1-2：先按夹具取中位数，再在调用处取 max；不把快慢夹具混进同一个池。
    medians.push(median(elapsed));
  }
  return { medians };
}

export function registerCriterion(
  request: RegistrationRequest,
  run: FixtureRunner,
  options: RegisterOptions = {},
): RegistrationResult {
  const now = options.now ?? (() => performance.now());
  const samples = options.samples ?? BUDGET_SAMPLES;
  const budget = BUDGET_MS;

  if (typeof request.criterion_id !== 'string' || request.criterion_id.trim().length === 0) {
    return reject('criterion_invalid', 'criterion_id must be a non-empty string');
  }
  if (typeof request.remedy !== 'string' || request.remedy.trim().length === 0) {
    return reject('criterion_invalid', 'remedy must be non-empty (docs/04 §2)');
  }
  // P2-1：注册器先查目录——未知 code / guarantee 与目录不符都不许过。
  const meta = criterionMeta(request.criterion_id);
  if (meta === undefined) {
    return reject('unknown_criterion', `criterion ${request.criterion_id} is not in the docs/04 catalog`);
  }
  if (!isGuarantee(request.guarantee)) {
    return reject('guarantee_invalid', `guarantee must be one of 1|2|3|—, got ${String(request.guarantee)}`);
  }
  if (meta.guarantee !== request.guarantee) {
    return reject(
      'guarantee_mismatch',
      `criterion ${request.criterion_id} is guarantee=${meta.guarantee} in the catalog, got ${request.guarantee}`,
    );
  }
  const invalid = validateFixtures(request.fixtures);
  if (invalid !== undefined) return invalid;

  const measured = runFixtures(request.fixtures, run, Math.max(1, samples), now);
  if ('ok' in measured) return measured;

  const elapsed_ms = Math.max(...measured.medians);
  if (elapsed_ms >= budget) {
    return {
      ok: false,
      reason_code: 'budget_exceeded',
      message: `slowest fixture median ${elapsed_ms.toFixed(2)}ms >= ${budget}ms budget`,
      elapsed_ms,
      samples: measured.medians,
    };
  }
  return { ok: true, elapsed_ms, samples: measured.medians };
}
