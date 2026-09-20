import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../dist/index.js';
import { createDatabaseStore } from '../dist/src/core/database.js';
import { Engine } from '../dist/src/core/engine.js';
import { loadModel } from '../dist/src/core/model.js';
import { validateDirectory } from '../dist/src/files/contract.js';

const setup = async (t, data, schema) => {
  const app = (await createServer({ storage: 'memory', database: { source: data, schema }, server: { logger: false } })).fastify();
  t.after(() => app.close());
  return app;
};
const scopeUrl = (url, scope) => `${url}?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
const temp = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-beta3-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

test('newly inferred relations use the current transaction model for writes and conflicts', async (t) => {
  const app = await setup(t, { users: [{ id: '1', name: 'old' }], movies: [{ id: 'm', title: 'movie' }] });
  assert.equal((await app.inject({ method: 'PATCH', url: '/movies/m', payload: { userId: '1' } })).statusCode, 200);
  const updated = await app.inject({ method: 'PATCH', url: '/movies/m', payload: { user: { id: '1', name: 'new' } } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal((await app.inject('/users/1')).json().name, 'new');
  const conflict = await app.inject({ method: 'PATCH', url: '/movies/m', payload: { userId: '1', user: { id: '1', name: 'rejected' } } });
  assert.equal(conflict.statusCode, 400, conflict.body);
  assert.equal((await app.inject('/users/1')).json().name, 'new');
  const read = await app.inject(scopeUrl('/movies/m', [{ user: [{ name: true }] }]));
  assert.deepEqual(read.json(), { user: { name: 'new' } });
});

for (const explicit of [false, true]) {
  test(`embedded union preserves distinct objects without primary keys (explicit=${explicit})`, async (t) => {
    const schema = explicit ? { models: { Item: { collection: 'items', fields: { id: { type: 'number', primary: true }, rows: { type: 'object[]' }, 'rows.name': { type: 'string' } } } } } : undefined;
    const rows = [{ name: 'same' }, { name: 'same' }, { name: 'last' }];
    const app = await setup(t, { items: [{ id: 1, rows }] }, schema);
    const response = await app.inject(scopeUrl('/items/1', [{ rows: { union: [[{ '*': true }, { pager: { pageSize: 2 } }], [{ '*': true }]] } }]));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { rows: { data: rows, total: 3 } });
  });
}

test('schemaless wildcard selects actual primitives in mixed fields and excludes relation keys', async (t) => {
  const app = await setup(t, {
    users: [{ id: 'u' }],
    items: [
      { id: 1, value: 1, userId: 'u' },
      { id: 2, value: [2, 3] },
      { id: 3, value: { name: 'nested' } },
      { id: 4, value: null },
    ],
  });
  const response = await app.inject('/items');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, [{ id: 1, value: 1 }, { id: 2 }, { id: 3 }, { id: 4, value: null }]);
  const array = await app.inject(scopeUrl('/items/2', [{ value: [{ '*': true }] }]));
  assert.equal(array.statusCode, 200, array.body);
  assert.deepEqual(array.json().value, [2, 3]);
});

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

test('portable directory segments use the same validation for initial files and HTTP uploads', async (t) => {
  for (const path of ['CON', 'photos/bad:name', 'trailing.', 'line\nbreak', 'a/NUL.txt']) assert.throws(() => validateDirectory(path, 'directory'));
  assert.equal(validateDirectory('photos/2026', 'directory'), 'photos/2026');
  const app = (await createServer({ storage: 'memory', database: { source: { items: [] } }, files: { source: [] }, server: { logger: false } })).fastify();
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': 'a.txt', 'content-directory': 'photos/CON', 'content-type': 'text/plain' }, payload: 'test' });
  assert.equal(response.statusCode, 400, response.body);
});

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

test('wildcard preserves system nulls and omits nullable objects and arrays declared by the schema', async (t) => {
  const schema = {
    timestamps: true,
    models: {
      Item: {
        collection: 'items',
        fields: {
          id: { type: 'string', primary: true },
          name: { type: 'string', nullable: true },
          tags: { type: 'string[]', nullable: true },
          profile: { type: 'object', nullable: true },
          'profile.name': { type: 'string' },
        },
      },
    },
  };
  const app = await setup(t, { items: [{ id: '1', name: null, tags: null, profile: null }] }, schema);
  const response = await app.inject('/items/1');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { id: '1', name: null, createdAt: null, updatedAt: null });
  assert.deepEqual((await app.inject(scopeUrl('/items/1', [{ tags: true, profile: [{ '*': true }] }]))).json(), { tags: null, profile: null });
});

test('disk mutations infer relations from the fresh transaction snapshot before any GET', async (t) => {
  const path = join(await temp(t), 'db.json');
  const data = { users: [{ id: '1', name: 'old' }], movies: [{ id: 'm' }] };
  await writeFile(path, JSON.stringify(data));
  const app = (await createServer({ storage: 'file', database: { source: path }, server: { logger: false } })).fastify();
  t.after(() => app.close());
  await app.ready();
  data.movies[0].userId = '1';
  await writeFile(path, JSON.stringify(data));
  const result = await app.inject({ method: 'PATCH', url: '/movies/m', payload: { user: { id: '1', name: 'new' } } });
  assert.equal(result.statusCode, 200, result.body);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.users[0].name, 'new');
  assert.equal(stored.movies[0].userId, '1');
  assert.equal(Object.hasOwn(stored.movies[0], 'user'), false);
});
