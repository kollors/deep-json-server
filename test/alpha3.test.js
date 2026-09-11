import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createServer, generateGraphql, generateOpenapi } from '../dist/index.js';
import { runCli } from '../dist/src/cli.js';
import { configure, readConfigModule } from '../dist/src/config.js';
import { Engine } from '../dist/src/engine.js';
import { createConfiguredServer } from '../dist/src/server.js';

const model = (fields = {}) => ({ Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, ...fields } } });
const temporary = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-alpha3-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};
const setup = async (t, config) => {
  const facade = await createServer({ ...config, server: { logger: false, ...config.server } });
  const app = facade.fastify();
  t.after(() => app.close());
  await app.ready();
  return { app, facade };
};
const url = (path, options) => `${path}?${new URLSearchParams(Object.entries(options).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))}`;
const gql = (app, query) => app.inject({ method: 'POST', url: '/graphql', payload: { query } });

test('file uploads and moves preserve database, counters, schema and config inputs', async (t) => {
  const directory = await temporary(t);
  const sourcePath = join(directory, 'server.config.mjs');
  const config = { database: { path: 'db.json', schema: 'model.json' }, files: { directory: '.', metadata: 'files.json' }, server: { logger: false } };
  const contents = {
    'db.json': JSON.stringify({ items: [{ id: '1' }] }),
    'db.json.counters.json': '{}',
    'model.json': JSON.stringify(model()),
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
  const conflicting = (await createServer({ database: { path: join(directory, 'db.json') }, files: { directory, metadata: join(directory, 'db.json') }, server: { logger: false } })).fastify();
  try {
    await assert.rejects(() => conflicting.ready(), /protected/);
  } finally {
    await conflicting.close();
  }
  assert.equal(await readFile(join(directory, 'db.json'), 'utf8'), contents['db.json']);
  const alias = join(directory, 'storage-alias');
  await symlink(directory, alias);
  const aliased = (await createServer({ database: { data: { items: [] } }, files: { directory: alias, metadata: join(directory, 'files.json') }, server: { logger: false } })).fastify();
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

test('generation accepts schema-only config and rejects colliding destinations before writes', async (t) => {
  const directory = await temporary(t);
  const source = join(directory, 'config.mjs');
  const schemaPath = join(directory, 'model.json');
  await writeFile(schemaPath, JSON.stringify(model()));
  const config = { database: { schema: 'model.json' }, openapi: { path: 'api.yaml' }, graphql: { path: 'api.graphql' } };
  const run = async (value, formats = 'openapi,graphql') => {
    await writeFile(source, `export default ${JSON.stringify(value)};`);
    return runCli(['generate', formats, source]);
  };
  await run(config);
  assert.match(await readFile(join(directory, 'api.graphql'), 'utf8'), /itemList/);
  await run({ ...config, files: 'ignored by GraphQL', server: { port: 'ignored by GraphQL' } }, 'graphql');
  const original = await readFile(join(directory, 'api.yaml'), 'utf8');
  await assert.rejects(() => run({ ...config, graphql: { path: 'api.yaml' } }), /different/);
  assert.equal(await readFile(join(directory, 'api.yaml'), 'utf8'), original);
  await assert.rejects(() => run({ ...config, openapi: { path: 'model.json' } }), /overwrite/);
  await symlink(schemaPath, join(directory, 'alias.yaml'));
  await assert.rejects(() => run({ ...config, openapi: { path: 'alias.yaml' } }), /overwrite/);
  await link(schemaPath, join(directory, 'hardlink.yaml'));
  await assert.rejects(() => run({ ...config, openapi: { path: 'hardlink.yaml' } }), /overwrite/);
  assert.deepEqual(JSON.parse(await readFile(schemaPath, 'utf8')), model());
});

test('pagination and info snapshots agree across public generators and the server', async (t) => {
  const schema = model();
  const generated = await generateOpenapi(schema, { maxPageSize: 5 });
  assert.equal(generated.components.schemas.Pager.properties.pageSize.default, 5);
  for (const options of [
    { pageSize: 0 },
    { maxPageSize: -1 },
    { pageSize: 6, maxPageSize: 5 },
    { pageSize: Number.MAX_SAFE_INTEGER + 1 },
    { port: '4001' },
    { info: { title: 'x' } },
    { files: 'true' },
  ])
    await assert.rejects(() => generateOpenapi(schema, options));
  const info = { title: 'Original', version: '1' };
  const { facade, app } = await setup(t, { database: { schema, data: { items: [] } }, openapi: { enabled: true, info }, server: { maxPageSize: 5, port: 0 } });
  info.title = 'Changed';
  const fromFacade = await facade.openapi();
  const fromEndpoint = (await app.inject('/openapi.json')).json();
  assert.deepEqual(fromFacade, fromEndpoint);
  assert.equal(fromEndpoint.info.title, 'Original');
  assert.deepEqual(fromEndpoint.servers, [{ url: '/' }]);
});

test('listen preserves configured host when overriding only the port in promise and callback forms', async (t) => {
  for (const callback of [false, true]) {
    const { app } = await setup(t, { database: { data: { items: [] } }, server: { host: '127.0.0.2', port: 4001 } });
    const address = callback ? await new Promise((resolve, reject) => app.listen({ port: 0 }, (error, result) => (error ? reject(error) : resolve(result)))) : await app.listen({ port: 0 });
    assert.match(address, /^http:\/\/127\.0\.0\.2:/);
  }
});

test('nested field lookups reject inherited names and empty objects remain writable in REST', async (t) => {
  const schema = model({ profile: { type: 'object' }, 'profile.name': { type: 'string' }, settings: { type: 'object' } });
  const { app } = await setup(t, { database: { schema, data: { items: [] } } });
  const created = await app.inject({ method: 'POST', url: '/items', payload: { settings: {}, profile: { name: 'A' } } });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().settings, {});
  for (const options of [{ scope: 'profile(toString)' }, { order: [{ field: 'profile.toString', direction: 'ASC' }] }, { where: { profile: { toString: { eq: 'x' } } } }])
    assert.equal((await app.inject(url('/items', options))).statusCode, 400);
  assert.ok((await generateOpenapi(schema)).components.schemas.ItemCreate.properties.settings);
  await assert.rejects(() => generateGraphql(schema), /at least one visible field/);
  for (const type of ['object', 'object[]']) await assert.rejects(() => generateOpenapi(model({ profile: { type, enum: [{}] } })), /enum.*primitive/);
});

test('OpenAPI preserves annotations on objects and relations', async () => {
  const schema = model({
    profile: { type: 'object', nullable: true, readOnly: true, description: 'Profile', example: { name: 'A' } },
    'profile.name': { type: 'string' },
    related: { type: 'Item[]', source: 'id', target: 'id', description: 'Related items' },
  });
  const doc = await generateOpenapi(schema);
  const { profile, related } = doc.components.schemas.Item.properties;
  assert.equal(profile.readOnly, true);
  assert.equal(profile.description, 'Profile');
  assert.deepEqual(profile.example, { name: 'A' });
  assert.ok(profile.allOf[0].anyOf);
  assert.equal(related.description, 'Related items');
  assert.equal(related.allOf[0].$ref, '#/components/schemas/ItemPage');
});

test('GraphQL prepares each selected list once and REST reuses nested plans', async (t) => {
  const { app } = await setup(t, {
    database: { schema: model({ rows: { type: 'object[]' }, 'rows.name': { type: 'string' } }), data: { items: Array.from({ length: 10 }, (_, i) => ({ id: String(i), rows: [{ name: 'x' }] })) } },
    graphql: { enabled: true },
  });
  const original = Engine.prototype.prepareOptions;
  let calls = 0;
  Engine.prototype.prepareOptions = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    const roots = Array.from({ length: 20 }, (_, i) => `q${i}:itemList { total }`).join(' ');
    assert.equal((await gql(app, `{${roots}}`)).json().errors, undefined);
    assert.equal(calls, 20);
    calls = 0;
    assert.equal((await gql(app, '{itemList {data { rows(where:{name:{eq:"x"}}) {total} }}}')).json().errors, undefined);
    assert.equal(calls, 2);
    calls = 0;
    assert.equal((await app.inject(url('/items', { nested: { rows: { where: { name: { eq: 'x' } } } } }))).statusCode, 200);
    assert.equal(calls, 2);
  } finally {
    Engine.prototype.prepareOptions = original;
  }
});

test('inferred relation indexes use collections rather than singular model names', async (t) => {
  const { app } = await setup(t, { database: { data: { user: [{ id: '1', name: 'A' }], users: [{ id: '1', name: 'B' }], links: [{ id: '1', userId: '1', usersId: '1' }] } } });
  for (const scope of ['user(name),users(name)', 'users(name),user(name)']) {
    const result = (await app.inject(url('/links/1', { scope }))).json();
    assert.deepEqual(result, { user: { name: 'A' }, users: { name: 'B' } });
  }
});

test('mixed schemaless shapes preserve projected data and never expose internal references', async (t) => {
  const mixed = [
    { id: '1', tagId: 't', profile: [{ name: 'A' }] },
    { id: '2', tagId: 't', profile: { name: 'B' } },
    { id: '3', tagId: 't', profile: 'scalar' },
  ];
  for (const items of [mixed, [...mixed].reverse()]) {
    const { app } = await setup(t, { database: { data: { items, tags: [{ id: 't' }], privateNotes: [{ id: 'p', text: 'fixture' }] } } });
    const result = await app.inject('/items/1?scope=profile(name)');
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { profile: { data: [{ name: 'A' }], total: 1 } });
    assert.doesNotMatch(result.body, /context|bindings|privateNotes/);
    assert.equal((await app.inject('/items')).statusCode, 200);
    for (const options of [{ where: { profile: {} } }, { order: [{ field: 'profile.name', direction: 'ASC' }] }, { nested: { profile: {} } }])
      assert.equal((await app.inject(url('/items', options))).statusCode, 400);
    const updated = await app.inject({ method: 'PATCH', url: '/items/2?scope=profile', payload: { profile: [{ name: 'C' }] } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json(), { profile: { data: [{ name: 'C' }], total: 1 } });
  }
});

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
      const schema = { Item: { collection: 'items', fields: { id: { type: 'string', primary: true } } } };
      if (mode === 'openapi') await api.generateOpenapi(schema);
      if (mode === 'graphql') await api.generateGraphql(schema);
      if (mode === 'rest') { const app = (await api.createServer({ database: { data: { items: [] } }, server: { logger: false } })).fastify(); await app.ready(); await app.close(); }
      console.log(JSON.stringify([...loaded]));
    `,
      ],
      { cwd: new URL('..', import.meta.url) },
    );
    const loaded = JSON.parse(stdout);
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
