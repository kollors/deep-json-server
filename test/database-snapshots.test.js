import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabaseStore } from '../dist/src/core/database.js';

const temp = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

for (const storage of ['memory', 'file']) {
  test(`${storage} snapshots cannot be changed through reads or a failed transaction callback`, async (t) => {
    const data = { items: [{ id: '1', values: ['old'] }] };
    const path = join(await temp(t), 'db.json');
    await writeFile(path, JSON.stringify(data));
    const store = await createDatabaseStore({ source: storage === 'file' ? path : data });
    const snapshot = await store.read();
    assert.throws(() => snapshot.items[0].values.push('forged'), TypeError);
    await assert.rejects(
      () =>
        store.update((draft, before) => {
          draft.data.items[0].values.push('draft');
          before.items.push({ id: 'outside' });
        }),
      TypeError,
    );
    assert.deepEqual(await store.read(), data);
    await store.update((draft) => {
      draft.data.items[0].values.push('saved');
    });
    assert.deepEqual(snapshot, data);
    assert.throws(() => store.database.data.items[0].values.push('after commit'), TypeError);
    assert.deepEqual((await store.read()).items[0].values, ['old', 'saved']);
    if (storage === 'file') assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).items[0].values, ['old', 'saved']);
  });
}
