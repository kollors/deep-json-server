import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../dist/src/cli/index.js';

const model = (fields = {}) => ({ models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, ...fields } } } });
const temporary = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

test('generation reads only the schema and rejects colliding destinations before writes', async (t) => {
  const directory = await temporary(t);
  const source = join(directory, 'config.mjs');
  const schemaPath = join(directory, 'model.json');
  await writeFile(schemaPath, JSON.stringify(model()));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'fixture-api', version: '1.2.3', description: 'Fixture API' }));
  const config = {
    storage: 'file',
    database: { source: 'missing-db.json', schema: 'model.json' },
    openapi: { target: 'api.yaml' },
    graphql: { target: 'api.graphql' },
    package: { source: 'package.json' },
  };
  const run = async (value) => {
    await writeFile(source, `export default ${JSON.stringify(value)};`);
    return runCli(['--generate-only', source]);
  };
  await run(config);
  assert.match(await readFile(join(directory, 'api.graphql'), 'utf8'), /itemList/);
  await assert.rejects(() => run({ ...config, openapi: undefined, files: 'invalid' }), /config.files/);
  const original = await readFile(join(directory, 'api.yaml'), 'utf8');
  await assert.rejects(() => run({ ...config, graphql: { target: 'api.yaml' } }), /different/);
  assert.equal(await readFile(join(directory, 'api.yaml'), 'utf8'), original);
  await assert.rejects(() => run({ ...config, openapi: { target: 'model.json' } }), /overwrite/);
  await symlink(schemaPath, join(directory, 'alias.yaml'));
  await assert.rejects(() => run({ ...config, openapi: { target: 'alias.yaml' } }), /overwrite/);
  await link(schemaPath, join(directory, 'hardlink.yaml'));
  await assert.rejects(() => run({ ...config, openapi: { target: 'hardlink.yaml' } }), /overwrite/);
  assert.deepEqual(JSON.parse(await readFile(schemaPath, 'utf8')), model());
});
