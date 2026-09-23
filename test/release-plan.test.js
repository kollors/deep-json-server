import assert from 'node:assert/strict';
import test from 'node:test';
import { releasePlan } from '../scripts/prepare-release.js';

test('release plan publishes prerelease channels from main and stable versions from tags', () => {
  assert.deepEqual(releasePlan('1.0.0-alpha.1', 'branch', 'main'), { publish: true, createTag: true, tag: 'v1.0.0-alpha.1' });
  assert.deepEqual(releasePlan('1.0.0-beta.1', 'branch', 'main'), { publish: true, createTag: true, tag: 'v1.0.0-beta.1' });
  assert.deepEqual(releasePlan('1.0.0-rc.1', 'branch', 'main'), { publish: true, createTag: true, tag: 'v1.0.0-rc.1' });
  assert.deepEqual(releasePlan('1.0.0', 'branch', 'main'), { publish: false, createTag: false, tag: 'v1.0.0' });
  assert.deepEqual(releasePlan('1.0.0', 'tag', 'v1.0.0'), { publish: true, createTag: false, tag: 'v1.0.0' });
});
