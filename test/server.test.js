import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer, startServer } from '../index.js';

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

const withServer = async (run, data = fixture, schemaConfig) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-'));
  const databasePath = join(directory, 'database.json');
  const schemaPath = schemaConfig == null ? undefined : join(directory, 'database-schema.json');

  await writeFile(databasePath, JSON.stringify(data));

  if (schemaPath != null) {
    await writeFile(schemaPath, JSON.stringify(schemaConfig));
  }

  const server = await createServer({ databasePath, logger: false, schemaPath });

  try {
    await run({ databasePath, server });
  } finally {
    await server.close();
    await rm(directory, { force: true, recursive: true });
  }
};

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
    assert.equal(orResponse.json().items, 2);
    assert.deepEqual(
      notResponse.json().data.map(({ title }) => title),
      ['The Godfather'],
    );
    assert.equal(emptyAndResponse.json().items, 2);
  });
});

test('supports every field operator', async () => {
  const data = {
    items: [
      { amount: 10, children: [{ score: 2 }, { score: 4 }], code: '001', id: '1', name: 'Alpha', tags: ['a', 'b'] },
      { amount: 20, children: [], code: '002', id: '2', name: 'Beta', tags: ['b'] },
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
      assert.equal(response.json().items >= 1, true);
    }

    const simpleResponse = await server.inject({ method: 'GET', query: { amount: '20', code: '002' }, url: '/items' });
    const inResponse = await server.inject({ method: 'GET', query: { 'id:in': '1,2' }, url: '/items' });

    assert.deepEqual(
      simpleResponse.json().data.map(({ id }) => id),
      ['2'],
    );
    assert.equal(inResponse.json().items, 2);
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
    const response = await server.inject({ method: 'GET', query: { _page: 100, _perPage: 1 }, url: '/movies' });
    const page = response.json();

    assert.deepEqual(page.data, []);
    assert.equal(page.last, 2);
    assert.equal(page.prev, 2);
    assert.equal(page.next, null);
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

test('rejects missing files, unsafe resources and malformed or ambiguous records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-invalid-'));
  const databasePath = join(directory, 'database.json');

  try {
    await assert.rejects(() => createServer({ databasePath, logger: false }), /не найден/);

    for (const data of [[], { items: {} }, { items: [null] }, { items: [{ name: 'Missing ID' }] }, { items: [{ id: true }] }, { items: [{ id: 1 }, { id: '1' }] }, { 'bad/name': [] }]) {
      await writeFile(databasePath, JSON.stringify(data));
      await assert.rejects(() => createServer({ databasePath, logger: false }));
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('starts on an ephemeral port and validates server options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-listen-'));
  const databasePath = join(directory, 'database.json');

  await writeFile(databasePath, JSON.stringify({ items: [{ id: '1', name: 'One' }] }));

  try {
    const server = await startServer({ databasePath, logger: false, port: 0 });

    assert.equal((await server.inject({ method: 'GET', url: '/items/1' })).statusCode, 200);
    await server.close();
    await assert.rejects(() => startServer({ databasePath, logger: false, port: -1 }), /Порт/);
    await assert.rejects(() => createServer({ databasePath, logger: false, maxPageSize: 0 }), /Максимальный/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
