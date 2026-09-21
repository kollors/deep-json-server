import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { runCli } from '../dist/src/cli/index.js';

const schema = { models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true } } } } };
const fixture = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.mjs');
  await writeFile(join(directory, 'schema.json'), JSON.stringify(schema));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'cli-fixture', version: '1.0.0', description: 'CLI fixture' }));
  const config = {
    storage: 'file',
    database: { source: 'missing-db.json', schema: 'schema.json' },
    auth: { source: 'missing-users.json' },
    files: { source: 'missing-uploads' },
    openapi: { target: 'openapi.yaml' },
    graphql: { target: 'schema.graphql' },
    package: { source: 'package.json' },
    server: { host: 'localhost', port: 5000, logger: false, maxPageSize: 250 },
  };
  const save = (value = config) => writeFile(path, `export default ${JSON.stringify(value)};`);
  await save();
  return { directory, path, config, save };
};
const services = (calls, onStart = () => {}) => ({
  async createServer(...args) {
    assert.equal(args.length, 2);
    calls.push(args[0]);
    return { fastify: () => ({ listen: onStart, log: { info() {} } }) };
  },
});

test('CLI starts from section presence and applies address precedence without exporting files', async (t) => {
  const f = await fixture(t);
  const calls = [];
  await runCli([f.path], services(calls));
  assert.equal(calls[0].storage, 'file');
  assert.equal(calls[0].database.source, join(f.directory, 'missing-db.json'));
  assert.equal(calls[0].files.metadata, join(f.directory, 'missing-uploads', '.files.json'));
  assert.equal(calls[0].graphql.endpoint, '/graphql');
  await assert.rejects(() => readFile(join(f.directory, 'openapi.yaml')), { code: 'ENOENT' });
  await runCli(['--host', '127.0.0.2', f.path, '--port', '0'], services(calls));
  assert.equal(calls[1].server.host, '127.0.0.2');
  assert.equal(calls[1].server.port, 0);
});

test('generate-only exports configured formats without opening data, auth or files', async (t) => {
  const f = await fixture(t);
  const calls = [];
  await runCli(['--generate-only', f.path], services(calls));
  assert.equal(calls.length, 0);
  const document = parse(await readFile(join(f.directory, 'openapi.yaml'), 'utf8'));
  assert.ok(document.paths['/auth/register']);
  assert.ok(document.paths['/_files/storage']);
  assert.equal(document.components.schemas.Pager.properties.pageSize.maximum, 250);
  assert.match(await readFile(join(f.directory, 'schema.graphql'), 'utf8'), /itemList/);
  await assert.rejects(() => readFile(join(f.directory, 'missing-users.json')), { code: 'ENOENT' });
  delete f.config.openapi;
  await f.save();
  await rm(join(f.directory, 'openapi.yaml'));
  await runCli([f.path, '--generate-only']);
  await assert.rejects(() => readFile(join(f.directory, 'openapi.yaml')), { code: 'ENOENT' });
});

test('generate exports before starting and never starts after a generation error', async (t) => {
  const f = await fixture(t);
  const calls = [];
  await runCli(
    ['--generate', f.path],
    services(calls, async () => {
      assert.match(await readFile(join(f.directory, 'schema.graphql'), 'utf8'), /itemList/);
      assert.ok(parse(await readFile(join(f.directory, 'openapi.yaml'), 'utf8')).paths['/items']);
    }),
  );
  assert.equal(calls.length, 1);
  await rm(join(f.directory, 'openapi.yaml'));
  await writeFile(join(f.directory, 'schema.json'), JSON.stringify({ models: { Item: { ...schema.models.Item, api: ['openapi'] } } }));
  await assert.rejects(() => runCli(['--generate', f.path], services(calls)), /No models enable graphql/);
  assert.equal(calls.length, 1);
  await assert.rejects(() => readFile(join(f.directory, 'openapi.yaml')), { code: 'ENOENT' });
});

test('CLI rejects removed commands, flags, repetitions and ambiguous modes', async (t) => {
  const f = await fixture(t);
  for (const flag of ['--files', '--auth', '--graphql', '--openapi', '--timestamps', '--soft-delete', '--unknown']) {
    await assert.rejects(() => runCli([flag, f.path]), /Неизвестный/);
  }
  for (const args of [
    ['--generate', '--generate'],
    ['--generate-only', '--generate-only'],
    ['--host', 'a', '--host', 'b'],
  ])
    await assert.rejects(() => runCli([...args, f.path]), /повтор/);
  await assert.rejects(() => runCli(['--generate', '--generate-only', f.path]), /mutually exclusive/);
  await assert.rejects(() => runCli(['generate', 'openapi', f.path]), /только один/);
  await assert.rejects(() => runCli([]), /файлу конфигурации/);
  for (const flag of ['--host', '--port']) await assert.rejects(() => runCli([f.path, flag]), /Укажите значение/);
  for (const port of ['abc', '2.2', '65536']) await assert.rejects(() => runCli([f.path, '--port', port]), /port/);
  await runCli(['--help']);
  await runCli(['-h']);
  await runCli(['--version']);
  await runCli(['-v']);
});

test('CLI validates all export destinations and requires configured formats', async (t) => {
  const f = await fixture(t);
  delete f.config.graphql.target;
  await f.save();
  await assert.rejects(() => runCli([f.path, '--generate-only']), /config.graphql.target/);
  await assert.rejects(() => readFile(join(f.directory, 'openapi.yaml')), { code: 'ENOENT' });
  delete f.config.graphql;
  delete f.config.openapi;
  await f.save();
  await assert.rejects(() => runCli([f.path, '--generate-only']), /section/);
  f.config.openapi = {};
  await f.save();
  await assert.rejects(() => runCli([f.path, '--generate-only']), /config.openapi.target/);
  f.config.openapi.target = 'schema.json';
  await f.save();
  await assert.rejects(() => runCli([f.path, '--generate-only']), /overwrite/);
});

test('CLI loads fresh ES module configuration and uses environment address defaults', async (t) => {
  const f = await fixture(t);
  const before = { HOST: process.env.HOST, PORT: process.env.PORT };
  t.after(() => {
    for (const key of ['HOST', 'PORT'])
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
  });
  process.env.HOST = '0.0.0.0';
  process.env.PORT = '4012';
  await f.save({ storage: 'memory', database: { source: { items: [] } } });
  const calls = [];
  await runCli([f.path], services(calls));
  assert.equal(calls[0].server.host, '0.0.0.0');
  assert.equal(calls[0].server.port, 4012);
  await f.save({ storage: 'memory', database: { source: { items: [] } }, server: { host: 'localhost', port: 5000 } });
  await runCli([f.path], services(calls));
  assert.equal(calls[1].server.port, 5000);
  await writeFile(f.path, 'export default [];');
  await assert.rejects(() => runCli([f.path]), /JSON-объект/);
  await writeFile(f.path, 'throw new Error("broken config");');
  await assert.rejects(() => runCli([f.path]), /broken config/);
});
