import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../dist/index.js';

const setup = async (t, data, schema) => {
  const app = (await createServer({ storage: 'memory', database: { source: data, schema }, server: { logger: false } })).fastify();
  t.after(() => app.close());
  return app;
};
const scopeUrl = (url, scope) => `${url}?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
const temp = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-test-'));
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

test('generated string ids preserve relations beside numeric ids and support subsequent nested writes', async (t) => {
  const app = await setup(t, {
    users: [{ id: 1, name: 'numeric' }],
    movies: [
      { id: 'a', userId: 1 },
      { id: 'b', userId: 1 },
    ],
  });
  const created = await app.inject({ method: 'POST', url: '/users', payload: { name: 'generated' } });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  assert.equal(typeof id, 'string');
  const linked = await app.inject({ method: 'PATCH', url: '/movies/b', payload: { user: { id } } });
  assert.equal(linked.statusCode, 200, linked.body);
  const read = await app.inject(scopeUrl('/movies', [{ id: true, user: [{ name: true }] }]));
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(read.json().data, [
    { id: 'a', user: { name: 'numeric' } },
    { id: 'b', user: { name: 'generated' } },
  ]);
  const nested = await app.inject({ method: 'PATCH', url: '/movies/b', payload: { user: { id, name: 'updated' } } });
  assert.equal(nested.statusCode, 200, nested.body);
  assert.equal((await app.inject(`/users/${id}`)).json().name, 'updated');
  const reverse = await app.inject(scopeUrl(`/users/${id}`, [{ movies: [{ id: true }] }]));
  assert.equal(reverse.statusCode, 200, reverse.body);
  assert.deepEqual(reverse.json(), { movies: { data: [{ id: 'b' }], total: 1 } });
});

test('inferred nested arrays of relation keys accept numeric and string ids together', async (t) => {
  const app = await setup(t, {
    users: [
      { id: 1, name: 'number' },
      { id: 's', name: 'string' },
    ],
    movies: [{ id: 'm', cast: { userIds: [1, 's'] } }],
  });
  const read = await app.inject(scopeUrl('/movies/m', [{ cast: [{ users: [{ name: true }] }] }]));
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(read.json(), { cast: { users: { data: [{ name: 'number' }, { name: 'string' }], total: 2 } } });
  const reverse = await app.inject(scopeUrl('/users/s', [{ movies: [{ id: true }] }]));
  assert.equal(reverse.statusCode, 200, reverse.body);
  assert.deepEqual(reverse.json(), { movies: { data: [{ id: 'm' }], total: 1 } });
});

test('mixed relation key structures and non-key types still prevent inference', async (t) => {
  for (const values of [
    [1, [1]],
    [1, true],
    ['s', { value: 1 }],
  ]) {
    const app = await setup(t, { users: [{ id: 1 }, { id: 's' }], movies: values.map((userId, i) => ({ id: String(i), userId })) });
    const read = await app.inject(scopeUrl('/movies', [{ user: [{ id: true }] }]));
    assert.equal(read.statusCode, 400, read.body);
    assert.match(read.json().error, /Unknown or inaccessible scope field user/);
  }
});
