import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { generateGraphql, generateOpenapi } from '../dist/index.js';
import { runCli } from '../dist/src/cli/index.js';
import { createDatabaseStore } from '../dist/src/core/database.js';
import { Engine } from '../dist/src/core/engine.js';
import { loadModel } from '../dist/src/core/model.js';
import { createDiskFileStore } from '../dist/src/files/disk-store.js';
import { createMemoryFileStore } from '../dist/src/files/memory-store.js';
import { normalizeServerConfig } from '../dist/src/server/config.js';

const schema = { models: { Item: { collection: 'items', fields: { id: { type: 'number', primary: true, generated: 'increment' }, name: { type: 'string', required: true } } } } };
const temp = async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'deep-optimization-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

test('server config and generators apply the same option validation and defaults', async () => {
  const normalized = normalizeServerConfig({ storage: 'memory', database: { source: {} }, server: { maxPageSize: 5 } });
  assert.deepEqual(normalized.server, { cors: true, host: '127.0.0.1', logger: true, maxFileSize: 104857600, pageSize: 5, maxPageSize: 5, port: 4001 });
  assert.equal(normalized.openapi, undefined);
  assert.equal(normalized.graphql, undefined);
  for (const info of [[], {}, { title: 'API', version: '1', description: 42 }]) {
    assert.throws(() => normalizeServerConfig({ storage: 'memory', database: { source: {}, schema }, openapi: { info } }));
    await assert.rejects(() => generateOpenapi(schema, { info }));
  }
  for (const options of [{ host: '' }, { port: 65536 }, { pageSize: 0 }, { maxPageSize: Number.MAX_SAFE_INTEGER + 1 }, { pageSize: 11, maxPageSize: 10 }]) {
    assert.throws(() => normalizeServerConfig({ storage: 'memory', database: { source: {} }, server: options }));
    await assert.rejects(() => generateOpenapi(schema, options));
  }
  const info = { title: 'API', version: '1', description: 'Описание', 'x-meta': { owner: 'one' } };
  const config = normalizeServerConfig({ storage: 'memory', database: { source: {}, schema }, openapi: { info } });
  const document = await generateOpenapi(schema, { info, maxPageSize: 5, host: '::1', port: 0 });
  info['x-meta'].owner = 'changed';
  assert.deepEqual(config.openapi.info, document.info);
  assert.equal(document.info['x-meta'].owner, 'one');
  assert.equal(document.servers[0].url, '/');
  assert.equal(document.components.schemas.Pager.properties.pageSize.default, normalized.server.pageSize);
});

test('combined CLI export reads one model and validates both formats before writing', async (t) => {
  const directory = await temp(t);
  const schemaPath = join(directory, 'model.json');
  const configPath = join(directory, 'config.mjs');
  const config = { storage: 'file', database: { source: 'missing-db.json', schema: schemaPath }, openapi: { path: 'api.yaml' }, graphql: { path: 'api.graphql' } };
  await fs.writeFile(schemaPath, JSON.stringify({ ...schema, timestamps: true, softDelete: true }));
  await fs.writeFile(configPath, `export default ${JSON.stringify(config)};`);
  const readFile = fs.readFile;
  let reads = 0;
  fs.readFile = (...args) => {
    if (args[0] === schemaPath) reads++;
    return readFile(...args);
  };
  syncBuiltinESMExports();
  try {
    await runCli(['--generate-only', configPath]);
    assert.equal(reads, 1);
  } finally {
    fs.readFile = readFile;
    syncBuiltinESMExports();
  }
  const originalYaml = await fs.readFile(join(directory, 'api.yaml'), 'utf8');
  const originalGraphql = await fs.readFile(join(directory, 'api.graphql'), 'utf8');
  assert.equal(originalGraphql, `${await generateGraphql({ ...schema, timestamps: true, softDelete: true })}\n`);
  await fs.writeFile(schemaPath, JSON.stringify({ models: { Item: { ...schema.models.Item, api: ['openapi'] } } }));
  await assert.rejects(() => runCli(['--generate-only', configPath]), /graphql/);
  assert.equal(await fs.readFile(join(directory, 'api.yaml'), 'utf8'), originalYaml);
  assert.equal(await fs.readFile(join(directory, 'api.graphql'), 'utf8'), originalGraphql);
  config.openapi.info = { title: 'API', version: '1', description: 42 };
  await fs.writeFile(configPath, `export default ${JSON.stringify(config)};`);
  await assert.rejects(() => runCli(['--generate-only', configPath]), /OpenAPI info/);
});

for (const softDelete of [false, true]) {
  test(`mutations preserve previous snapshots and rollback with one database copy (softDelete=${softDelete})`, async (t) => {
    const model = await loadModel({ ...schema, timestamps: true, softDelete });
    const store = await createDatabaseStore({ source: { items: [{ id: 1, name: 'one' }] } });
    const engine = new Engine(store, model);
    const entity = model.byName.get('Item');
    const copy = structuredClone;
    let copies = 0;
    const mock = t.mock.method(globalThis, 'structuredClone', (value, ...args) => {
      if (Array.isArray(value?.items) || Array.isArray(value?.data?.items)) copies++;
      return copy(value, ...args);
    });
    try {
      for (const mode of ['update', 'delete', ...(softDelete ? ['delete', 'replace'] : [])]) {
        const before = await store.read();
        const expected = copy(before);
        copies = 0;
        const result = await engine.mutate(entity, mode, 1, { name: 'updated' });
        assert.equal(copies, 1, mode);
        assert.deepEqual(before, expected, mode);
        assert.notEqual(await store.read(), before);
        assert.equal(result.value.name, 'updated');
      }
      const before = await store.read();
      const expected = copy(before);
      copies = 0;
      await assert.rejects(
        () =>
          engine.mutate(entity, 'create', undefined, { name: 'rollback' }, () => {
            throw new Error('projection failed');
          }),
        /projection failed/,
      );
      assert.equal(copies, 1);
      assert.equal(await store.read(), before);
      assert.deepEqual(before, expected);
    } finally {
      mock.mock.restore();
    }
  });
}

test('cascade follows reversed chains and cycles, checks restrict after closure and rolls back conflicts', async () => {
  const model = await loadModel({
    models: {
      Item: { ...schema.models.Item, fields: { ...schema.models.Item.fields, parent: { type: 'Item', source: 'parentId', onDelete: 'cascade' }, guard: { type: 'Item', source: 'guardId' } } },
    },
  });
  const items = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: 'chain', parentId: i + 2 }));
  items[199].parentId = 1;
  items[0].guardId = 200;
  items.push({ id: 201, name: 'blocker', guardId: 200 });
  const store = await createDatabaseStore({ source: { items } });
  const engine = new Engine(store, model);
  const entity = model.byName.get('Item');
  const before = await store.read();
  await assert.rejects(() => engine.mutate(entity, 'delete', 200), /restricted by guard/);
  assert.equal(await store.read(), before);
  assert.deepEqual(before.items, items);
  await engine.mutate(entity, 'delete', 201);
  await engine.mutate(entity, 'delete', 200);
  assert.deepEqual((await store.read()).items, []);
});

test('list sorting preserves nulls, numeric strings, stable ties and original order', async () => {
  const model = await loadModel({
    models: { Item: { ...schema.models.Item, fields: { ...schema.models.Item.fields, rank: { type: 'number' }, profile: { type: 'object' }, 'profile.code': { type: 'string', nullable: true } } } },
  });
  const items = [
    { id: 1, name: 'a', rank: 2, profile: { code: 'item10' } },
    { id: 2, name: 'b', rank: 2, profile: { code: null } },
    { id: 3, name: 'c', rank: 1, profile: { code: 'item2' } },
    { id: 4, name: 'd', rank: 2, profile: { code: 'ITEM2' } },
    { id: 5, name: 'e', rank: 2, profile: { code: 'item2' } },
    { id: 6, name: 'f', rank: 2 },
  ];
  const store = await createDatabaseStore({ source: { items } });
  const engine = new Engine(store, model);
  const entity = model.byName.get('Item');
  const records = engine.records(await engine.context(), entity);
  Object.freeze(records);
  const ids = (page) => page.data.map((ref) => ref.value.id);
  const order = [
    { field: 'profile.code', direction: 'ASC' },
    { field: 'rank', direction: 'DESC' },
  ];
  assert.deepEqual(ids(engine.list(records, entity.root, { order })), [4, 5, 3, 1, 2, 6]);
  assert.deepEqual(ids(engine.list(records, entity.root, { order: [{ field: 'profile.code', direction: 'DESC' }] })), [2, 6, 1, 3, 4, 5]);
  assert.deepEqual(ids(engine.list(records, entity.root, { pager: { page: 2, pageSize: 2 } })), [3, 4]);
  const filtered = engine.list(records, entity.root, { where: { rank: { eq: 2 } }, pager: { page: 2, pageSize: 2 } });
  assert.deepEqual(ids(filtered), [4, 5]);
  assert.equal(filtered.total, 5);
  const empty = engine.list(records, entity.root, { order, pager: { page: 10, pageSize: 2 } });
  assert.deepEqual(ids(empty), []);
  assert.equal(empty.total, 6);
  assert.deepEqual((await store.read()).items, items);
});

for (const storage of ['memory', 'disk']) {
  test(`${storage} files return independent metadata and preserve content after failed streaming uploads`, async (t) => {
    const directory = await temp(t);
    const store = storage === 'memory' ? createMemoryFileStore([]) : await createDiskFileStore({ directory, metadata: join(directory, 'metadata.json') });
    const options = { directory: '', name: 'file.txt', mimeType: 'text/plain', maxFileSize: 3, override: false };
    const uploaded = await store.upload({ ...options, stream: Readable.from(['a', 'bc']) });
    const expected = { directory: '', name: 'file.txt', mimeType: 'text/plain', size: 3 };
    uploaded.file.name = 'changed';
    const metadata = await store.metadata('file.txt');
    metadata.mimeType = 'changed';
    const reading = await store.get('file.txt');
    reading.file.directory = 'changed';
    const chunks = [];
    for await (const chunk of reading.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'abc');
    for (const chunk of chunks) chunk.fill(0);
    assert.deepEqual(await store.metadata('file.txt'), expected);
    const updated = await store.update('file.txt', { name: 'renamed.txt' });
    updated.name = 'changed';
    const again = await store.get('renamed.txt');
    assert.equal(await again.stream.toArray().then((parts) => Buffer.concat(parts).toString()), 'abc');
    assert.deepEqual(again.file, { ...expected, name: 'renamed.txt' });
    const overwrite = { ...options, name: 'renamed.txt', override: true };
    await assert.rejects(() => store.upload({ ...overwrite, stream: Readable.from(['ab', 'cd']) }), { code: 'PAYLOAD_TOO_LARGE' });
    const broken = Readable.from(
      (async function* () {
        yield Buffer.from('a');
        throw new Error('stream failed');
      })(),
    );
    await assert.rejects(() => store.upload({ ...overwrite, stream: broken }), /stream failed/);
    const preserved = await store.get('renamed.txt');
    assert.equal(await preserved.stream.toArray().then((parts) => Buffer.concat(parts).toString()), 'abc');
    const empty = await store.upload({ ...options, name: 'empty.txt', stream: Readable.from([]) });
    assert.equal(empty.file.size, 0);
    await store.remove('renamed.txt');
    await assert.rejects(() => store.metadata('renamed.txt'), { code: 'NOT_FOUND' });
  });
}
