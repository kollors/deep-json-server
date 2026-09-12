import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, generateGraphql, generateOpenapi, writeGraphql, writeOpenapi } from '../dist/index.js';

const model = (fields = {}) => ({ Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, ...fields } } });
const setup = async (t, schema, data = { items: [] }, extra = {}) => {
  const facade = await createServer({ database: { data, schema }, server: { logger: false }, ...extra });
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
  const schema = { Query: { collection: 'items', fields: { id: { type: 'string', primary: true } } } };
  const openapiPath = join(dir, 'out', 'schema.yaml');
  const graphqlPath = join(dir, 'out', 'schema.graphql');
  const facade = await createServer({
    database: { path: join(dir, 'missing.json'), schema },
    files: { data: [{ name: 'file.txt', mimeType: 'invalid', content: new Uint8Array() }] },
    graphql: { enabled: true, path: graphqlPath },
    openapi: { path: openapiPath },
  });
  assert.ok((await facade.openapi()).paths['/items']);
  await assert.rejects(() => fs.access(openapiPath), { code: 'ENOENT' });
  await assert.rejects(() => facade.graphql(), /collision/);
  const s = facade.fastify();
  await assert.rejects(() => s.ready(), /не найден/);
  await s.close();
  const doc = await generateOpenapi(model());
  const sdl = await generateGraphql(model());
  await writeOpenapi(doc, openapiPath);
  await writeGraphql(sdl, graphqlPath);
  assert.match(await fs.readFile(graphqlPath, 'utf8'), /itemList/);
  const brokenData = await createServer({ database: { data: { items: [{ id: '1', wrong: true }] }, schema: model() }, graphql: { path: graphqlPath } });
  assert.match(await brokenData.graphql(), /itemCreate/);
});

test('REST, GraphQL and files coexist with consistent parsers and error envelopes', async (t) => {
  const { server } = await setup(t, model({ name: { type: 'string' } }), { items: [] }, { graphql: { enabled: true }, openapi: { enabled: true }, files: { data: [] } });
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
  const specOnly = await setup(t, model(), { items: [] }, { openapi: { enabled: true, endpoint: '/spec.json' } });
  assert.equal((await specOnly.server.inject('/spec.json')).statusCode, 200);
  assert.equal((await specOnly.server.inject('/graphql')).statusCode, 404);
});

test('API endpoints cannot shadow collections, records or one another', async () => {
  for (const extra of [
    { graphql: { enabled: true, endpoint: '/items' } },
    { graphql: { enabled: true, endpoint: '/items/123' } },
    { openapi: { enabled: true, endpoint: '/items/123' } },
    { graphql: { enabled: true, endpoint: '/api' }, openapi: { enabled: true, endpoint: '/api' } },
  ]) {
    const f = await createServer({ database: { data: { items: [{ id: '123' }] }, schema: model() }, server: { logger: false }, ...extra });
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
  const { server } = await setup(t, schema, { items: [{ id: '1', profile: { contains: 'abc', eq: 'yes' }, children: [{ in: 3 }] }] }, { graphql: { enabled: true } });
  const where = { profile: { contains: { eq: 'abc' }, eq: { eq: 'yes' } }, children: { some: { in: { gte: 3 } } } };
  const rest = await server.inject(`/items?${new URLSearchParams({ where: JSON.stringify(where) })}`);
  assert.equal(rest.json().total, 1);
  const graph = await gql(server, '{itemList(where:{profile:{contains:{eq:"abc"},eq:{eq:"yes"}},children:{some:{in:{gte:3}}}}){total}}');
  assert.equal(graph.json().data.itemList.total, 1);
});

test('GraphQL validates all selected list arguments before any mutation including variables and fragments', async (t) => {
  const { server } = await setup(t, model({ name: { type: 'string' }, children: { type: 'object[]' }, 'children.name': { type: 'string' } }), { items: [] }, { graphql: { enabled: true } });
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
  const { server } = await setup(t, undefined, {}, { database: { path, schema: model() }, graphql: { enabled: true }, files: { data: [] } });
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
  await assert.rejects(() => generateOpenapi({ DownloadFile: { collection: 'downloads', fields: { id: { type: 'string', primary: true } } } }, { files: true }), /operation collision/);
  const schema = model({ state: { type: 'string', enum: ['a', 'b'], nullable: true } });
  const { server, facade } = await setup(t, schema, { items: [{ id: '1', state: null }] }, { graphql: { enabled: true } });
  const doc = await facade.openapi();
  assert.deepEqual(doc.components.schemas.Item_stateFilter.properties.eq.enum, ['a', 'b', null]);
  assert.equal((await server.inject(`/items?${new URLSearchParams({ where: JSON.stringify({ state: { eq: null } }) })}`)).json().total, 1);
  assert.equal((await gql(server, '{itemList(where:{state:{eq:null}}){total}}')).json().data.itemList.total, 1);
  assert.equal((await server.inject(`/items?${new URLSearchParams({ where: JSON.stringify({ state: { eq: 'missing' } }) })}`)).statusCode, 400);
});

test('schemaless commits publish the inferred model and reject invalid projections before persistence', async (t) => {
  const dir = await temp(t);
  const path = join(dir, 'db.json');
  await fs.writeFile(path, '{"items":[]}');
  const { server } = await setup(t, undefined, {}, { database: { path } });
  const post = await server.inject({ method: 'POST', url: `/items?${new URLSearchParams({ scope: JSON.stringify({ name: true }) })}`, payload: { name: 'one' } });
  assert.equal(post.statusCode, 201);
  const id = JSON.parse(await fs.readFile(path, 'utf8')).items[0].id;
  const patch = await server.inject({ method: 'PATCH', url: `/items/${id}?${new URLSearchParams({ scope: JSON.stringify({ name: true }) })}`, payload: { name: 'two' } });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().name, 'two');
  const before = await fs.readFile(path, 'utf8');
  const failed = await server.inject({ method: 'POST', url: `/items?${new URLSearchParams({ scope: JSON.stringify({ missing: true }) })}`, payload: { name: 'three' } });
  assert.equal(failed.statusCode, 400);
  assert.equal(await fs.readFile(path, 'utf8'), before);
  const raw = await server.inject({ method: 'POST', url: '/items', headers: { 'content-type': 'application/json' }, payload: '{"new-field":"saved"}' });
  assert.equal(raw.statusCode, 201);
  assert.equal(raw.json()['new-field'], 'saved');
  assert.equal((await server.inject('/items')).statusCode, 200);
});

test('schemas are isolated from caller mutations and server instances', async (t) => {
  const schema = model({ state: { type: 'string', enum: ['a'], default: 'a' } });
  const { server, facade } = await setup(t, schema, { items: [] }, { graphql: { enabled: true } });
  await server.ready();
  schema.Item.fields.state.enum.push('b');
  schema.Item.fields.state.default = 'b';
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
  const { server } = await setup(t, schema, { items: [{ id: '1', profile: { name: 'old', stamp: 'fixed' }, meta: { server: 'value' } }] }, { graphql: { enabled: true } });
  let r = await server.inject({ method: 'PATCH', url: '/items/1', payload: { profile: { name: 'new' } } });
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
  const { server } = await setup(t, undefined, {}, { files: { directory: join(dir, 'files'), metadata } });
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
