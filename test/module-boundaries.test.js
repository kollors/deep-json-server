import { writeFile as writeFixture } from 'node:fs/promises';

const writeJson = async (path, value) => {
  await writeFixture(path, JSON.stringify(value));
  return path;
};

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, generateGraphql, generateOpenapi, writeGraphql, writeOpenapi } from '../dist/index.js';

const packagePath = new URL('../package.json', import.meta.url).pathname;
const packageSource = { name: 'test-api', version: '1.0.0' };
const model = (fields = {}) => ({ models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, ...fields } } } });
const setup = async (t, schema, data = { items: [] }, extra = {}) => {
  const config = { storage: 'memory', database: { source: data, schema }, server: { logger: false }, ...extra };
  const facade = await createServer({ ...config, ...((config.openapi ?? config.graphql) === undefined ? {} : { package: { source: config.storage === 'file' ? packagePath : packageSource } }) });
  const server = facade.fastify();
  t.after(() => server.close());
  return { server, facade };
};
const gql = (server, query, variables) => server.inject({ method: 'POST', url: '/graphql', payload: { query, variables } });
const temp = async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'deep-boundaries-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

test('schema generators and accessors need no database, file store or unrelated API', async (t) => {
  const dir = await temp(t);
  const schema = { models: { Query: { collection: 'items', fields: { id: { type: 'string', primary: true } } } } };
  const openapiPath = join(dir, 'out', 'schema.yaml');
  const graphqlPath = join(dir, 'out', 'schema.graphql');
  const facade = await createServer({
    storage: 'file',
    database: { source: join(dir, 'missing.json'), schema: await writeJson(`${join(dir, 'missing.json')}.schema.json`, schema) },
    files: { source: join(dir, 'missing-files') },
    graphql: { target: graphqlPath },
    openapi: { target: openapiPath },
    package: { source: packagePath },
  });
  assert.ok((await facade.openapi()).paths['/items']);
  await assert.rejects(() => fs.access(openapiPath), { code: 'ENOENT' });
  await assert.rejects(() => facade.graphql(), /collision/);
  const s = facade.fastify();
  await assert.rejects(() => s.ready(), /not found/);
  await s.close();
  const doc = await generateOpenapi(model(), { packagePath });
  const sdl = await generateGraphql(model());
  await writeOpenapi(doc, openapiPath);
  await writeGraphql(sdl, graphqlPath);
  assert.match(await fs.readFile(graphqlPath, 'utf8'), /itemList/);
  const brokenData = await createServer({
    storage: 'memory',
    database: { source: { items: [{ id: '1', wrong: true }] }, schema: model() },
    graphql: { target: graphqlPath },
    package: { source: packageSource },
  });
  assert.match(await brokenData.graphql(), /itemCreate/);
});

test('REST, GraphQL and files coexist with consistent parsers and error envelopes', async (t) => {
  const { server } = await setup(t, model({ name: { type: 'string' } }), { items: [] }, { graphql: {}, openapi: {}, files: { source: [] } });
  const upload = await server.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': 'one.json', 'content-type': 'application/json' }, payload: '{"raw":true}' });
  assert.equal(upload.statusCode, 201);
  assert.equal((await server.inject(upload.json().url)).body, '{"raw":true}');
  assert.equal((await server.inject({ method: 'POST', url: '/items', payload: { name: 'rest' } })).statusCode, 201);
  assert.equal((await gql(server, 'mutation{itemCreate(data:{name:"graphql"}){name}}')).json().data.itemCreate.name, 'graphql');
  const doc = (await server.inject('/openapi.json')).json();
  assert.ok(doc.paths['/_files/storage']);
  assert.equal((await gql(server, '{itemList{total}}')).json().data.itemList.total, 2);
  const invalid = (await gql(server, '{itemList(pager:{page:0}){total}}')).json();
  assert.equal(invalid.errors[0].extensions.code, 'INVALID_QUERY');
  const missing = (await gql(server, 'mutation{itemDelete(id:"missing"){id}}')).json();
  assert.equal(missing.errors[0].extensions.code, 'NOT_FOUND');
  assert.ok((await gql(server, '{noSuchField}')).json().errors);
  const specOnly = await setup(t, model(), { items: [] }, { openapi: { endpoint: '/spec.json' } });
  assert.equal((await specOnly.server.inject('/spec.json')).statusCode, 200);
  assert.equal((await specOnly.server.inject('/graphql')).statusCode, 404);
});

test('database API selection controls routes and OpenAPI without hiding auth or files', async (t) => {
  const schema = model({ name: { type: 'string' } });
  for (const api of [['rest'], ['graphql'], ['rest', 'graphql']]) {
    const selectedSchema = { ...schema, api };
    const { server, facade } = await setup(
      t,
      selectedSchema,
      { items: [{ id: '1', name: 'one' }] },
      {
        database: { source: { items: [{ id: '1', name: 'one' }] }, schema: selectedSchema },
        ...(api.includes('graphql') ? { graphql: {} } : {}),
        openapi: {},
        auth: { source: [] },
        files: { source: [] },
      },
    );
    const rest = api.includes('rest');
    const graph = api.includes('graphql');
    assert.equal((await server.inject('/items/1')).statusCode, rest ? 200 : 404);
    assert.equal((await server.inject({ method: 'POST', url: '/items', payload: { name: 'two' } })).statusCode, rest ? 401 : 404);
    assert.equal((await gql(server, '{itemList{total}}')).statusCode, graph ? 200 : 404);
    assert.equal((await server.inject('/auth/me')).statusCode, 401);
    assert.equal((await server.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': 'one.txt', 'content-type': 'text/plain' }, payload: 'hello' })).statusCode, 201);
    const document = await facade.openapi();
    assert.equal(Boolean(document.paths['/items']), rest);
    assert.ok(document.paths['/auth/login']);
    assert.ok(document.paths['/_files/storage']);
  }
});

test('model API selection cannot exceed database API and hides individual routes', async (t) => {
  const schema = {
    models: {
      Item: { ...model().models.Item, api: ['rest'] },
      Other: { collection: 'others', api: ['graphql'], fields: { id: { type: 'string', primary: true } } },
    },
  };
  const data = { items: [{ id: '1' }], others: [{ id: '2' }] };
  const { server, facade } = await setup(t, schema, data, { graphql: {}, openapi: {} });
  assert.equal((await server.inject('/items/1')).statusCode, 200);
  assert.equal((await server.inject('/others/2')).statusCode, 404);
  assert.deepEqual((await server.inject('/')).json().resources, ['items']);
  assert.ok((await facade.openapi()).paths['/items']);
  assert.equal((await facade.openapi()).paths['/others'], undefined);
  const graphql = await facade.graphql();
  assert.match(graphql, /otherList/);
  assert.doesNotMatch(graphql, /itemList/);
  await assert.rejects(() => createServer({ storage: 'memory', database: { source: data, schema: { ...schema, api: ['rest'] } }, package: { source: packageSource } }), /Other.api includes graphql/);
  await assert.rejects(
    () => createServer({ storage: 'memory', database: { source: data, schema: { ...schema, api: ['graphql'] } }, graphql: {}, package: { source: packageSource } }),
    /Item.api includes rest/,
  );
});

test('API endpoints cannot shadow collections, records or one another', async () => {
  for (const extra of [
    { graphql: { endpoint: '/items' } },
    { graphql: { endpoint: '/items/123' } },
    { openapi: { endpoint: '/items/123' } },
    { graphql: { endpoint: '/api' }, openapi: { endpoint: '/api' } },
  ]) {
    const f = await createServer({ storage: 'memory', database: { source: { items: [{ id: '123' }] }, schema: model() }, package: { source: packageSource }, server: { logger: false }, ...extra });
    const s = f.fastify();
    try {
      await assert.rejects(() => s.ready(), /conflict/);
    } finally {
      await s.close();
    }
  }
});

test('field names matching operators filter correctly through objects, lists and relations', async (t) => {
  const schema = model({ profile: { type: 'object' }, 'profile.contains': { type: 'string' }, 'profile.eq': { type: 'string' }, children: { type: 'object[]' }, 'children.in': { type: 'number' } });
  const { server } = await setup(t, schema, { items: [{ id: '1', profile: { contains: 'abc', eq: 'yes' }, children: [{ in: 3 }] }] }, { graphql: {} });
  const where = { profile: { contains: { eq: 'abc' }, eq: { eq: 'yes' } }, children: { some: { in: { gte: 3 } } } };
  const rest = await server.inject(`/items?${new URLSearchParams({ scope: JSON.stringify([{ '*': true }, { where }]) })}`);
  assert.equal(rest.json().total, 1);
  const graph = await gql(server, '{itemList(where:{profile:{contains:{eq:"abc"},eq:{eq:"yes"}},children:{some:{in:{gte:3}}}}){total}}');
  assert.equal(graph.json().data.itemList.total, 1);
});

test('GraphQL validates all selected list arguments before any mutation including variables and fragments', async (t) => {
  const { server } = await setup(t, model({ name: { type: 'string' }, children: { type: 'object[]' }, 'children.name': { type: 'string' } }), { items: [] }, { graphql: {} });
  const query =
    'mutation Run($size:Int!,$skip:Boolean!){ first:itemCreate(data:{name:"one",children:[{name:"a"}]}){id} second:itemCreate(data:{name:"two",children:[]}){...Shape}} fragment Shape on Item{children(pager:{pageSize:$size}) @skip(if:$skip){total data{name}}}';
  const failed = await gql(server, query, { size: 0, skip: false });
  assert.ok(failed.json().errors);
  assert.equal((await server.inject('/items')).json().total, 0);
  const skipped = await gql(server, query, { size: 0, skip: true });
  assert.equal(skipped.json().errors, undefined);
  assert.equal((await server.inject('/items')).json().total, 2);
  const invalid = await gql(server, '{itemList(where:{name:{eq:"absent"}}){data{children(pager:{pageSize:0}){total}}}}');
  assert.ok(invalid.json().errors);
});

test('GraphQL introspection stays available when the database fails and internal errors are masked', async (t) => {
  const dir = await temp(t);
  const path = join(dir, 'db.json');
  await fs.writeFile(path, '{"items":[]}');
  const { server } = await setup(
    t,
    undefined,
    {},
    { storage: 'file', database: { source: path, schema: await writeJson(`${path}.schema.json`, model()) }, graphql: {}, files: { source: join(dir, 'files') } },
  );
  await server.ready();
  await fs.writeFile(path, 'broken');
  const introspection = (await gql(server, '{__schema{queryType{name}}}')).json();
  assert.equal(introspection.data.__schema.queryType.name, 'Query');
  const failed = (await gql(server, '{itemList{total}}')).json();
  assert.equal(failed.errors[0].extensions.code, 'INTERNAL_ERROR');
  assert.equal(failed.error, undefined);
  assert.equal((await server.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': 'one.txt', 'content-type': 'text/plain' }, payload: 'one' })).statusCode, 201);
});

test('OpenAPI checks file operation collisions and nullable enum filters match runtime', async (t) => {
  await assert.rejects(
    () => generateOpenapi({ models: { DownloadFile: { collection: 'downloads', fields: { id: { type: 'string', primary: true } } } } }, { files: true, packagePath }),
    /operation collision/,
  );
  const schema = model({ state: { type: 'string', enum: ['a', 'b'], nullable: true } });
  const { server, facade } = await setup(t, schema, { items: [{ id: '1', state: null }] }, { graphql: {}, openapi: {} });
  const doc = await facade.openapi();
  assert.deepEqual(doc.components.schemas.Item_stateFilter.properties.eq.enum, ['a', 'b', null]);
  assert.equal((await server.inject(`/items?${new URLSearchParams({ scope: JSON.stringify([{ '*': true }, { where: { state: { eq: null } } }]) })}`)).json().total, 1);
  assert.equal((await gql(server, '{itemList(where:{state:{eq:null}}){total}}')).json().data.itemList.total, 1);
  assert.equal((await server.inject(`/items?${new URLSearchParams({ scope: JSON.stringify([{ '*': true }, { where: { state: { eq: 'missing' } } }]) })}`)).statusCode, 400);
});

test('schemaless commits publish the inferred model and reject invalid projections before persistence', async (t) => {
  const dir = await temp(t);
  const path = join(dir, 'db.json');
  await fs.writeFile(path, '{"items":[]}');
  const { server } = await setup(t, undefined, {}, { storage: 'file', database: { source: path } });
  const post = await server.inject({ method: 'POST', url: `/items?${new URLSearchParams({ scope: JSON.stringify([{ name: true }]) })}`, payload: { name: 'one' } });
  assert.equal(post.statusCode, 201);
  const id = JSON.parse(await fs.readFile(path, 'utf8')).items[0].id;
  const patch = await server.inject({ method: 'PATCH', url: `/items/${id}?${new URLSearchParams({ scope: JSON.stringify([{ name: true }]) })}`, payload: { name: 'two' } });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().name, 'two');
  const before = await fs.readFile(path, 'utf8');
  const failed = await server.inject({ method: 'POST', url: `/items?${new URLSearchParams({ scope: JSON.stringify([{ missing: true }]) })}`, payload: { name: 'three' } });
  assert.equal(failed.statusCode, 400);
  assert.equal(await fs.readFile(path, 'utf8'), before);
  const raw = await server.inject({ method: 'POST', url: '/items', headers: { 'content-type': 'application/json' }, payload: '{"new-field":"saved"}' });
  assert.equal(raw.statusCode, 201);
  assert.equal(raw.json()['new-field'], 'saved');
  assert.equal((await server.inject('/items')).statusCode, 200);
});

test('schemas are isolated from caller mutations and server instances', async (t) => {
  const schema = model({ state: { type: 'string', enum: ['a'], default: 'a' } });
  const { server, facade } = await setup(t, schema, { items: [] }, { graphql: {}, openapi: {} });
  await server.ready();
  schema.models.Item.fields.state.enum.push('b');
  schema.models.Item.fields.state.default = 'b';
  assert.deepEqual((await facade.openapi()).components.schemas.Item.properties.state.enum, ['a']);
  assert.equal((await server.inject({ method: 'POST', url: '/items', payload: {} })).json().state, 'a');
  assert.equal((await server.inject({ method: 'POST', url: '/items', payload: { state: 'b' } })).statusCode, 400);
  assert.ok((await gql(server, 'mutation{itemCreate(data:{state:b}){id}}')).json().errors);
  const other = await setup(t, schema);
  assert.equal((await other.server.inject({ method: 'POST', url: '/items', payload: {} })).json().state, 'b');
});

test('nested read-only fields survive object replacement and produce valid GraphQL inputs', async (t) => {
  const schema = model({
    profile: { type: 'object' },
    'profile.name': { type: 'string' },
    'profile.stamp': { type: 'string', readOnly: true, required: true },
    meta: { type: 'object' },
    'meta.server': { type: 'string', readOnly: true },
  });
  const { server } = await setup(t, schema, { items: [{ id: '1', profile: { name: 'old', stamp: 'fixed' }, meta: { server: 'value' } }] }, { graphql: {} });
  let r = await server.inject({ method: 'PATCH', url: `/items/1?${new URLSearchParams({ scope: JSON.stringify([{ profile: [{ '*': true }] }]) })}`, payload: { profile: { name: 'new' } } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().profile.stamp, 'fixed');
  r = await gql(server, 'mutation{itemReplace(id:"1",data:{profile:{name:"graphql"}}){profile{name stamp} meta{server}}}');
  assert.equal(r.json().errors, undefined);
  assert.equal(r.json().data.itemReplace.meta.server, 'value');
  r = await server.inject({ method: 'PATCH', url: '/items/1', payload: { profile: { stamp: 'forged' } } });
  assert.equal(r.statusCode, 400);
  await assert.rejects(() => generateGraphql(model({ rows: { type: 'object[]' }, 'rows.stamp': { type: 'string', readOnly: true } })), /readOnly parent/);
  assert.match(await generateGraphql(model({ rows: { type: 'object[]', readOnly: true }, 'rows.stamp': { type: 'string', readOnly: true } })), /Item_rows/);
});

test('disk file reads wait for a consistent metadata and content snapshot', async (t) => {
  const dir = await temp(t);
  const metadata = join(dir, 'metadata.json');
  const { server } = await setup(t, undefined, {}, { storage: 'file', database: { source: await writeJson(join(dir, 'db.json'), { items: [] }) }, files: { source: join(dir, 'files'), metadata } });
  await server.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': 'one.txt', 'content-type': 'text/plain' }, payload: 'old' });
  const original = fs.rename;
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve));
  const reached = new Promise((resolve) => (entered = resolve));
  fs.rename = async (from, to) => {
    if (to === metadata) {
      entered();
      await gate;
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  try {
    const writing = server.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': 'one.txt', 'content-type': 'application/json', 'content-override': 'true' }, payload: '"new"' });
    await reached;
    let resolved = false;
    const reading = server.inject('/_files/storage/one.txt').then((r) => {
      resolved = true;
      return r;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    release();
    assert.equal((await writing).statusCode, 200);
    const response = await reading;
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.body, '"new"');
  } finally {
    release();
    fs.rename = original;
    syncBuiltinESMExports();
  }
});

test('src contains module directories and core has no API or server dependencies', async () => {
  const root = new URL('../src/', import.meta.url);
  const entries = await fs.readdir(root, { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['auth', 'cli', 'core', 'files', 'graphql', 'openapi', 'rest', 'server']);
  assert.ok(entries.every((entry) => entry.isDirectory()));
  const dependencies = {
    core: [],
    auth: ['core'],
    files: ['core'],
    rest: ['core'],
    graphql: ['core'],
    openapi: ['core', 'auth', 'files'],
    cli: ['core', 'server', 'openapi', 'graphql'],
    server: ['core', 'rest', 'graphql', 'openapi', 'auth', 'files'],
  };
  for (const [module, allowed] of Object.entries(dependencies)) {
    const directory = new URL(`${module}/`, root);
    const paths = await fs.readdir(directory, { recursive: true });
    for (const path of paths.filter((path) => path.endsWith('.ts'))) {
      const url = new URL(path, directory);
      const source = await fs.readFile(url, 'utf8');
      for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
        const target = match[2];
        if (!target.startsWith('.')) {
          if (module === 'core') assert.ok(!['fastify', 'mercurius', 'graphql', 'yaml'].includes(target), `${url} imports ${target}`);
          continue;
        }
        const resolved = new URL(target, url);
        assert.ok(resolved.href.startsWith(directory.href) || allowed.some((name) => resolved.href.startsWith(new URL(`${name}/`, root).href)), `${url} imports ${target}`);
        if (module === 'openapi' && !resolved.href.startsWith(directory.href) && !resolved.href.startsWith(new URL('core/', root).href)) {
          assert.ok(
            ['auth/contract.js', 'files/http.js'].some((path) => resolved.href === new URL(path, root).href),
            `${url} imports a runtime instead of a contract: ${target}`,
          );
        }
      }
    }
  }
});
