import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pathHitsPublicFace } from '../../../src/core/publicface/catalog.js';

// M4-3 第 1 轮 P1-1：相交按路径段双向包含。
test('C2: public face intersection is bidirectional on segments', () => {
  assert.equal(pathHitsPublicFace('src/core/criteria/register.ts', 'src/core/criteria/'), true);
  assert.equal(pathHitsPublicFace('src/core', 'src/core/criteria/'), true, '写域比公共面宽也算相交');
  assert.equal(pathHitsPublicFace('src/core/criteria/', 'src/core/criteria/register.ts'), true);
  assert.equal(pathHitsPublicFace('src/core', 'src/core2'), false, '段前缀不是字符串前缀');
  assert.equal(pathHitsPublicFace('a/b', 'a/bc'), false);
  assert.equal(pathHitsPublicFace('src/views/catalog.ts', 'src/core/criteria/'), false);
});

// M4-3 第 2 轮 P3：`..` 不归一就能绕过相交判定（`src/core/../migrations/x`）。
test('C2/P3: dot segments are normalized before intersecting', () => {
  assert.equal(pathHitsPublicFace('src/../migrations/002_views.sql', 'migrations/002_views.sql'), true);
  // 归一后是 src/migrations/...，与 migrations/... 不相交——证明判定看的是归一结果而不是原串包含
  assert.equal(pathHitsPublicFace('src/core/../migrations/002_views.sql', 'migrations/002_views.sql'), false);
  assert.equal(pathHitsPublicFace('./src/core/criteria/x.ts', 'src/core/criteria/'), true);
  assert.equal(pathHitsPublicFace('src/core/criteria/../../core', 'src/core'), true);
});
