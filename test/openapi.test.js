import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { createServer } from '../dist/index.js';
import { buildOpenapiDocument } from '../dist/src/openapi/document.js';

const database = {
  countries: [{ id: '1', name: 'Russia' }],
  genres: [
    { id: '1', name: 'Crime', parentIds: [] },
    { id: '2', name: 'Drama', parentIds: ['1'] },
  ],
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
const createDocument = (data, schema, options = {}) => buildOpenapiDocument({ database: data, files: options.files, maxPageSize: options.server?.maxPageSize, schema });

const withFiles = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-openapi-'));
  const databasePath = join(directory, 'database.json');
  const schemaPath = join(directory, 'database-schema.json');
  const outputPath = join(directory, 'openapi-schema.yaml');
  const filesDirectoryPath = join(directory, 'files');
  const filesMetadataPath = join(filesDirectoryPath, '_database.json');

  await writeFile(databasePath, JSON.stringify(database));
  await writeFile(schemaPath, JSON.stringify(schemaConfig));

  try {
    await run({ databasePath, filesDirectoryPath, filesMetadataPath, outputPath, schemaPath });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

test('generates CRUD schemas, formats and direct and reverse relations', async () => {
  await withFiles(async ({ databasePath, filesDirectoryPath, filesMetadataPath, outputPath, schemaPath }) => {
    const server = await createServer(
      {
        database: { path: databasePath, schema: schemaPath },
        files: { directory: filesDirectoryPath, metadata: filesMetadataPath },
        openapi: { path: outputPath },
      },
      { files: true },
    );

    await server.openapi();

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
    assert.equal(document.components.schemas.Genre.properties.children.items.$ref, '#/components/schemas/Genre');
    assert.equal(document.components.schemas.Country.properties.users.items.$ref, '#/components/schemas/User');
    assert.equal(document.components.schemas.User.properties.movies.items.$ref, '#/components/schemas/Movie');
    assert.equal(document.components.schemas.Asset.properties.name.type, 'string');
    assert.equal(document.components.parameters.PerPage.schema.default, 10);
    assert.equal(document.components.parameters.PerPage.schema.maximum, 1000);
    assert.equal(document.components.parameters.PerPage.name, '_perPage');
    assert.deepEqual(document.components.schemas.MoviePage.properties.total, { minimum: 0, type: 'integer' });
    assert.deepEqual(document.components.schemas.MoviePage.required, ['data', 'total']);
    assert.equal(document.paths['/movies'].get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/MoviePage');
    assert.equal(document.paths['/movies'].get.operationId, 'getMovies');
    assert.equal(document.paths['/movies'].post.operationId, 'postMovies');
    assert.equal(document.paths['/movies/{id}'].get.operationId, 'getMoviesById');
    assert.equal(document.paths['/movies/{id}'].patch.operationId, 'patchMoviesById');
    assert.equal(document.paths['/_files/storage'].post.operationId, 'uploadFile');
    assert.equal(document.paths['/_files/storage'].post.requestBody.content['*/*'].schema.format, 'binary');
    assert.equal(document.paths['/_files/storage/{path}'].get.operationId, 'getFileContent');
    assert.equal(document.paths['/_files/storage/{path}'].get.responses[200].content['*/*'].schema.format, 'binary');
    assert.equal(document.paths['/_files/storage/{path}'].patch.operationId, 'updateFile');
    assert.equal(document.paths['/_files/storage/{path}'].delete.responses[204].description, 'Deleted');
    assert.equal(document.paths['/_files/metadata/{path}'].get.operationId, 'getFileMetadata');
    assert.equal(document.paths['/_files/download/{path}'].get.operationId, 'downloadFile');
    assert.deepEqual(document.components.schemas.FileMetadata.required, ['directory', 'downloadUrl', 'metadataUrl', 'mimeType', 'name', 'size', 'url']);
    assert.deepEqual(document.components.schemas.FileUpdate.anyOf, [{ required: ['directory'] }, { required: ['name'] }]);
    assert.equal(document.components.parameters.ContentDirectory.name, 'Content-Directory');
    assert.equal(document.components.parameters.ContentName.name, 'Content-Name');
    assert.equal(document.components.parameters.ContentOverride.name, 'Content-Override');
    assert.deepEqual(document.components.parameters.ContentOverride.schema, { default: 'false', enum: ['false', 'true'], type: 'string' });
    assert.equal(document.components.parameters.FilePath.allowReserved, undefined);
  });
});

test('returns OpenAPI in memory and validates file configuration', async () => {
  await withFiles(async ({ databasePath, filesDirectoryPath, outputPath }) => {
    const server = await createServer({ database: { path: databasePath } });
    const document = await server.openapi();

    assert.equal(document.openapi, '3.0.3');
    await assert.rejects(() => createServer({ database: { path: databasePath }, files: { directory: filesDirectoryPath }, openapi: { path: outputPath } }), /config\.files\.metadata/);
  });
});

test('describes empty resources through explicit properties', () => {
  const document = createDocument(
    { items: [] },
    { $schema: { items: { formats: { createdAt: 'date-time' }, properties: { createdAt: { type: 'string' }, name: { type: 'string' } }, required: ['name'] } } },
  );

  assert.deepEqual(document.components.schemas.Item.required, ['id', 'name']);
  assert.equal(document.components.schemas.Item.properties.id.type, 'string');
  assert.equal(document.components.schemas.Item.properties.createdAt.format, 'date-time');
  assert.deepEqual(document.components.schemas.ItemCreate.required, ['name']);
});

test('accepts supported OpenAPI property constraints', () => {
  const document = createDocument(
    { items: [] },
    {
      $schema: {
        items: {
          properties: {
            details: { additionalProperties: false, properties: { active: { type: 'boolean' } }, type: 'object' },
            labels: { items: { minLength: 1, type: 'string' }, minItems: 1, type: 'array', uniqueItems: true },
            rating: { maximum: 5, minimum: 1, type: 'number' },
            title: { enum: ['One', 'Two'], maxLength: 20, minLength: 1, nullable: true, pattern: '^[A-Z]', type: 'string' },
            value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
      },
    },
  );

  assert.equal(document.components.schemas.Item.properties.rating.maximum, 5);
  assert.equal(document.components.schemas.Item.properties.labels.items.minLength, 1);
  assert.equal(document.components.schemas.Item.properties.details.additionalProperties, false);
});

test('widens numeric ID schemas because POST creates string IDs', () => {
  const document = createDocument({ items: [{ id: 1, name: 'One' }] });
  const idSchemas = document.components.schemas.Item.properties.id.oneOf;

  assert.deepEqual(
    idSchemas.map(({ type }) => type),
    ['integer', 'string'],
  );
  assert.equal(document.components.parameters.Id.schema.type, 'string');
});

test('infers arrays, objects, primitives and nullable values independently', () => {
  const document = createDocument({
    items: [
      { id: '1', value: ['one'] },
      { id: '2', value: 'two' },
      { id: '3', value: null },
    ],
  });
  const valueSchema = document.components.schemas.Item.properties.value;

  assert.equal(valueSchema.oneOf.find(({ type }) => type === 'array').items.type, 'string');
  assert.equal(
    valueSchema.oneOf.some(({ type }) => type === 'string'),
    true,
  );
  assert.equal(valueSchema.nullable, true);

  const nullSchema = createDocument({ items: [{ id: '1', value: null }] }).components.schemas.Item.properties.value;

  assert.deepEqual(nullSchema.enum, [null]);
  assert.equal(nullSchema.nullable, true);
});

test('normalizes overlapping numeric schemas', () => {
  const document = createDocument({
    items: [
      { id: '1', value: 1 },
      { id: '2', value: 1.5 },
    ],
  });

  assert.deepEqual(document.components.schemas.Item.properties.value, { type: 'number' });
});

test('validates database contents and schema configuration', () => {
  assert.throws(() => createDocument({ $schema: [] }), /имя ресурса/);
  assert.throws(() => createDocument({ items: [null] }), /JSON-объект/);
  assert.throws(() => createDocument({ items: [{ name: 'Missing ID' }] }), /id/);
  assert.throws(() => createDocument({ items: [{ id: 1 }, { id: '1' }] }), /повторяющийся id/);
  assert.throws(() => createDocument({ 'bad/name': [] }), /имя ресурса/);
  assert.throws(() => createDocument({ items: [] }, { $info: {} }), /title и version/);
  assert.throws(() => createDocument({ items: [] }, { $schema: [] }), /\$schema/);
  assert.throws(() => createDocument({ items: [] }, { $schema: { missing: {} } }), /неизвестный ресурс/);
  assert.throws(() => createDocument({ items: [] }, { $schema: { items: { name: ' ' } } }), /name/);
  assert.throws(() => createDocument({ items: [] }, { $schema: { items: { name: 'Bad/Name' } } }), /шаблону/);
  assert.throws(() => createDocument({ items: [] }, { $schema: { items: { properties: [] } } }), /properties/);
  assert.throws(() => createDocument({ items: [] }, { $schema: { items: { require: ['name'] } } }), /require/);
  assert.throws(() => createDocument({ items: [] }, { $schema: { items: { properties: { value: { type: 'invalid' } } } } }), /поддерживаемый тип/);
  assert.throws(() => createDocument({ items: [{ id: '1', value: 1 }] }, { $schema: { items: { properties: { value: { minimum: 'bad' } } } } }), /minimum/);
  assert.throws(() => createDocument({ items: [{ id: '1', value: 1 }] }, { $schema: { items: { properties: { value: { unknown: true } } } } }), /Неизвестный ключ/);
  assert.throws(() => createDocument({ items: [{ id: '1', value: 1 }] }, { $schema: { items: { properties: { value: { minimum: 1, type: 'string' } } } } }), /несовместим/);
  assert.throws(() => createDocument({ items: [{ id: '1', value: 'one' }] }, { $schema: { items: { properties: { value: { minLength: -1 } } } } }), /minLength/);
  assert.throws(() => createDocument({ items: [{ id: '1', value: 'one' }] }, { $schema: { items: { properties: { value: { nullable: 'true' } } } } }), /nullable/);
  assert.throws(() => createDocument({ items: [{ id: '1', value: 'one' }] }, { $schema: { items: { properties: { value: { enum: [] } } } } }), /enum/);
  assert.throws(() => createDocument({ items: [{ id: '1', value: 'one' }] }, { $schema: { items: { properties: { value: { oneOf: [] } } } } }), /oneOf/);
  assert.throws(() => createDocument({ items: [{ id: '1', value: 'one' }] }, { $schema: { items: { properties: { value: { items: 'invalid' } } } } }), /JSON-объект/);
  assert.throws(() => createDocument({ items: [] }, { unknown: true }), /schema\.unknown/);
  assert.throws(() => createDocument({ items: [] }, { $schema: { items: { required: ['missing'] } } }), /отсутствует/);
  assert.throws(() => createDocument({ items: [{ id: '1', total: 1 }] }, { $schema: { items: { formats: { total: 'date' } } } }), /строковому полю/);
  assert.throws(() => buildOpenapiDocument({ database: { items: [] }, files: 'true' }), /Ключ files/);
});

test('rejects colliding component names and operation IDs', () => {
  assert.throws(() => createDocument({ people: [], persons: [] }), /имя OpenAPI-схемы/i);
  assert.throws(() => createDocument({ 'blog-posts': [], blog_posts: [] }, { $schema: { 'blog-posts': { name: 'BlogPostDash' }, blog_posts: { name: 'BlogPostUnderscore' } } }), /operationId/);
  assert.throws(() => createDocument({ files: [] }, { $schema: { files: { name: 'FileMetadata' } } }, { files: true }), /имя OpenAPI-схемы/i);
  assert.throws(() => createDocument({ 'file-content': [] }, undefined, { files: true }), /operationId.*getFileContent/);

  const document = createDocument({ files: [] }, { $schema: { files: { name: 'StoredFile' } } }, { files: true });

  assert.equal(document.tags.filter(({ name }) => name === 'files').length, 1);
});

test('keeps runtime server address outside an in-memory document', () => {
  const document = createDocument({ items: [{ id: '1' }] }, undefined, { server: { maxPageSize: 25 } });

  assert.equal(document.servers, undefined);
  assert.equal(document.components.parameters.PerPage.schema.maximum, 25);
});
