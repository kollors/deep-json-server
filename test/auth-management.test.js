import { writeFile as writeFixture } from 'node:fs/promises';

const writeJson = async (path, value) => {
  await writeFixture(path, JSON.stringify(value));
  return path;
};

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, generateGraphql, generateOpenapi, hashPassword } from '../dist/index.js';
import { verifyPassword } from '../dist/src/auth/password.js';
import { createAuthService } from '../dist/src/auth/service.js';
import { createDatabaseStore } from '../dist/src/core/database.js';
import { Engine } from '../dist/src/core/engine.js';
import { loadModel } from '../dist/src/core/model.js';

const password = 'initial-password';
const passwordHash = await hashPassword(password);
const users = [
  { id: 'root', username: 'root', passwordHash, isAdmin: true },
  { id: 'peer', username: 'peer', passwordHash, isAdmin: true },
  { id: 'alice', username: 'alice', passwordHash },
  { id: 'bob', username: 'bob', passwordHash },
];
const schema = { models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, name: { type: 'string' } } } } };
const header = (token) => ({ authorization: `Bearer ${token}` });
const request = (app, method, url, payload, token) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }), ...(token ? { headers: header(token) } : {}) });
const login = async (app, username, secret = password) => {
  const result = await request(app, 'POST', '/auth/login', { username, password: secret });
  assert.equal(result.statusCode, 200, result.body);
  return result.json().accessToken;
};
const me = (app, token) => request(app, 'GET', '/auth/me', undefined, token);
const setAdmin = (app, token, id, isAdmin) => request(app, 'PATCH', `/auth/users/${id}/admin`, { isAdmin }, token);
const changePassword = (app, token, id, newPassword, currentPassword) =>
  request(app, 'PATCH', `/auth/users/${id}/password`, { newPassword, ...(currentPassword === undefined ? {} : { currentPassword }) }, token);
const temporary = async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'deep-auth-management-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const setup = async (t, extra = {}) => {
  const facade = await createServer({ storage: 'memory', database: { source: { items: [] }, schema }, auth: { source: users }, server: { logger: false }, ...extra });
  const app = facade.fastify();
  t.after(() => app.close());
  await app.ready();
  return app;
};
const service = async (t, records = users) => {
  const auth = await createAuthService({ source: records });
  t.after(() => auth.close());
  return auth;
};
const tokenFor = async (auth, username) => `Bearer ${(await auth.login({ username, password })).accessToken}`;
const holdPassword = (t, value) => {
  const original = crypto.scrypt;
  const entered = Promise.withResolvers();
  let release = () => {};
  const mock = t.mock.method(crypto, 'scrypt', (...args) => {
    const callback = args.pop();
    return original(...args, (...result) => {
      if (args[0] === value) {
        release = () => callback(...result);
        entered.resolve();
      } else callback(...result);
    });
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return { entered: entered.promise, release: () => release() };
};

test('registration is public, creates ordinary users and keeps memory input isolated', async (t) => {
  const source = structuredClone(users);
  const app = await setup(t, { auth: { source: source } });
  const created = await request(app, 'POST', '/auth/register', { username: 'new-user', password });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.headers['cache-control'], 'no-store');
  const user = created.json();
  assert.deepEqual(Object.keys(user).sort(), ['id', 'isAdmin', 'username']);
  assert.equal(typeof user.id, 'string');
  assert.equal(user.isAdmin, false);
  assert.equal(user.username, 'new-user');
  const token = await login(app, 'new-user');
  assert.deepEqual((await me(app, token)).json(), user);
  assert.equal((await request(app, 'POST', '/auth/register', { username: 'new-user', password })).statusCode, 409);
  assert.equal((await request(app, 'POST', '/auth/register', { username: 'New-user', password })).statusCode, 201);
  for (const payload of [
    [],
    {},
    { username: '   ', password },
    { username: 'x'.repeat(257), password },
    { username: 'invalid', password: '' },
    { username: 'invalid', password: 'x'.repeat(1025) },
    { username: 'invalid', password, id: 'chosen' },
    { username: 'invalid', password, passwordHash },
    { username: 'invalid', password, isAdmin: true },
  ])
    assert.equal((await request(app, 'POST', '/auth/register', payload)).statusCode, 400);
  assert.deepEqual(source, users);
  const restarted = await setup(t, { auth: { source: source } });
  assert.equal((await request(restarted, 'POST', '/auth/login', { username: 'new-user', password })).statusCode, 401);
});

test('password permissions distinguish self, ordinary users and other admins and revoke only target sessions', async (t) => {
  const app = await setup(t);
  const root = await login(app, 'root');
  const peer = await login(app, 'peer');
  const alice = await login(app, 'alice');
  const aliceOther = await login(app, 'alice');
  assert.equal((await changePassword(app, undefined, 'alice', 'next', password)).statusCode, 401);
  assert.equal((await changePassword(app, alice, 'bob', 'next')).statusCode, 403);
  assert.equal((await changePassword(app, root, 'peer', 'next')).statusCode, 403);
  assert.equal((await changePassword(app, peer, 'root', 'next')).statusCode, 403);
  assert.equal((await changePassword(app, root, 'missing', 'next')).statusCode, 404);
  assert.equal((await changePassword(app, root, 'root', 'next')).statusCode, 400);
  assert.equal((await changePassword(app, alice, 'alice', 'next')).statusCode, 400);
  for (const payload of [{}, { newPassword: '' }, { newPassword: 'next', currentPassword: 1 }, { newPassword: 'next', extra: true }])
    assert.equal((await request(app, 'PATCH', '/auth/users/alice/password', payload, alice)).statusCode, 400);
  assert.equal((await changePassword(app, alice, 'alice', 'next', 'wrong')).statusCode, 401);
  assert.equal((await me(app, alice)).statusCode, 200);
  const changed = await changePassword(app, alice, 'alice', 'next', password);
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json(), { success: true });
  for (const token of [alice, aliceOther]) assert.equal((await me(app, token)).statusCode, 401);
  assert.equal((await me(app, root)).statusCode, 200);
  assert.equal((await request(app, 'POST', '/auth/login', { username: 'alice', password })).statusCode, 401);
  const updatedAlice = await login(app, 'alice', 'next');
  assert.equal((await changePassword(app, root, 'alice', 'reset')).statusCode, 200);
  assert.equal((await me(app, updatedAlice)).statusCode, 401);
  await login(app, 'alice', 'reset');
  assert.equal((await changePassword(app, root, 'root', 'root-new', password)).statusCode, 200);
  assert.equal((await me(app, root)).statusCode, 401);
  await login(app, 'root', 'root-new');
  assert.equal((await me(app, peer)).statusCode, 200);
});

test('admin changes apply to existing REST and GraphQL tokens and allow demotion followed by password reset', async (t) => {
  const app = await setup(t, { graphql: {} });
  const root = await login(app, 'root');
  const bob = await login(app, 'bob');
  const peer = await login(app, 'peer');
  assert.equal((await setAdmin(app, undefined, 'bob', true)).statusCode, 401);
  assert.equal((await setAdmin(app, bob, 'bob', true)).statusCode, 403);
  assert.equal((await setAdmin(app, root, 'missing', true)).statusCode, 404);
  for (const payload of [{}, { isAdmin: 'true' }, { isAdmin: 1 }, { isAdmin: true, extra: true }]) assert.equal((await request(app, 'PATCH', '/auth/users/bob/admin', payload, root)).statusCode, 400);
  const record = (await request(app, 'POST', '/items', { name: 'owned by root' }, root)).json();
  const rest = () => request(app, 'PATCH', `/items/${record.id}`, { name: 'changed' }, bob);
  const graphql = async () => (await request(app, 'POST', '/graphql', { query: `mutation { itemUpdate(id:"${record.id}", data:{name:"graphql"}){name} }` }, bob)).json();
  assert.equal((await rest()).statusCode, 403);
  assert.equal((await graphql()).errors[0].extensions.code, 'FORBIDDEN');
  assert.equal((await setAdmin(app, root, 'bob', true)).statusCode, 200);
  assert.equal((await me(app, bob)).json().isAdmin, true);
  assert.equal((await rest()).statusCode, 200);
  assert.equal((await graphql()).errors, undefined);
  assert.equal((await setAdmin(app, root, 'bob', false)).statusCode, 200);
  assert.equal((await me(app, bob)).json().isAdmin, false);
  assert.equal((await rest()).statusCode, 403);
  assert.equal((await graphql()).errors[0].extensions.code, 'FORBIDDEN');
  assert.equal((await setAdmin(app, root, 'peer', false)).statusCode, 200);
  assert.equal((await changePassword(app, root, 'peer', 'peer-new')).statusCode, 200);
  assert.equal((await me(app, peer)).statusCode, 401);
  const peerNew = await login(app, 'peer', 'peer-new');
  assert.equal((await me(app, peerNew)).json().isAdmin, false);
  assert.equal((await setAdmin(app, root, 'root', false)).statusCode, 409);
  assert.equal((await me(app, root)).json().isAdmin, true);
  await setAdmin(app, root, 'bob', true);
  assert.equal((await setAdmin(app, root, 'root', false)).statusCode, 200);
  assert.equal((await me(app, root)).json().isAdmin, false);
  assert.equal((await setAdmin(app, root, 'peer', true)).statusCode, 403);
});

test('concurrent registrations cannot duplicate a username and concurrent demotions retain an admin', async (t) => {
  const auth = await service(t, users.slice(0, 2));
  const a = await tokenFor(auth, 'root');
  const b = await tokenFor(auth, 'peer');
  const registrations = await Promise.allSettled(Array.from({ length: 2 }, () => auth.register({ username: 'same', password })));
  assert.equal(registrations.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(registrations.find((result) => result.status === 'rejected').reason.code, 'CONFLICT');
  const changes = await Promise.allSettled([auth.changeAdmin(a, 'root', { isAdmin: false }), auth.changeAdmin(b, 'peer', { isAdmin: false })]);
  assert.equal(changes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(changes.find((result) => result.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal([auth.me(a), auth.me(b)].filter((user) => user.isAdmin).length, 1);
});

test('file users persist registration, roles and passwords across restart and reserve the temporary file', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'auth.json');
  await fs.writeFile(path, JSON.stringify(users));
  const app = await setup(t, {
    storage: 'file',
    database: { source: await writeJson(path + '.db.json', { items: [] }), schema: await writeJson(path + '.schema.json', schema) },
    auth: { source: path },
    files: { source: directory, metadata: join(directory, 'files.json') },
  });
  for (const name of ['auth.json', '.auth.json.tmp']) {
    const response = await app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': name, 'content-type': 'text/plain', 'content-override': 'true' }, payload: 'overwrite' });
    assert.equal(response.statusCode, 400, response.body);
  }
  const root = await login(app, 'root');
  const bob = await login(app, 'bob');
  const registered = await request(app, 'POST', '/auth/register', { username: 'persistent', password: 'persisted-password' });
  assert.equal(registered.statusCode, 201, registered.body);
  assert.equal((await setAdmin(app, root, 'bob', true)).statusCode, 200);
  assert.equal((await changePassword(app, bob, 'bob', 'new-bob', password)).statusCode, 200);
  const saved = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(saved.length, users.length + 1);
  assert.equal(saved.find((user) => user.id === 'bob').isAdmin, true);
  assert.equal(await verifyPassword('new-bob', saved.find((user) => user.id === 'bob').passwordHash), true);
  assert.equal(saved.find((user) => user.id === registered.json().id).isAdmin, false);
  assert.ok(saved.every((user) => !Object.hasOwn(user, 'password') && !Object.hasOwn(user, 'newPassword')));
  await assert.rejects(() => fs.stat(join(directory, '.auth.json.tmp')), { code: 'ENOENT' });
  await app.close();
  const reopened = await service(t, path);
  assert.equal((await reopened.login({ username: 'bob', password: 'new-bob' })).user.isAdmin, true);
  assert.equal((await reopened.login({ username: 'persistent', password: 'persisted-password' })).user.id, registered.json().id);
  assert.throws(() => reopened.me(`Bearer ${root}`), { code: 'UNAUTHENTICATED' });
});

test('all storage sources obey the same global mode', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'database.json');
  await fs.writeFile(path, '{"items":[]}');
  await assert.rejects(() => setup(t, { storage: 'memory', database: { source: path, schema } }), /memory storage/);
  await assert.rejects(() => setup(t, { storage: 'file', database: { source: path }, auth: { source: users }, graphql: undefined, openapi: undefined }), /config.auth.source/);
});

test('failed temporary writes preserve the original file, users and sessions, and the queue recovers', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'auth.json');
  const original = JSON.stringify(users);
  await fs.writeFile(path, original);
  const app = await setup(t, {
    storage: 'file',
    database: { source: await writeJson(path + '.db.json', { items: [] }), schema: await writeJson(path + '.schema.json', schema) },
    auth: { source: path },
  });
  const root = await login(app, 'root');
  const alice = await login(app, 'alice');
  const writeFile = fs.writeFile;
  let fail = true;
  const mock = t.mock.method(fs, 'writeFile', async (destination, content, ...args) => {
    if (destination === join(directory, '.auth.json.tmp') && fail) {
      await writeFile(destination, content.slice(0, 10), ...args);
      throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
    }
    return writeFile(destination, content, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await request(app, 'POST', '/auth/register', { username: 'retry', password })).statusCode, 500);
    assert.equal((await setAdmin(app, root, 'alice', true)).statusCode, 500);
    assert.equal((await changePassword(app, alice, 'alice', 'next', password)).statusCode, 500);
    assert.equal(await fs.readFile(path, 'utf8'), original);
    assert.equal((await me(app, alice)).json().isAdmin, false);
    assert.equal((await me(app, root)).statusCode, 200);
    assert.equal((await request(app, 'POST', '/auth/login', { username: 'retry', password })).statusCode, 401);
    await login(app, 'alice');
    assert.equal((await request(app, 'POST', '/auth/login', { username: 'alice', password: 'next' })).statusCode, 401);
    fail = false;
    assert.equal((await request(app, 'POST', '/auth/register', { username: 'retry', password })).statusCode, 201);
    assert.equal((await changePassword(app, alice, 'alice', 'next', password)).statusCode, 200);
    assert.equal((await me(app, alice)).statusCode, 401);
    await login(app, 'alice', 'next');
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const change of ['target promoted', 'actor demoted']) {
  test(`password reset rechecks rights after hashing: ${change}`, async (t) => {
    const auth = await service(t);
    const root = await tokenFor(auth, 'root');
    const peer = await tokenFor(auth, 'peer');
    const paused = holdPassword(t, 'paused-new');
    const reset = auth.changePassword(root, 'bob', { newPassword: 'paused-new' });
    const rejected = assert.rejects(reset, { code: 'FORBIDDEN' });
    await paused.entered;
    try {
      if (change === 'target promoted') await auth.changeAdmin(peer, 'bob', { isAdmin: true });
      else await auth.changeAdmin(peer, 'root', { isAdmin: false });
    } finally {
      paused.release();
    }
    await rejected;
    await auth.login({ username: 'bob', password });
  });
}

test('a login using the previous password cannot finish after a successful reset', async (t) => {
  const auth = await service(t);
  const root = await tokenFor(auth, 'root');
  const paused = holdPassword(t, password);
  const pending = auth.login({ username: 'bob', password });
  const rejected = assert.rejects(pending, { code: 'UNAUTHENTICATED' });
  await paused.entered;
  try {
    await auth.changePassword(root, 'bob', { newPassword: 'new-bob' });
  } finally {
    paused.release();
  }
  await rejected;
  await auth.login({ username: 'bob', password: 'new-bob' });
});

test('queued record mutations recheck auth instead of keeping the original admin role', async (t) => {
  const auth = await service(t);
  const root = await tokenFor(auth, 'root');
  const peer = await tokenFor(auth, 'peer');
  const model = await loadModel(schema, { auth: true });
  const store = await createDatabaseStore({ source: { items: [{ id: 'one', name: 'before', createdById: 'alice' }] } });
  const engine = new Engine(store, model);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const update = store.update;
  store.update = async (...args) => {
    entered.resolve();
    await released.promise;
    return update(...args);
  };
  const pending = engine.mutate(model.byName.get('Item'), 'update', 'one', { name: 'after' }, undefined, () => auth.me(root));
  const rejected = assert.rejects(pending, { code: 'FORBIDDEN' });
  await entered.promise;
  try {
    await auth.changeAdmin(peer, 'root', { isAdmin: false });
  } finally {
    released.resolve();
  }
  await rejected;
  assert.equal((await store.read()).items[0].name, 'before');
});

test('OpenAPI describes all auth methods and GraphQL remains limited to record operations', async () => {
  const document = await generateOpenapi(schema, { auth: true });
  for (const path of ['/auth/register', '/auth/login']) assert.deepEqual(document.paths[path].post.security, []);
  for (const path of ['/auth/users/{id}/password', '/auth/users/{id}/admin']) {
    const operation = document.paths[path].patch;
    assert.deepEqual(operation.security, [{ AuthBearer: [] }]);
    assert.equal(operation.parameters[0].name, 'id');
    assert.equal(operation.parameters[0].required, true);
    for (const status of [200, 400, 401, 403, 404, 409, 500]) assert.ok(operation.responses[status]);
  }
  assert.ok(document.paths['/auth/register'].post.responses[201]);
  assert.equal(document.components.schemas.AuthCredentialsInput.additionalProperties, false);
  assert.equal(document.components.schemas.AuthCredentialsInput.properties.isAdmin, undefined);
  assert.equal(document.components.schemas.AuthPasswordInput.properties.currentPassword.writeOnly, true);
  assert.equal(document.components.schemas.AuthPasswordInput.properties.newPassword.writeOnly, true);
  assert.deepEqual(document.components.schemas.AuthPasswordInput.required, ['newPassword']);
  assert.doesNotMatch(await generateGraphql(schema, { auth: true }), /authRegister|authChangePassword|authChangeAdmin|AuthCredentialsInput|AuthSuccess/);
  const disabled = await generateOpenapi(schema);
  assert.equal(disabled.paths['/auth/register'], undefined);
  assert.equal(disabled.components.schemas.AuthPasswordInput, undefined);
});
