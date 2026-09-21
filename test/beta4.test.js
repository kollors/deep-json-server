import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { createServer, generateGraphql, generateOpenapi } from '../dist/index.js';
import { createDatabaseStore } from '../dist/src/core/database.js';
import { Engine } from '../dist/src/core/engine.js';
import { loadModel } from '../dist/src/core/model.js';
import { cloneSnapshot, freezeSnapshot } from '../dist/src/core/snapshot.js';
import { createHttpServer } from '../dist/src/server/http.js';

const packagePath = new URL('../package.json', import.meta.url).pathname;
const packageSource = { name: 'test-api', version: '1.0.0' };
const schema = (fields = {}) => ({
  models: { Note: { collection: 'notes', fields: { id: { type: 'number', primary: true, generated: 'increment' }, name: { type: 'string', required: true }, ...fields } } },
});
const temp = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-beta4-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

for (const storage of ['memory', 'file']) {
  test(`${storage}: async transaction failures roll back, successful callbacks finish before the next transaction`, async (t) => {
    const path = join(await temp(t), 'db.json');
    const data = { notes: [{ id: 1, name: 'before' }] };
    await writeFile(path, JSON.stringify(data));
    const store = await createDatabaseStore({ source: storage === 'file' ? path : data });
    await assert.rejects(
      store.update(async (draft) => {
        draft.data.notes[0].name = 'rejected';
        await Promise.resolve();
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.deepEqual(await store.read(), data);
    if (storage === 'file') assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data);
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const first = store.update(async (draft) => {
      draft.data.notes[0].name = 'pending';
      started.resolve();
      await release.promise;
      draft.data.notes[0].name = 'committed';
      return 'result';
    });
    await started.promise;
    assert.deepEqual(await store.read(), data);
    const second = store.update((draft) => {
      assert.equal(draft.data.notes[0].name, 'committed');
      draft.data.notes.push({ id: 2, name: 'second' });
    });
    release.resolve();
    assert.equal(await first, 'result');
    await second;
    assert.deepEqual(
      (await store.read()).notes.map((row) => row.name),
      ['committed', 'second'],
    );
    assert.throws(() => {
      store.database.data = data;
    }, TypeError);
    assert.throws(() => {
      store.database = { data };
    }, TypeError);
    assert.throws(() => {
      store.database.data.notes[0].name = 'forged';
    }, TypeError);
  });

  test(`${storage}: every mutation waits for response preparation and rolls back a rejected response`, async (t) => {
    const path = join(await temp(t), 'db.json');
    const data = { notes: [{ id: 1, name: 'before' }] };
    await writeFile(path, JSON.stringify(data));
    const store = await createDatabaseStore({ source: storage === 'file' ? path : data });
    const model = await loadModel(schema());
    const engine = new Engine(store, model);
    const entity = model.entities[0];
    for (const mode of ['create', 'update', 'replace', 'delete']) {
      await assert.rejects(
        engine.mutate(entity, mode, mode === 'create' ? undefined : 1, { name: 'rejected' }, async () => {
          await Promise.resolve();
          throw new Error('response failed');
        }),
        /response failed/,
      );
      assert.deepEqual(await store.read(), data, mode);
      if (storage === 'file') assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data, mode);
    }
    const output = await engine.mutate(entity, 'create', undefined, { name: 'saved' }, async (ref) => {
      await Promise.resolve();
      return { id: ref.value.id, name: ref.value.name };
    });
    assert.deepEqual(output, { id: 2, name: 'saved' });
    assert.equal((await store.read()).notes.length, 2);
  });
}

test('snapshot freezing visits shallow-frozen ancestors and cloning produces independent mutable data', () => {
  const child = { tags: ['old'] };
  const source = Object.freeze({
    notes: [
      { id: 1, child },
      { id: 2, child },
    ],
  });
  const snapshot = freezeSnapshot(source);
  assert.equal(snapshot, source);
  assert.throws(() => child.tags.push('forged'), TypeError);
  assert.equal(freezeSnapshot(snapshot), snapshot);
  const copy = cloneSnapshot(snapshot);
  copy.notes[0].child.tags.push('copy');
  assert.deepEqual(snapshot.notes[0].child.tags, ['old']);
});

for (const callback of [false, true]) {
  test(`listen uses the requested Unix socket (callback=${callback})`, { skip: process.platform === 'win32' }, async (t) => {
    const socketPath = join(await temp(t), 'server.sock');
    const app = (await createServer({ storage: 'memory', database: { source: { notes: [] } }, server: { port: 0, logger: false } })).fastify();
    t.after(() => app.close());
    try {
      if (callback) await new Promise((resolve, reject) => app.listen({ path: socketPath }, (error) => (error ? reject(error) : resolve())));
      else await app.listen({ path: socketPath });
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      t.skip('The environment does not allow Unix sockets');
      return;
    }
    assert.equal(app.server.address(), socketPath);
    const body = await new Promise((resolve, reject) => {
      const req = request({ socketPath, path: '/notes' }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(JSON.parse(body)));
        response.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.deepEqual(body, { data: [], total: 0 });
  });
}

test('listen preserves Unix options and applies TCP defaults only to TCP calls', async (t) => {
  const calls = [];
  const create = (options) => {
    const app = Fastify(options);
    app.listen = (options, callback) => {
      calls.push(options);
      if (callback) callback(null, 'address');
      else return Promise.resolve('address');
    };
    return app;
  };
  const app = createHttpServer({ create, host: '127.0.0.1', port: 4001, logger: false, cors: false, corsHeaders: {} });
  t.after(() => app.close());
  const unix = { path: '/tmp/socket', readableAll: true };
  assert.equal(await app.listen(unix), 'address');
  await new Promise((resolve, reject) => app.listen(unix, (error) => (error ? reject(error) : resolve())));
  assert.deepEqual(calls, [unix, unix]);
  await app.listen({ port: 0 });
  await app.listen();
  await new Promise((resolve, reject) => app.listen((error) => (error ? reject(error) : resolve())));
  assert.deepEqual(calls.slice(2), [
    { host: '127.0.0.1', port: 0 },
    { host: '127.0.0.1', port: 4001 },
    { host: '127.0.0.1', port: 4001 },
  ]);
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

test('query helpers do not load model file readers or validators', () => {
  const url = new URL('../dist/src/core/query/execute.js', import.meta.url).href;
  const script = `
    import { registerHooks } from 'node:module';
    const seen = new Set();
    const hook = registerHooks({ resolve(name, context, next) { seen.add(name); return next(name, context); } });
    await import(${JSON.stringify(url)});
    hook.deregister();
    process.stdout.write(JSON.stringify([...seen]));
  `;
  const dependencies = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  for (const name of ['ajv', 'ajv-formats', 'node:fs/promises', 'fastify', 'graphql', 'mercurius']) assert.equal(dependencies.includes(name), false, name);
});
