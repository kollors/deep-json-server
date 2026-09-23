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
