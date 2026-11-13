import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SDO_CORE_VERSION, describeCoreVersion } from '../src/core/version.js';

test('core: version marker is present and descriptive', () => {
  assert.match(SDO_CORE_VERSION, /^\d+\.\d+\.\d+-m\d+$/);
  assert.equal(describeCoreVersion(), `sdo-core/${SDO_CORE_VERSION}`);
  assert.notEqual(describeCoreVersion(), 'sdo-core/');
});
