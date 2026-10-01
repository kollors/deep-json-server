import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, link, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../dist/index.js';

const temporary = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const database = async (directory, name = 'database.json') => {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify({ items: [] }));
  return path;
};
const server = async (t, source, config = {}) => {
  const app = (await createServer({ storage: 'file', database: { source }, ...config, server: { logger: false } })).fastify();
  t.after(() => app.close());
  return { app };
};
const missing = (path) => assert.rejects(() => access(path), { code: 'ENOENT' });
const nextMessage = (child) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', message);
      child.off('error', error);
      child.off('exit', exit);
    };
    const message = (value) => {
      cleanup();
      resolve(value);
    };
    const error = (value) => {
      cleanup();
      reject(value);
    };
    const exit = (code, signal) => error(new Error(`Lock worker exited before its reply: ${code ?? signal}`));
    child.once('message', message);
    child.once('error', error);
    child.once('exit', exit);
  });
const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
};
const worker = async (t, source) => {
  const script = `
    import { createServer } from './dist/index.js';
    let app;
    process.on('message', async () => {
      try {
        app = (await createServer({ storage: 'file', database: { source: process.argv[1] }, server: { logger: false } })).fastify();
        await app.ready();
        process.send({ state: 'ready', pid: process.pid });
      } catch (error) {
        await app?.close();
        process.send({ state: 'blocked', message: error.message });
      }
    });
    process.send({ state: 'waiting' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, source], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => stop(child));
  assert.equal((await nextMessage(child)).state, 'waiting');
  return child;
};
const run = (child) => {
  const message = nextMessage(child);
  child.send('start');
  return message;
};

test('a second server cannot open the same database and a crashed owner leaves a recoverable lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-lock-'));
  const databasePath = join(directory, 'database.json');
  await writeFile(databasePath, JSON.stringify({ items: [] }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const script = `
    import { createServer } from './dist/index.js';
    const facade = await createServer({ storage: 'file', database: { source: process.argv[1] }, server: { logger: false } });
    await facade.fastify().ready();
    process.send('READY');
    setInterval(() => {}, 1000000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, databasePath], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const started = await new Promise((resolve, reject) => {
    child.once('message', (message) => resolve(String(message)));
    child.once('exit', (code) => reject(new Error(`Lock owner exited before startup: ${code}`)));
    child.once('error', reject);
  });
  assert.match(started, /READY/);

  const blocked = (await createServer({ storage: 'file', database: { source: databasePath }, server: { logger: false } })).fastify();
  await assert.rejects(() => blocked.ready(), /already in use/);
  await blocked.close();
  assert.deepEqual(JSON.parse(await readFile(databasePath, 'utf8')), { items: [] });

  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const restarted = (await createServer({ storage: 'file', database: { source: databasePath }, server: { logger: false } })).fastify();
  await restarted.ready();
  assert.equal((await restarted.inject('/items')).statusCode, 200);
  await restarted.close();
});

test('one readable lock file excludes another server in the same process and is removed on close', async (t) => {
  const directory = await temporary(t);
  const source = await database(directory, 'catalog.json');
  const path = join(directory, 'catalog-lock.json');
  const { app: first } = await server(t, source);
  await first.ready();
  assert.equal((await lstat(path)).isFile(), true);
  const owner = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(owner.type, 'deep-json-server-lock');
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.token, 'string');
  assert.ok(owner.token.length > 0);
  assert.deepEqual((await readdir(directory)).sort(), ['catalog-lock.json', 'catalog.json']);
  const { app: second } = await server(t, source);
  await assert.rejects(() => second.ready(), /already in use/);
  await second.close();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), owner);
  assert.equal((await first.inject('/items')).statusCode, 200);
  await Promise.all([first.close(), first.close()]);
  await missing(path);
  const { app: restarted } = await server(t, source);
  await restarted.ready();
  assert.notEqual(JSON.parse(await readFile(path, 'utf8')).token, owner.token);
  await restarted.close();
  await missing(path);
});

test('after SIGKILL concurrent restarts elect exactly one owner and leave the database intact', { timeout: 20000 }, async (t) => {
  const directory = await temporary(t);
  const source = await database(directory);
  const original = await readFile(source, 'utf8');
  const initial = await worker(t, source);
  assert.equal((await run(initial)).state, 'ready');
  const previous = JSON.parse(await readFile(join(directory, 'database-lock.json'), 'utf8'));
  await stop(initial);
  const contenders = await Promise.all(Array.from({ length: 4 }, () => worker(t, source)));
  try {
    const results = await Promise.all(contenders.map(run));
    const winners = results.filter(({ state }) => state === 'ready');
    assert.equal(winners.length, 1, JSON.stringify(results));
    for (const result of results.filter(({ state }) => state === 'blocked')) assert.match(result.message, /already in use/);
    const owner = JSON.parse(await readFile(join(directory, 'database-lock.json'), 'utf8'));
    assert.equal(owner.pid, winners[0].pid);
    assert.notEqual(owner.token, previous.token);
    assert.equal(await readFile(source, 'utf8'), original);
  } finally {
    await Promise.all(contenders.map(stop));
  }
  const { app: restarted } = await server(t, source);
  await restarted.ready();
  assert.equal((await restarted.inject('/items')).statusCode, 200);
  await restarted.close();
  await missing(join(directory, 'database-lock.json'));
});

test('abandoned empty and partially written lock files recover without a recovery directory', async (t) => {
  const directory = await temporary(t);
  const source = await database(directory);
  const path = join(directory, 'database-lock.json');
  for (const content of ['', '{"type":"deep-json-ser', '{"type":"deep-json-server-lock","pid":']) {
    await writeFile(path, content);
    const { app } = await server(t, source);
    await app.ready();
    const owner = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.type, 'deep-json-server-lock');
    assert.equal((await app.inject('/items')).statusCode, 200);
    await app.close();
    await missing(path);
  }
  assert.deepEqual(await readdir(directory), ['database.json']);
});

test('unrelated JSON and symbolic or hard links at the lock path are preserved', async (t) => {
  for (const kind of ['json', 'symlink', 'hardlink']) {
    await t.test(kind, async (t) => {
      const directory = await temporary(t);
      const source = await database(directory);
      const path = join(directory, 'database-lock.json');
      const target = join(directory, 'keep.json');
      const content = '{"keep":"unchanged"}';
      await writeFile(target, content);
      if (kind === 'json') await writeFile(path, content);
      if (kind === 'symlink') await symlink(target, path);
      if (kind === 'hardlink') await link(target, path);
      const before = await lstat(path);
      const { app } = await server(t, source);
      await assert.rejects(() => app.ready());
      await app.close();
      const after = await lstat(path);
      assert.equal(after.ino, before.ino);
      assert.equal(after.isSymbolicLink(), before.isSymbolicLink());
      assert.equal(await readFile(path, 'utf8'), content);
      assert.equal(await readFile(target, 'utf8'), content);
      assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { items: [] });
    });
  }
});

test('a shared auth source rejects another database and releases locks acquired before the conflict', async (t) => {
  const directory = await temporary(t);
  const firstSource = await database(directory, 'first.json');
  const secondSource = await database(directory, 'a-second.json');
  const auth = join(directory, 'z-auth.json');
  await writeFile(auth, '[]');
  const { app: first } = await server(t, firstSource, { auth: { source: auth } });
  await first.ready();
  const { app: second } = await server(t, secondSource, { auth: { source: auth } });
  await assert.rejects(() => second.ready(), /already in use/);
  await missing(join(directory, 'a-second-lock.json'));
  await second.close();
  assert.equal(JSON.parse(await readFile(join(directory, 'z-auth-lock.json'), 'utf8')).pid, process.pid);
  assert.equal(await readFile(auth, 'utf8'), '[]');
  await first.close();
  const { app: restarted } = await server(t, secondSource, { auth: { source: auth } });
  await restarted.ready();
  await restarted.close();
  await missing(join(directory, 'z-auth-lock.json'));
});

test('startup failure releases every acquired lock before a corrected server is started', async (t) => {
  const directory = await temporary(t);
  const source = await database(directory);
  const auth = join(directory, 'users.json');
  await writeFile(auth, '{}');
  const { app: failed } = await server(t, source, { auth: { source: auth } });
  await assert.rejects(() => failed.ready(), /Auth users must be an array/);
  await missing(join(directory, 'database-lock.json'));
  await missing(join(directory, 'users-lock.json'));
  await writeFile(auth, '[]');
  const { app: corrected } = await server(t, source, { auth: { source: auth } });
  await corrected.ready();
  await failed.close();
  assert.equal((await corrected.inject('/items')).statusCode, 200);
  await corrected.close();
});

test('shared file storage roots or metadata exclude independent database servers', async (t) => {
  for (const shared of ['root', 'metadata']) {
    await t.test(shared, async (t) => {
      const directory = await temporary(t);
      const firstSource = await database(directory, 'first.json');
      const secondSource = await database(directory, 'second.json');
      const firstFiles = { source: join(directory, 'files'), metadata: join(directory, 'metadata.json') };
      const secondFiles =
        shared === 'root' ? { source: firstFiles.source, metadata: join(directory, 'other-metadata.json') } : { source: join(directory, 'other-files'), metadata: firstFiles.metadata };
      const { app: first } = await server(t, firstSource, { files: firstFiles });
      await first.ready();
      const { app: second } = await server(t, secondSource, { files: secondFiles });
      await assert.rejects(() => second.ready(), /already in use/);
      await second.close();
      const response = await first.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': 'keep.txt', 'content-type': 'text/plain' }, payload: 'keep' });
      assert.equal(response.statusCode, 201, response.body);
      await first.close();
      const { app: restarted } = await server(t, secondSource, { files: secondFiles });
      await restarted.ready();
      await restarted.close();
      assert.equal(await readFile(join(firstFiles.source, 'keep.txt'), 'utf8'), 'keep');
    });
  }
});

test('a generated lock path cannot overwrite a configured input file', async (t) => {
  const directory = await temporary(t);
  const source = await database(directory);
  const auth = join(directory, 'database-lock.json');
  await writeFile(auth, '[]');
  const { app } = await server(t, source, { auth: { source: auth } });
  await assert.rejects(() => app.ready(), /overwrite an input file/);
  await app.close();
  assert.equal(await readFile(auth, 'utf8'), '[]');
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { items: [] });
});
