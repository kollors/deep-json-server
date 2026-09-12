import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert(paths.every((path) => !path.startsWith('src/') && !path.startsWith('types/')));

  await writeFile(join(temporaryDirectory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
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
      const schema = { Item: { collection: 'items', fields: { id: { type: 'string', primary: true } } } };
      assert.equal((await generateOpenapi(schema)).openapi, '3.0.3');
      assert.match(await generateGraphql(schema), /itemList/);
      const facade = await createServer({
        database: { data: { items: [] }, schema: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, name: { type: 'string', required: true } } } } },
        auth: { enabled: true, users: [{ id: '1', username: 'admin', passwordHash: await hashPassword('packed-test') }] },
        graphql: { enabled: true }, server: { logger: false },
      });
      assert.match(await facade.graphql(), /itemCreate/);
      assert.equal((await facade.openapi()).openapi, '3.0.3');
      const server = facade.fastify();
      const created = await server.inject({ method: 'POST', url: '/items', payload: { name: 'packed' } });
      assert.equal(created.statusCode, 201, created.body);
      const queried = await server.inject({ method: 'POST', url: '/graphql', payload: { query: '{ itemList { total data { name } } }' } });
      assert.equal(queried.json().data.itemList.data[0].name, 'packed');
      const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'packed-test' } });
      assert.equal(login.statusCode, 200, login.body);
      const me = await server.inject({ url: '/auth/me', headers: { authorization: 'Bearer ' + login.json().accessToken } });
      assert.equal(me.json().username, 'admin');
      assert.doesNotMatch(await facade.graphql(), /authLogin|authMe|authLogout|AuthSession/);
      assert.equal((await facade.openapi()).components.securitySchemes.AuthBearer.scheme, 'bearer');
      await server.close();`,
    ],
    {
      cwd: temporaryDirectory,
    },
  );
  await execute(join(temporaryDirectory, 'node_modules/.bin/deep-json-server'), ['--help'], { cwd: temporaryDirectory });
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
