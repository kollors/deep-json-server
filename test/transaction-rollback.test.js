import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabaseStore } from '../dist/src/core/database.js';
import { Engine } from '../dist/src/core/engine.js';
import { loadModel } from '../dist/src/core/model.js';
import { cloneSnapshot, freezeSnapshot } from '../dist/src/core/snapshot.js';

const schema = (fields = {}) => ({
  models: { Note: { collection: 'notes', fields: { id: { type: 'number', primary: true, generated: 'increment' }, name: { type: 'string', required: true }, ...fields } } },
});
const temp = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

for (const storage of ['memory', 'file']) {
  test(`${storage}: async transaction failures roll back, successful callbacks finish before the next transaction`, async (t) => {
    const path = join(await temp(t), 'db.json');
    const data = { notes: [{ id: 1, name: 'before' }] };
    await writeFile(path, JSON.stringify(data));
    const store = await createDatabaseStore({ source: storage === 'file' ? path : data });
    await assert.rejects(
      store.update(async (draft) => {
        draft.data.notes[0].name = 'rejected';
        await Promise.resolve();
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.deepEqual(await store.read(), data);
    if (storage === 'file') assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data);
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const first = store.update(async (draft) => {
      draft.data.notes[0].name = 'pending';
      started.resolve();
      await release.promise;
      draft.data.notes[0].name = 'committed';
      return 'result';
    });
    await started.promise;
    assert.deepEqual(await store.read(), data);
    const second = store.update((draft) => {
      assert.equal(draft.data.notes[0].name, 'committed');
      draft.data.notes.push({ id: 2, name: 'second' });
    });
    release.resolve();
    assert.equal(await first, 'result');
    await second;
    assert.deepEqual(
      (await store.read()).notes.map((row) => row.name),
      ['committed', 'second'],
    );
    assert.throws(() => {
      store.database.data = data;
    }, TypeError);
    assert.throws(() => {
      store.database = { data };
    }, TypeError);
    assert.throws(() => {
      store.database.data.notes[0].name = 'forged';
    }, TypeError);
  });
}

for (const storage of ['memory', 'file']) {
  test(`${storage}: every mutation waits for response preparation and rolls back a rejected response`, async (t) => {
    const path = join(await temp(t), 'db.json');
    const data = { notes: [{ id: 1, name: 'before' }] };
    await writeFile(path, JSON.stringify(data));
    const store = await createDatabaseStore({ source: storage === 'file' ? path : data });
    const model = await loadModel(schema());
    const engine = new Engine(store, model);
    const entity = model.entities[0];
    for (const mode of ['create', 'update', 'replace', 'delete']) {
      await assert.rejects(
        engine.mutate(entity, mode, mode === 'create' ? undefined : 1, { name: 'rejected' }, async () => {
          await Promise.resolve();
          throw new Error('response failed');
        }),
        /response failed/,
      );
      assert.deepEqual(await store.read(), data, mode);
      if (storage === 'file') assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data, mode);
    }
    const output = await engine.mutate(entity, 'create', undefined, { name: 'saved' }, async (ref) => {
      await Promise.resolve();
      return { id: ref.value.id, name: ref.value.name };
    });
    assert.deepEqual(output, { id: 2, name: 'saved' });
    assert.equal((await store.read()).notes.length, 2);
  });
}

test('snapshot freezing visits shallow-frozen ancestors and cloning produces independent mutable data', () => {
  const child = { tags: ['old'] };
  const source = Object.freeze({
    notes: [
      { id: 1, child },
      { id: 2, child },
    ],
  });
  const snapshot = freezeSnapshot(source);
  assert.equal(snapshot, source);
  assert.throws(() => child.tags.push('forged'), TypeError);
  assert.equal(freezeSnapshot(snapshot), snapshot);
  const copy = cloneSnapshot(snapshot);
  copy.notes[0].child.tags.push('copy');
  assert.deepEqual(snapshot.notes[0].child.tags, ['old']);
});
