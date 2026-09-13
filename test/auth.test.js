import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { createServer, generateGraphql, generateOpenapi, hashPassword } from '../dist/index.js';
import { verifyPassword } from '../dist/src/auth/password.js';
import { createAuthService } from '../dist/src/auth/service.js';
import { runCli } from '../dist/src/cli/index.js';
import { normalizeServerConfig } from '../dist/src/server/config.js';

const schema = { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, name: { type: 'string' } } } };
const password = 'Тестовый пароль';
const users = [{ id: '1', username: 'admin', passwordHash: await hashPassword(password) }];
const credentials = { username: 'admin', password };
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const setup = async (t, extra = {}, features) => {
  const facade = await createServer({ database: { data: { items: [] }, schema }, auth: { users }, server: { logger: false }, ...extra }, features);
  const app = facade.fastify();
  t.after(() => app.close());
  return { app, facade };
};
const login = (app, payload = credentials) => app.inject({ method: 'POST', url: '/auth/login', payload });
const gql = (app, query, headers = {}, variables) => app.inject({ method: 'POST', url: '/graphql', headers, payload: { query, variables } });
const temporary = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'deep-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('password hashes use independent salts and validate the whole password', async () => {
  const other = await hashPassword(password);
  assert.notEqual(other, users[0].passwordHash);
  assert.equal(await verifyPassword(password, other), true);
  assert.equal(await verifyPassword(`${password}!`, other), false);
  assert.equal(await verifyPassword(password, 'invalid'), false);
  for (const invalid of ['', 'x'.repeat(1025), null, 123]) await assert.rejects(() => hashPassword(invalid), /Password/);
});

test('REST sessions authenticate, expire and revoke independently without exposing hashes', async (t) => {
  const { app } = await setup(t);
  const first = await login(app);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers['cache-control'], 'no-store');
  const session = first.json();
  assert.deepEqual(Object.keys(session).sort(), ['accessToken', 'expiresIn', 'user']);
  assert.deepEqual(session.user, { id: '1', username: 'admin', isAdmin: false });
  assert.equal(session.expiresIn, 3600);
  const second = (await login(app)).json();
  assert.notEqual(session.accessToken, second.accessToken);
  assert.deepEqual((await app.inject({ url: '/auth/me', headers: bearer(session.accessToken) })).json(), session.user);
  const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(session.accessToken) });
  assert.deepEqual(logout.json(), { success: true });
  assert.equal((await app.inject({ url: '/auth/me', headers: bearer(session.accessToken) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(session.accessToken) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/auth/me', headers: bearer(second.accessToken) })).statusCode, 200);
  for (const headers of [{}, { authorization: 'Basic abc' }, bearer('x'.repeat(43))]) {
    const response = await app.inject({ url: '/auth/me', headers });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const incorrect = await login(app, { ...credentials, password: 'wrong' });
  const unknown = await login(app, { ...credentials, username: 'missing' });
  assert.equal(incorrect.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(incorrect.json(), unknown.json());
  for (const payload of [{}, { ...credentials, extra: true }, { ...credentials, username: '' }, { ...credentials, password: 'x'.repeat(1025) }])
    assert.equal((await login(app, payload)).statusCode, 400);
  const { app: other } = await setup(t);
  assert.equal((await other.inject({ url: '/auth/me', headers: bearer(second.accessToken) })).statusCode, 401);
});

test('service bounds simultaneous logins, expires sessions and clears them on close', async (t) => {
  const auth = await createAuthService({ users, expiresIn: 1 });
  t.after(() => auth.close());
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => auth.login(credentials)));
  assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 4);
  assert.equal(attempts[4].reason.code, 'TOO_MANY_REQUESTS');
  const token = attempts[0].value.accessToken;
  const identity = auth.me(`Bearer ${token}`);
  identity.username = 'changed';
  assert.equal(auth.me(`Bearer ${token}`).username, 'admin');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1001 });
  assert.throws(() => auth.me(`Bearer ${token}`), { code: 'UNAUTHENTICATED' });
  const fresh = await auth.login(credentials);
  assert.equal(auth.me(`Bearer ${fresh.accessToken}`).username, 'admin');
  auth.close();
  assert.throws(() => auth.me(`Bearer ${fresh.accessToken}`), { code: 'UNAUTHENTICATED' });
  await assert.rejects(() => auth.login(credentials), { code: 'UNAUTHENTICATED' });
  const closing = await createAuthService({ users });
  const pending = closing.login(credentials);
  closing.close();
  await assert.rejects(() => pending, { code: 'UNAUTHENTICATED' });
});

test('auth protects REST and GraphQL writes while reads and files remain open', async (t) => {
  const { app, facade } = await setup(t, { graphql: { enabled: true }, openapi: { enabled: true }, files: { data: [] } });
  const session = (await login(app)).json();
  assert.deepEqual((await app.inject({ url: '/auth/me', headers: bearer(session.accessToken) })).json(), session.user);
  assert.equal(await facade.graphql(), await generateGraphql(schema, { auth: true }));
  const introspection = (await gql(app, '{__schema{queryType{fields{name}} mutationType{fields{name}} types{name}}}')).json().data.__schema;
  const names = [...introspection.queryType.fields, ...introspection.mutationType.fields, ...introspection.types].map(({ name }) => name);
  for (const name of ['authMe', 'authLogin', 'authLogout', 'AuthUser', 'AuthLoginInput', 'AuthSession', 'AuthLogoutResult']) assert.equal(names.includes(name), false, name);
  for (const query of ['{authMe{id}}', 'mutation{authLogin(data:{username:"admin",password:"wrong"}){accessToken}}', 'mutation{authLogout{success}}']) {
    const response = await gql(app, query, bearer(session.accessToken));
    assert.equal(response.statusCode, 400);
    assert.ok(response.json().errors.length > 0);
    assert.ok(response.json().data == null);
  }
  // A GraphQL request cannot revoke the REST session.
  assert.equal((await app.inject({ url: '/auth/me', headers: bearer(session.accessToken) })).statusCode, 200);
  for (const headers of [{}, bearer('invalid'), bearer(session.accessToken)]) {
    const authenticated = headers.authorization === `Bearer ${session.accessToken}`;
    assert.equal((await app.inject({ method: 'POST', url: '/items', payload: { name: 'rest' }, headers })).statusCode, authenticated ? 201 : 401);
    const mutation = (await gql(app, 'mutation{itemCreate(data:{name:"graph"}){id}}', headers)).json();
    if (authenticated) assert.equal(mutation.errors, undefined);
    else assert.equal(mutation.errors[0].extensions.code, 'UNAUTHENTICATED');
    assert.equal((await app.inject({ url: '/items', headers })).statusCode, 200);
    const result = (await gql(app, '{itemList{total}}', headers)).json();
    assert.equal(result.errors, undefined);
    assert.equal(typeof result.data.itemList.total, 'number');
    const doc = (await app.inject({ url: '/openapi.json', headers })).json();
    assert.ok(doc.paths['/auth/login']);
    assert.equal(doc.components.securitySchemes.AuthBearer.scheme, 'bearer');
  }
  const upload = await app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-type': 'text/plain', 'content-name': 'file.txt' }, payload: 'public' });
  assert.equal(upload.statusCode, 201);
  assert.equal((await app.inject(upload.json().url)).body, 'public');
  const cors = await app.inject({ method: 'OPTIONS', url: '/auth/me', headers: { origin: 'https://example.org', 'access-control-request-headers': 'authorization' } });
  assert.match(cors.headers['access-control-allow-headers'], /Authorization/);
  assert.match(cors.headers['access-control-allow-headers'], /Content-Name/i);
});

test('disabled auth does not read credentials or install endpoints and can be overridden', async (t) => {
  const { app, facade } = await setup(t, { auth: { users: '/missing/auth.json' }, graphql: { enabled: true } }, { auth: false });
  assert.equal((await app.inject('/auth/me')).statusCode, 404);
  assert.doesNotMatch(await facade.graphql(), /authMe/);
  assert.equal((await facade.openapi()).components.securitySchemes, undefined);
  const disabled = await setup(t, { auth: { users: '/missing/auth.json' } }, { auth: false });
  assert.equal((await disabled.app.inject('/auth/me')).statusCode, 404);
  const enabled = await setup(t, { auth: { users } }, { auth: true });
  assert.equal((await login(enabled.app)).statusCode, 200);
  const schemaless = await setup(t, { database: { data: { items: [] } } });
  assert.equal((await login(schemaless.app)).statusCode, 200);
});

test('auth schemas are optional, isolate security requirements and reject name collisions', async () => {
  const doc = await generateOpenapi(schema, { auth: true });
  assert.equal(doc.security, undefined);
  assert.equal(doc.paths['/items'].get.security, undefined);
  assert.deepEqual(doc.paths['/items'].post.security, [{ AuthBearer: [] }]);
  assert.deepEqual(doc.paths['/auth/login'].post.security, []);
  assert.deepEqual(doc.paths['/auth/me'].get.security, [{ AuthBearer: [] }]);
  assert.deepEqual(doc.paths['/auth/logout'].post.security, [{ AuthBearer: [] }]);
  assert.equal(doc.components.securitySchemes.AuthBearer.scheme, 'bearer');
  assert.equal(doc.components.schemas.AuthUser.properties.passwordHash, undefined);
  doc.components.schemas.AuthUser.properties.username.type = 'number';
  assert.equal((await generateOpenapi(schema, { auth: true })).components.schemas.AuthUser.properties.username.type, 'string');
  await assert.rejects(() => generateOpenapi(schema, { auth: 'true' }), /auth/);
  for (const name of ['AuthUser', 'AuthMe']) {
    const model = { [name]: { ...schema.Item } };
    await assert.rejects(() => generateOpenapi(model, { auth: true }), /collision/);
    const facade = await createServer({ database: { data: { items: [] }, schema: model }, auth: { users } });
    assert.equal(await facade.graphql(), await generateGraphql(model, { auth: true }));
  }
  await assert.rejects(() => generateOpenapi({ Item: { ...schema.Item, collection: 'auth' } }, { auth: true }), /collision/);
});

test('auth config, credential records and route collisions fail before startup', async (t) => {
  for (const auth of [{}, { users: 1 }, { users: '' }, { users, enabled: 'yes' }, { users, expiresIn: 0 }, { users, expiresIn: 2147483648 }, { users, typo: true }])
    assert.throws(() => normalizeServerConfig({ database: { data: {} }, auth }), /auth/);
  await assert.rejects(() => createServer({ database: { data: {} } }, { auth: true }), /config.auth.users/);
  for (const records of [
    {},
    [null],
    [{ ...users[0], passwordHash: 'plaintext' }],
    [{ ...users[0], password: 'secret' }],
    [users[0], { ...users[0], id: '2' }],
    [users[0], { ...users[0], username: 'other' }],
  ])
    await assert.rejects(() => createAuthService({ users: records }), /Auth user/);
  for (const extra of [{ database: { data: { auth: [] } } }, { graphql: { enabled: true, endpoint: '/auth/login' } }, { openapi: { enabled: true, endpoint: '/auth/me' } }]) {
    const { app } = await setup(t, extra);
    await assert.rejects(() => app.ready(), /conflict/);
  }
});

test('auth works independently of later database errors and protects the credentials file', async (t) => {
  const dir = await temporary(t);
  const path = join(dir, 'auth.json');
  const database = join(dir, 'db.json');
  const contents = JSON.stringify(users);
  await writeFile(path, contents);
  await writeFile(database, '{"items":[]}');
  const { app } = await setup(t, {
    database: { path: database, schema },
    auth: { users: path },
    graphql: { enabled: true },
    files: { directory: dir, metadata: join(dir, 'files.json') },
  });
  await app.ready();
  await writeFile(database, 'broken');
  const session = (await login(app)).json();
  assert.deepEqual((await app.inject({ url: '/auth/me', headers: bearer(session.accessToken) })).json(), session.user);
  assert.equal((await gql(app, '{itemList{total}}')).json().errors[0].extensions.code, 'INTERNAL_ERROR');
  assert.equal((await app.inject('/_files/storage/auth.json')).statusCode, 404);
  const overwrite = await app.inject({
    method: 'POST',
    url: '/_files/storage',
    headers: { 'content-type': 'text/plain', 'content-name': 'auth.json', 'content-override': 'true' },
    payload: 'overwrite',
  });
  assert.equal(overwrite.statusCode, 400);
  assert.equal(await readFile(path, 'utf8'), contents);
});

test('CLI enables auth and exports auth schemas without opening the users file', async (t) => {
  const dir = await temporary(t);
  const source = join(dir, 'server.config.mjs');
  const config = { database: { data: { items: [] }, schema }, auth: { users: './missing-users.json' }, openapi: { path: 'api.yaml' }, graphql: { path: 'api.graphql' } };
  const save = () => writeFile(source, `export default ${JSON.stringify(config)};`);
  await save();
  let call;
  await runCli([source], {
    createServer: async (normalized, features) => {
      call = { normalized, features };
      return { fastify: () => ({ listen: async () => {}, log: { info() {} } }) };
    },
  });
  assert.equal(call.features.auth, true);
  assert.equal(call.normalized.auth.users, join(dir, 'missing-users.json'));
  await runCli(['generate', 'openapi,graphql', source]);
  assert.ok(parse(await readFile(join(dir, 'api.yaml'), 'utf8')).paths['/auth/login']);
  assert.equal((await readFile(join(dir, 'api.graphql'), 'utf8')).trimEnd(), await generateGraphql(schema, { auth: true }));
  const facade = await createServer({ ...config, auth: { users: '/missing/users.json' } });
  assert.ok((await facade.openapi()).paths['/auth/login']);
  assert.equal(await facade.graphql(), await generateGraphql(schema, { auth: true }));
  config.auth.users = '/missing/users.json';
  await save();
  await runCli(['generate', 'graphql', source]);
  assert.equal((await readFile(join(dir, 'api.graphql'), 'utf8')).trimEnd(), await generateGraphql(schema, { auth: true }));

  config.openapi.path = config.auth.users;
  await save();
  await assert.rejects(() => runCli(['generate', 'openapi', source]), /overwrite/);
  delete config.auth;
  config.openapi.path = 'api.yaml';
  await save();
  await runCli(['generate', 'openapi', source]);
  assert.equal(parse(await readFile(join(dir, 'api.yaml'), 'utf8')).paths['/auth/login'], undefined);
});
