import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { runCli } from '../src/cli.js';

const createFixture = async () => {
  const directoryPath = await mkdtemp(join(tmpdir(), 'deep-json-server-cli-'));
  const configPath = join(directoryPath, 'server.config.js');
  const databasePath = join(directoryPath, 'database.json');
  const schemaPath = join(directoryPath, 'database-schema.json');
  const openapiPath = join(directoryPath, 'openapi-schema.yaml');
  const filesDirectoryPath = join(directoryPath, 'files');
  const filesMetadataPath = join(filesDirectoryPath, '_database.json');
  const config = {
    database: { path: 'database.json', schema: 'database-schema.json' },
    files: { directory: 'files', metadata: 'files/_database.json' },
    openapi: { path: 'openapi-schema.yaml' },
    server: { host: 'localhost', logger: false, maxFileSize: 2048, maxPageSize: 250, port: 5000 },
  };

  await writeFile(databasePath, JSON.stringify({ items: [{ id: '1', name: 'One' }] }));
  await writeFile(schemaPath, JSON.stringify({ $info: { title: 'Test API', version: '1.0.0' } }));
  await writeFile(configPath, `export default ${JSON.stringify(config)};`);

  return { config, configPath, databasePath, directoryPath, filesDirectoryPath, filesMetadataPath, openapiPath, schemaPath };
};

const createServices = (calls) => ({
  createServer: async (config, features) => {
    const call = { config, fastifyCalls: 0, features, listenOptions: undefined, openapiCalls: 0 };

    calls.push(call);

    return {
      fastify: () => {
        call.fastifyCalls += 1;

        return {
          listen: async (options) => {
            call.listenOptions = options;
          },
          log: { info: () => undefined },
        };
      },
      openapi: async () => {
        call.openapiCalls += 1;
        return {};
      },
    };
  },
});

test('starts from config and enables files only with --files', async () => {
  const fixture = await createFixture();
  const calls = [];
  const services = createServices(calls);

  try {
    await runCli([fixture.configPath], services);
    await runCli(['--files', fixture.configPath], services);

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map(({ features }) => features),
      [{ files: false }, { files: true }],
    );
    assert.deepEqual(calls[0].config.database, { path: fixture.databasePath, schema: fixture.schemaPath });
    assert.deepEqual(calls[0].config.server, fixture.config.server);
    assert.equal(calls[0].fastifyCalls, 1);
    assert.equal(calls[0].listenOptions, undefined);
    assert.equal(calls[1].config.files.directory, fixture.filesDirectoryPath);
    assert.equal(calls[1].config.files.metadata, fixture.filesMetadataPath);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('supports generate-and-run and generate-only OpenAPI modes', async () => {
  const fixture = await createFixture();
  const calls = [];
  const services = createServices(calls);

  try {
    await runCli(['--openapi', fixture.configPath], services);
    await runCli(['--openapi-only', fixture.configPath], services);

    assert.equal(calls[0].openapiCalls, 1);
    assert.equal(calls[0].fastifyCalls, 1);
    assert.equal(calls[1].openapiCalls, 1);
    assert.equal(calls[1].fastifyCalls, 0);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('generates OpenAPI from config and includes files only with --files', async () => {
  const fixture = await createFixture();

  try {
    await runCli(['--openapi-only', '--files', fixture.configPath]);

    const document = parse(await readFile(fixture.openapiPath, 'utf8'));

    assert.equal(document.openapi, '3.0.3');
    assert.equal(document.components.parameters.PerPage.schema.maximum, 250);
    assert.equal(document.servers[0].url, 'http://localhost:5000');
    assert.equal(document.paths['/_files/storage'].post.operationId, 'uploadFile');

    await runCli(['--openapi-only', fixture.configPath]);

    const documentWithoutFiles = parse(await readFile(fixture.openapiPath, 'utf8'));

    assert.equal(documentWithoutFiles.paths['/_files/storage'], undefined);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('loads computed values, environment variables and in-memory data from config', async () => {
  const fixture = await createFixture();
  const calls = [];
  const services = createServices(calls);

  try {
    await writeFile(
      fixture.configPath,
      `export default { database: { data: { items: [{ id: '1' }] }, schema: { $info: { title: 'Memory API', version: '1.0.0' } } }, server: { host: process.env.DEEP_JSON_SERVER_TEST_HOST, port: 2_000 + 1 } };`,
    );
    process.env.DEEP_JSON_SERVER_TEST_HOST = '0.0.0.0';

    await runCli([fixture.configPath], services);

    assert.equal(calls[0].config.server.host, '0.0.0.0');
    assert.equal(calls[0].config.server.port, 2001);
    assert.deepEqual(calls[0].config.database.data, { items: [{ id: '1' }] });
  } finally {
    delete process.env.DEEP_JSON_SERVER_TEST_HOST;
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('validates CLI arguments and conditional config keys', async () => {
  const fixture = await createFixture();
  const services = createServices([]);
  const writeConfig = (config) => writeFile(fixture.configPath, `export default ${JSON.stringify(config)};`);

  try {
    await assert.rejects(() => runCli([], services), /файлу конфигурации/);
    await assert.rejects(() => runCli(['--unknown', fixture.configPath], services), /Неизвестный параметр/);
    await assert.rejects(() => runCli([fixture.configPath, 'other.js'], services), /только один/);
    await assert.rejects(() => runCli(['--openapi', '--openapi-only', fixture.configPath], services), /нельзя использовать одновременно/);

    await writeConfig({});
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.database/);

    await writeConfig({ database: { path: 'database.json' } });
    await assert.rejects(() => runCli(['--openapi', fixture.configPath], services), /config\.openapi\.path/);
    await assert.rejects(() => runCli(['--openapi-only', fixture.configPath], services), /config\.openapi\.path/);
    await assert.rejects(() => runCli(['--files', fixture.configPath], services), /config\.files/);

    await writeConfig({ database: { data: {}, path: 'database.json' } });
    await assert.rejects(() => runCli([fixture.configPath], services), /ровно один/);

    await writeConfig({ database: { path: 'database.json' }, files: { directory: 'files' } });
    await assert.rejects(() => runCli(['--files', fixture.configPath], services), /config\.files\.metadata/);

    await writeConfig({ database: { path: 'database.json' }, unknown: true });
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.unknown/);

    await writeConfig({ database: { path: 'database.json', unknown: true } });
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.database\.unknown/);

    await writeConfig({ database: 'database.json' });
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.database.*JSON-объект/);

    await writeConfig({ database: { path: 'database.json' }, server: { port: '5000' } });
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.server\.port/);

    await writeConfig({ database: { path: 'database.json' }, server: { maxPageSize: 0 } });
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.server\.maxPageSize/);

    await writeConfig({ database: { path: 'database.json' }, server: { maxFileSize: 0 } });
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.server\.maxFileSize/);

    await writeConfig({ database: { path: 'database.json' }, server: { logger: 'false' } });
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.server\.logger/);

    await writeFile(fixture.configPath, 'export default {');
    await assert.rejects(() => runCli([fixture.configPath], services), /Не удалось загрузить конфигурацию/);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});
