import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'deep-json-server-package-'));

try {
  const { stdout } = await execute('npm', ['pack', '--json', '--pack-destination', temporaryDirectory], { cwd: new URL('..', import.meta.url) });
  const [packageInfo] = JSON.parse(stdout);
  const paths = packageInfo.files.map(({ path }) => path);
  const archivePath = join(temporaryDirectory, packageInfo.filename);
  assert(paths.includes('dist/index.js'));
  assert(paths.includes('dist/index.d.ts'));
  assert(paths.includes('dist/bin/deep-json-server.js'));
  assert(paths.includes('CHANGELOG.md'));
  assert(paths.includes('MIGRATION.md'));
  assert(paths.includes('examples/database.json'));
  assert(paths.every((path) => !path.startsWith('src/') && !path.startsWith('types/')));

  await writeFile(join(temporaryDirectory, 'package.json'), JSON.stringify({ name: 'deep-json-server-package-check', private: true, type: 'module', version: '1.0.0' }));
  await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archivePath], { cwd: temporaryDirectory });
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import assert from 'node:assert/strict';
      import { hashPassword } from '@kollors/deep-json-server/auth';
      import { createServer } from '@kollors/deep-json-server/server';
      import { generateOpenapi } from '@kollors/deep-json-server/openapi';
      import { generateGraphql } from '@kollors/deep-json-server/graphql';
      const schema = { models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true } } } } };
      assert.equal((await generateOpenapi(schema, { packagePath: './package.json' })).openapi, '3.0.3');
      assert.match(await generateGraphql(schema), /itemList/);
      const facade = await createServer({ storage: 'memory', package: { source: { name: 'packed-api', version: '1.0.0' } }, database: { source: { items: [] }, schema: { models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, name: { type: 'string', required: true } } } } } }, auth: { source: [{ id: '1', username: 'admin', passwordHash: await hashPassword('packed-test') }] }, graphql: {}, openapi: {}, server: { logger: false } });
      assert.match(await facade.graphql(), /itemCreate/);
      assert.equal((await facade.openapi()).openapi, '3.0.3');
      const server = facade.fastify();
      const session = await server.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'packed-test' } });
      const created = await server.inject({ method: 'POST', url: '/items', headers: { authorization: 'Bearer ' + session.json().accessToken }, payload: { name: 'packed' } });
      assert.equal(created.statusCode, 201, created.body);
      const queried = await server.inject({ method: 'POST', url: '/graphql', payload: { query: '{ itemList { total data { name } } }' } });
      assert.equal(queried.json().data.itemList.data[0].name, 'packed');
      const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'packed-test' } });
      assert.equal(login.statusCode, 200, login.body);
      const me = await server.inject({ url: '/auth/me', headers: { authorization: 'Bearer ' + login.json().accessToken } });
      assert.equal(me.json().username, 'admin');
      assert.doesNotMatch(await facade.graphql(), /authLogin|authMe|authLogout|AuthSession/);
      assert.equal((await facade.openapi()).components.securitySchemes.AuthBearer.scheme, 'bearer');
      await server.close();
      const selected = await createServer({
        storage: 'memory',
        database: {
          source: { restItems: [], graphItems: [] },
          schema: {
            api: ['rest', 'graphql'],
            models: {
              RestItem: { collection: 'restItems', api: ['rest'], fields: { id: { type: 'string', primary: true } } },
              GraphItem: { collection: 'graphItems', api: ['graphql'], fields: { id: { type: 'string', primary: true } } },
            },
          },
        },
        graphql: {}, openapi: {}, package: { source: { name: 'selected-api', version: '1.0.0' } }, server: { logger: false },
      });
      const selectedServer = selected.fastify();
      assert.equal((await selectedServer.inject('/restItems')).statusCode, 200);
      assert.equal((await selectedServer.inject('/graphItems')).statusCode, 404);
      assert.ok((await selected.openapi()).paths['/restItems']);
      assert.equal((await selected.openapi()).paths['/graphItems'], undefined);
      assert.match(await selected.graphql(), /graphItemList/);
      assert.doesNotMatch(await selected.graphql(), /restItemList/);
      await selectedServer.close();`,
    ],
    { cwd: temporaryDirectory },
  );
  await execute(join(temporaryDirectory, 'node_modules/.bin/deep-json-server'), ['--help'], { cwd: temporaryDirectory });
  await writeFile(
    join(temporaryDirectory, 'consumer.mts'),
    `import { createServer, type DeepJsonServerConfig, type ModelSchema } from '@kollors/deep-json-server';
import { hashPassword } from '@kollors/deep-json-server/auth';
import { generateGraphql } from '@kollors/deep-json-server/graphql';
import { generateOpenapi } from '@kollors/deep-json-server/openapi';

const schema: ModelSchema = { models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true } } } } };
const config: DeepJsonServerConfig = {
  storage: 'memory',
  database: { source: { items: [] }, schema },
  openapi: {},
  package: { source: { name: 'consumer-api', version: '1.0.0' } },
};
void createServer(config);
void generateGraphql(schema);
void generateOpenapi(schema, { packagePath: './package.json' });
void hashPassword('secret');

// @ts-expect-error File storage requires a path, not a collection object.
const invalid: DeepJsonServerConfig = { storage: 'file', database: { source: { items: [] } } };
void invalid;
`,
  );
  await execute(
    fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url)),
    ['--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer.mts'],
    {
      cwd: temporaryDirectory,
    },
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
