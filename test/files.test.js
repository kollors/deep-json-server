import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createServer } from '../dist/index.js';
import { createMemoryFileStore } from '../dist/src/files/memory-store.js';

const withDiskServer = async (run) => {
  const rootPath = await mkdtemp(join(tmpdir(), 'deep-json-server-files-'));
  const databasePath = join(rootPath, 'database.json');
  const filesPath = join(rootPath, 'files');
  const metadataPath = join(rootPath, 'files.json');

  await writeFile(databasePath, JSON.stringify({ items: [{ id: '1' }] }));

  const facade = await createServer({
    database: { path: databasePath },
    files: { directory: filesPath, metadata: metadataPath },
    server: { logger: false },
  });
  const server = facade.fastify();

  try {
    await server.ready();
    await run({ databasePath, filesPath, metadataPath, rootPath, server });
  } finally {
    await server.close();
    await rm(rootPath, { force: true, recursive: true });
  }
};

test('rejects overwriting a directory without moving its files or metadata', async () => {
  await withDiskServer(async ({ filesPath, metadataPath, server }) => {
    const upload = await server.inject({
      headers: { 'content-directory': 'album', 'content-name': 'old.txt', 'content-type': 'text/plain' },
      method: 'POST',
      payload: 'original',
      url: '/_files/storage',
    });

    assert.equal(upload.statusCode, 201);
    const metadata = await readFile(metadataPath, 'utf8');
    const entries = await readdir(filesPath);

    for (const override of ['false', 'true']) {
      const response = await server.inject({
        headers: { 'content-name': 'album', 'content-override': override, 'content-type': 'text/plain' },
        method: 'POST',
        payload: 'replacement',
        url: '/_files/storage',
      });

      assert.equal(response.statusCode, 400, response.body);
      assert.equal((await lstat(join(filesPath, 'album'))).isDirectory(), true);
      assert.equal(await readFile(join(filesPath, 'album', 'old.txt'), 'utf8'), 'original');
      assert.equal(await readFile(metadataPath, 'utf8'), metadata);
      assert.deepEqual(await readdir(filesPath), entries);
      assert.deepEqual(await readdir(join(filesPath, '.deep-json-server')), []);
      assert.equal((await server.inject(upload.json().url)).body, 'original');
      assert.equal((await server.inject(upload.json().metadataUrl)).statusCode, 200);
    }
  });
});

test('rejects registered paths replaced externally with directories', async () => {
  await withDiskServer(async ({ filesPath, metadataPath, server }) => {
    const upload = await server.inject({
      headers: { 'content-name': 'file.txt', 'content-type': 'text/plain' },
      method: 'POST',
      payload: 'original',
      url: '/_files/storage',
    });

    assert.equal(upload.statusCode, 201);
    const file = upload.json();
    const path = join(filesPath, 'file.txt');
    const metadata = await readFile(metadataPath, 'utf8');

    await rm(path);
    await mkdir(path);
    await writeFile(join(path, 'keep.txt'), 'keep');

    for (const request of [
      { url: file.url },
      { url: file.metadataUrl },
      { url: file.downloadUrl },
      { method: 'PATCH', payload: { name: 'renamed.txt' }, url: file.url },
      { method: 'DELETE', url: file.url },
    ]) {
      const response = await server.inject(request);

      assert.equal(response.statusCode, 400, response.body);
    }

    assert.equal(await readFile(join(path, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(metadataPath, 'utf8'), metadata);
  });
});

test('does not follow symbolic links outside disk storage', async () => {
  await withDiskServer(async ({ filesPath, rootPath, server }) => {
    const outsidePath = join(rootPath, 'outside');

    await mkdir(outsidePath);
    await symlink(outsidePath, join(filesPath, 'escape'), 'dir');

    const response = await server.inject({
      headers: { 'content-directory': 'escape', 'content-name': 'file.txt', 'content-type': 'text/plain' },
      method: 'POST',
      payload: 'outside',
      url: '/_files/storage',
    });

    assert.equal(response.statusCode, 400);
    await assert.rejects(() => access(join(outsidePath, 'file.txt')), { code: 'ENOENT' });

    const nestedResponse = await server.inject({
      headers: { 'content-directory': 'escape/created', 'content-name': 'nested.txt', 'content-type': 'text/plain' },
      method: 'POST',
      payload: 'outside',
      url: '/_files/storage',
    });

    assert.equal(nestedResponse.statusCode, 400);
    await assert.rejects(() => access(join(outsidePath, 'created')), { code: 'ENOENT' });
  });
});

test('keeps file routes independent from an invalid resource database', async () => {
  await withDiskServer(async ({ databasePath, server }) => {
    const uploadResponse = await server.inject({
      headers: { 'content-name': 'file.txt', 'content-type': 'text/plain' },
      method: 'POST',
      payload: 'content',
      url: '/_files/storage',
    });

    await writeFile(databasePath, '{ invalid json');

    const metadataResponse = await server.inject({ method: 'GET', url: uploadResponse.json().metadataUrl });
    const resourceResponse = await server.inject({ method: 'GET', url: '/items' });

    assert.equal(metadataResponse.statusCode, 200);
    assert.equal(resourceResponse.statusCode, 500);
    assert.deepEqual(resourceResponse.json(), { error: 'Внутренняя ошибка сервера' });
  });
});

test('restores an overwritten file when metadata persistence fails', async () => {
  await withDiskServer(async ({ metadataPath, server }) => {
    const headers = { 'content-name': 'file.txt', 'content-type': 'text/plain' };
    const uploadResponse = await server.inject({ headers, method: 'POST', payload: 'original', url: '/_files/storage' });

    await rm(metadataPath);
    await mkdir(metadataPath);

    const overwriteResponse = await server.inject({
      headers: { ...headers, 'content-override': 'true' },
      method: 'POST',
      payload: 'replacement',
      url: '/_files/storage',
    });
    const contentResponse = await server.inject({ method: 'GET', url: uploadResponse.json().url });

    assert.equal(overwriteResponse.statusCode, 500);
    assert.equal(contentResponse.rawPayload.toString(), 'original');
  });
});

test('does not hold the mutation queue while reading an upload stream', async () => {
  const store = createMemoryFileStore([{ content: new Uint8Array([1]), mimeType: 'application/octet-stream', name: 'existing.bin' }]);
  let continueUpload;
  let uploadStarted;
  const started = new Promise((resolve) => (uploadStarted = resolve));
  const continuation = new Promise((resolve) => (continueUpload = resolve));
  const stream = Readable.from(
    (async function* () {
      uploadStarted();
      await continuation;
      yield Buffer.from('new');
    })(),
  );
  const upload = store.upload({ directory: '', maxFileSize: 100, mimeType: 'text/plain', name: 'new.txt', override: false, stream });

  await started;
  assert.equal((await store.metadata('existing.bin')).name, 'existing.bin');
  continueUpload();
  await upload;
});

test('rejects an oversized duplicate before reading its body', async () => {
  const facade = await createServer({
    database: { data: { items: [] } },
    files: { data: [{ content: new Uint8Array([1]), mimeType: 'application/octet-stream', name: 'existing.bin' }] },
    server: { logger: false, maxFileSize: 1 },
  });
  const server = facade.fastify();

  try {
    const response = await server.inject({
      headers: { 'content-name': 'existing.bin', 'content-type': 'application/octet-stream' },
      method: 'POST',
      payload: Buffer.from([1, 2]),
      url: '/_files/storage',
    });

    assert.equal(response.statusCode, 413);
  } finally {
    await server.close();
  }
});

test('supports update and delete in memory and validates stored MIME types', async () => {
  const config = {
    database: { data: { items: [] } },
    files: { data: [{ content: new Uint8Array([1]), directory: 'old', mimeType: 'image/jpeg', name: 'file.jpg' }] },
    server: { logger: false },
  };
  const facade = await createServer(config);
  const server = facade.fastify();

  try {
    const updateResponse = await server.inject({ method: 'PATCH', payload: { directory: 'new', name: 'renamed.jpg' }, url: '/_files/storage/old/file.jpg' });
    const deleteResponse = await server.inject({ method: 'DELETE', url: updateResponse.json().url });

    assert.equal(updateResponse.statusCode, 200);
    assert.equal(deleteResponse.statusCode, 204);
    assert.equal((await server.inject({ method: 'GET', url: updateResponse.json().metadataUrl })).statusCode, 404);
  } finally {
    await server.close();
  }

  await assert.rejects(() => createServer({ database: { data: { items: [] } }, files: { data: [{ content: new Uint8Array(), mimeType: 'invalid', name: 'file.bin' }] } }), /mimeType.*MIME-тип/);
});

test('rejects file names that are not portable across supported platforms', async () => {
  const facade = await createServer({ database: { data: { items: [] } }, files: { data: [] }, server: { logger: false } });
  const server = facade.fastify();

  try {
    for (const name of ['CON', 'NUL.txt', 'file.', 'file ', 'file:name.txt']) {
      const response = await server.inject({ headers: { 'content-name': name, 'content-type': 'text/plain' }, method: 'POST', payload: 'content', url: '/_files/storage' });

      assert.equal(response.statusCode, 400, name);
    }
  } finally {
    await server.close();
  }
});

test('does not initialize disk file storage when only OpenAPI is generated', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'deep-json-server-openapi-only-'));
  const filesPath = join(rootPath, 'files');
  const facade = await createServer(
    {
      database: { data: { items: [] } },
      files: { directory: filesPath, metadata: join(rootPath, 'metadata.json') },
    },
    { files: true },
  );

  try {
    await facade.openapi();
    await assert.rejects(() => access(filesPath), { code: 'ENOENT' });
  } finally {
    await rm(rootPath, { force: true, recursive: true });
  }
});
