import assert from 'node:assert/strict';
import test from 'node:test';
import { getIntrospectionQuery } from 'graphql';
import { createServer } from '../dist/index.js';
import { QueryBudget } from '../dist/src/core/query/budget.js';

const schema = {
  models: {
    Item: {
      collection: 'items',
      fields: {
        id: { type: 'number', primary: true },
        name: { type: 'string' },
        peers: { type: 'Item[]', keyOn: 'current', source: 'peerIds' },
        peerOwners: { type: 'Item[]', keyOn: 'related', target: 'peerIds' },
      },
    },
  },
};
const setup = async (t, data) => {
  const app = (
    await createServer({
      storage: 'memory',
      database: { source: data, schema },
      graphql: {},
      package: { source: { name: 'test-api', version: '1.0.0' } },
      server: { logger: false },
    })
  ).fastify();
  t.after(() => app.close());
  return app;
};
const linked = () => ({ items: Array.from({ length: 10 }, (_, id) => ({ id, name: `Item ${id}`, peerIds: Array.from({ length: 10 }, (_, peer) => peer) })) });
const scopeUrl = (path, scope) => `${path}?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
const scopeTree = (depth, pageSize = 10) => (depth ? [{ id: true, peers: scopeTree(depth - 1, pageSize) }, { pager: { pageSize } }] : [{ id: true }, { pager: { pageSize } }]);
const graphTree = (depth, pageSize = 10) => (depth ? `id peers(pager:{pageSize:${pageSize}}){data{${graphTree(depth - 1, pageSize)}}}` : 'id');
const graph = (app, query) => app.inject({ method: 'POST', url: '/graphql', payload: { query } });
const assertGraphBudget = (response) => {
  const errors = response.json().errors;
  assert.ok(errors?.length, response.body);
  assert.ok(
    errors.every((error) => error.extensions?.code === 'INVALID_QUERY'),
    response.body,
  );
  assert.match(errors[0].message, /request budget/);
};

test('REST bounds recursive fan-out and accepts the same relation depth with pagination', async (t) => {
  const app = await setup(t, linked());
  const rejected = await app.inject(scopeUrl('/items', scopeTree(6)));
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json().error, /request budget/);
  const paginated = await app.inject(scopeUrl('/items', scopeTree(6, 1)));
  assert.equal(paginated.statusCode, 200, paginated.body);
  assert.equal(paginated.json().data.length, 1);
});

test('REST shares list work budget across union parts even when every result is deduplicated', async (t) => {
  const app = await setup(t, { items: Array.from({ length: 1000 }, (_, id) => ({ id })) });
  const part = [{ id: true }, { where: { id: { gte: 0 } } }];
  assert.equal((await app.inject(scopeUrl('/items', part))).statusCode, 200);
  const response = await app.inject(scopeUrl('/items', { union: Array.from({ length: 120 }, () => part) }));
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /request budget/);
});

test('REST rolls back a mutation when its expanded response exceeds the request budget', async (t) => {
  const app = await setup(t, linked());
  const response = await app.inject({ method: 'PATCH', url: scopeUrl('/items/0', [scopeTree(6)[0]]), payload: { name: 'unsaved' } });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal((await app.inject('/items/0')).json().name, 'Item 0');
});

test('GraphQL stops recursive fan-out and shares its result budget across aliases', async (t) => {
  const app = await setup(t, linked());
  assertGraphBudget(await graph(app, `{item(id:0){${graphTree(6)}}}`));
  const single = await graph(app, `{item(id:0){${graphTree(3)}}}`);
  assert.equal(single.json().errors, undefined, single.body);
  assertGraphBudget(await graph(app, `{${Array.from({ length: 12 }, (_, index) => `part${index}:item(id:0){${graphTree(3)}}`).join(' ')}}`));
  const paginated = await graph(app, `{item(id:0){${graphTree(6, 1)}}}`);
  assert.equal(paginated.json().errors, undefined, paginated.body);
});

test('GraphQL validates the total selection budget before executing mutation aliases', async (t) => {
  const app = await setup(t, { items: [{ id: 0, name: 'original' }] });
  const query = `mutation {${Array.from({ length: 510 }, (_, index) => `part${index}:itemUpdate(id:0,data:{name:"unsaved"}){id}`).join(' ')}}`;
  assertGraphBudget(await graph(app, query));
  assert.equal((await app.inject('/items/0')).json().name, 'original');
});

test('GraphQL allows the standard full introspection query', async (t) => {
  const first = await setup(t, linked());
  const query = getIntrospectionQuery();
  const original = (await graph(first, query)).json();
  assert.equal(original.errors, undefined);
  assert.ok(original.data.__schema.types.length);
  for (let index = 0; index < 12; index++) {
    const app = await setup(t, linked());
    const response = await graph(app, query);
    assert.deepEqual(response.json(), original);
    await app.close();
  }
  assert.deepEqual((await graph(first, query)).json(), original);
});

test('GraphQL applies the selection budget to built-in fields without entity resolvers', async (t) => {
  const app = await setup(t, linked());
  assertGraphBudget(await graph(app, `{${Array.from({ length: 1001 }, (_, index) => `part${index}:__typename`).join(' ')}}`));
});

test('scalar output is bounded before cloning or GraphQL serialization', async (t) => {
  const name = '\u0000'.repeat(750_000);
  const app = await setup(t, {
    items: [
      { id: 0, name },
      { id: 1, name },
    ],
  });
  const response = await app.inject('/items');
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /request budget/);
  assertGraphBudget(await graph(app, '{item(id:0){a:name b:name}}'));
  const budget = new QueryBudget();
  assert.throws(() => budget.scalar(Array.from({ length: 100_001 }, () => null)), { code: 'INVALID_QUERY' });
});
