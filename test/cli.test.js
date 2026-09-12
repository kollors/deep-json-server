import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { runCli } from '../dist/src/cli.js';

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
    server: { cors: false, host: 'localhost', logger: false, maxFileSize: 2048, maxPageSize: 250, port: 5000 },
  };

  await writeFile(databasePath, JSON.stringify({ items: [{ id: '1', name: 'One' }] }));
  await writeFile(schemaPath, JSON.stringify({ Item: { collection: 'items', fields: { id: { type: 'string', primary: true }, name: { type: 'string' } } } }));
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
      graphql: async () => {
        call.graphqlCalls = (call.graphqlCalls ?? 0) + 1;
        return 'type Query { item: String }';
      },
      openapi: async () => {
        call.openapiCalls += 1;
        return {};
      },
    };
  },
});

test('starts from config with consistent feature defaults', async () => {
  const fixture = await createFixture();
  const calls = [];
  const services = createServices(calls);

  try {
    await runCli([fixture.configPath], services);
    await runCli(['--files', fixture.configPath], services);

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map(({ features }) => features),
      [
        { auth: false, files: true, graphql: false, openapi: false },
        { auth: false, files: true, graphql: false, openapi: false },
      ],
    );
    assert.deepEqual(calls[0].config.database, { path: fixture.databasePath, schema: fixture.schemaPath });
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].config.server)), fixture.config.server);
    assert.equal(calls[0].fastifyCalls, 1);
    assert.equal(calls[0].listenOptions, undefined);
    assert.equal(calls[1].config.files.directory, fixture.filesDirectoryPath);
    assert.equal(calls[1].config.files.metadata, fixture.filesMetadataPath);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('endpoint flags start the server and generation writes files independently', async () => {
  const fixture = await createFixture();
  const calls = [];
  try {
    await runCli(['--openapi', '--graphql', '--host', '127.0.0.2', '--port', '4010', fixture.configPath], createServices(calls));
    assert.deepEqual(calls[0].features, { auth: false, files: true, graphql: true, openapi: true });
    assert.equal(calls[0].openapiCalls, 0);
    assert.equal(calls[0].config.server.host, '127.0.0.2');
    assert.equal(calls[0].config.server.port, 4010);
    await rm(fixture.databasePath);
    await runCli(['generate', 'openapi', fixture.configPath]);
    const document = parse(await readFile(fixture.openapiPath, 'utf8'));
    assert.equal(document.components.schemas.Pager.properties.pageSize.maximum, 250);
    assert.equal(document.servers[0].url, 'http://localhost:5000');
    assert.equal(document.paths['/_files/storage'].post.operationId, 'uploadFile');
    delete fixture.config.files;
    await writeFile(fixture.configPath, `export default ${JSON.stringify(fixture.config)};`);
    await runCli(['generate', 'openapi', fixture.configPath]);
    assert.equal(parse(await readFile(fixture.openapiPath, 'utf8')).paths['/_files/storage'], undefined);
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
      `export default { database: { data: { items: [{ id: '1' }] }, schema: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true } } } } }, server: { host: process.env.DEEP_JSON_SERVER_TEST_HOST, port: 2_000 + 1 } };`,
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
    await assert.rejects(() => runCli(['--openapi', '--openapi-only', fixture.configPath], services), /Неизвестный параметр/);

    await writeConfig({});
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.database/);

    await writeConfig({ database: { path: 'database.json', schema: 'database-schema.json' } });
    await assert.rejects(() => runCli(['generate', 'openapi', fixture.configPath], services), /config\.openapi\.path/);
    await assert.rejects(() => runCli(['generate', 'graphql', fixture.configPath], services), /config\.graphql\.path/);
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

    await writeConfig({ database: { path: 'database.json' }, server: { cors: 'true' } });
    await assert.rejects(() => runCli([fixture.configPath], services), /config\.server\.cors/);

    await writeFile(fixture.configPath, 'export default {');
    await assert.rejects(() => runCli([fixture.configPath], services), /Не удалось загрузить конфигурацию/);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('exports GraphQL separately or together and validates command arguments', async () => {
  const fixture = await createFixture();
  try {
    fixture.config.graphql = { path: 'schema.graphql' };
    await writeFile(fixture.configPath, `export default ${JSON.stringify(fixture.config)};`);
    await runCli(['generate', 'graphql', fixture.configPath]);
    assert.match(await readFile(join(fixture.directoryPath, 'schema.graphql'), 'utf8'), /itemList/);
    await runCli(['generate', 'openapi,graphql', fixture.configPath]);
    for (const args of [
      ['generate', 'xml', fixture.configPath],
      ['generate', 'openapi,openapi', fixture.configPath],
      ['generate', 'openapi', '--graphql', fixture.configPath],
      ['--port', 'bad', fixture.configPath],
      ['--host'],
      ['--port', '70000', fixture.configPath],
      ['--graphql', '--graphql', fixture.configPath],
    ])
      await assert.rejects(() => runCli(args));
    delete fixture.config.database.schema;
    await writeFile(fixture.configPath, `export default ${JSON.stringify(fixture.config)};`);
    await assert.rejects(() => runCli(['generate', 'openapi', fixture.configPath]), /explicit/);
    await runCli(['--help']);
    await runCli(['-h']);
    await runCli(['--version']);
    await runCli(['-v']);
  } finally {
    await rm(fixture.directoryPath, { force: true, recursive: true });
  }
});

test('publication channels never send prereleases to latest', async () => {
  const { publicationTag } = await import('../scripts/publish-package.js');
  assert.equal(publicationTag('1.0.0-alpha.1'), 'alpha');
  assert.equal(publicationTag('1.0.0-beta.2'), 'beta');
  assert.equal(publicationTag('1.0.0-rc.1'), 'rc');
  assert.equal(publicationTag('1.0.0'), 'latest');
  assert.throws(() => publicationTag('1.0.0-preview.1'));
});

test('automatic alpha publication requires main and an unused version tag', async () => {
  const { releasePlan } = await import('../scripts/prepare-release.js');
  assert.deepEqual(releasePlan('1.0.0-alpha.1', 'branch', 'main'), { publish: true, createTag: true, tag: 'v1.0.0-alpha.1' });
  assert.equal(releasePlan('1.0.0-alpha.1', 'branch', 'main', true).publish, false);
  assert.deepEqual(releasePlan('1.0.0-alpha.1', 'branch', 'main', true, false), { publish: true, createTag: false, tag: 'v1.0.0-alpha.1' });
  assert.equal(releasePlan('1.0.0-alpha.1', 'branch', 'feature').publish, false);
  assert.equal(releasePlan('1.0.0', 'branch', 'main').publish, false);
  assert.deepEqual(releasePlan('1.0.0', 'tag', 'v1.0.0'), { publish: true, createTag: false, tag: 'v1.0.0' });
  assert.throws(() => releasePlan('1.0.0', 'tag', 'v0.9.0'));
});
