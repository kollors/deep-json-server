import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, hashPassword } from '../dist/index.js';
import { createAuthService } from '../dist/src/auth/service.js';

const password = 'session-password';
const user = { id: 'admin', username: 'admin', passwordHash: await hashPassword(password), isAdmin: true };
const credentials = { username: user.username, password };
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const bearer = (token) => `Bearer ${token}`;
const session = (token, expiresAt) => ({ tokenHash: tokenHash(token), expiresAt });
const request = (app, method, url, token, payload) => app.inject({ method, url, ...(token ? { headers: { authorization: bearer(token) } } : {}), ...(payload === undefined ? {} : { payload }) });
const login = async (app, secret = password) => {
  const response = await request(app, 'POST', '/auth/login', undefined, { username: user.username, password: secret });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().accessToken;
};
const temporary = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-auth-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const service = async (t, source, expiresIn) => {
  const auth = await createAuthService({ source, expiresIn });
  t.after(() => auth.close());
  return auth;
};

test('file sessions survive server restarts and authorize REST and GraphQL until logout or password change', async (t) => {
  const directory = await temporary(t);
  const source = join(directory, 'auth.json');
  const database = join(directory, 'database.json');
  const schema = join(directory, 'schema.json');
  await writeFile(source, JSON.stringify([user]));
  await writeFile(database, '{"items":[]}');
  await writeFile(schema, JSON.stringify({ models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, name: { type: 'string' } } } } }));
  const start = async (expiresIn = 3600) => {
    const facade = await createServer({ storage: 'file', database: { source: database, schema }, auth: { source, expiresIn }, graphql: {}, server: { logger: false } });
    const app = facade.fastify();
    t.after(() => app.close());
    await app.ready();
    return app;
  };
  let app = await start();
  const [first, second] = await Promise.all([login(app), login(app)]);
  const saved = JSON.parse(await readFile(source, 'utf8'));
  assert.deepEqual(saved[0].sessions.map(({ tokenHash }) => tokenHash).sort(), [tokenHash(first), tokenHash(second)].sort());
  for (const stored of saved[0].sessions) {
    assert.deepEqual(Object.keys(stored).sort(), ['expiresAt', 'tokenHash']);
    assert.ok(stored.expiresAt > Date.now());
  }
  assert.equal(JSON.stringify(saved).includes(first), false);
  assert.equal(JSON.stringify(saved).includes(second), false);
  await app.close();

  app = await start(7200);
  assert.deepEqual((await request(app, 'GET', '/auth/me', second)).json(), { id: user.id, username: user.username, isAdmin: true });
  assert.equal((await request(app, 'POST', '/items', second, { name: 'rest' })).statusCode, 201);
  const graphql = await request(app, 'POST', '/graphql', second, { query: 'mutation {itemCreate(data:{name:"graphql"}){name}}' });
  assert.equal(graphql.json().errors, undefined, graphql.body);
  assert.equal(graphql.json().data.itemCreate.name, 'graphql');
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8'))[0].sessions, saved[0].sessions);
  assert.deepEqual((await request(app, 'POST', '/auth/logout', first)).json(), { success: true });
  assert.equal((await request(app, 'GET', '/auth/me', first)).statusCode, 401);
  await app.close();

  app = await start();
  assert.equal((await request(app, 'GET', '/auth/me', first)).statusCode, 401);
  assert.equal((await request(app, 'GET', '/auth/me', second)).statusCode, 200);
  const changed = await request(app, 'PATCH', '/auth/users/admin/password', second, { currentPassword: password, newPassword: 'new-password' });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8'))[0].sessions, []);
  await app.close();

  app = await start();
  assert.equal((await request(app, 'GET', '/auth/me', second)).statusCode, 401);
  await login(app, 'new-password');
});

test('memory sources restore seeded sessions while runtime logins and logouts leave the source unchanged', async (t) => {
  const seededToken = randomBytes(32).toString('base64url');
  const source = [{ ...user, sessions: [session(seededToken, Date.now() + 60000)] }];
  const original = structuredClone(source);
  const auth = await service(t, source);
  assert.equal(auth.me(bearer(seededToken)).id, user.id);
  const created = await auth.login(credentials);
  await auth.logout(bearer(seededToken));
  assert.throws(() => auth.me(bearer(seededToken)), { code: 'UNAUTHENTICATED' });
  assert.deepEqual(source, original);
  auth.close();

  const restarted = await service(t, source);
  assert.equal(restarted.me(bearer(seededToken)).id, user.id);
  assert.throws(() => restarted.me(bearer(created.accessToken)), { code: 'UNAUTHENTICATED' });
});

test('expired sessions never authenticate after restart and are pruned for every user on the next successful update', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'auth.json');
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const expired = randomBytes(32).toString('base64url');
  const active = randomBytes(32).toString('base64url');
  const other = randomBytes(32).toString('base64url');
  const initial = [
    { ...user, sessions: [session(expired, now), session(active, now + 1000)] },
    { ...user, id: 'other', username: 'other', sessions: [session(other, now + 1000)] },
  ];
  await writeFile(path, JSON.stringify(initial));
  const first = await service(t, path);
  assert.throws(() => first.me(bearer(expired)), { code: 'UNAUTHENTICATED' });
  assert.equal(first.me(bearer(active)).id, user.id);
  first.close();

  t.mock.timers.setTime(now + 1000);
  const second = await service(t, path, 7200);
  for (const token of [expired, active, other]) assert.throws(() => second.me(bearer(token)), { code: 'UNAUTHENTICATED' });
  const created = await second.login(credentials);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved[0].sessions, [session(created.accessToken, now + 1000 + 7200 * 1000)]);
  assert.deepEqual(saved[1].sessions, []);

  t.mock.timers.setTime(now + 1000 + 7200 * 1000);
  assert.throws(() => second.me(bearer(created.accessToken)), { code: 'UNAUTHENTICATED' });
  await second.login(credentials);
  assert.equal(JSON.parse(await readFile(path, 'utf8'))[0].sessions.length, 1);
});

test('session fixtures reject malformed records and duplicate hashes instead of accepting ambiguous identities', async () => {
  const valid = session(randomBytes(32).toString('base64url'), Date.now() + 60000);
  for (const sessions of [
    null,
    {},
    [null],
    [{}],
    [{ ...valid, tokenHash: 'raw-token' }],
    [{ ...valid, tokenHash: valid.tokenHash.toUpperCase() }],
    [{ ...valid, expiresAt: '123' }],
    [{ ...valid, expiresAt: 0 }],
    [{ ...valid, expiresAt: -1 }],
    [{ ...valid, expiresAt: 1.5 }],
    [{ ...valid, expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...valid, expiresAt: Number.NaN }],
    [{ ...valid, accessToken: 'secret' }],
    [valid, valid],
  ])
    await assert.rejects(() => createAuthService({ source: [{ ...user, sessions }] }), /Auth user session/);
  await assert.rejects(
    () =>
      createAuthService({
        source: [
          { ...user, sessions: [valid] },
          { ...user, id: 'other', username: 'other', sessions: [valid] },
        ],
      }),
    /token hashes must be unique/,
  );
});

test('restored active sessions count toward the global limit and simultaneous logins cannot exceed it', async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const sessions = Array.from({ length: 9999 }, (_, i) => ({ tokenHash: i.toString(16).padStart(64, '0'), expiresAt: now + 1000 }));
  const auth = await service(t, [{ ...user, sessions }]);
  const attempts = await Promise.allSettled([auth.login(credentials), auth.login(credentials)]);
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.find(({ status }) => status === 'rejected').reason.code, 'TOO_MANY_REQUESTS');
  t.mock.timers.setTime(now + 1000);
  const created = await auth.login(credentials);
  assert.equal(auth.me(bearer(created.accessToken)).id, user.id);
});
