import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, generateGraphql, generateOpenapi } from '../dist/index.js';
import { loadModel } from '../dist/src/core/model.js';

const packagePath = new URL('../package.json', import.meta.url).pathname;
const packageSource = { name: 'test-api', version: '1.0.0' };
const schema = (fields = {}) => ({
  models: { Note: { collection: 'notes', fields: { id: { type: 'number', primary: true, generated: 'increment' }, name: { type: 'string', required: true }, ...fields } } },
});

test('invalid enum values fail during model loading and both API generations', async () => {
  const invalid = [
    { type: 'string', enum: [1, 2] },
    { type: 'number', enum: ['1'] },
    { type: 'boolean', enum: [0] },
    { type: 'string[]', enum: [['a']] },
    { type: 'string', nullable: true, enum: [null] },
    { type: 'number', enum: [NaN] },
    { type: 'number', minimum: 2, enum: [1, 2] },
    { type: 'string', minLength: 2, enum: ['a', 'bc'] },
  ];
  for (const field of invalid) {
    const model = schema({ state: field });
    await assert.rejects(loadModel(model), /Invalid enum\[0\]: Note.state/);
    await assert.rejects(generateOpenapi(model, { packagePath }), /Invalid enum\[0\]: Note.state/);
    await assert.rejects(generateGraphql(model), /Invalid enum\[0\]: Note.state/);
  }
});

test('valid nullable enums and enum arrays agree between REST, GraphQL and OpenAPI', async (t) => {
  const model = schema({ state: { type: 'string', nullable: true, enum: ['on', 'off'] }, tags: { type: 'string[]', enum: ['a', 'b'] } });
  const app = (
    await createServer({ storage: 'memory', database: { source: { notes: [] }, schema: model }, graphql: {}, openapi: {}, package: { source: packageSource }, server: { logger: false } })
  ).fastify();
  t.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/notes', payload: { name: 'rest', state: null, tags: ['a'] } });
  assert.equal(created.statusCode, 201, created.body);
  const result = await app.inject({ method: 'POST', url: '/graphql', payload: { query: 'mutation { noteCreate(data: { name: "graphql", state: on, tags: [b] }) { id state tags } }' } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().data.noteCreate, { id: 2, state: 'on', tags: ['b'] });
  const doc = (await app.inject('/openapi.json')).json();
  assert.deepEqual(doc.components.schemas.Note.properties.state.enum, ['on', 'off', null]);
  assert.equal(doc.components.schemas.Note.properties.state.nullable, true);
  assert.deepEqual(doc.components.schemas.Note.properties.tags.items.enum, ['a', 'b']);
});
