import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  CRITERIA_CATALOG,
  STAGE_KINDS,
  catalogCodes,
  criterionMeta,
  isCoreCriterion,
  isGuarantee,
  isStageKind,
  appliesToKinds,
  CORE_CODES,
  type Guarantee,
  type StageKind,
} from '../../../src/core/criteria/catalog.js';

const DOC = resolve(process.cwd(), 'docs/04-判据-门禁与负例.md');

/** §4 表格：`| \`code\` | guarantee | ...` ⇒ code→保证。 */
function parseDocGuarantees(markdown: string): Map<string, Guarantee> {
  const section = markdown.slice(markdown.indexOf('## 4.'), markdown.indexOf('### 4.1'));
  const found = new Map<string, Guarantee>();
  for (const line of section.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([123—])\s*\|/u.exec(line);
    if (match === null) continue;
    found.set(match[1] as string, match[2] as Guarantee);
  }
  return found;
}

/** §4.1 表格：首列 code 列表、第二列 kinds 列表。 */
function parseDocAppliesTo(markdown: string): Map<string, StageKind[]> {
  const section = markdown.slice(markdown.indexOf('### 4.1'), markdown.indexOf('## 5.'));
  const found = new Map<string, StageKind[]>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const codes = [...(cells[1] ?? '').matchAll(/`([^`]+)`/gu)].map((match) => match[1] as string);
    if (codes.length === 0) continue;
    const kinds = (cells[2] ?? '')
      .split('/')
      .map((kind) => kind.trim())
      .filter((kind) => kind.length > 0);
    for (const kind of kinds) assert.ok(isStageKind(kind), `doc applies_to has invalid kind ${kind}`);
    for (const code of codes) found.set(code, kinds as StageKind[]);
  }
  return found;
}

test('C1: catalog is a snapshot equal to docs/04 §4 (guarantee) and §4.1 (applies_to)', () => {
  const markdown = readFileSync(DOC, 'utf8');
  const guarantees = parseDocGuarantees(markdown);
  const appliesTo = parseDocAppliesTo(markdown);

  assert.equal(CRITERIA_CATALOG.length, 24, 'catalog must have exactly 24 entries');
  assert.deepEqual(new Set(catalogCodes()), new Set(guarantees.keys()), 'catalog codes != docs/04 §4');
  assert.equal(appliesTo.size + 1, 24, '§4.1 covers 23 gate-bound codes; work_unit is table-bound');

  for (const meta of CRITERIA_CATALOG) {
    assert.equal(meta.guarantee, guarantees.get(meta.code), `${meta.code}: guarantee drift`);
    assert.ok(isGuarantee(meta.guarantee));
    for (const kind of meta.applies_to) assert.ok(isStageKind(kind));
    if (meta.code === 'work_unit.evidence_consistent') {
      assert.deepEqual(meta.applies_to, [], 'work_unit.evidence_consistent is table-bound (no gate)');
      continue;
    }
    assert.deepEqual([...meta.applies_to].sort(), [...(appliesTo.get(meta.code) ?? [])].sort(), `${meta.code}: applies_to drift`);
  }
});

test('C1: catalog exposes pure query helpers (no DB)', () => {
  assert.equal(catalogCodes().length, 24);
  assert.deepEqual([...CORE_CODES], ['spec_set.signed', 'assumption_set.signed', 'provenance.present']);
  assert.equal(isCoreCriterion('provenance.present'), true);
  assert.equal(isCoreCriterion('task.complete'), false);
  assert.equal(criterionMeta('task.complete')?.guarantee, '3');
  assert.equal(criterionMeta('nope'), undefined);
  assert.equal(appliesToKinds(criterionMeta('task.complete')!, ['design']), false);
  assert.equal(appliesToKinds(criterionMeta('task.complete')!, ['design', 'implement']), true);
  assert.deepEqual([...STAGE_KINDS], ['requirement', 'design', 'implement', 'review', 'deliver']);
});
