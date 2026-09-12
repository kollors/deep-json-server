import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSchema, parse, validate } from 'graphql';
import { createServer, generateGraphql } from '../dist/index.js';
import { preflight } from '../dist/src/graphql/preflight.js';

const primary = { type: 'number', primary: true, generated: 'increment' };
const url = (path, scope) => `${path}?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
const setup = async (t, schema, data, graphql = false) => {
  const facade = await createServer({ database: { schema, data }, graphql: { enabled: graphql }, server: { logger: false } });
  const app = facade.fastify();
  t.after(() => app.close());
  return { app, facade };
};
const itemSchema = {
  Item: {
    collection: 'items',
    fields: {
      id: primary,
      name: { type: 'string' },
      profile: { type: 'object', nullable: true },
      'profile.name': { type: 'string' },
      rows: { type: 'object[]' },
      'rows.name': { type: 'string' },
      peers: { type: 'Item[]', source: 'peerIds' },
    },
  },
};

test('scope is the only REST query parameter and root arguments match GraphQL', async (t) => {
  const { app } = await setup(
    t,
    itemSchema,
    {
      items: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
      ],
    },
    true,
  );
  const result = await app.inject(url('/items', [{ name: true }, { where: { id: { gte: 2 } }, order: [{ field: 'name', direction: 'DESC' }], pager: { page: 2, pageSize: 1 } }]));
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { data: [{ name: 'B' }], total: 2 });
  const graph = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query: '{itemList(where:{id:{gte:2}},order:[{field:name,direction:DESC}],pager:{page:2,pageSize:1}){data{name}total}}' },
  });
  assert.deepEqual(result.json(), graph.json().data.itemList);
  for (const [key, value] of Object.entries({ where: {}, order: [], pager: {}, nested: {} })) {
    for (const path of ['/items', '/items/1']) {
      const response = await app.inject(`${path}?${new URLSearchParams({ [key]: JSON.stringify(value) })}`);
      assert.equal(response.statusCode, 400, response.body);
      assert.match(response.json().error, /Unknown query parameter/);
    }
  }
});

test('scope validates every tuple and list argument before projecting empty data', async (t) => {
  const { app } = await setup(t, itemSchema, { items: [] });
  for (const scope of [
    {},
    [],
    [true],
    [null],
    [{}, {}, {}],
    [{}, null],
    [{}, []],
    [{}, { limit: 1 }],
    [{ rows: true }],
    [{ profile: {} }],
    [{ peers: [true, {}] }],
    [{ id: [{}] }],
    [{ profile: [{}, {}] }],
    [{ rows: [{}, { where: { missing: { eq: 'x' } } }] }],
    [{ rows: [{}, { order: [{ field: 'missing', direction: 'ASC' }] }] }],
    [{ rows: [{}, { pager: { pageSize: 0 } }] }],
    [{ peers: [{}, { unknown: {} }] }],
    [{ peers: [{ peers: [{}, { pager: { page: -1 } }] }] }],
  ]) {
    const result = await app.inject(url('/items', scope));
    assert.equal(result.statusCode, 400, JSON.stringify({ scope, response: result.json() }));
  }
  assert.equal((await app.inject(url('/items', [{}, {}]))).statusCode, 200);
  assert.equal((await app.inject(url('/items/missing', [{}, {}]))).statusCode, 400);
  const post = await app.inject({ method: 'POST', url: url('/items', [{}, { pager: { page: 1 } }]), payload: { name: 'unsaved' } });
  assert.equal(post.statusCode, 400, post.body);
  assert.equal((await app.inject('/items')).json().total, 0);
});

test('scope arguments work in mutation responses and invalid nested arguments roll back writes', async (t) => {
  const { app } = await setup(t, itemSchema, {
    items: [
      { id: 1, name: 'A', peerIds: [] },
      { id: 2, name: 'B' },
    ],
  });
  const scope = [{ name: true, peers: [{ name: true }, { order: [{ field: 'name', direction: 'DESC' }], pager: { pageSize: 1 } }] }];
  const result = await app.inject({ method: 'PATCH', url: url('/items/1', scope), payload: { peers: [2, { name: 'C' }] } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { name: 'A', peers: { data: [{ name: 'C' }], total: 2 } });
  const failed = await app.inject({ method: 'PATCH', url: url('/items/1', [{ peers: [{}, { pager: { pageSize: 0 } }] }]), payload: { peers: [{ name: 'unsaved' }] } });
  assert.equal(failed.statusCode, 400, failed.body);
  assert.equal((await app.inject('/items')).json().total, 3);
  const good = await app.inject({ method: 'POST', url: '/items', payload: { name: 'D' } });
  assert.equal(good.json().id, 4);
});

test('scope projects objects in mixed schemaless arrays while preserving scalars', async (t) => {
  const { app } = await setup(t, undefined, { things: [{ id: 1, mixed: [{ name: 'a', extra: 'unselected', profile: { name: 'b', extra: 'unselected' } }, 2, null, 'text'] }] });
  const result = await app.inject(url('/things/1', [{ mixed: [{ name: true, profile: [{ name: true }] }] }]));
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { mixed: [{ name: 'a', profile: { name: 'b' } }, 2, null, 'text'] });
  assert.deepEqual((await app.inject(url('/things/1', [{ mixed: [{}] }]))).json(), { mixed: [{}, 2, null, 'text'] });
  assert.equal((await app.inject(url('/things/1', [{ mixed: [{ name: true }, { pager: { pageSize: 1 } }] }]))).statusCode, 400);
  assert.doesNotMatch(result.body, /context|bindings|unselected/);
});

test('GraphQL rejects collisions between root and nested input types in either model order', async () => {
  const models = {
    User: { collection: 'users', fields: { id: primary, name: { type: 'string', required: true } } },
    UserNested: { collection: 'userNesteds', fields: { id: primary, unrelated: { type: 'string' } } },
    Holder: { collection: 'holders', fields: { id: primary, users: { type: 'User[]', source: 'userIds' } } },
  };
  for (const schema of [models, Object.fromEntries(Object.entries(models).reverse())]) await assert.rejects(() => generateGraphql(schema), /GraphQL type name collision: UserNested/);
});

test('GraphQL preflight traverses shared fragments once, respecting skipped occurrences', () => {
  const schema = buildSchema('type Query { item: Item } type Item { id: ID }');
  const item = schema.getType('Item');
  const original = item.getFields.bind(item);
  let visits = 0;
  item.getFields = () => {
    visits++;
    return original();
  };
  const fragments = Array.from({ length: 18 }, (_, i) => `fragment F${i + 1} on Item { ...F${i} ...F${i} }`).join(' ');
  const document = parse(`{ item { ...F18 @skip(if:true) ...F18 } } fragment F0 on Item { id } ${fragments}`);
  assert.deepEqual(validate(schema, document), []);
  visits = 0;
  preflight({ schema, operation: document.definitions[0], fragments: Object.fromEntries(document.definitions.slice(1).map((f) => [f.name.value, f])), variableValues: {} }, {});
  assert.equal(visits, 1);
});

test('custom protected source keys support reverse PUT clearing and PATCH preservation', async (t) => {
  for (const code of [
    { type: 'string', readOnly: true },
    { type: 'string', generated: 'uuid' },
  ]) {
    const schema = {
      Parent: { collection: 'parents', fields: { id: primary, name: { type: 'string' }, code, children: { type: 'Child[]', source: 'code', target: 'parentCode' } } },
      Child: { collection: 'children', fields: { id: primary, parentCode: { type: 'string', nullable: true } } },
    };
    const { app } = await setup(t, schema, { parents: [{ id: 1, name: 'old', code: 'P' }], children: [{ id: 1, parentCode: 'P' }] }, true);
    const path = url('/parents/1', [{ '*': true, children: [{ id: true }] }]);
    const patch = await app.inject({ method: 'PATCH', url: path, payload: { name: 'patch' } });
    assert.equal(patch.json().children.total, 1);
    for (const payload of [{ name: 'replace' }, { name: 'replace', children: [] }]) {
      const result = await app.inject({ method: 'PUT', url: path, payload });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().children.total, 0);
      assert.equal(result.json().code, 'P');
      assert.equal((await app.inject('/children/1')).json().parentCode, null);
      const relink = await app.inject({ method: 'PATCH', url: path, payload: { children: [1] } });
      assert.equal(relink.statusCode, 200, relink.body);
      assert.equal(relink.json().children.total, 1);
    }
    const graph = await app.inject({ method: 'POST', url: '/graphql', payload: { query: 'mutation {parentReplace(id:1,data:{name:"graphql"}){code children{total}}}' } });
    assert.equal(graph.json().errors, undefined, graph.body);
    assert.equal(graph.json().data.parentReplace.children.total, 0);
  }
});

test('required reverse relations with custom keys cannot be cleared', async (t) => {
  const schema = {
    Parent: { collection: 'parents', fields: { id: primary, code: { type: 'string', readOnly: true }, children: { type: 'Child[]', source: 'code', target: 'parentCode', required: true } } },
    Child: { collection: 'children', fields: { id: primary, parentCode: { type: 'string', nullable: true } } },
  };
  const { app } = await setup(t, schema, { parents: [{ id: 1, code: 'P' }], children: [{ id: 1, parentCode: 'P' }] });
  for (const payload of [{}, { children: [] }]) {
    const result = await app.inject({ method: 'PUT', url: '/parents/1', payload });
    assert.equal(result.statusCode, 400, result.body);
    assert.match(result.json().error, /Required relation/);
    assert.equal((await app.inject('/children/1')).json().parentCode, 'P');
  }
});

test('transaction key indexes see earlier creates and do not outlive rolled back writes', async (t) => {
  const schema = {
    User: { collection: 'users', fields: { id: primary, name: { type: 'string' } } },
    Holder: { collection: 'holders', fields: { id: primary, first: { type: 'User', source: 'firstId' }, second: { type: 'User', source: 'secondId' } } },
  };
  const { app } = await setup(t, schema, { users: [], holders: [{ id: 1 }] });
  const mutate = (payload) => app.inject({ method: 'PATCH', url: '/holders/1', payload });
  const failed = await mutate({ first: { name: 'rollback' }, second: 999 });
  assert.equal(failed.statusCode, 404, failed.body);
  assert.equal((await mutate({ second: 1 })).statusCode, 404);
  const good = await mutate({ first: { name: 'created' }, second: { id: 1, name: 'updated' } });
  assert.equal(good.statusCode, 200, good.body);
  assert.deepEqual(good.json(), { id: 1, firstId: 1, secondId: 1 });
  assert.equal((await app.inject('/users/1')).json().name, 'updated');
});
