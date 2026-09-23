import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const packagePath = new URL('../package.json', import.meta.url).pathname;

test('public imports and REST startup do not load unrelated API runtimes', async () => {
  const execute = promisify(execFile);
  for (const mode of ['root', 'openapi', 'graphql', 'rest']) {
    const { stdout } = await execute(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { registerHooks } from 'node:module';
      const loaded = new Set();
      registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context); } });
      const mode = ${JSON.stringify(mode)};
      const entry = mode === 'openapi' ? './dist/src/openapi/entry.js' : mode === 'graphql' ? './dist/src/graphql/entry.js' : './dist/index.js';
      const api = await import(entry);
      const schema = { models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true } } } } };
      if (mode === 'openapi') await api.generateOpenapi(schema, { auth: true, packagePath: ${JSON.stringify(packagePath)} });
      if (mode === 'graphql') await api.generateGraphql(schema);
      if (mode === 'rest') { const app = (await api.createServer({ storage: 'memory', database: { source: { items: [] } }, server: { logger: false } })).fastify(); await app.ready(); await app.close(); }
      console.log(JSON.stringify([...loaded]));
    `,
      ],
      { cwd: new URL('..', import.meta.url) },
    );
    const loaded = JSON.parse(stdout);
    assert.equal(
      loaded.some((path) => /\/auth\/(?:service|password|routes)\.js$/.test(path)),
      false,
      mode,
    );
    const forbidden =
      mode === 'root'
        ? ['fastify', 'mercurius', 'graphql', 'lowdb', 'yaml']
        : mode === 'rest'
          ? ['mercurius', 'graphql', 'yaml']
          : mode === 'openapi'
            ? ['fastify', 'mercurius', 'graphql', 'lowdb']
            : ['fastify', 'mercurius', 'lowdb', 'yaml'];
    for (const name of forbidden)
      assert.equal(
        loaded.some((path) => path.includes(`/node_modules/${name}/`)),
        false,
        `${mode} loaded ${name}`,
      );
    assert.equal(
      loaded.some((path) => /\/files\/(?:disk-store|memory-store|routes)\.js$/.test(path)),
      false,
      mode,
    );
  }
});
