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
    { countryId: '1', fullName: 'Alexander Petrov', id: '1' },
    { countryId: '2', fullName: 'Ryan Gosling', id: '2' },
  ],
};

const withServer = async(run) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-'));
  const databasePath = join(directory, 'database.json');

  await writeFile(databasePath, JSON.stringify(fixture));

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
      query: { _where: JSON.stringify({ actors: { some: { userId: { eq: '1' } } }, title: { contains: 'father' } }) },
      url: '/movies',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().map(({ title }) => title), ['The Godfather']);
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
    const listResponse = await server.inject({ method: 'GET', query: { _page: 1, _perPage: 1, _sort: '-id' }, url: '/movies' });

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
