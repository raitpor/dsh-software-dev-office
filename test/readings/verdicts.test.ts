import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface VerdictsApi {
  overallFor(verdicts: Record<string, 'pass' | 'partial' | 'fail'>): 'pass' | 'partial' | 'fail';
  exitCodeFor(verdicts: Record<string, 'pass' | 'partial' | 'fail'>): number;
}

async function loadVerdicts(): Promise<VerdictsApi> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/readings/verdicts.mjs')).href;
  return (await import(url)) as VerdictsApi;
}

test('exitCodeFor: fail ⇒ 1, partial ⇒ 0, all pass ⇒ 0', async () => {
  const verdicts = await loadVerdicts();

  assert.equal(verdicts.overallFor({ R1: 'pass', R2: 'pass' }), 'pass');
  assert.equal(verdicts.overallFor({ R1: 'pass', R4: 'partial' }), 'partial');
  assert.equal(verdicts.overallFor({ R1: 'fail', R4: 'partial' }), 'fail');

  assert.equal(verdicts.exitCodeFor({ R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass' }), 0);
  assert.equal(verdicts.exitCodeFor({ R1: 'pass', R4: 'partial' }), 0);
  assert.equal(verdicts.exitCodeFor({ R1: 'fail', R4: 'partial' }), 1);
});
