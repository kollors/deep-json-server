import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, generateOpenapi } from '../dist/index.js';

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

test('pagination and package metadata agree across public generators and the server', async (t) => {
  const schema = model();
  const generated = await generateOpenapi(schema, { maxPageSize: 5, packagePath });
  assert.equal(generated.components.schemas.Pager.properties.pageSize.default, 5);
  for (const options of [
    { pageSize: 0 },
    { maxPageSize: -1 },
    { pageSize: 6, maxPageSize: 5 },
    { pageSize: Number.MAX_SAFE_INTEGER + 1 },
    { port: '4001' },
    { info: { title: 'x' } },
    { files: 'true' },
  ])
    await assert.rejects(() => generateOpenapi(schema, { ...options, packagePath }));
  const { facade, app } = await setup(t, { storage: 'memory', database: { schema, source: { items: [] } }, openapi: {}, server: { maxPageSize: 5, port: 0 } });
  const fromFacade = await facade.openapi();
  const fromEndpoint = (await app.inject('/openapi.json')).json();
  assert.deepEqual(fromFacade, fromEndpoint);
  assert.equal(fromEndpoint.info.title, 'test-api');
  assert.deepEqual(fromEndpoint.servers, [{ url: '/' }]);
});

test('OpenAPI preserves annotations on objects and relations', async () => {
  const schema = model({
    profile: { type: 'object', nullable: true, readOnly: true, description: 'Profile', example: { name: 'A' } },
    'profile.name': { type: 'string' },
    related: { type: 'Item[]', keyOn: 'related', source: 'id', target: 'id', description: 'Related items' },
    relatedBack: { type: 'Item[]', keyOn: 'current', source: 'id', target: 'id' },
  });
  const doc = await generateOpenapi(schema, { packagePath });
  const { profile, related } = doc.components.schemas.Item.properties;
  assert.equal(profile.readOnly, true);
  assert.equal(profile.description, 'Profile');
  assert.deepEqual(profile.example, { name: 'A' });
  assert.ok(profile.allOf[0].anyOf);
  assert.equal(related.description, 'Related items');
  assert.equal(related.allOf[0].$ref, '#/components/schemas/ItemPage');
});
