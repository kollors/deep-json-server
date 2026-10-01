import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from '../dist/index.js';

const schema = {
  models: {
    Item: {
      collection: 'items',
      fields: {
        id: { type: 'number', primary: true, generated: 'increment' },
        name: { type: 'string' },
        peers: { type: 'Item[]', keyOn: 'current', source: 'peerIds' },
        peerOwners: { type: 'Item[]', keyOn: 'related', target: 'peerIds' },
      },
    },
  },
};
const graphTree = (depth) => (depth ? `id peers { data { ${graphTree(depth - 1)} } }` : 'id');
const graph = async (app, query) => (await app.inject({ method: 'POST', url: '/graphql', payload: { query } })).json();

const setup = async (t, storage) => {
  const data = { items: Array.from({ length: 10 }, (_, id) => ({ id, name: `Item ${id}`, peerIds: Array.from({ length: 10 }, (_, peer) => peer) })) };
  const directory = storage === 'file' ? await mkdtemp(join(tmpdir(), 'deep-json-mutation-result-')) : undefined;
  const path = directory && join(directory, 'database.json');
  const schemaPath = directory && join(directory, 'schema.json');
  if (path) {
    await writeFile(path, JSON.stringify(data));
    await writeFile(schemaPath, JSON.stringify(schema));
  }
  const config = {
    storage,
    database: { source: path ?? data, schema: schemaPath ?? schema },
    graphql: {},
    package: { source: directory ? fileURLToPath(new URL('../package.json', import.meta.url)) : { name: 'test-api', version: '1.0.0' } },
    server: { logger: false },
  };
  let app = (await createServer(config)).fastify();
  t.after(async () => {
    await app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    path,
    async restart() {
      await app.close();
      app = (await createServer(config)).fastify();
      return app;
    },
  };
};

for (const storage of ['memory', 'file']) {
  test(`GraphQL ${storage} result-budget failure preserves earlier commits and stops later aliases`, async (t) => {
    const fixture = await setup(t, storage);
    const response = await graph(
      fixture.app,
      `mutation {
      earlier: itemUpdate(id: 2, data: {name: "earlier commit"}) { id }
      failing: itemUpdate(id: 0, data: {name: "committed"}) { ${graphTree(6)} }
      later: itemUpdate(id: 1, data: {name: "must not run"}) { id }
    }`,
    );
    assert.equal(response.data, null);
    assert.equal(response.errors.length, 1);
    assert.equal(response.errors[0].extensions.code, 'INVALID_QUERY');
    assert.match(response.errors[0].message, /request budget/);

    const query = '{ first: item(id: 0) { name } untouched: item(id: 1) { name } earlier: item(id: 2) { name } }';
    const expected = { first: { name: 'committed' }, untouched: { name: 'Item 1' }, earlier: { name: 'earlier commit' } };
    assert.deepEqual(await graph(fixture.app, query), { data: expected });
    if (fixture.path) {
      const stored = JSON.parse(await readFile(fixture.path, 'utf8'));
      assert.equal(stored.items[0].name, 'committed');
      assert.equal(stored.items[1].name, 'Item 1');
      assert.equal(stored.items[2].name, 'earlier commit');
      assert.deepEqual(await graph(await fixture.restart(), query), { data: expected });
    }
  });

  test(`GraphQL ${storage} recovers a generated key through a smaller read after a create result error`, async (t) => {
    const fixture = await setup(t, storage);
    const response = await graph(fixture.app, `mutation { itemCreate(data: {name: "created before result error", peers: [{id: 0}]}) { ${graphTree(6)} } }`);
    assert.equal(response.data, null);
    assert.equal(response.errors.length, 1);
    assert.equal(response.errors[0].extensions.code, 'INVALID_QUERY');

    const recovered = await graph(fixture.app, '{ itemList(where: {name: {eq: "created before result error"}}) { data { id name } total } }');
    assert.equal(recovered.errors, undefined);
    assert.equal(recovered.data.itemList.total, 1);
    assert.deepEqual(recovered.data.itemList.data, [{ id: 10, name: 'created before result error' }]);
    const updated = await graph(fixture.app, 'mutation { itemUpdate(id: 10, data: {name: "recovered"}) { id name } }');
    assert.deepEqual(updated, { data: { itemUpdate: { id: 10, name: 'recovered' } } });
    assert.equal((await graph(fixture.app, '{ itemList { total } }')).data.itemList.total, 11);
    if (fixture.path) {
      assert.equal(JSON.parse(await readFile(fixture.path, 'utf8')).items.length, 11);
      assert.deepEqual(await graph(await fixture.restart(), '{ item(id: 10) { id name } }'), { data: { item: { id: 10, name: 'recovered' } } });
    }
  });
}
