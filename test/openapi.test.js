import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { generateOpenApi } from '../index.js';
import { runCli } from '../src/cli.js';
import { isMainModule } from '../src/utils.js';

const database = {
  clothes: [{ id: '1', name: 'Suit' }],
  countries: [{ id: '1', name: 'Russia' }],
  genres: [{ id: '1', name: 'Crime', parentIds: [] }, { id: '2', name: 'Drama', parentIds: ['1'] }],
  movies: [
    { actors: [{ clothesIds: ['1'], genreIds: ['2'], id: 'actor-1', userId: '1' }], coverSrc: 'https://example.com/cover.jpg', description: 'Description', id: '1', publisherIds: ['1'], title: 'Movie' },
    { actors: [], coverSrc: 'https://example.com/cover-2.jpg', id: '2', publisherIds: [], title: 'Movie 2' },
  ],
  publishers: [{ id: '1', name: 'Publisher' }],
  users: [{ avatarSrc: 'https://example.com/avatar.jpg', bornAt: '1989-01-25', countryId: '1', fullName: 'Actor', id: '1' }],
};
const schemaConfig = {
  movies: { formats: { coverSrc: 'uri' }, optional: ['description'] },
  users: { formats: { avatarSrc: 'uri', bornAt: 'date' } },
};

const withFiles = async(run) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-openapi-'));
  const databasePath = join(directory, 'database.json');
  const schemaPath = join(directory, 'database-schema.json');
  const outputPath = join(directory, 'openapi-schema.yaml');

  await writeFile(databasePath, JSON.stringify(database));
  await writeFile(schemaPath, JSON.stringify(schemaConfig));

  try {
    await run({ databasePath, outputPath, schemaPath });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

test('generates OpenAPI schemas, CRUD paths, formats and inferred relations', async() => {
  await withFiles(async({ databasePath, outputPath, schemaPath }) => {
    await generateOpenApi({ databasePath, outputPath, schemaPath });

    const document = parse(await readFile(outputPath, 'utf8'));
    const movie = document.components.schemas.Movie;
    const actor = movie.properties.actors.items;

    assert.equal(document.openapi, '3.0.3');
    assert.equal(movie.properties.coverSrc.format, 'uri');
    assert.ok(!movie.required.includes('description'));
    assert.equal(document.components.schemas.User.properties.bornAt.format, 'date');
    assert.equal(movie.properties.publishers.items.$ref, '#/components/schemas/Publisher');
    assert.equal(actor.properties.clothes.items.$ref, '#/components/schemas/Clothes');
    assert.equal(actor.properties.user.$ref, '#/components/schemas/User');
    assert.equal(actor.properties.genres.items.$ref, '#/components/schemas/Genre');
    assert.equal(document.components.schemas.Genre.properties.parents.items.$ref, '#/components/schemas/Genre');
    assert.equal(document.paths['/movies'].get.operationId, 'getMovies');
    assert.equal(document.paths['/movies/{id}'].patch.operationId, 'updateMovie');
  });
});

test('generates OpenAPI through CLI and exits without starting the server', async() => {
  await withFiles(async({ databasePath, outputPath, schemaPath }) => {
    await runCli([databasePath, '--generate', schemaPath, outputPath]);

    assert.equal(parse(await readFile(outputPath, 'utf8')).openapi, '3.0.3');
  });
});

test('recognizes the CLI entry point invoked through a node_modules symlink', async() => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-bin-'));
  const indexPath = resolve('index.js');
  const binaryPath = join(directory, 'deep-json-server');

  try {
    await symlink(indexPath, binaryPath);
    assert.equal(isMainModule(binaryPath, pathToFileURL(indexPath).href), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
