import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, generateOpenapi, hashPassword } from '../dist/index.js';
import { runCli } from '../dist/src/cli/index.js';
import { normalizeServerConfig } from '../dist/src/server/config.js';

const passwordHash = await hashPassword('test-password');
const users = [
  { id: 'a', username: 'alice', passwordHash },
  { id: 'b', username: 'bob', passwordHash },
  { id: 'root', username: 'admin', passwordHash, isAdmin: true },
];
const item = { collection: 'items', fields: { id: { type: 'number', primary: true, generated: 'increment' }, name: { type: 'string', required: true } } };
const model = { Item: item };
const setup = async (t, options = {}) => {
  const facade = await createServer({ database: { data: { items: [] }, schema: model, timestamps: true, softDelete: true }, server: { logger: false }, ...options });
  const app = facade.fastify();
  t.after(() => app.close());
  await app.ready();
  return { app, facade };
};
const headers = (token) => (token ? { authorization: `Bearer ${token}` } : {});
const request = (app, method, url, payload, token) => app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), headers: headers(token) });
const login = async (app, username) => {
  const response = await request(app, 'POST', '/auth/login', { username, password: 'test-password' });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().accessToken;
};
const scope = (path, where, fields = { '*': true }) => `${path}?${new URLSearchParams({ scope: JSON.stringify([fields, { where }]) })}`;
const gql = (app, query, token) => request(app, 'POST', '/graphql', { query }, token);
const temp = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-lifecycle-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

test('timestamps, deletion filters, singleton reads and PUT/PATCH restoration agree', async (t) => {
  const { app, facade } = await setup(t, { graphql: { enabled: true } });
  const created = await request(app, 'POST', '/items', { name: 'one' });
  assert.equal(created.statusCode, 201, created.body);
  const row = created.json();
  assert.equal(row.createdAt, row.updatedAt);
  assert.equal(new Date(row.createdAt).toISOString(), row.createdAt);
  assert.equal(row.deletedAt, null);
  assert.equal(row.createdById, undefined);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5000 });
  const removed = await request(app, 'DELETE', '/items/1');
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(removed.json().deletedAt);
  assert.equal(removed.json().updatedAt, removed.json().deletedAt);
  assert.equal(removed.json().djsDeletion, undefined);
  assert.equal((await app.inject('/items')).json().total, 0);
  assert.ok((await app.inject('/items/1')).json().deletedAt);
  assert.ok((await gql(app, '{item(id:1){deletedAt}}')).json().data.item.deletedAt);
  assert.equal((await app.inject(scope('/items', { deletedAt: { ne: null } }))).json().total, 1);
  assert.equal((await app.inject(scope('/items', { not: { deletedAt: { eq: null } } }))).json().total, 1);
  assert.equal((await app.inject(scope('/items', { or: [{ deletedAt: { eq: null } }, { deletedAt: { ne: null } }] }))).json().total, 1);
  const invalid = await request(app, 'PUT', '/items/1', {});
  assert.equal(invalid.statusCode, 400);
  assert.ok((await app.inject('/items/1')).json().deletedAt);
  const restored = await request(app, 'PATCH', '/items/1', {});
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().deletedAt, null);
  assert.equal(restored.json().createdAt, row.createdAt);
  await request(app, 'DELETE', '/items/1');
  const replaced = (await gql(app, 'mutation{itemReplace(id:1,data:{name:"new"}){name createdAt updatedAt deletedAt}}')).json();
  assert.equal(replaced.errors, undefined);
  assert.equal(replaced.data.itemReplace.deletedAt, null);
  assert.equal(replaced.data.itemReplace.createdAt, row.createdAt);
  for (const field of ['createdAt', 'updatedAt', 'deletedAt', 'djsDeletion']) {
    assert.equal((await request(app, 'PATCH', '/items/1', { [field]: null })).statusCode, 400);
    assert.equal((await app.inject(scope('/items', { [field]: { eq: null } }))).statusCode, field === 'djsDeletion' ? 400 : 200);
  }
  assert.doesNotMatch(await facade.graphql(), /djsDeletion/);
  assert.equal((await facade.openapi()).components.schemas.Item.properties.djsDeletion, undefined);
});

test('entity overrides and schemaless collections independently enable record features', async (t) => {
  const mixed = { Item: { ...item, timestamps: false }, Plain: { ...item, collection: 'plain', softDelete: false }, Both: { ...item, collection: 'both', timestamps: false, softDelete: false } };
  const { app } = await setup(t, { database: { schema: mixed, data: { items: [], plain: [], both: [] }, timestamps: true, softDelete: true } });
  const a = (await request(app, 'POST', '/items', { name: 'a' })).json();
  const b = (await request(app, 'POST', '/plain', { name: 'b' })).json();
  const c = (await request(app, 'POST', '/both', { name: 'c' })).json();
  assert.equal(a.createdAt, undefined);
  assert.equal(a.deletedAt, null);
  assert.ok(b.createdAt);
  assert.equal(b.deletedAt, undefined);
  assert.equal(c.createdAt, undefined);
  assert.equal(c.deletedAt, undefined);
  await request(app, 'DELETE', '/plain/1');
  assert.equal((await app.inject('/plain/1')).statusCode, 404);
  const inferred = await setup(t, { database: { data: { items: [{ id: 'old', name: 'old' }] }, timestamps: true, softDelete: true } });
  const legacy = (await inferred.app.inject('/items/old')).json();
  assert.equal(legacy.createdAt, null);
  assert.equal(legacy.updatedAt, null);
  assert.equal(legacy.deletedAt, null);
  const fresh = (await request(inferred.app, 'POST', '/items', { name: 'fresh' })).json();
  assert.ok(fresh.createdAt);
  assert.equal((await request(inferred.app, 'PATCH', `/items/${fresh.id}`, { createdAt: null })).statusCode, 400);
  await request(inferred.app, 'DELETE', `/items/${fresh.id}`);
  const output = (await inferred.app.inject(scope('/items', { deletedAt: { ne: null } }))).json();
  assert.equal(output.total, 1);
  assert.equal(output.data[0].djsDeletion, undefined);
  const patched = (await request(inferred.app, 'PATCH', '/items/old', {})).json();
  assert.equal(patched.createdAt, null);
  assert.ok(patched.updatedAt);
});

test('REST and GraphQL mutations enforce ownership and audit the authenticated user', async (t) => {
  const { app } = await setup(t, { auth: { users }, graphql: { enabled: true }, files: { data: [] } });
  const alice = await login(app, 'alice'),
    bob = await login(app, 'bob'),
    admin = await login(app, 'admin');
  assert.equal((await request(app, 'GET', '/auth/me', undefined, admin)).json().isAdmin, true);
  assert.equal((await request(app, 'POST', '/items', { name: 'one' })).statusCode, 401);
  const created = (await request(app, 'POST', '/items', { name: 'one' }, alice)).json();
  assert.equal(created.createdById, 'a');
  assert.equal(created.updatedById, 'a');
  assert.equal(created.deletedById, null);
  for (const [method, body] of [
    ['PATCH', {}],
    ['PUT', { name: 'stolen' }],
    ['DELETE', undefined],
  ])
    assert.equal((await request(app, method, '/items/1', body, bob)).statusCode, 403);
  const forbidden = (await gql(app, 'mutation{itemUpdate(id:1,data:{name:"stolen"}){id}}', bob)).json();
  assert.equal(forbidden.errors[0].extensions.code, 'FORBIDDEN');
  const anonymous = (await gql(app, 'mutation{itemUpdate(id:1,data:{name:"stolen"}){id}}')).json();
  assert.equal(anonymous.errors[0].extensions.code, 'UNAUTHENTICATED');
  assert.equal((await gql(app, '{itemList{total}}')).json().data.itemList.total, 1);
  const edited = (await gql(app, 'mutation{itemUpdate(id:1,data:{name:"admin edit"}){createdById updatedById}}', admin)).json().data.itemUpdate;
  assert.deepEqual(edited, { createdById: 'a', updatedById: 'root' });
  const deleted = (await request(app, 'DELETE', '/items/1', undefined, alice)).json();
  assert.equal(deleted.deletedById, 'a');
  assert.equal((await request(app, 'PATCH', '/items/1', {}, bob)).statusCode, 403);
  const restored = (await request(app, 'PATCH', '/items/1', {}, admin)).json();
  assert.equal(restored.deletedById, null);
  assert.equal(restored.createdById, 'a');
  assert.equal(restored.updatedById, 'root');
  for (const field of ['createdById', 'updatedById', 'deletedById']) assert.equal((await request(app, 'PATCH', '/items/1', { [field]: 'b' }, alice)).statusCode, 400);
  const upload = await app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-type': 'text/plain', 'content-name': 'open.txt' }, payload: 'open' });
  assert.equal(upload.statusCode, 201);
  assert.equal((await request(app, 'DELETE', upload.json().url)).statusCode, 204);
});

const cascadeSchema = (extra = {}) => ({
  Parent: { ...item, collection: 'parents' },
  Child: { ...item, collection: 'children', ...extra, fields: { ...item.fields, parent: { type: 'Parent', source: 'parentId', required: true, onDelete: 'cascade' } } },
});

test('cascade restoration survives restart, excludes earlier deletions and checks every owner', async (t) => {
  const directory = await temp(t),
    path = join(directory, 'db.json');
  await writeFile(path, '{"parents":[],"children":[]}');
  const config = { database: { path, schema: cascadeSchema(), timestamps: true, softDelete: true }, auth: { users } };
  let { app } = await setup(t, config);
  const alice = await login(app, 'alice'),
    bob = await login(app, 'bob'),
    admin = await login(app, 'admin');
  await request(app, 'POST', '/parents', { name: 'parent' }, alice);
  await request(app, 'POST', '/children', { name: 'earlier', parentId: 1 }, alice);
  await request(app, 'POST', '/children', { name: 'cascade', parentId: 1 }, bob);
  assert.equal((await request(app, 'DELETE', '/children/1', undefined, alice)).statusCode, 200);
  const before = await readFile(path, 'utf8');
  assert.equal((await request(app, 'DELETE', '/parents/1', undefined, alice)).statusCode, 403);
  assert.equal(await readFile(path, 'utf8'), before);
  const deletion = await request(app, 'DELETE', '/parents/1', undefined, admin);
  assert.equal(deletion.statusCode, 200, deletion.body);
  assert.equal((await app.inject('/children')).json().total, 0);
  await app.close();
  ({ app } = await setup(t, config));
  const newAlice = await login(app, 'alice'),
    newAdmin = await login(app, 'admin');
  assert.equal((await request(app, 'PATCH', '/parents/1', {}, newAlice)).statusCode, 403);
  const restored = await request(app, 'PATCH', '/parents/1', {}, newAdmin);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.ok((await app.inject('/children/1')).json().deletedAt);
  const child = (await app.inject('/children/2')).json();
  assert.equal(child.deletedAt, null);
  assert.equal(child.createdById, 'b');
  assert.equal(child.updatedById, 'root');
  assert.equal((await app.inject('/children')).json().total, 1);
});

test('mixed cascades honor each entity policy and never recreate physically deleted children', async (t) => {
  const { app } = await setup(t, { database: { data: { parents: [], children: [] }, schema: cascadeSchema({ softDelete: false }), softDelete: true } });
  await request(app, 'POST', '/parents', { name: 'p' });
  await request(app, 'POST', '/children', { name: 'c', parentId: 1 });
  const removed = await request(app, 'DELETE', '/parents/1');
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await app.inject('/children/1')).statusCode, 404);
  assert.equal((await request(app, 'PATCH', '/parents/1', {})).statusCode, 200);
  assert.equal((await app.inject('/children')).json().total, 0);
});

test('nested object cascades restore only unchanged pruned fields', async (t) => {
  const schema = {
    Genre: { ...item, collection: 'genres' },
    Movie: { ...item, collection: 'movies', fields: { ...item.fields, actors: { type: 'object[]' }, 'actors.genre': { type: 'Genre', source: 'actors.genreId', onDelete: 'cascade' } } },
  };
  const { app } = await setup(t, { database: { schema, data: { genres: [], movies: [] }, softDelete: true, timestamps: true } });
  await request(app, 'POST', '/genres', { name: 'genre' });
  await request(app, 'POST', '/movies', { name: 'movie', actors: [{ genreId: 1 }] });
  assert.equal((await request(app, 'DELETE', '/genres/1')).statusCode, 200);
  assert.equal((await app.inject('/movies/1')).json().actors.total, 0);
  assert.equal((await request(app, 'PATCH', '/genres/1', {})).statusCode, 200);
  assert.equal((await app.inject('/movies/1')).json().actors.total, 1);
  await request(app, 'DELETE', '/genres/1');
  await request(app, 'PATCH', '/movies/1', { actors: [{}] });
  assert.equal((await request(app, 'PATCH', '/genres/1', {})).statusCode, 409);
  assert.ok((await app.inject('/genres/1')).json().deletedAt);
});

test('relation where applies deletion defaults at its own level including every and none', async (t) => {
  const schema = {
    Parent: { ...item, collection: 'parents', fields: { ...item.fields, children: { type: 'Child[]', source: 'id', target: 'parentId' } } },
    Child: { ...item, collection: 'children', fields: { ...item.fields, parentId: { type: 'number' } } },
  };
  const { app } = await setup(t, {
    database: {
      schema,
      softDelete: true,
      data: {
        parents: [
          { id: 1, name: 'p' },
          { id: 2, name: 'removed', deletedAt: '2026-01-01T00:00:00Z' },
        ],
        children: [
          { id: 1, parentId: 1, name: 'a' },
          { id: 2, parentId: 1, name: 'b', deletedAt: '2026-01-01T00:00:00Z' },
        ],
      },
    },
    graphql: { enabled: true },
  });
  assert.equal((await app.inject(scope('/parents', { children: { some: { deletedAt: { ne: null } } } }))).json().total, 1);
  assert.equal((await app.inject(scope('/parents', { children: { every: { name: { eq: 'a' } } } }))).json().total, 1);
  assert.equal((await app.inject(scope('/parents', { children: { none: { name: { eq: 'b' } } } }))).json().total, 1);
  const response = (await gql(app, '{parentList{total data{children(where:{deletedAt:{ne:null}}){total data{name}}}}}')).json();
  assert.equal(response.errors, undefined);
  assert.equal(response.data.parentList.total, 1);
  assert.deepEqual(response.data.parentList.data[0].children.data, [{ name: 'b' }]);
});

test('nested writes and reverse reconnections cannot bypass ownership or forge auditing', async (t) => {
  const schema = {
    Parent: { ...item, collection: 'parents', fields: { ...item.fields, children: { type: 'Child[]', source: 'id', target: 'parentId' } } },
    Child: { ...item, collection: 'children', fields: { ...item.fields, parentId: { type: 'number', nullable: true } } },
  };
  const { app } = await setup(t, { database: { schema, data: { parents: [], children: [] } }, auth: { users } });
  const alice = await login(app, 'alice'),
    bob = await login(app, 'bob');
  const p = await request(app, 'POST', '/parents', { name: 'p', children: [{ name: 'nested' }] }, alice);
  assert.equal(p.statusCode, 201, p.body);
  assert.equal((await app.inject('/children/1')).json().createdById, 'a');
  await request(app, 'POST', '/children', { name: 'foreign', parentId: null }, bob);
  const before = (await app.inject('/children/2')).body;
  assert.equal((await request(app, 'PATCH', '/parents/1', { children: [2] }, alice)).statusCode, 403);
  assert.equal((await app.inject('/children/2')).body, before);
  assert.equal((await app.inject('/children/1')).json().parentId, 1);
  assert.equal((await request(app, 'PATCH', '/parents/1', { children: [{ id: 2, name: 'stolen' }] }, alice)).statusCode, 403);
  assert.equal((await request(app, 'PATCH', '/parents/1', { children: [{ name: 'forged', createdById: 'b' }] }, alice)).statusCode, 400);
});

test('CLI, config validation and standalone generators share entity lifecycle settings', async (t) => {
  for (const flags of [{ timestamps: 'yes' }, { softDelete: 1 }]) {
    assert.throws(() => normalizeServerConfig({ database: { data: {}, ...flags } }), /boolean/);
    await assert.rejects(() => generateOpenapi(model, flags), /boolean/);
  }
  await assert.rejects(() => generateOpenapi({ Item: { ...item, timestamps: 'yes' } }), /boolean/);
  await assert.rejects(() => generateOpenapi({ Item: { ...item, fields: { ...item.fields, createdAt: { type: 'string' } } } }, { timestamps: true }), /Reserved/);
  assert.throws(() => normalizeServerConfig({ database: { data: {} }, auth: { enabled: true, users } }), /enabled/);
  const directory = await temp(t),
    path = join(directory, 'config.mjs');
  await writeFile(path, `export default ${JSON.stringify({ database: { schema: model }, auth: { users: 'missing.json' }, graphql: { path: 'schema.graphql' }, openapi: { path: 'api.yaml' } })};`);
  await runCli(['generate', 'openapi,graphql', '--timestamps', '--soft-delete', path]);
  const sdl = await readFile(join(directory, 'schema.graphql'), 'utf8');
  assert.match(sdl, /createdAt: String/);
  assert.match(sdl, /deletedById: String/);
  assert.doesNotMatch(sdl, /djsDeletion|authLogin/);
  await assert.rejects(() => runCli(['--auth', path]), /Неизвестный/);
  const spec = await generateOpenapi(model, { timestamps: true, softDelete: true, auth: true, files: true });
  for (const name of ['createdAt', 'updatedAt', 'deletedAt', 'createdById', 'updatedById', 'deletedById']) {
    assert.equal(spec.components.schemas.Item.properties[name].readOnly, true);
    assert.equal(spec.components.schemas.ItemCreate.properties[name], undefined);
  }
  assert.equal(spec.paths['/_files/storage'].post.security, undefined);
});

test('legacy unowned records require an administrator and disabling features retains stored audit data', async (t) => {
  const dir = await temp(t),
    path = join(dir, 'db.json');
  await writeFile(path, JSON.stringify({ items: [{ id: 1, name: 'legacy' }] }));
  const config = { database: { path, schema: model, timestamps: true, softDelete: true }, auth: { users } };
  const { app } = await setup(t, config);
  const alice = await login(app, 'alice'),
    admin = await login(app, 'admin');
  assert.equal((await request(app, 'PATCH', '/items/1', {}, alice)).statusCode, 403);
  const old = await request(app, 'PATCH', '/items/1', { name: 'retained' }, admin);
  assert.equal(old.statusCode, 200, old.body);
  assert.equal(old.json().createdById, null);
  assert.equal(old.json().updatedById, 'root');
  assert.equal(old.json().createdAt, null);
  const original = JSON.parse(await readFile(path, 'utf8')).items[0];
  await app.close();
  const disabled = (await createServer({ database: { path, schema: model }, server: { logger: false } })).fastify();
  t.after(() => disabled.close());
  const replaced = await request(disabled, 'PUT', '/items/1', { name: 'open' });
  assert.equal(replaced.statusCode, 200, replaced.body);
  const stored = JSON.parse(await readFile(path, 'utf8')).items[0];
  assert.equal(stored.updatedById, original.updatedById);
  assert.equal(stored.updatedAt, original.updatedAt);
});

test('failed restore validation and repeated DELETE retain original records', async (t) => {
  const dir = await temp(t),
    path = join(dir, 'db.json');
  const schema = cascadeSchema();
  schema.Parent.softDelete = false;
  await writeFile(path, JSON.stringify({ parents: [{ id: 1, name: 'p' }], children: [{ id: 1, name: 'c', parentId: 1 }] }));
  const { app } = await setup(t, { database: { path, schema, softDelete: true } });
  assert.equal((await request(app, 'DELETE', '/parents/1')).statusCode, 200);
  const before = await readFile(path, 'utf8');
  assert.equal((await request(app, 'PATCH', '/children/1', {})).statusCode, 400);
  assert.equal(await readFile(path, 'utf8'), before);
  const deleted = (await app.inject('/children/1')).json();
  assert.deepEqual((await request(app, 'DELETE', '/children/1')).json(), deleted);
  assert.equal(await readFile(path, 'utf8'), before);
});
