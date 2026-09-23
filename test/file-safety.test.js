import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../dist/index.js';
import { configure, readConfigModule } from '../dist/src/server/config.js';
import { createConfiguredServer } from '../dist/src/server/create.js';

const packageSource = { name: 'test-api', version: '1.0.0', description: 'Test API' };
const model = (fields = {}) => ({ models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, ...fields } } } });
const temporary = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

test('file uploads and moves preserve database, counters, schema and config inputs', async (t) => {
  const directory = await temporary(t);
  const sourcePath = join(directory, 'server.config.mjs');
  const config = {
    storage: 'file',
    database: { source: 'db.json', schema: 'model.json' },
    files: { source: '.', metadata: 'files.json' },
    package: { source: 'package.json' },
    server: { logger: false },
  };
  const contents = {
    'db.json': JSON.stringify({ items: [{ id: '1' }] }),
    'db.json.counters.json': '{}',
    'model.json': JSON.stringify(model()),
    'package.json': JSON.stringify(packageSource),
    'server.config.mjs': `export default ${JSON.stringify(config)};`,
  };
  for (const [name, content] of Object.entries(contents)) await writeFile(join(directory, name), content);
  const source = await readConfigModule(sourcePath);
  const facade = await createConfiguredServer(configure(source.config, source.directory, source.path));
  const app = facade.fastify();
  t.after(() => app.close());
  const upload = (name, content = 'new', extra = {}) =>
    app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-type': 'text/plain', 'content-name': name, 'content-override': 'true', ...extra }, payload: content });
  assert.equal((await upload('safe.txt')).statusCode, 201);
  for (const [name, content] of Object.entries(contents)) {
    assert.equal((await upload(name)).statusCode, 400, name);
    assert.equal((await app.inject({ method: 'PATCH', url: '/_files/storage/safe.txt', payload: { name } })).statusCode, 400, name);
    assert.equal(await readFile(join(directory, name), 'utf8'), content);
  }
  assert.equal((await app.inject('/items/1')).json().id, '1');
  const conflicting = (
    await createServer({ storage: 'file', database: { source: join(directory, 'db.json') }, files: { source: directory, metadata: join(directory, 'db.json') }, server: { logger: false } })
  ).fastify();
  try {
    await assert.rejects(() => conflicting.ready(), /protected/);
  } finally {
    await conflicting.close();
  }
  assert.equal(await readFile(join(directory, 'db.json'), 'utf8'), contents['db.json']);
  const alias = join(directory, 'storage-alias');
  await symlink(directory, alias);
  const aliased = (
    await createServer({ storage: 'file', database: { source: join(directory, 'db.json') }, files: { source: alias, metadata: join(directory, 'files.json') }, server: { logger: false } })
  ).fastify();
  t.after(() => aliased.close());
  const originalMetadata = await readFile(join(directory, 'files.json'), 'utf8');
  const response = await aliased.inject({
    method: 'POST',
    url: '/_files/storage',
    headers: { 'content-type': 'text/plain', 'content-name': 'files.json', 'content-override': 'true' },
    payload: 'replacement',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(await readFile(join(directory, 'files.json'), 'utf8'), originalMetadata);
});
