import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../index.js';

const fixture = {
  countries: [
    { id: '1', name: 'Russia' },
    { id: '2', name: 'United States' },
  ],
  genres: [
    { id: '1', name: 'Crime', parentIds: [] },
    { id: '2', name: 'Gangster film', parentIds: ['1'] },
    { id: '3', name: 'Drama', parentIds: [] },
    { id: '4', name: 'Comedy', parentIds: [] },
  ],
  movies: [
    { actors: [{ genreIds: ['2', '3'], id: 'actor-1', userId: '1' }], id: '1', publisherIds: ['2'], title: 'The Godfather' },
    { actors: [{ genreIds: ['4'], id: 'actor-2', userId: '2' }], id: '2', publisherIds: ['1'], title: 'Barbie' },
  ],
  publishers: [
    { id: '1', name: 'Warner Bros.' },
    { id: '2', name: 'Paramount Pictures' },
  ],
  users: [
    { country: { id: 'stale', name: 'Stale country' }, countryId: '1', fullName: 'Alexander Petrov', id: '1' },
    { countryId: '2', fullName: 'Ryan Gosling', id: '2' },
  ],
};

const withServer = async (run, data = fixture, schemaConfig, serverOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-'));
  const databasePath = join(directory, 'database.json');
  const filesDirectoryPath = serverOptions.files === true ? join(directory, 'files') : undefined;
  const filesMetadataPath = serverOptions.files === true ? join(directory, 'files', '_database.json') : undefined;
  const schemaPath = schemaConfig == null ? undefined : join(directory, 'database-schema.json');
  const { files: _files, ...options } = serverOptions;

  await writeFile(databasePath, JSON.stringify(data));

  if (schemaPath != null) {
    await writeFile(schemaPath, JSON.stringify(schemaConfig));
  }

  const serverFacade = await createServer({
    database: { path: databasePath, schema: schemaPath },
    files: serverOptions.files === true ? { directory: filesDirectoryPath, metadata: filesMetadataPath } : undefined,
    server: { ...options, logger: false },
  });
  const server = serverFacade.fastify();

  try {
    await run({ databasePath, filesDirectoryPath, filesMetadataPath, server });
  } finally {
    await server.close();
    await rm(directory, { force: true, recursive: true });
  }
};

test('uploads, reads, moves, downloads and deletes binary files', async () => {
  await withServer(
    async ({ filesDirectoryPath, filesMetadataPath, server }) => {
      const payload = Buffer.from([0, 1, 2, 3, 255]);
      const uploadResponse = await server.inject({
        headers: { 'content-directory': 'posters', 'content-name': encodeURIComponent('Крёстный отец.jpg'), 'content-type': 'image/jpeg' },
        method: 'POST',
        payload,
        url: '/_files/storage',
      });
      const uploadedFile = uploadResponse.json();
      const contentResponse = await server.inject({ method: 'GET', url: uploadedFile.url });
      const metadataResponse = await server.inject({ method: 'GET', url: uploadedFile.metadataUrl });
      const encodedPathMetadataResponse = await server.inject({ method: 'GET', url: `/_files/metadata/${encodeURIComponent('posters/Крёстный отец.jpg')}` });
      const downloadResponse = await server.inject({ method: 'GET', url: uploadedFile.url });
      const storedMetadata = JSON.parse(await readFile(filesMetadataPath, 'utf8'));
      const storedContent = await readFile(join(filesDirectoryPath, 'posters', 'Крёстный отец.jpg'));
      const attachmentResponse = await server.inject({ method: 'GET', url: uploadedFile.downloadUrl });
      const updateResponse = await server.inject({
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
        payload: { directory: 'archive', name: 'godfather.jpg' },
        url: uploadedFile.url,
      });
      const updatedFile = updateResponse.json();
      const oldLocationResponse = await server.inject({ method: 'GET', url: uploadedFile.url });
      const updatedContentResponse = await server.inject({ method: 'GET', url: updatedFile.url });
      const deleteResponse = await server.inject({ method: 'DELETE', url: updatedFile.url });
      const missingResponse = await server.inject({ method: 'GET', url: updatedFile.url });

      assert.equal(uploadResponse.statusCode, 201);
      assert.deepEqual(uploadedFile, {
        directory: 'posters',
        downloadUrl: `/_files/download/posters/${encodeURIComponent('Крёстный отец.jpg')}`,
        metadataUrl: `/_files/metadata/posters/${encodeURIComponent('Крёстный отец.jpg')}`,
        mimeType: 'image/jpeg',
        name: 'Крёстный отец.jpg',
        size: payload.length,
        url: `/_files/storage/posters/${encodeURIComponent('Крёстный отец.jpg')}`,
      });
      assert.equal(contentResponse.statusCode, 200);
      assert.equal(contentResponse.headers['content-type'], 'image/jpeg');
      assert.match(contentResponse.headers['content-disposition'], /^inline; filename\*=UTF-8''/);
      assert.deepEqual(contentResponse.rawPayload, payload);
      assert.deepEqual(metadataResponse.json(), uploadedFile);
      assert.deepEqual(encodedPathMetadataResponse.json(), uploadedFile);
      assert.equal(downloadResponse.statusCode, 200);
      assert.deepEqual(downloadResponse.rawPayload, payload);
      assert.match(attachmentResponse.headers['content-disposition'], /^attachment; filename\*=UTF-8''/);
      assert.deepEqual(attachmentResponse.rawPayload, payload);
      assert.deepEqual(storedMetadata, [{ directory: 'posters', mimeType: 'image/jpeg', name: 'Крёстный отец.jpg' }]);
      assert.deepEqual(storedContent, payload);
      assert.equal(updateResponse.statusCode, 200);
      assert.equal(updatedFile.directory, 'archive');
      assert.equal(updatedFile.name, 'godfather.jpg');
      assert.equal(oldLocationResponse.statusCode, 404);
      assert.deepEqual(updatedContentResponse.rawPayload, payload);
      assert.equal(deleteResponse.statusCode, 204);
      assert.equal(deleteResponse.body, '');
      assert.equal(missingResponse.statusCode, 404);
    },
    { items: [{ id: '1', name: 'One' }] },
    undefined,
    { files: true },
  );
});

test('rejects duplicate file paths and overwrites them only when requested', async () => {
  await withServer(
    async ({ server }) => {
      const filePayload = Buffer.from('{"value":true}');
      const headers = { 'content-name': 'data.json', 'content-type': 'application/json' };
      const uploadResponse = await server.inject({ headers, method: 'POST', payload: filePayload, url: '/_files/storage' });
      const duplicateResponse = await server.inject({ headers, method: 'POST', payload: 'duplicate', url: '/_files/storage' });
      const overwriteResponse = await server.inject({ headers: { ...headers, 'content-override': 'true' }, method: 'POST', payload: 'updated', url: '/_files/storage' });
      const createResponse = await server.inject({ method: 'POST', payload: { name: 'Two' }, url: '/items' });

      assert.equal(uploadResponse.statusCode, 201);
      assert.equal(duplicateResponse.statusCode, 409);
      assert.equal(overwriteResponse.statusCode, 200);
      assert.equal((await server.inject({ method: 'GET', url: overwriteResponse.json().url })).rawPayload.toString(), 'updated');
      assert.equal(createResponse.statusCode, 201);
      assert.equal(createResponse.json().name, 'Two');
    },
    { items: [{ id: '1', name: 'One' }] },
    undefined,
    { files: true },
  );
});

test('reads file size from disk and validates move destinations', async () => {
  await withServer(
    async ({ filesDirectoryPath, filesMetadataPath, server }) => {
      const upload = (name, payload) =>
        server.inject({ headers: { 'content-directory': 'files', 'content-name': name, 'content-type': 'text/plain' }, method: 'POST', payload, url: '/_files/storage' });
      const firstFile = (await upload('first.txt', 'first')).json();

      await upload('second.txt', 'second');
      await writeFile(join(filesDirectoryPath, 'files', 'first.txt'), 'externally changed');

      const metadataResponse = await server.inject({ method: 'GET', url: firstFile.metadataUrl });
      const conflictResponse = await server.inject({
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
        payload: { name: 'second.txt' },
        url: firstFile.url,
      });
      const invalidResponses = await Promise.all([
        server.inject({ headers: { 'content-type': 'application/json' }, method: 'PATCH', payload: {}, url: firstFile.url }),
        server.inject({ headers: { 'content-type': 'application/json' }, method: 'PATCH', payload: { unknown: true }, url: firstFile.url }),
        server.inject({ headers: { 'content-type': 'text/plain' }, method: 'PATCH', payload: '{}', url: firstFile.url }),
      ]);
      const storedMetadata = JSON.parse(await readFile(filesMetadataPath, 'utf8'));

      assert.equal(metadataResponse.json().size, Buffer.byteLength('externally changed'));
      assert.equal(conflictResponse.statusCode, 409);
      assert.deepEqual(
        invalidResponses.map(({ statusCode }) => statusCode),
        [400, 400, 415],
      );
      assert.equal(
        storedMetadata.every((file) => !Object.hasOwn(file, 'size')),
        true,
      );
    },
    { items: [] },
    undefined,
    { files: true },
  );
});

test('validates file headers, size and optional feature state', async () => {
  await withServer(
    async ({ server }) => {
      assert.equal((await server.inject({ headers: { 'content-type': 'application/octet-stream' }, method: 'POST', payload: 'file', url: '/_files/storage' })).statusCode, 404);
    },
    { items: [] },
  );

  await withServer(
    async ({ server }) => {
      const requests = [
        { expectedStatus: 400, headers: { 'content-type': 'application/octet-stream' }, payload: 'file' },
        { expectedStatus: 400, headers: { 'content-name': '../file.txt', 'content-type': 'text/plain' }, payload: 'file' },
        { expectedStatus: 400, headers: { 'content-directory': '../files', 'content-name': 'file.txt', 'content-type': 'text/plain' }, payload: 'file' },
        { expectedStatus: 400, headers: { 'content-name': 'file.txt', 'content-override': 'yes', 'content-type': 'text/plain' }, payload: 'file' },
        { expectedStatus: 400, headers: { 'content-name': '%E0%A4%A', 'content-type': 'text/plain' }, payload: 'file' },
        { expectedStatus: 415, headers: { 'content-name': 'file.txt', 'content-type': 'invalid' }, payload: 'file' },
      ];

      for (const { expectedStatus, ...request } of requests) {
        const response = await server.inject({ ...request, method: 'POST', url: '/_files/storage' });

        assert.equal(response.statusCode, expectedStatus);
      }

      const largeResponse = await server.inject({ headers: { 'content-name': 'large.bin', 'content-type': 'application/octet-stream' }, method: 'POST', payload: '12345', url: '/_files/storage' });
      const originalResponse = await server.inject({ headers: { 'content-name': 'safe.bin', 'content-type': 'application/octet-stream' }, method: 'POST', payload: '1234', url: '/_files/storage' });
      const failedOverrideResponse = await server.inject({
        headers: { 'content-name': 'safe.bin', 'content-override': 'true', 'content-type': 'application/octet-stream' },
        method: 'POST',
        payload: '12345',
        url: '/_files/storage',
      });

      assert.equal(largeResponse.statusCode, 413);
      assert.equal(originalResponse.statusCode, 201);
      assert.equal(failedOverrideResponse.statusCode, 413);
      assert.equal((await server.inject({ method: 'GET', url: originalResponse.json().url })).rawPayload.toString(), '1234');
    },
    { items: [] },
    undefined,
    { files: true, maxFileSize: 4 },
  );
});

test('filters nested fields and combines conditions with AND, OR and NOT', async () => {
  await withServer(async ({ server }) => {
    const response = await server.inject({
      method: 'GET',
      query: { _where: JSON.stringify({ actors: { some: { and: [{ userId: { eq: '1' } }, { genreIds: { some: { eq: '2' } } }] } }, title: { contains: 'father' } }) },
      url: '/movies',
    });
    const orResponse = await server.inject({ method: 'GET', query: { _where: JSON.stringify({ or: [{ title: { startsWith: 'Bar' } }, { title: { endsWith: 'father' } }] }) }, url: '/movies' });
    const notResponse = await server.inject({ method: 'GET', query: { _where: JSON.stringify({ not: { title: { eq: 'Barbie' } } }) }, url: '/movies' });
    const emptyAndResponse = await server.inject({ method: 'GET', query: { _where: JSON.stringify({ and: [] }) }, url: '/movies' });

    assert.deepEqual(
      response.json().data.map(({ title }) => title),
      ['The Godfather'],
    );
    assert.equal(orResponse.json().total, 2);
    assert.deepEqual(
      notResponse.json().data.map(({ title }) => title),
      ['The Godfather'],
    );
    assert.equal(emptyAndResponse.json().total, 2);
  });
});

test('supports every field operator', async () => {
  const data = {
    items: [
      { amount: 10, children: [{ score: 2 }, { score: 4 }], code: '001', id: '1', name: 'Alpha', status_eq: 'enabled', tags: ['a', 'b'] },
      { amount: 20, children: [], code: '002', id: '2', name: 'Beta', status_eq: 'disabled', tags: ['b'] },
    ],
  };

  await withServer(async ({ server }) => {
    const conditions = [
      { amount: { gt: 15 } },
      { amount: { gte: 20 } },
      { amount: { in: [10] } },
      { amount: { lt: 15 } },
      { amount: { lte: 10 } },
      { amount: { ne: 20 } },
      { amount: { not: { eq: 20 } } },
      { children: { none: { score: { gt: 4 } } } },
      { children: { some: { score: { eq: 4 } } } },
      { name: { contains: 'lph' } },
      { name: { endsWith: 'pha' } },
      { name: { startsWith: 'Al' } },
      { tags: { every: { in: ['b'] } } },
    ];

    for (const condition of conditions) {
      const response = await server.inject({ method: 'GET', query: { _where: JSON.stringify(condition) }, url: '/items' });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().total >= 1, true);
    }

    const simpleResponse = await server.inject({ method: 'GET', query: { amount: '20', code: '002' }, url: '/items' });
    const inResponse = await server.inject({ method: 'GET', query: { 'id:in': '1,2' }, url: '/items' });
    const underscoreFieldResponse = await server.inject({ method: 'GET', query: { status_eq: 'enabled' }, url: '/items' });

    assert.deepEqual(
      simpleResponse.json().data.map(({ id }) => id),
      ['2'],
    );
    assert.equal(inResponse.json().total, 2);
    assert.deepEqual(
      underscoreFieldResponse.json().data.map(({ id }) => id),
      ['1'],
    );
  }, data);
});

test('rejects invalid filters, sorting, embeds and pagination', async () => {
  await withServer(
    async ({ server }) => {
      const queries = [
        { 'name:contain': 'Original' },
        { _where: JSON.stringify({ name: { contain: 'Original' } }) },
        { _where: JSON.stringify({ or: {} }) },
        { 'name..value': 'Original' },
        { _where: JSON.stringify({ name: { some: { eq: 'Original' } } }) },
        { _where: JSON.stringify({ amount: { startsWith: '2' } }) },
        { _page: 'abc' },
        { _page: '0' },
        { _page: '1.5' },
        { _perPage: '-1' },
        { _perPage: '1001' },
        { _sort: 'missing' },
        { _sort: '__proto__' },
        { _embed: 'missing' },
        { _embed: 'children..owner' },
      ];

      for (const query of queries) {
        const response = await server.inject({ method: 'GET', query, url: '/items' });

        assert.equal(response.statusCode, 400, JSON.stringify(query));
      }
    },
    { items: [{ amount: 20, code: '001', id: '1', name: 'Original' }] },
  );
});

test('returns an empty page without silently clamping an out-of-range page', async () => {
  await withServer(async ({ server }) => {
    const firstPage = (await server.inject({ method: 'GET', query: { _page: 1, _perPage: 1 }, url: '/movies' })).json();
    const lastPage = (await server.inject({ method: 'GET', query: { _page: 2, _perPage: 1 }, url: '/movies' })).json();
    const response = await server.inject({ method: 'GET', query: { _page: 100, _perPage: 1 }, url: '/movies' });
    const page = response.json();

    assert.equal(firstPage.data.length, 1);
    assert.equal(firstPage.total, 2);
    assert.equal(lastPage.data.length, 1);
    assert.equal(lastPage.total, 2);
    assert.deepEqual(page.data, []);
    assert.equal(page.total, 2);
  });
});

test('embeds direct, nested, reverse and self relations', async () => {
  await withServer(async ({ server }) => {
    const movieResponse = await server.inject({ method: 'GET', query: { _embed: ['actors.user.country', 'actors.genres', 'publishers'] }, url: '/movies/1' });
    const countryResponse = await server.inject({ method: 'GET', query: { _embed: 'users' }, url: '/countries/1' });
    const genreResponse = await server.inject({ method: 'GET', query: { _embed: 'parents' }, url: '/genres/2' });
    const movie = movieResponse.json();

    assert.equal(movie.actors[0].user.fullName, 'Alexander Petrov');
    assert.equal(movie.actors[0].user.country.name, 'Russia');
    assert.deepEqual(
      movie.actors[0].genres.map(({ name }) => name),
      ['Gangster film', 'Drama'],
    );
    assert.equal(movie.publishers[0].name, 'Paramount Pictures');
    assert.equal(countryResponse.json().users[0].fullName, 'Alexander Petrov');
    assert.equal(genreResponse.json().parents[0].name, 'Crime');
  });
});

test('supports root discovery, CORS, sorting and persistent CRUD', async () => {
  await withServer(async ({ databasePath, server }) => {
    const rootResponse = await server.inject({ method: 'GET', url: '/' });
    const optionsResponse = await server.inject({ method: 'OPTIONS', url: '/movies' });
    const listResponse = await server.inject({ method: 'GET', query: { _page: 1, _perPage: 1, _sort: '-id' }, url: '/movies' });
    const createResponse = await server.inject({ method: 'POST', payload: { name: 'Universal Pictures' }, url: '/publishers' });
    const createdPublisher = createResponse.json();
    const patchResponse = await server.inject({ method: 'PATCH', payload: { name: 'Universal' }, url: `/publishers/${createdPublisher.id}` });
    const putResponse = await server.inject({ method: 'PUT', payload: { name: 'Universal International' }, url: `/publishers/${createdPublisher.id}` });
    const deleteResponse = await server.inject({ method: 'DELETE', url: `/publishers/${createdPublisher.id}` });

    assert.deepEqual(rootResponse.json().resources, Object.keys(fixture));
    assert.equal(optionsResponse.statusCode, 204);
    assert.equal(optionsResponse.headers['access-control-allow-origin'], '*');
    assert.match(optionsResponse.headers['access-control-allow-headers'], /Content-Name/);
    assert.match(optionsResponse.headers['access-control-allow-headers'], /Content-Directory/);
    assert.match(optionsResponse.headers['access-control-allow-headers'], /Content-Override/);
    assert.equal(listResponse.json().data[0].id, '2');
    assert.equal(createResponse.statusCode, 201);
    assert.equal(patchResponse.json().name, 'Universal');
    assert.equal(putResponse.json().name, 'Universal International');
    assert.equal(deleteResponse.json().id, createdPublisher.id);

    const storedDatabase = JSON.parse(await readFile(databasePath, 'utf8'));

    assert.equal(storedDatabase.publishers.length, fixture.publishers.length);
  });
});

test('returns 404 for missing records across CRUD methods', async () => {
  await withServer(
    async ({ server }) => {
      for (const request of [
        { method: 'GET', url: '/items/missing' },
        { method: 'PUT', payload: { name: 'Missing' }, url: '/items/missing' },
        { method: 'PATCH', payload: { name: 'Missing' }, url: '/items/missing' },
        { method: 'DELETE', url: '/items/missing' },
      ]) {
        const response = await server.inject(request);

        assert.equal(response.statusCode, 404);
      }

      assert.equal((await server.inject({ method: 'GET', url: '/unknown' })).statusCode, 404);
    },
    { items: [{ id: '1', name: 'Original' }] },
  );
});

test('validates POST, PUT and PATCH bodies against the configured schema', async () => {
  await withServer(
    async ({ server }) => {
      const missingRequiredResponse = await server.inject({ method: 'POST', payload: { count: 2 }, url: '/items' });
      const invalidCreateResponse = await server.inject({ method: 'POST', payload: { count: 'two', name: 'Two' }, url: '/items' });
      const invalidPutResponse = await server.inject({ method: 'PUT', payload: { count: 2 }, url: '/items/1' });
      const invalidPatchResponse = await server.inject({ method: 'PATCH', payload: { count: 'two' }, url: '/items/1' });
      const invalidFormatResponse = await server.inject({ method: 'POST', payload: { count: 2, name: 'Two', website: 'invalid' }, url: '/items' });
      const validCreateResponse = await server.inject({ method: 'POST', payload: { count: 2, name: 'Two', website: 'https://example.com/two' }, url: '/items' });

      assert.equal(missingRequiredResponse.statusCode, 400);
      assert.equal(invalidCreateResponse.statusCode, 400);
      assert.equal(invalidPutResponse.statusCode, 400);
      assert.equal(invalidPatchResponse.statusCode, 400);
      assert.equal(invalidFormatResponse.statusCode, 400);
      assert.equal(validCreateResponse.statusCode, 201);
    },
    { items: [{ count: 1, id: '1', name: 'One', website: 'https://example.com/one' }] },
    { $schema: { items: { formats: { website: 'uri' }, required: ['name'] } } },
  );
});

test('serializes concurrent writes and preserves stored numeric IDs', async () => {
  await withServer(
    async ({ databasePath, server }) => {
      await Promise.all([server.inject({ method: 'PATCH', payload: { left: true }, url: '/items/1' }), server.inject({ method: 'PATCH', payload: { right: true }, url: '/items/1' })]);

      const patchedDatabase = JSON.parse(await readFile(databasePath, 'utf8'));
      const replaceResponse = await server.inject({ method: 'PUT', payload: { name: 'Replaced' }, url: '/items/1' });
      const createResponses = await Promise.all(Array.from({ length: 20 }, (_, index) => server.inject({ method: 'POST', payload: { name: `Item ${index}` }, url: '/items' })));
      const storedDatabase = JSON.parse(await readFile(databasePath, 'utf8'));

      assert.equal(patchedDatabase.items[0].left, true);
      assert.equal(patchedDatabase.items[0].right, true);
      assert.equal(replaceResponse.json().id, 1);
      assert.equal(
        createResponses.every(({ statusCode }) => statusCode === 201),
        true,
      );
      assert.equal(storedDatabase.items.length, 21);
      assert.equal(typeof storedDatabase.items[0].id, 'number');
    },
    { items: [{ id: 1, name: 'Original' }] },
  );
});

test('supports in-memory database, schema and files without mutating config', async () => {
  const database = { items: [{ id: '1', name: 'Original' }] };
  const content = new Uint8Array([1, 2, 3, 255]);
  const config = {
    database: {
      data: database,
      schema: { $info: { title: 'Memory API', version: '1.0.0' }, $schema: { items: { required: ['name'] } } },
    },
    files: { data: [{ content, directory: 'initial', mimeType: 'application/octet-stream', name: 'file.bin' }] },
    server: { logger: false },
  };
  const serverFacade = await createServer(config);
  const server = serverFacade.fastify();

  try {
    assert.equal(serverFacade.fastify(), server);
    assert.deepEqual((await server.inject({ method: 'GET', url: '/items/1' })).json(), database.items[0]);
    assert.deepEqual((await server.inject({ method: 'GET', url: '/_files/storage/initial/file.bin' })).rawPayload, Buffer.from(content));

    const patchResponse = await server.inject({ method: 'PATCH', payload: { name: 'Changed' }, url: '/items/1' });
    const uploadResponse = await server.inject({ headers: { 'content-name': 'new.bin', 'content-type': 'application/octet-stream' }, method: 'POST', payload: 'new', url: '/_files/storage' });

    assert.equal(patchResponse.json().name, 'Changed');
    assert.equal(uploadResponse.statusCode, 201);
    assert.equal(database.items[0].name, 'Original');
    assert.deepEqual(content, new Uint8Array([1, 2, 3, 255]));
  } finally {
    await server.close();
  }
});

test('rejects missing files, unsafe resources and malformed or ambiguous records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-invalid-'));
  const databasePath = join(directory, 'database.json');

  try {
    await assert.rejects(() => createServer({ database: { path: databasePath }, server: { logger: false } }), /не найден/);

    for (const data of [[], { items: {} }, { items: [null] }, { items: [{ name: 'Missing ID' }] }, { items: [{ id: true }] }, { items: [{ id: 1 }, { id: '1' }] }, { 'bad/name': [] }]) {
      await writeFile(databasePath, JSON.stringify(data));
      await assert.rejects(() => createServer({ database: { path: databasePath }, server: { logger: false } }));
    }

    await assert.rejects(() => createServer({ database: { data: { items: [] }, path: databasePath } }), /ровно один/);
    await assert.rejects(() => createServer({ database: { data: { items: [] } }, files: { data: [], directory: 'files', metadata: 'files.json' } }), /либо config\.files\.data/);
    await assert.rejects(() => createServer({ database: { data: { items: [] } }, files: { data: [{ content: 'invalid', mimeType: 'text/plain', name: 'file.txt' }] } }), /config\.files\.data/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects values that cannot be represented in JSON', async () => {
  const cyclicRecord = { id: '1' };

  cyclicRecord.self = cyclicRecord;

  for (const value of [1n, undefined, () => undefined, Symbol('value'), Number.NaN, Number.POSITIVE_INFINITY, new Date(), cyclicRecord]) {
    const data = value === cyclicRecord ? { items: [value] } : { items: [{ id: '1', value }] };

    await assert.rejects(() => createServer({ database: { data }, server: { logger: false } }), /JSON|конечное число|обычный JSON-объект|циклическую ссылку/);
  }
});

test('starts on an ephemeral port and validates server options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-listen-'));
  const databasePath = join(directory, 'database.json');
  const filesDirectoryPath = join(directory, 'files');
  const filesMetadataPath = join(directory, 'files', '_database.json');

  await writeFile(databasePath, JSON.stringify({ items: [{ id: '1', name: 'One' }] }));

  try {
    const serverFacade = await createServer({
      database: { path: databasePath },
      files: { directory: filesDirectoryPath, metadata: filesMetadataPath },
      server: { host: '127.0.0.1', logger: false, port: 0 },
    });
    const server = serverFacade.fastify();

    await server.listen();
    const address = server.server.address();
    const filePayload = Buffer.from([0, 1, 2, 255]);
    const uploadResponse = await fetch(`http://127.0.0.1:${address.port}/_files/storage`, {
      body: filePayload,
      headers: { 'Content-Name': 'network.bin', 'Content-Type': 'application/octet-stream' },
      method: 'POST',
    });
    const uploadedFile = await uploadResponse.json();
    const downloadResponse = await fetch(`http://127.0.0.1:${address.port}${uploadedFile.url}`);

    assert.equal((await server.inject({ method: 'GET', url: '/items/1' })).statusCode, 200);
    assert.equal(uploadResponse.status, 201);
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), filePayload);
    await server.close();
    await assert.rejects(() => createServer({ database: { path: databasePath }, server: { logger: false, port: -1 } }), /config\.server\.port/);
    await assert.rejects(() => createServer({ database: { path: databasePath }, server: { logger: false, maxPageSize: 0 } }), /maxPageSize/);
    await assert.rejects(() => createServer({ database: { path: databasePath }, server: { logger: false, maxFileSize: 0 } }), /maxFileSize/);
    await assert.rejects(() => createServer({ database: { path: databasePath }, files: { directory: '', metadata: filesMetadataPath }, server: { logger: false } }), /config\.files\.directory/);
    await assert.rejects(() => createServer({ database: { path: databasePath }, files: { directory: filesDirectoryPath }, server: { logger: false } }), /config\.files\.metadata/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
