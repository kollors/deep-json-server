import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, hashPassword } from '../dist/index.js';
import { validateDirectory, validateName } from '../dist/src/files/contract.js';
import { createDiskFileStore } from '../dist/src/files/disk-store.js';
import { createMemoryFileStore } from '../dist/src/files/memory-store.js';

const temporary = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-file-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const start = async (t, config) => {
  const app = (await createServer({ ...config, server: { logger: false } })).fastify();
  t.after(() => app.close());
  await app.ready();
  return app;
};

test('file uploads and moves keep both auth symlink paths protected after login replaces the link', async (t) => {
  const directory = await temporary(t);
  const storage = join(directory, 'storage');
  const alias = join(directory, 'storage-alias');
  await mkdir(storage);
  await symlink(storage, alias, 'dir');
  const database = join(directory, 'database.json');
  const target = join(storage, 'original-users.json');
  const source = join(alias, 'users.json');
  const users = JSON.stringify([{ id: 'admin', username: 'admin', passwordHash: await hashPassword('password'), isAdmin: true }]);
  await writeFile(database, '{"items":[]}');
  await writeFile(target, users);
  await symlink(target, source);
  const app = await start(t, { storage: 'file', database: { source: database }, files: { source: storage }, auth: { source } });
  const upload = (name, payload = '[]') => app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-type': 'text/plain', 'content-name': name, 'content-override': 'true' }, payload });
  assert.equal((await upload('safe.txt', 'original')).statusCode, 201);
  assert.equal((await upload('users.json')).statusCode, 400);
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'password' } });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal((await lstat(source)).isSymbolicLink(), false);
  const savedUsers = await readFile(source, 'utf8');
  assert.equal(JSON.parse(savedUsers)[0].sessions.length, 1);
  for (const name of ['users.json', 'original-users.json']) {
    const response = await upload(name);
    assert.equal(response.statusCode, 400, response.body);
    const moved = await app.inject({ method: 'PATCH', url: '/_files/storage/safe.txt', payload: { name } });
    assert.equal(moved.statusCode, 400, moved.body);
  }
  assert.equal(await readFile(source, 'utf8'), savedUsers);
  assert.equal(await readFile(target, 'utf8'), users);
  assert.equal((await app.inject('/_files/storage/safe.txt')).body, 'original');
});

test('file metadata symlink remains reserved after metadata persistence replaces it', async (t) => {
  const directory = await temporary(t);
  const alias = join(directory, 'storage-alias');
  await symlink(directory, alias, 'dir');
  const database = join(directory, 'database.json');
  const metadata = join(directory, 'metadata.json');
  const target = join(directory, 'original-metadata.json');
  await writeFile(database, '{"items":[]}');
  await writeFile(target, '[]');
  await symlink(target, metadata);
  const app = await start(t, { storage: 'file', database: { source: database }, files: { source: alias, metadata } });
  const upload = (name) => app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-type': 'text/plain', 'content-name': name, 'content-override': 'true' }, payload: 'original' });
  assert.equal((await upload('safe.txt')).statusCode, 201);
  assert.equal((await lstat(metadata)).isSymbolicLink(), false);
  const savedMetadata = await readFile(metadata, 'utf8');
  for (const name of ['metadata.json', 'original-metadata.json']) assert.equal((await upload(name)).statusCode, 400);
  assert.equal(await readFile(metadata, 'utf8'), savedMetadata);
  assert.equal(await readFile(target, 'utf8'), '[]');
});

test('malformed Unicode cannot rename or move files in memory or on disk', async (t) => {
  for (const storage of ['memory', 'file']) {
    await t.test(storage, async (t) => {
      const directory = await temporary(t);
      const database = join(directory, 'database.json');
      const files = join(directory, 'files');
      const metadata = join(directory, 'metadata.json');
      await writeFile(database, '{"items":[]}');
      const app = await start(
        t,
        storage === 'file' ? { storage, database: { source: database }, files: { source: files, metadata } } : { storage, database: { source: { items: [] } }, files: { source: [] } },
      );
      const uploaded = await app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-type': 'text/plain', 'content-name': 'original.txt' }, payload: 'original' });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
      const file = uploaded.json();
      const savedMetadata = storage === 'file' ? await readFile(metadata, 'utf8') : undefined;
      const entries = storage === 'file' ? await readdir(files) : undefined;
      for (const value of ['\ud800', '\udc00', 'x\ud800y', '\udc00\ud800']) {
        for (const payload of [{ name: value }, { directory: `folder/${value}` }]) {
          const response = await app.inject({ method: 'PATCH', url: file.url, payload });
          assert.equal(response.statusCode, 400, response.body);
          assert.equal((await app.inject(file.url)).body, 'original');
          assert.deepEqual((await app.inject(file.metadataUrl)).json(), file);
        }
      }
      if (storage === 'file') {
        assert.equal(await readFile(metadata, 'utf8'), savedMetadata);
        assert.deepEqual(await readdir(files), entries);
      }
      const valid = await app.inject({ method: 'PATCH', url: file.url, payload: { directory: '📁', name: '📄.txt' } });
      assert.equal(valid.statusCode, 200, valid.body);
      assert.equal((await app.inject(valid.json().url)).body, 'original');
    });
  }
});

test('initial file metadata rejects malformed Unicode in names and directories', async (t) => {
  const directory = await temporary(t);
  const metadata = join(directory, 'metadata.json');
  for (const invalid of [{ name: '\ud800' }, { directory: 'folder/\udc00' }]) {
    const file = { content: Buffer.from('original'), directory: '', mimeType: 'text/plain', name: 'file.txt', ...invalid };
    assert.throws(() => createMemoryFileStore([file]), /safe file name/);
    await writeFile(metadata, JSON.stringify([{ directory: file.directory, mimeType: file.mimeType, name: file.name }]));
    await assert.rejects(() => createDiskFileStore({ directory: join(directory, 'files'), metadata }), /safe file name/);
  }
  assert.throws(() => validateName('\ud800', 'name'), /safe file name/);
  assert.throws(() => validateDirectory('folder/\udc00', 'directory'), /safe file name/);
  assert.equal(validateName('📄.txt', 'name'), '📄.txt');
  assert.equal(validateDirectory('📁/photos', 'directory'), '📁/photos');
});
