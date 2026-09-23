import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../dist/index.js';

const setup = async (t, data, schema) => {
  const app = (await createServer({ storage: 'memory', database: { source: data, schema }, server: { logger: false } })).fastify();
  t.after(() => app.close());
  return app;
};
const scopeUrl = (url, scope) => `${url}?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;

for (const explicit of [false, true]) {
  test(`embedded union preserves distinct objects without primary keys (explicit=${explicit})`, async (t) => {
    const schema = explicit ? { models: { Item: { collection: 'items', fields: { id: { type: 'number', primary: true }, rows: { type: 'object[]' }, 'rows.name': { type: 'string' } } } } } : undefined;
    const rows = [{ name: 'same' }, { name: 'same' }, { name: 'last' }];
    const app = await setup(t, { items: [{ id: 1, rows }] }, schema);
    const response = await app.inject(scopeUrl('/items/1', [{ rows: { union: [[{ '*': true }, { pager: { pageSize: 2 } }], [{ '*': true }]] } }]));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { rows: { data: rows, total: 3 } });
  });
}

test('schemaless wildcard selects actual primitives in mixed fields and excludes relation keys', async (t) => {
  const app = await setup(t, {
    users: [{ id: 'u' }],
    items: [
      { id: 1, value: 1, userId: 'u' },
      { id: 2, value: [2, 3] },
      { id: 3, value: { name: 'nested' } },
      { id: 4, value: null },
    ],
  });
  const response = await app.inject('/items');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, [{ id: 1, value: 1 }, { id: 2 }, { id: 3 }, { id: 4, value: null }]);
  const array = await app.inject(scopeUrl('/items/2', [{ value: [{ '*': true }] }]));
  assert.equal(array.statusCode, 200, array.body);
  assert.deepEqual(array.json().value, [2, 3]);
});

test('wildcard preserves system nulls and omits nullable objects and arrays declared by the schema', async (t) => {
  const schema = {
    timestamps: true,
    models: {
      Item: {
        collection: 'items',
        fields: {
          id: { type: 'string', primary: true },
          name: { type: 'string', nullable: true },
          tags: { type: 'string[]', nullable: true },
          profile: { type: 'object', nullable: true },
          'profile.name': { type: 'string' },
        },
      },
    },
  };
  const app = await setup(t, { items: [{ id: '1', name: null, tags: null, profile: null }] }, schema);
  const response = await app.inject('/items/1');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { id: '1', name: null, createdAt: null, updatedAt: null });
  assert.deepEqual((await app.inject(scopeUrl('/items/1', [{ tags: true, profile: [{ '*': true }] }]))).json(), { tags: null, profile: null });
});
