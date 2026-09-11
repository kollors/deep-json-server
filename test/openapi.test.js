import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSchema, validateSchema } from 'graphql';
import { parse } from 'yaml';
import { createServer, writeGraphql, writeOpenapi } from '../dist/index.js';

const startServer = async (config) => {
  const facade = await createServer(config);
  const server = facade.fastify();
  try {
    await server.ready();
    return facade;
  } catch (error) {
    await server.close();
    throw error;
  }
};

import { loadModel } from '../dist/src/model.js';
import { createOpenapi } from '../dist/src/openapi/index.js';

const schema = JSON.parse(await readFile(new URL('../examples/schema.json', import.meta.url), 'utf8'));
const definition = (fields) => ({ Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, ...fields } } });
const facadeFor = (model, extra = {}) => createServer({ database: { data: {}, schema: model }, server: { logger: false }, ...extra });
function checkReferences(document) {
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/components/'));
      const [, , category, name] = value.$ref.split('/');
      assert.ok(document.components[category][name], value.$ref);
    }
    Object.values(value).forEach(walk);
  };
  walk(document);
}

test('exports catalog without data or runtime server and resolves every reference', async () => {
  const facade = await facadeFor(schema);
  const document = await facade.openapi();
  assert.equal(document.openapi, '3.0.3');
  assert.equal(document.paths['/users'].get.operationId, 'userList');
  assert.equal(document.paths['/users/{id}'].get.operationId, 'user');
  assert.equal(document.components.schemas.Movie.properties.actors.$ref, '#/components/schemas/Movie_actorsPage');
  assert.equal(document.components.schemas.Movie_actors.properties.genres.$ref, '#/components/schemas/GenrePage');
  assert.equal(document.components.schemas.UserCreate.properties.id, undefined);
  assert.equal(document.components.schemas.UserCreate.properties.countryId.type, 'string');
  assert.equal(document.components.schemas.User.properties.bornAt.format, 'date');
  assert.equal(document.components.schemas.UserUpdate.required, undefined);
  assert.equal(document.components.schemas.Pager.properties.pageSize.maximum, 100);
  const parameter = document.paths['/users'].get.parameters.find((p) => p.name === 'where');
  assert.ok(parameter.content['application/json']);
  assert.equal(parameter.schema, undefined);
  assert.ok(document.components.schemas.UserNested.properties['movies.actors.genres']);
  checkReferences(document);
  const sdl = await facade.graphql();
  assert.deepEqual(validateSchema(buildSchema(sdl)), []);
  assert.match(sdl, /userList/);
  assert.doesNotMatch(sdl, /ById/);
  document.components.schemas.User.properties.fullName.type = 'number';
  assert.equal((await facade.openapi()).components.schemas.User.properties.fullName.type, 'string');
});

test('manual primary key, formats, nullable arrays, read/write fields and annotations', async () => {
  const model = {
    LocalUser: {
      collection: 'localUsers',
      fields: {
        username: { type: 'string', primary: true },
        password: { type: 'string', writeOnly: true, required: true },
        tags: { type: 'string[]', nullable: true, minLength: 1 },
        profile: { type: 'object', nullable: true },
        'profile.name': { type: 'string', description: 'Name', example: 'Alice' },
        rows: { type: 'object[]', nullable: true },
        'rows.flag': { type: 'boolean' },
        created: { type: 'string', readOnly: true, default: 'server' },
        email: { type: 'string', format: 'email' },
        uuid: { type: 'string', format: 'uuid' },
        stamp: { type: 'string', format: 'date-time' },
        level: { type: 'number', enum: [1, 2] },
        note: { type: 'string', description: 'A note', default: 'x', example: 'y' },
      },
    },
  };
  const facade = await facadeFor(model);
  const doc = await facade.openapi();
  checkReferences(doc);
  assert.ok(doc.paths['/localUsers/{username}']);
  assert.equal(doc.components.schemas.LocalUser.properties.password, undefined);
  assert.equal(doc.components.schemas.LocalUserCreate.properties.password.type, 'string');
  assert.equal(doc.components.schemas.LocalUserCreate.properties.created, undefined);
  assert.equal(doc.components.schemas.LocalUser.properties.created.readOnly, true);
  assert.equal(doc.components.schemas.LocalUser.properties.tags.nullable, true);
  assert.equal(doc.components.schemas.LocalUser.properties.tags.items.minLength, 1);
  assert.equal(doc.components.schemas.LocalUser.properties.note.description, 'A note');
  assert.equal(doc.components.schemas.LocalUser.properties.note.example, 'y');
  assert.equal(doc.components.schemas.LocalUserReplace.properties.username, undefined);
  assert.ok(doc.components.schemas.LocalUserCreate.required.includes('username'));
  const sdl = await facade.graphql();
  assert.match(sdl, /VALUE_0/);
  assert.match(sdl, /LocalUser_profile/);
  assert.deepEqual(validateSchema(buildSchema(sdl)), []);
});

test('writes YAML and SDL to nested output paths with independent API settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-alpha-export-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const model = definition({ name: { type: 'string' } });
  const openapiPath = join(directory, 'out', 'api.yaml');
  const graphqlPath = join(directory, 'out', 'api.graphql');
  const facade = await facadeFor(model, {
    openapi: { path: openapiPath, info: { title: 'Example', version: 'alpha', description: 'Shared schema' } },
    graphql: { path: graphqlPath },
    server: { host: '::1', port: 9000, logger: false },
  });
  await writeOpenapi(await facade.openapi(), openapiPath);
  await writeGraphql(await facade.graphql(), graphqlPath);
  const doc = parse(await readFile(openapiPath, 'utf8'));
  assert.equal(doc.info.title, 'Example');
  assert.equal(doc.servers[0].url, 'http://[::1]:9000');
  assert.match(await readFile(graphqlPath, 'utf8'), /itemList/);
  for (const bad of [{ host: '' }, { port: -1 }, { port: 70000 }]) assert.throws(() => createOpenapi({ document: doc, ...bad }));
  assert.deepEqual(createOpenapi({ document: doc, port: 0 }).servers, [{ url: '/' }]);
  model.Item.api = ['openapi'];
  const only = await facadeFor(model);
  assert.ok((await only.openapi()).paths['/items']);
  await assert.rejects(() => only.graphql(), /No models/);
  model.Item.api = [];
  const internal = await facadeFor(model);
  assert.deepEqual((await internal.openapi()).paths, {});
  const server = internal.fastify();
  assert.equal((await server.inject('/items')).statusCode, 200);
  await server.close();
});

test('rejects disabled API targets, operation/type collisions, and sort enum collisions', async () => {
  const models = { A: { collection: 'a', fields: { id: { type: 'string', primary: true }, b: { type: 'B' } } }, B: { collection: 'b', api: [], fields: { id: { type: 'string', primary: true } } } };
  let facade = await facadeFor(models);
  await assert.rejects(() => facade.openapi(), /does not enable/);
  await assert.rejects(() => facade.graphql(), /does not enable/);
  for (const name of ['Error', 'Pager', 'ItemPage', 'ItemCreate']) {
    const model = definition({});
    model[name] = { collection: `other${name}`, fields: { id: { type: 'string', primary: true } } };
    facade = await facadeFor(model);
    await assert.rejects(() => facade.openapi(), /collision/);
  }
  facade = await facadeFor({ ...definition({}), Query: { collection: 'queries', fields: { id: { type: 'string', primary: true } } } });
  await assert.rejects(() => facade.graphql(), /collision/);
  facade = await facadeFor({ ...definition({}), ItemList: { collection: 'lists', fields: { id: { type: 'string', primary: true } } } });
  await assert.rejects(() => facade.graphql(), /collision/);
  await assert.rejects(() => facade.openapi(), /collision/);
  facade = await facadeFor(definition({ a_b: { type: 'string' }, a: { type: 'object' }, 'a.b': { type: 'string' } }));
  await assert.rejects(() => facade.graphql(), /collision/);
  for (const key of ['and', 'or', 'not']) {
    facade = await facadeFor(definition({ [key]: { type: 'string' } }));
    await assert.rejects(() => facade.graphql(), /Reserved/);
    await assert.rejects(() => facade.openapi(), /Reserved/);
  }
});

test('schema validation rejects malformed declarations and removed syntax', async () => {
  for (const input of [null, [], {}, { $schema: {} }, { $info: {} }]) await assert.rejects(() => loadModel(input));
  const invalidFields = [
    { type: 'integer' },
    { type: 'string[][]' },
    { type: 'string', items: {} },
    { type: 'string', required: 'yes' },
    { type: 'string', nullable: 'yes' },
    { type: 'string', description: 1 },
    { type: 'string', example: 1 },
    { type: 'string', default: 1 },
    { type: 'string', minLength: '1' },
    { type: 'string', maxLength: -1 },
    { type: 'string', minLength: 2, maxLength: 1 },
    { type: 'number', minimum: 2, maximum: 1 },
    { type: 'number', minimum: Infinity },
    { type: 'string', readOnly: true, writeOnly: true },
    { type: 'string', enum: [] },
    { type: 'string', generated: 'random' },
    { type: 'string', generated: 'uuid', default: 'x' },
    { type: 'number', generated: 'uuid' },
    { type: 'string', primary: true, nullable: true },
    { type: 'string', primary: true, writeOnly: true },
    { type: 'string', primary: true, required: false },
    { type: 'string', onDelete: 'remove' },
    { type: 'string', source: 'id' },
    { type: 'string', format: 'unknown' },
    { type: 'number', format: 'email' },
    { type: 'string', minimum: 0 },
    { type: 'string', pattern: '[' },
    { type: 'string', minItems: 1 },
    { type: 'string', multipleOf: 1 },
    { type: 'string', pattern: 1 },
  ];
  for (const field of invalidFields) await assert.rejects(() => loadModel(definition({ value: field })), undefined, JSON.stringify(field));
  for (const model of [
    { Bad: { collection: 'bad', fields: {} } },
    { Bad: { collection: 'bad', fields: { id: { type: 'string', primary: true }, other: { type: 'number', primary: true } } } },
    { Bad: { collection: 'bad', fields: { 'nested.id': { type: 'string', primary: true } } } },
    { Bad: { collection: 'bad', api: ['bad'], fields: {} } },
    { Bad: { collection: 'bad', api: ['graphql', 'graphql'], fields: {} } },
    { Bad: { collection: 'bad', fields: [] } },
    { Bad: { collection: 'bad', fields: { id: { type: 'string', primary: true } }, extra: 1 } },
    { Bad: { collection: '../bad', fields: {} } },
    { string: { collection: 'bad', fields: {} } },
  ])
    await assert.rejects(() => loadModel(model));
  await assert.rejects(() => loadModel({ ...definition({}), Other: { collection: 'items', fields: { id: { type: 'string', primary: true } } } }), /Duplicate/);
  await assert.rejects(() => loadModel(definition({ 'bad..path': { type: 'string' } })), /path/);
  await assert.rejects(() => loadModel(definition({ a: { type: 'string' }, 'a.b': { type: 'string' } })), /contain/);
  await assert.rejects(() => loadModel(definition({ 'nested.value': { type: 'string', generated: 'uuid' } })), /root/);
});

test('validates explicit keys, implicit fields, primary defaults and nullable references', async () => {
  const model = {
    A: { collection: 'a', fields: { code: { type: 'number', primary: true }, b: { type: 'B', source: 'bCode', nullable: true } } },
    B: { collection: 'b', fields: { code: { type: 'number', primary: true } } },
  };
  const compiled = await loadModel(model);
  assert.equal(compiled.byName.get('A').fields.bCode.type, 'number');
  assert.equal(compiled.byName.get('A').fields.bCode.nullable, true);
  await createServer({ database: { data: { a: [{ code: 1, bCode: null }], b: [] }, schema: model }, server: { logger: false } });
  const both = structuredClone(model);
  delete both.A.fields.b.source;
  const loaded = await loadModel(both);
  assert.equal(loaded.byName.get('A').fields.b.source, 'code');
  assert.equal(loaded.byName.get('A').fields.b.target, 'code');
  model.A.fields.b.target = 'unknown';
  await assert.rejects(() => loadModel(model), /ambiguous/);
  model.A.fields.b.target = 'code';
  model.A.fields.bCode = { type: 'string' };
  await assert.rejects(() => loadModel(model), /Incompatible/);
  delete model.A.fields.bCode;
  model.A.fields.b.default = {};
  await assert.rejects(() => loadModel(model), /relation options/);
});

test('initial database validates unknown fields, dangling references and required relations', async () => {
  const model = definition({ name: { type: 'string', required: true } });
  for (const data of [{ items: [{ id: '1' }] }, { items: [{ id: '1', name: 1 }] }, { items: [{ id: '1', name: 'x', extra: 1 }] }, { other: [] }])
    await assert.rejects(() => startServer({ database: { data, schema: model } }));
  const links = { ...definition({ link: { type: 'Other', source: 'otherId', required: true } }), Other: { collection: 'other', fields: { id: { type: 'string', primary: true } } } };
  for (const row of [{ id: '1' }, { id: '1', otherId: 'missing' }]) await assert.rejects(() => startServer({ database: { data: { items: [row], other: [] }, schema: links } }));
  const singular = {
    ...definition({ link: { type: 'Other', source: 'code', target: 'code' }, code: { type: 'string' } }),
    Other: { collection: 'other', fields: { id: { type: 'string', primary: true }, code: { type: 'string' } } },
  };
  await assert.rejects(
    () =>
      startServer({
        database: {
          schema: singular,
          data: {
            items: [{ id: '1', code: 'x' }],
            other: [
              { id: 'a', code: 'x' },
              { id: 'b', code: 'x' },
            ],
          },
        },
      }),
    /Multiple targets/,
  );
});

test('OpenAPI 3.0 nullable references and enum constraints accept actual null responses', async () => {
  const { Ajv } = await import('ajv');
  const model = definition({
    state: { type: 'string', nullable: true, enum: ['on', 'off'] },
    parent: { type: 'Item', source: 'parentId' },
    profile: { type: 'object', nullable: true },
    'profile.name': { type: 'string' },
  });
  const facade = await facadeFor(model);
  const document = await facade.openapi();
  const validator = new Ajv({ strict: false });
  validator.addSchema({ $id: 'contract', components: document.components });
  const validate = validator.compile({ $ref: 'contract#/components/schemas/Item' });
  assert.equal(validate({ id: '1', state: null, parent: null, profile: null }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ id: '1', state: 'invalid', parent: null, profile: null }), false);
  assert.equal(document.components.schemas.ItemCreate.properties.state.nullable, true);
});
