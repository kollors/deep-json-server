import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { runCli } from '../src/cli.js';
import { generateOpenApi } from '../src/openapi/index.js';

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
    server: { host: 'localhost', port: 5000 },
  };

  await writeFile(databasePath, JSON.stringify({ items: [{ id: '1', name: 'One' }] }));
  await writeFile(schemaPath, JSON.stringify({ $info: { title: 'Test API', version: '1.0.0' } }));
  await writeFile(configPath, `export default ${JSON.stringify(config)};`);

  return { config, configPath, databasePath, directoryPath, filesDirectoryPath, filesMetadataPath, openapiPath, schemaPath };
};

test('starts from config and enables files only with --files', async () => {
  const fixture = await createFixture();
  const calls = [];
  const services = { generateOpenApi, startServer: async (options) => calls.push(options) };

  try {
    await runCli([fixture.configPath], services);
    await runCli(['--files', fixture.configPath], services);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      databasePath: fixture.databasePath,
      filesDirectoryPath: undefined,
      filesMetadataPath: undefined,
      host: 'localhost',
      port: 5000,
      schemaPath: fixture.schemaPath,
    });
    assert.deepEqual(calls[1], {
      databasePath: fixture.databasePath,
      filesDirectoryPath: fixture.filesDirectoryPath,
      filesMetadataPath: fixture.filesMetadataPath,
      host: 'localhost',
      port: 5000,
      schemaPath: fixture.schemaPath,
    });
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('generates OpenAPI from config and includes files only with --files', async () => {
  const fixture = await createFixture();
  const services = { generateOpenApi, startServer: async () => assert.fail('Сервер не должен запускаться в режиме --openapi') };

  try {
    await runCli(['--openapi', '--files', fixture.configPath], services);

    const document = parse(await readFile(fixture.openapiPath, 'utf8'));

    assert.equal(document.openapi, '3.0.3');
    assert.equal(document.servers[0].url, 'http://localhost:5000');
    assert.equal(document.paths['/_files'].post.operationId, 'uploadFile');

    await runCli(['--openapi', fixture.configPath], services);

    const documentWithoutFiles = parse(await readFile(fixture.openapiPath, 'utf8'));

    assert.equal(documentWithoutFiles.paths['/_files'], undefined);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('loads computed values and environment variables from the config module', async () => {
  const fixture = await createFixture();
  const calls = [];
  const services = { generateOpenApi, startServer: async (options) => calls.push(options) };

  try {
    await writeFile(fixture.configPath, `export default { database: { path: 'database.json' }, server: { host: process.env.DEEP_JSON_SERVER_TEST_HOST, port: 2_000 + 1 } };`);
    process.env.DEEP_JSON_SERVER_TEST_HOST = '0.0.0.0';

    await runCli([fixture.configPath], services);

    assert.equal(calls[0].host, '0.0.0.0');
    assert.equal(calls[0].port, 2001);
  } finally {
    delete process.env.DEEP_JSON_SERVER_TEST_HOST;
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('validates CLI arguments and conditional config keys', async () => {
  const fixture = await createFixture();
  const services = { generateOpenApi, startServer: async () => undefined };
  const writeConfig = (config) => writeFile(fixture.configPath, `export default ${JSON.stringify(config)};`);

  try {
    await assert.rejects(() => runCli([], services), /файлу конфигурации/);
    await assert.rejects(() => runCli(['--unknown', fixture.configPath], services), /Неизвестный параметр/);
    await assert.rejects(() => runCli([fixture.configPath, 'other.js'], services), /только один/);

    await writeConfig({});
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.database\.path/);

    await writeConfig({ database: { path: 'database.json' } });
    await assert.rejects(() => runCli(['--openapi', fixture.configPath], services), /config\.openapi\.path/);
    await assert.rejects(() => runCli(['--files', fixture.configPath], services), /config\.files\.directory/);

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

    await writeFile(fixture.configPath, 'export default {');
    await assert.rejects(() => runCli([fixture.configPath], services), /Не удалось загрузить конфигурацию/);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});
