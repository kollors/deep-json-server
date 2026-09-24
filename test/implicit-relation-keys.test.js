import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../dist/index.js';

const relation = { type: 'Country', source: 'countryId' };
const country = { collection: 'countries', fields: { id: { type: 'string', primary: true } } };
const user = (explicit = false) => ({
  collection: 'users',
  fields: { id: { type: 'string', primary: true }, ...(explicit ? { countryId: { type: 'string' } } : {}), country: relation },
});
const schema = (explicit = false) => ({ models: { Country: country, User: user(explicit) } });
const database = { countries: [{ id: '1' }, { id: '2' }], users: [{ id: 'u1', countryId: '1' }] };
const scope = (fields, options) => `?${new URLSearchParams({ scope: JSON.stringify([fields, ...(options ? [options] : [])]) })}`;

test('undeclared relation keys stay in database.json but are absent from REST, GraphQL, and OpenAPI', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-implicit-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'database.json');
  const schemaPath = join(directory, 'schema.json');
  const packagePath = join(directory, 'package.json');
  await writeFile(databasePath, JSON.stringify(database));
  await writeFile(schemaPath, JSON.stringify(schema()));
  await writeFile(packagePath, JSON.stringify({ name: 'implicit-key-api', version: '1.0.0' }));
  const facade = await createServer({
    storage: 'file',
    database: { source: databasePath, schema: schemaPath },
    package: { source: packagePath },
    graphql: {},
    openapi: {},
    server: { logger: false },
  });
  const app = facade.fastify();
  t.after(() => app.close());

  assert.deepEqual((await app.inject('/users/u1')).json(), { id: 'u1' });
  assert.equal((await app.inject(`/users/u1${scope({ countryId: true })}`)).statusCode, 400);
  assert.equal((await app.inject(`/users${scope({ id: true }, { where: { countryId: { eq: '1' } } })}`)).statusCode, 400);
  assert.equal((await app.inject(`/users${scope({ id: true }, { order: [{ field: 'countryId', direction: 'ASC' }] })}`)).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/users/u1', payload: { countryId: '2' } })).statusCode, 400);

  const graphql = await facade.graphql();
  assert.doesNotMatch(graphql, /countryId/);
  const invalidGraphql = await app.inject({ method: 'POST', url: '/graphql', payload: { query: '{ user(id: "u1") { countryId } }' } });
  assert.ok(invalidGraphql.json().errors);
  assert.doesNotMatch(JSON.stringify(await facade.openapi()), /countryId/);

  const connected = await app.inject({ method: 'PATCH', url: '/users/u1', payload: { country: { id: '2' } } });
  assert.equal(connected.statusCode, 200, connected.body);
  assert.deepEqual((await app.inject(`/users/u1${scope({ country: [{ id: true }] })}`)).json(), { country: { id: '2' } });
  const stored = JSON.parse(await readFile(databasePath, 'utf8'));
  assert.equal(stored.users[0].countryId, '2');
});

test('explicit relation keys remain available in every API', async (t) => {
  const facade = await createServer({
    storage: 'memory',
    database: { source: database, schema: schema(true) },
    package: { source: { name: 'explicit-key-api', version: '1.0.0' } },
    graphql: {},
    openapi: {},
    server: { logger: false },
  });
  const app = facade.fastify();
  t.after(() => app.close());
  assert.equal((await app.inject(`/users/u1${scope({ countryId: true })}`)).json().countryId, '1');
  assert.match(await facade.graphql(), /countryId/);
  assert.match(JSON.stringify(await facade.openapi()), /countryId/);
  assert.equal((await app.inject({ method: 'PATCH', url: '/users/u1', payload: { countryId: '2' } })).statusCode, 200);
});
