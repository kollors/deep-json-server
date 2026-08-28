import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { createOpenApiDocument, generateOpenApi } from '../index.js';
import { runCli } from '../src/cli.js';
import { isMainModule } from '../src/utils.js';

const database = {
  countries: [{ id: '1', name: 'Russia' }],
  genres: [{ id: '1', name: 'Crime', parentIds: [] }, { id: '2', name: 'Drama', parentIds: ['1'] }],
  movies: [
    { actors: [{ genreIds: ['2'], id: 'actor-1', userId: '1' }], coverSrc: 'https://example.com/cover.jpg', description: 'Description', id: '1', publisherIds: ['1'], title: 'Movie' },
    { actors: [], coverSrc: 'https://example.com/cover-2.jpg', id: '2', publisherIds: [], title: 'Movie 2' },
  ],
  publishers: [{ id: '1', name: 'Publisher' }],
  resources: [{ id: '1', name: 'Resource' }],
  users: [{ avatarSrc: 'https://example.com/avatar.jpg', bornAt: '1989-01-25', countryId: '1', fullName: 'Actor', id: '1' }],
};
const schemaConfig = {
  $info: { title: 'Test API', version: '1.0.0' },
  $schema: {
    movies: { formats: { coverSrc: 'uri' }, required: ['actors', 'actors.genreIds', 'actors.userId', 'publisherIds', 'title'] },
    resources: { name: 'Asset', required: ['name'] },
    users: { formats: { avatarSrc: 'uri', bornAt: 'date' }, required: ['bornAt', 'fullName'] },
  },
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

    const yaml = await readFile(outputPath, 'utf8');
    const document = parse(yaml);
    const movie = document.components.schemas.Movie;
    const actor = movie.properties.actors.items;

    assert.equal(document.openapi, '3.0.3');
    assert.doesNotMatch(yaml, /[&*]a\d/);
    assert.equal(movie.properties.coverSrc.format, 'uri');
    assert.deepEqual(movie.required, ['id', 'actors', 'publisherIds', 'title']);
    assert.deepEqual(actor.required, ['genreIds', 'userId']);
    assert.deepEqual(document.components.schemas.Country.required, ['id']);
    assert.deepEqual(document.components.schemas.MovieCreate.required, ['actors', 'publisherIds', 'title']);
    assert.equal(document.info.title, 'Test API');
    assert.equal(document.servers[0].url, 'http://127.0.0.1:4001');
    assert.equal(document.components.schemas.User.properties.bornAt.format, 'date');
    assert.equal(movie.properties.publishers.items.$ref, '#/components/schemas/Publisher');
    assert.equal(actor.properties.user.$ref, '#/components/schemas/User');
    assert.equal(actor.properties.genres.items.$ref, '#/components/schemas/Genre');
    assert.equal(document.components.schemas.Genre.properties.parents.items.$ref, '#/components/schemas/Genre');
    assert.equal(document.components.schemas.Asset.properties.name.type, 'string');
    assert.equal(document.components.parameters.Page.required, false);
    assert.equal(document.components.parameters.Page.schema.default, 1);
    assert.equal(document.components.parameters.PerPage.required, false);
    assert.equal(document.components.parameters.PerPage.schema.default, 10);
    assert.equal(document.components.parameters.PerPage.name, '_perPage');
    assert.equal(document.components.parameters.Embed.schema.type, 'array');
    assert.equal(document.paths['/movies'].get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/MoviePage');
    assert.equal(document.paths['/movies'].get.operationId, 'getMovies');
    assert.equal(document.paths['/movies'].post.operationId, 'postMovies');
    assert.equal(document.paths['/movies/{id}'].get.operationId, 'getMoviesById');
    assert.equal(document.paths['/movies/{id}'].patch.operationId, 'patchMoviesById');
  });
});

test('describes empty resources through explicit properties', () => {
  const document = createOpenApiDocument(
    { items: [] },
    { $schema: { items: { formats: { createdAt: 'date-time' }, properties: { createdAt: { type: 'string' }, name: { type: 'string' } }, required: ['name'] } } },
  );

  assert.deepEqual(document.components.schemas.Item.required, ['id', 'name']);
  assert.equal(document.components.schemas.Item.properties.id.type, 'string');
  assert.equal(document.components.schemas.Item.properties.name.type, 'string');
  assert.equal(document.components.schemas.Item.properties.createdAt.format, 'date-time');
  assert.deepEqual(document.components.schemas.ItemCreate.required, ['name']);
});

test('infers arrays, objects and primitives independently for mixed fields', () => {
  const document = createOpenApiDocument({ items: [{ id: '1', value: ['one'] }, { id: '2', value: 'two' }] });
  const schemas = document.components.schemas.Item.properties.value.oneOf;

  assert.equal(schemas.find(({ type }) => type === 'array').items.type, 'string');
  assert.equal(schemas.some(({ type }) => type === 'string'), true);
});

test('validates OpenAPI configuration and configured paths', () => {
  assert.throws(() => createOpenApiDocument({ $schema: './database-schema.json', items: [] }), /Ресурс «\$schema» должен содержать JSON-массив/);
  assert.throws(() => createOpenApiDocument({ items: [] }, { $info: {} }), /title и version/);
  assert.throws(() => createOpenApiDocument({ items: [] }, { $schema: [] }), /\$schema/);
  assert.throws(() => createOpenApiDocument({ items: [] }, { $schema: { missing: {} } }), /неизвестный ресурс/);
  assert.throws(() => createOpenApiDocument({ items: [] }, { $schema: { items: { name: ' ' } } }), /name/);
  assert.throws(() => createOpenApiDocument({ items: [] }, { $schema: { items: { properties: [] } } }), /properties/);
  assert.throws(() => createOpenApiDocument({ items: [] }, { $schema: { items: { required: ['missing'] } } }), /отсутствует/);
  assert.throws(() => createOpenApiDocument({ items: [{ id: '1', total: 1 }] }, { $schema: { items: { formats: { total: 'date' } } } }), /строковому полю/);
});

test('rejects colliding component names and operation IDs', () => {
  assert.throws(() => createOpenApiDocument({ people: [], persons: [] }), /имя OpenAPI-схемы/i);
  assert.throws(() => createOpenApiDocument(
    { 'blog-posts': [], blog_posts: [] },
    { $schema: { 'blog-posts': { name: 'BlogPostDash' }, blog_posts: { name: 'BlogPostUnderscore' } } },
  ), /operationId/);
});

test('generates OpenAPI through CLI and exits without starting the server', async() => {
  await withFiles(async({ databasePath, outputPath, schemaPath }) => {
    await runCli([databasePath, '--generate', schemaPath, outputPath, '--host', 'localhost', '--port', '5000']);

    const document = parse(await readFile(outputPath, 'utf8'));

    assert.equal(document.openapi, '3.0.3');
    assert.equal(document.servers[0].url, 'http://localhost:5000');
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
