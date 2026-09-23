import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabaseStore } from '../dist/src/core/database.js';
import { Engine } from '../dist/src/core/engine.js';
import { loadModel } from '../dist/src/core/model.js';

const temp = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

test('increment reservations survive deletes and failures and refresh for externally changed files', async (t) => {
  const model = await loadModel({ models: { Item: { collection: 'items', fields: { id: { type: 'number', primary: true, generated: 'increment' }, name: { type: 'string' } } } } });
  for (const storage of ['memory', 'file']) {
    const path = join(await temp(t), 'db.json');
    const data = { items: [{ id: 10, name: 'existing' }] };
    await writeFile(path, JSON.stringify(data));
    const store = await createDatabaseStore({ source: storage === 'file' ? path : data });
    const engine = new Engine(store, model);
    const entity = model.entities[0];
    await engine.mutate(entity, 'delete', 10);
    assert.equal((await engine.mutate(entity, 'create', undefined, {})).value.id, 11);
    await assert.rejects(
      () =>
        engine.mutate(entity, 'create', undefined, {}, () => {
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal((await engine.mutate(entity, 'create', undefined, {})).value.id, 12);
    if (storage === 'file') {
      await writeFile(path, JSON.stringify({ items: [{ id: 100 }] }));
      assert.equal((await engine.mutate(entity, 'create', undefined, {})).value.id, 101);
    }
  }
});
