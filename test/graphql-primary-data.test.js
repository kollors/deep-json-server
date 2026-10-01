import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, generateGraphql } from '../dist/index.js';

test('GraphQL preserves primary keys named data with a separate key argument for update and replace', async (t) => {
  const schema = { models: { Item: { collection: 'items', fields: { data: { type: 'string', primary: true }, name: { type: 'string' } } } } };
  const sdl = await generateGraphql(schema);
  assert.match(sdl, /itemUpdate\(key: ID!, data: ItemUpdate!\)/);
  assert.match(sdl, /itemReplace\(key: ID!, data: ItemReplace!\)/);
  const app = (
    await createServer({
      storage: 'memory',
      database: { source: { items: [{ data: 'one', name: 'original' }] }, schema },
      graphql: {},
      package: { source: { name: 'test-api', version: '1.0.0' } },
      server: { logger: false },
    })
  ).fastify();
  t.after(() => app.close());
  for (const [operation, query, name] of [
    ['itemUpdate', 'mutation {itemUpdate(key:"one",data:{name:"updated"}){data name}}', 'updated'],
    ['itemReplace', 'mutation {itemReplace(key:"one",data:{name:"replaced"}){data name}}', 'replaced'],
    ['item', '{item(data:"one"){data name}}', 'replaced'],
    ['itemDelete', 'mutation {itemDelete(data:"one"){data name}}', 'replaced'],
  ]) {
    const response = await app.inject({ method: 'POST', url: '/graphql', payload: { query } });
    assert.deepEqual(response.json(), { data: { [operation]: { data: 'one', name } } });
  }
  assert.equal((await app.inject('/items/one')).statusCode, 404);
});
