import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, generateGraphql, generateOpenapi } from '../dist/index.js';
import { Engine } from '../dist/src/core/engine.js';

const packagePath = new URL('../package.json', import.meta.url).pathname;
const packageSource = { name: 'test-api', version: '1.0.0', description: 'Test API' };
const model = (fields = {}) => ({ models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, ...fields } } } });
const setup = async (t, config) => {
  const facade = await createServer({
    ...config,
    ...((config.openapi ?? config.graphql) === undefined ? {} : { package: { source: config.storage === 'file' ? packagePath : packageSource } }),
    server: { logger: false, ...config.server },
  });
  const app = facade.fastify();
  t.after(() => app.close());
  await app.ready();
  return { app, facade };
};
const url = (path, options) => `${path}?${new URLSearchParams(Object.entries(options).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))}`;
const gql = (app, query) => app.inject({ method: 'POST', url: '/graphql', payload: { query } });

test('nested field lookups reject inherited names and empty objects remain writable in REST', async (t) => {
  const schema = model({ profile: { type: 'object' }, 'profile.name': { type: 'string' }, settings: { type: 'object' } });
  const { app } = await setup(t, { storage: 'memory', database: { schema, source: { items: [] } } });
  const created = await app.inject({ method: 'POST', url: url('/items', { scope: [{ '*': true, settings: [{ '*': true }] }] }), payload: { settings: {}, profile: { name: 'A' } } });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().settings, {});
  for (const options of [
    { scope: [{ profile: [{ toString: true }] }] },
    { scope: [{ '*': true }, { order: [{ field: 'profile.toString', direction: 'ASC' }] }] },
    { scope: [{ '*': true }, { where: { profile: { toString: { eq: 'x' } } } }] },
  ])
    assert.equal((await app.inject(url('/items', options))).statusCode, 400);
  assert.ok((await generateOpenapi(schema, { packagePath })).components.schemas.ItemCreate.properties.settings);
  await assert.rejects(() => generateGraphql(schema), /at least one visible field/);
  for (const type of ['object', 'object[]']) await assert.rejects(() => generateOpenapi(model({ profile: { type, enum: [{}] } }), { packagePath }), /enum.*primitive/);
});

test('GraphQL prepares each selected list once and REST reuses nested plans', async (t) => {
  const { app } = await setup(t, {
    storage: 'memory',
    database: { schema: model({ rows: { type: 'object[]' }, 'rows.name': { type: 'string' } }), source: { items: Array.from({ length: 10 }, (_, i) => ({ id: String(i), rows: [{ name: 'x' }] })) } },
    graphql: {},
  });
  const original = Engine.prototype.prepareOptions;
  let calls = 0;
  Engine.prototype.prepareOptions = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    const roots = Array.from({ length: 20 }, (_, i) => `q${i}:itemList { total }`).join(' ');
    assert.equal((await gql(app, `{${roots}}`)).json().errors, undefined);
    assert.equal(calls, 20);
    calls = 0;
    assert.equal((await gql(app, '{itemList {data { rows(where:{name:{eq:"x"}}) {total} }}}')).json().errors, undefined);
    assert.equal(calls, 2);
    calls = 0;
    assert.equal((await app.inject(url('/items', { scope: [{ rows: [{ '*': true }, { where: { name: { eq: 'x' } } }] }] }))).statusCode, 200);
    assert.equal(calls, 2);
    calls = 0;
    assert.equal((await app.inject('/items')).statusCode, 200);
    assert.equal(calls, 1);
  } finally {
    Engine.prototype.prepareOptions = original;
  }
});

test('inferred relation indexes use collections rather than singular model names', async (t) => {
  const { app } = await setup(t, { storage: 'memory', database: { source: { user: [{ id: '1', name: 'A' }], users: [{ id: '1', name: 'B' }], links: [{ id: '1', userId: '1', usersId: '1' }] } } });
  for (const scope of [[{ user: [{ name: true }], users: [{ name: true }] }], [{ users: [{ name: true }], user: [{ name: true }] }]]) {
    const result = (await app.inject(url('/links/1', { scope: scope }))).json();
    assert.deepEqual(result, { user: { name: 'A' }, users: { name: 'B' } });
  }
});

test('mixed schemaless shapes preserve projected data and never expose internal references', async (t) => {
  const mixed = [
    { id: '1', tagId: 't', profile: [{ name: 'A' }] },
    { id: '2', tagId: 't', profile: { name: 'B' } },
    { id: '3', tagId: 't', profile: 'scalar' },
  ];
  for (const items of [mixed, [...mixed].reverse()]) {
    const { app } = await setup(t, { storage: 'memory', database: { source: { items, tags: [{ id: 't' }], privateNotes: [{ id: 'p', text: 'fixture' }] } } });
    const result = await app.inject(url('/items/1', { scope: [{ profile: [{ name: true }] }] }));
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { profile: { data: [{ name: 'A' }], total: 1 } });
    assert.doesNotMatch(result.body, /context|bindings|privateNotes/);
    assert.equal((await app.inject('/items')).statusCode, 200);
    for (const options of [
      { scope: [{ '*': true }, { where: { profile: {} } }] },
      { scope: [{ '*': true }, { order: [{ field: 'profile.name', direction: 'ASC' }] }] },
      { scope: [{ profile: [{ '*': true }, {}] }] },
    ])
      assert.equal((await app.inject(url('/items', options))).statusCode, 400);
    const updated = await app.inject({ method: 'PATCH', url: url('/items/2', { scope: [{ profile: [{ '*': true }] }] }), payload: { profile: [{ name: 'C' }] } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json(), { profile: { data: [{ name: 'C' }], total: 1 } });
  }
});
