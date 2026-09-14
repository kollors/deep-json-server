import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createServer, generateGraphql, generateOpenapi } from '../dist/index.js';
import { loadModel } from '../dist/src/core/model.js';
import { normalizeServerConfig } from '../dist/src/server/config.js';

const item = { collection: 'items', fields: { id: { type: 'string', primary: true } } };
const schema = { models: { Item: item } };
const memory = { storage: 'memory', database: { source: { items: [] }, schema }, server: { logger: false } };

test('storage discriminates every source and the schema, with independent input copies', () => {
  const input = { ...memory, auth: { source: [] }, files: { source: [{ name: 'one.txt', mimeType: 'text/plain', content: new Uint8Array([1]) }] } };
  const result = normalizeServerConfig(input);
  assert.notEqual(result.database.source, input.database.source);
  assert.notEqual(result.database.schema.models, input.database.schema.models);
  result.files.source[0].content[0] = 2;
  assert.equal(input.files.source[0].content[0], 1);
  result.auth.source.push({ id: 'copy' });
  assert.deepEqual(input.auth.source, []);
  const disk = normalizeServerConfig({ storage: 'file', database: { source: 'db.json', schema: 'schema.json' }, auth: { source: 'auth.json' }, files: { source: 'uploads' } }, '/tmp/example');
  assert.equal(disk.database.source, '/tmp/example/db.json');
  assert.equal(disk.database.schema, '/tmp/example/schema.json');
  assert.equal(disk.auth.source, '/tmp/example/auth.json');
  assert.equal(disk.files.metadata, '/tmp/example/uploads/.files.json');
  for (const storage of ['file', 'memory']) {
    const base = storage === 'memory' ? memory : { storage, database: { source: 'db.json', schema: 'schema.json' } };
    const mismatches =
      storage === 'memory'
        ? [{ database: { source: 'db.json', schema } }, { database: { source: {}, schema: 'schema.json' } }, { auth: { source: 'auth.json' } }, { files: { source: 'uploads' } }]
        : [{ database: { source: {}, schema: 'schema.json' } }, { database: { source: 'db.json', schema } }, { auth: { source: [] } }, { files: { source: [] } }];
    for (const mismatch of mismatches) assert.throws(() => normalizeServerConfig({ ...base, ...mismatch }), /config\./);
  }
});

test('removed config keys and malformed section values are rejected before opening resources', async () => {
  for (const storage of [undefined, null, true, 'disk']) assert.throws(() => normalizeServerConfig({ ...memory, storage }), /storage/);
  for (const database of [{ data: {} }, { path: 'db.json' }, { source: {}, timestamps: true }, { source: {}, softDelete: false }])
    assert.throws(() => normalizeServerConfig({ ...memory, database }), /Неизвестный/);
  for (const extra of [
    { auth: { users: [] } },
    { files: { data: [] } },
    { files: { directory: 'uploads' } },
    { files: { source: [], metadata: 'files.json' } },
    { graphql: { enabled: true } },
    { graphql: { path: 'schema.graphql' } },
    { openapi: { enabled: false } },
    { openapi: { path: 'openapi.yaml' } },
  ])
    assert.throws(() => normalizeServerConfig({ ...memory, ...extra }), /Неизвестный/);
  for (const name of ['auth', 'files', 'graphql', 'openapi']) for (const value of [false, null, [], 'yes']) assert.throws(() => normalizeServerConfig({ ...memory, [name]: value }), /JSON-объект/);
  for (const name of ['graphql', 'openapi']) assert.throws(() => normalizeServerConfig({ ...memory, database: { source: {} }, [name]: {} }), /explicit/);
  await assert.rejects(() => createServer(memory, {}), /only a configuration/);
});

test('root schema settings are inherited and per-model values replace them, including false and empty api', async (t) => {
  const definition = {
    api: ['openapi'],
    timestamps: true,
    softDelete: true,
    models: { Item: item, Plain: { ...item, collection: 'plain', timestamps: false, softDelete: false, api: [] }, Graph: { ...item, collection: 'graphs', api: ['graphql'] } },
  };
  const model = await loadModel(definition);
  assert.equal(model.byName.get('Item').timestamps, true);
  assert.equal(model.byName.get('Plain').timestamps, false);
  assert.equal(model.byName.get('Plain').softDelete, false);
  assert.deepEqual(model.byName.get('Plain').api, []);
  const facade = await createServer({ ...memory, database: { source: { items: [{ id: '1' }], plain: [{ id: '2' }], graphs: [] }, schema: definition }, openapi: {}, graphql: {} });
  const app = facade.fastify();
  t.after(() => app.close());
  assert.equal((await app.inject('/plain/2')).statusCode, 200);
  const spec = await facade.openapi();
  assert.ok(spec.paths['/items']);
  assert.equal(spec.paths['/plain'], undefined);
  assert.equal(spec.paths['/graphs'], undefined);
  const graphql = await facade.graphql();
  assert.match(graphql, /graphList/);
  assert.doesNotMatch(graphql, /itemList|plainList/);
});

test('API defaults follow configured sections and direct generators without activating absent endpoints', async (t) => {
  for (const format of ['openapi', 'graphql']) {
    const facade = await createServer({ ...memory, [format]: {} });
    const app = facade.fastify();
    t.after(() => app.close());
    const other = format === 'openapi' ? 'graphql' : 'openapi';
    await assert.rejects(() => facade[other](), /not configured/);
    assert.equal((await app.inject(other === 'graphql' ? '/graphql' : '/openapi.json')).statusCode, 404);
  }
  assert.ok((await generateOpenapi(schema)).paths['/items']);
  assert.match(await generateGraphql(schema), /itemList/);
  assert.deepEqual((await generateOpenapi({ ...schema, api: [] })).paths, {});
  await assert.rejects(() => generateGraphql({ ...schema, api: [] }), /No models/);
  const facade = await createServer({ ...memory, database: { ...memory.database, schema: { ...schema, api: ['graphql'] } } });
  const app = facade.fastify();
  t.after(() => app.close());
  assert.equal((await app.inject('/graphql')).statusCode, 404);
  assert.equal((await app.inject('/items')).statusCode, 200);
});

test('schema rejects the old root layout and invalid global or entity overrides', async () => {
  await assert.rejects(() => loadModel(schema.models), /Неизвестный/);
  for (const models of [undefined, null, [], {}]) await assert.rejects(() => loadModel({ models }), /models/);
  for (const api of [null, true, false, 'graphql', ['rest'], ['graphql', 'graphql']]) {
    await assert.rejects(() => loadModel({ ...schema, api }), /api/);
    await assert.rejects(() => loadModel({ models: { Item: { ...item, api } } }), /api/);
  }
  for (const key of ['timestamps', 'softDelete']) {
    await assert.rejects(() => loadModel({ ...schema, [key]: 'yes' }), /boolean/);
    await assert.rejects(() => generateGraphql(schema, { [key]: true }), /Неизвестный/);
    await assert.rejects(() => generateOpenapi(schema, { [key]: true }), /Неизвестный/);
  }
  await assert.rejects(() => loadModel({ ...schema, typo: true }), /Неизвестный/);
});

test('public TypeScript types correlate all sources with the one storage discriminant', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-types-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.mts');
  const entry = resolve('dist/index.js');
  await writeFile(
    path,
    `import { createServer, type DeepJsonServerConfig, type ModelSchema } from ${JSON.stringify(entry)};
const schema: ModelSchema = { models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true } } } } };
const memory: DeepJsonServerConfig = { storage: 'memory', database: { source: {}, schema }, auth: { source: [] }, files: { source: [] }, graphql: {} };
const disk: DeepJsonServerConfig = { storage: 'file', database: { source: 'db.json', schema: 'schema.json' }, auth: { source: 'auth.json' }, files: { source: 'uploads' } };
// @ts-expect-error memory schema must be an object
const wrongSchema: DeepJsonServerConfig = { storage: 'memory', database: { source: {}, schema: 'schema.json' } };
// @ts-expect-error one storage mode covers auth
const wrongAuth: DeepJsonServerConfig = { storage: 'file', database: { source: 'db.json' }, auth: { source: [] } };
// @ts-expect-error one storage mode covers files
const wrongFiles: DeepJsonServerConfig = { storage: 'memory', database: { source: {} }, files: { source: 'uploads' } };
// @ts-expect-error file schema must be a path
const wrongFileSchema: DeepJsonServerConfig = { storage: 'file', database: { source: 'db.json', schema } };
// @ts-expect-error overrides were removed
createServer(memory, {});
// @ts-expect-error enabled was removed
const enabled: DeepJsonServerConfig = { ...memory, graphql: { enabled: true } };
void disk;
`,
  );
  await promisify(execFile)(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', path]);
});
