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
    { actors: [{ genreIds: ['2', '3'], userId: '1', uuid: 'actor-1' }], id: '1', publisherIds: ['2'], title: 'The Godfather' },
    { actors: [{ genreIds: ['4'], userId: '2', uuid: 'actor-2' }], id: '2', publisherIds: ['1'], title: 'Barbie' },
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

const withServer = async(run, data = fixture) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-'));
  const databasePath = join(directory, 'database.json');

  await writeFile(databasePath, JSON.stringify(data));

  const server = await createServer({ databasePath, logger: false });

  try {
    await run({ databasePath, server });
  } finally {
    await server.close();
    await rm(directory, { force: true, recursive: true });
  }
};

test('filters nested fields and combines conditions with AND', async() => {
  await withServer(async({ server }) => {
    const response = await server.inject({
      method: 'GET',
      query: { _where: JSON.stringify({ actors: { some: { and: [{ userId: { eq: '1' } }, { genreIds: { some: { eq: '2' } } }] } }, title: { contains: 'father' } }) },
      url: '/movies',
    });

    const emptyAndResponse = await server.inject({ method: 'GET', query: { _where: JSON.stringify({ and: [] }) }, url: '/movies' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.map(({ title }) => title), ['The Godfather']);
    assert.equal(emptyAndResponse.json().items, 2);
  });
});

test('parses primitive filters and rejects invalid filters', async() => {
  await withServer(async({ server }) => {
    const amountResponse = await server.inject({ method: 'GET', query: { amount: '20' }, url: '/items' });
    const idResponse = await server.inject({ method: 'GET', query: { id: '1' }, url: '/items' });
    const codeResponse = await server.inject({ method: 'GET', query: { code: '001' }, url: '/items' });
    const unknownSimpleOperatorResponse = await server.inject({ method: 'GET', query: { 'name:contain': 'Original' }, url: '/items' });
    const unknownWhereOperatorResponse = await server.inject({ method: 'GET', query: { _where: JSON.stringify({ name: { contain: 'Original' } }) }, url: '/items' });
    const invalidLogicalOperatorResponse = await server.inject({ method: 'GET', query: { _where: JSON.stringify({ or: {} }) }, url: '/items' });
    const invalidPathResponse = await server.inject({ method: 'GET', query: { 'name..value': 'Original' }, url: '/items' });
    const invalidArrayOperatorResponse = await server.inject({ method: 'GET', query: { _where: JSON.stringify({ name: { some: { eq: 'Original' } } }) }, url: '/items' });
    const invalidStringOperatorResponse = await server.inject({ method: 'GET', query: { _where: JSON.stringify({ amount: { startsWith: '2' } }) }, url: '/items' });

    assert.equal(amountResponse.json().items, 1);
    assert.equal(idResponse.json().items, 1);
    assert.equal(codeResponse.json().items, 1);
    assert.equal(unknownSimpleOperatorResponse.statusCode, 400);
    assert.equal(unknownWhereOperatorResponse.statusCode, 400);
    assert.equal(invalidLogicalOperatorResponse.statusCode, 400);
    assert.equal(invalidPathResponse.statusCode, 400);
    assert.equal(invalidArrayOperatorResponse.statusCode, 400);
    assert.equal(invalidStringOperatorResponse.statusCode, 400);
  }, { items: [{ amount: 20, code: '001', id: '1', name: 'Original' }] });
});

test('rejects invalid pagination values', async() => {
  await withServer(async({ server }) => {
    for (const query of [{ _page: 'abc' }, { _page: '0' }, { _page: '1.5' }, { _perPage: '-1' }, { _perPage: '0' }]) {
      const response = await server.inject({ method: 'GET', query, url: '/movies' });

      assert.equal(response.statusCode, 400);
    }
  });
});

test('embeds direct, nested, reverse and self relations', async() => {
  await withServer(async({ server }) => {
    const movieResponse = await server.inject({ method: 'GET', query: { _embed: ['actors.user.country', 'actors.genres', 'publishers'] }, url: '/movies/1' });
    const countryResponse = await server.inject({ method: 'GET', query: { _embed: 'users' }, url: '/countries/1' });
    const genreResponse = await server.inject({ method: 'GET', query: { _embed: 'parents' }, url: '/genres/2' });
    const movie = movieResponse.json();

    assert.equal(movie.actors[0].user.fullName, 'Alexander Petrov');
    assert.equal(movie.actors[0].user.country.name, 'Russia');
    assert.deepEqual(movie.actors[0].genres.map(({ name }) => name), ['Gangster film', 'Drama']);
    assert.equal(movie.publishers[0].name, 'Paramount Pictures');
    assert.equal(countryResponse.json().users[0].fullName, 'Alexander Petrov');
    assert.equal(genreResponse.json().parents[0].name, 'Crime');
  });
});

test('supports pagination, sorting and persistent CRUD', async() => {
  await withServer(async({ databasePath, server }) => {
    const defaultListResponse = await server.inject({ method: 'GET', url: '/movies' });
    const listResponse = await server.inject({ method: 'GET', query: { _page: 1, _perPage: 1, _sort: '-id' }, url: '/movies' });

    assert.equal(defaultListResponse.json().items, 2);
    assert.equal(defaultListResponse.json().data.length, 2);
    assert.equal(listResponse.json().items, 2);
    assert.equal(listResponse.json().data[0].id, '2');

    const createResponse = await server.inject({ method: 'POST', payload: { name: 'Universal Pictures' }, url: '/publishers' });
    const createdPublisher = createResponse.json();
    const publisherCount = fixture.publishers.length + 1;
    const updateResponse = await server.inject({ method: 'PATCH', payload: { name: 'Universal' }, url: `/publishers/${createdPublisher.id}` });

    assert.equal(createResponse.statusCode, 201);
    assert.equal(updateResponse.json().name, 'Universal');

    const database = JSON.parse(await readFile(databasePath, 'utf8'));

    assert.equal(database.publishers.length, publisherCount);
    assert.equal(database.publishers.at(-1).name, 'Universal');
  });
});

test('serializes writes and preserves the stored ID type', async() => {
  await withServer(async({ databasePath, server }) => {
    await Promise.all([
      server.inject({ method: 'PATCH', payload: { left: true }, url: '/items/1' }),
      server.inject({ method: 'PATCH', payload: { right: true }, url: '/items/1' }),
    ]);

    const patchedDatabase = JSON.parse(await readFile(databasePath, 'utf8'));
    const replaceResponse = await server.inject({ method: 'PUT', payload: { name: 'Replaced' }, url: '/items/1' });
    const createResponses = await Promise.all(Array.from({ length: 20 }, (_, index) => server.inject({ method: 'POST', payload: { name: `Item ${index}` }, url: '/items' })));
    const database = JSON.parse(await readFile(databasePath, 'utf8'));

    assert.equal(patchedDatabase.items[0].left, true);
    assert.equal(patchedDatabase.items[0].right, true);
    assert.equal(replaceResponse.json().id, 1);
    assert.equal(typeof replaceResponse.json().id, 'number');
    assert.equal(createResponses.every(({ statusCode }) => statusCode === 201), true);
    assert.equal(database.items.length, 21);
    assert.equal(database.items[0].id, 1);
    assert.equal(typeof database.items[0].id, 'number');
  }, { items: [{ id: 1, name: 'Original' }] });
});

test('rejects a missing file and invalid database structures', async() => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-invalid-'));
  const databasePath = join(directory, 'database.json');

  try {
    await assert.rejects(() => createServer({ databasePath, logger: false }), /Файл базы данных не найден/);

    await writeFile(databasePath, '[]');
    await assert.rejects(() => createServer({ databasePath, logger: false }), /JSON-объект/);

    await writeFile(databasePath, JSON.stringify({ items: {} }));
    await assert.rejects(() => createServer({ databasePath, logger: false }), /JSON-массив/);

    await writeFile(databasePath, JSON.stringify({ $schema: './database-schema.json', items: [] }));
    await assert.rejects(() => createServer({ databasePath, logger: false }), /Ресурс «\$schema» должен содержать JSON-массив/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
