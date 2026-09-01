# Deep JSON Server

[English](README.md) | [Русский](README.ru.md)

[GitHub](https://github.com/kollors/deep-json-server) | [npm](https://www.npmjs.com/package/@kollors/deep-json-server)

A small JSON REST mock server with CRUD, pagination, deep filters and recursive relationship embedding. It keeps the database in one readable JSON file and infers soft relations from conventional keys such as `countryId`, `genreIds` and `publisherIds`.

## Installation

Node.js 20 or newer is required.

```bash
npm install --save-dev @kollors/deep-json-server
```

## Configuration and startup

Create the ESM module `server.config.js`. The example below enables every feature:

```js
import process from 'node:process';

export default {
  database: {
    path: process.env.DATABASE_PATH ?? 'mock/database.json',
    schema: 'mock/database-schema.json',
  },
  files: {
    directory: 'mock/files',
    metadata: 'mock/files/_database.json',
  },
  openapi: {
    path: 'mock/openapi-schema.yaml',
  },
  server: {
    host: '127.0.0.1',
    port: 4001,
  },
};
```

Configuration keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `database.path` | Always | Existing JSON database file |
| `database.schema` | No | JSON overrides for request validation and OpenAPI schemas |
| `files.directory` | With `--files` | Directory for binary contents |
| `files.metadata` | With `--files` | JSON file containing uploaded-file metadata |
| `openapi.path` | With `--openapi` | Generated OpenAPI YAML file |
| `server.host` | No | Listening host; falls back to `HOST`, then `127.0.0.1` |
| `server.port` | No | Listening port; falls back to `PORT`, then `4001` |

All relative paths are resolved from the directory containing `server.config.js`, not from the current working directory. Unknown keys, empty paths and invalid value types are rejected before startup. The config is executable JavaScript, so it can read environment variables, import other modules and calculate values before exporting the object. A `.js` config with `export default` requires an ESM project (`"type": "module"`); in a CommonJS project, use the same contents in `server.config.mjs`.

Add the commands you need to `package.json`:

```json
{
  "scripts": {
    "mock": "deep-json-server --files server.config.js",
    "openapi": "deep-json-server --openapi --files server.config.js"
  }
}
```

CLI modes:

| Command | Behavior |
| --- | --- |
| `deep-json-server server.config.js` | Starts the CRUD server without file routes |
| `deep-json-server --files server.config.js` | Starts the CRUD server with file routes |
| `deep-json-server --openapi server.config.js` | Generates OpenAPI and exits |
| `deep-json-server --openapi --files server.config.js` | Generates OpenAPI with file routes and exits |

`--openapi` never starts the HTTP server. `--files` is independent: without it, file routes are neither registered nor added to OpenAPI. Run `deep-json-server --help` to print the CLI summary.

## Example database

This example is based on a movie catalog. `Gangster film` demonstrates a relationship with a parent genre.

```json
{
  "countries": [
    { "id": "1", "isArchived": false, "name": "Russia" },
    { "id": "2", "isArchived": false, "name": "United States" }
  ],
  "genres": [
    { "id": "1", "isArchived": false, "name": "Crime", "parentIds": [] },
    { "id": "2", "isArchived": false, "name": "Gangster film", "parentIds": ["1"] },
    { "id": "3", "isArchived": false, "name": "Drama", "parentIds": [] },
    { "id": "4", "isArchived": false, "name": "Comedy", "parentIds": [] }
  ],
  "movies": [
    {
      "actors": [
        { "genreIds": ["2", "3"], "id": "movie-1-actor-1", "userId": "1" },
        { "genreIds": ["3"], "id": "movie-1-actor-2", "userId": "2" }
      ],
      "coverSrc": "https://image.tmdb.org/t/p/w500/3bhkrj58Vtu7enYsRolD1fZdja1.jpg",
      "description": "The story of the Corleone family and the transfer of power from one generation to the next.",
      "id": "1",
      "isArchived": false,
      "publisherIds": ["2"],
      "title": "The Godfather"
    },
    {
      "actors": [],
      "coverSrc": "https://image.tmdb.org/t/p/w500/eWdyYQreja6JGCzqHWXpWHDrrPo.jpg",
      "description": "The adventures of a concierge and his young assistant in a famous European hotel.",
      "id": "2",
      "isArchived": false,
      "publisherIds": ["1"],
      "title": "The Grand Budapest Hotel"
    }
  ],
  "publishers": [
    { "id": "1", "isArchived": false, "name": "A24" },
    { "id": "2", "isArchived": false, "name": "Paramount Pictures" }
  ],
  "users": [
    {
      "bornAt": "1989-01-25",
      "countryId": "1",
      "fullName": "Alexander Petrov",
      "id": "1",
      "isArchived": false
    },
    {
      "bornAt": "1984-09-05",
      "countryId": "1",
      "fullName": "Yulia Peresild",
      "id": "2",
      "isArchived": false
    }
  ]
}
```

Every top-level array becomes a REST resource:

```text
GET    /movies
GET    /movies/:id
POST   /movies
PUT    /movies/:id
PATCH  /movies/:id
DELETE /movies/:id
```

`POST` generates a string ID. `PUT` completely replaces the selected record, while `PATCH` updates only supplied fields; both preserve the existing ID and its type. An `id` supplied in any request body cannot override the server-controlled ID. All write operations — `POST`, `PUT`, `PATCH` and `DELETE` — are serialized and persisted in the JSON file.

The database file must exist before startup. Resource names may contain Latin letters, numbers, `_` and `-`, and must start with a letter. Every resource is an array of JSON objects. Every record must have a non-empty string or finite numeric `id`; IDs must be unique within a resource when compared as strings, so `1` and `"1"` cannot coexist. The server rereads the file before every GET and write operation, so valid external edits become visible without a restart.

Successful writes return the created, replaced, updated or deleted record. Errors use an appropriate HTTP status and this JSON shape:

```json
{ "error": "Human-readable message" }
```

## Pagination and sorting

```http
GET /movies?_page=1&_perPage=10&_sort=-id,title
```

A GET collection always returns a page object. `_page` defaults to `1`, and `_perPage` defaults to `10`:

```json
{
  "data": [],
  "first": 1,
  "items": 0,
  "last": 1,
  "next": null,
  "pages": 1,
  "prev": null
}
```

Both pagination parameters must be positive integers. `_perPage` cannot exceed `1000` by default; use the programmatic `maxPageSize` option to change that limit. Invalid values return `400` instead of being silently corrected. A page beyond the last page returns an empty `data` array and points `prev` to the last available page instead of silently clamping the request.

`_sort` accepts comma-separated field paths. Rules are applied from left to right; prefix a field with `-` for descending order. Dot paths can address nested object fields, including fields added by `_embed`, for example `GET /users?_embed=country&_sort=country.name,-id`. Unknown or unsafe sort fields return `400`.

## Filters

Pass a JSON object through `_where`:

```http
GET /movies?_where={"title":{"contains":"father"}}
```

Nested objects and arrays can be filtered at any depth. Conditions in one object use `AND` by default:

```json
{
  "actors": { "some": { "userId": { "eq": "1" } } },
  "title": { "contains": "father" }
}
```

Use `and`, `or` and `not` for explicit logical groups:

```json
{
  "and": [
    {
      "or": [
        { "title": { "contains": "father" } },
        { "actors": { "some": { "userId": { "eq": "2" } } } }
      ]
    },
    { "not": { "isArchived": { "eq": true } } }
  ]
}
```

Field operators:

| Operator | Behavior |
| --- | --- |
| `eq`, `ne` | Equality or inequality |
| `contains` | Case-insensitive substring for strings, or matching member for arrays |
| `startsWith`, `endsWith` | Case-insensitive string prefix or suffix |
| `gt`, `gte`, `lt`, `lte` | Ordered comparison; ISO date strings can be compared lexically |
| `in` | Matches a scalar or array member against the supplied values |
| `some`, `every`, `none` | Applies a nested condition to array elements |
| `not` | Negates a nested field condition |

Simple query parameters are supported too:

```http
GET /movies?title:contains=father
```

Simple filter values recognize JSON primitives: numbers, `true`, `false` and `null`. Values with leading zeroes, such as `001`, remain strings. Unknown operators, invalid logical conditions and filter paths that do not exist in a non-empty resource return `400`.

For a simple `in` filter, separate values with commas: `GET /movies?id:in=1,2`. If `_where` is present, it is the complete filter and other simple filter parameters are ignored. The examples show readable JSON; an HTTP client must URL-encode `_where` when constructing the URL manually.

Filtering is performed after `_embed`. This means a filter can address fields added by an embedded relation when the same request includes that `_embed`; stored `...Id` and `...Ids` fields can always be filtered directly.

## Relationships

Use `_embed` to add related records to the response:

```http
GET /movies/1?_embed=actors.user.country&_embed=actors.genres&_embed=publishers
```

The response contains actors, each actor's user and genres, the user's country, and publishers. Original ID fields remain in the response, and the database file is not modified. Embedding can follow any number of levels:

```http
GET /movies/1?_embed=actors.user.country
GET /genres/2?_embed=parents.parents
```

Unknown or malformed `_embed` paths return `400`.

Pass `_embed` more than once, as above, or provide a comma-separated list in one parameter. Pagination applies only to the requested root collection; embedded related records are returned in full.

Reverse relationships work as well:

```http
GET /countries/1?_embed=users
```

Relations are inferred by convention. A field named `<relation>Id` creates a single relation, while `<relation>Ids` creates a collection relation. The relation name is matched to a top-level resource directly or through its singular form. For example:

- `countryId` points to `countries`;
- `userId` points to `users` when the requested relation is `user`;
- `genreIds` points to `genres`;
- `publisherIds` points to `publishers`;
- `parentIds` points back to the current resource when `_embed=parents` is requested; `_embed=children` resolves the reverse self-relation.

Reverse relations use the source resource name. For example, `_embed=users` on a country finds users whose nested data contains the corresponding `countryId`. They are soft references: the server resolves them when requested but does not enforce referential integrity when data is written.

An explicit `...Id` or `...Ids` field is the source of truth. If a record also contains an outdated embedded value, `_embed` replaces that response property with the current related record. A missing target becomes `null` for a single relation or is omitted from the resulting array for a collection relation. Relationship lookups use lazy per-request ID indexes, so each referenced resource is indexed only when needed.

## Files

Add `files.directory` and `files.metadata` to the server config, then pass `--files` to enable raw binary uploads:

```bash
deep-json-server --files server.config.js
```

Upload one file as the request body. Both headers are required: `Content-Name` contains the relative logical name encoded with `encodeURIComponent`, and `Content-Type` contains the file MIME type:

```http
POST /_files
Content-Name: posters%2Fthe-godfather.jpg
Content-Type: image/jpeg

<binary body>
```

The response contains metadata and a stable URL:

```json
{
  "id": "generated-id",
  "mimeType": "image/jpeg",
  "name": "posters/the-godfather.jpg",
  "size": 182340,
  "url": "/_files/generated-id"
}
```

Use `GET /_files/:id` to download the original bytes and `DELETE /_files/:id` to delete both the binary contents and their metadata. The returned `url` is relative to the mock-server origin. The server creates the configured directories automatically, stores binary contents under generated IDs without relying on the original file name, and keeps the logical names and other metadata in `files.metadata`. The metadata file may be absent initially and is created on the first upload. Do not edit it while the server is running.

The upload is raw binary rather than `multipart/form-data`, so `XMLHttpRequest.upload.onprogress` can report progress while the browser sends a `File` directly with `xhr.send(file)`. The default maximum size is 100 MiB and can be changed through the programmatic `maxFileSize` option. Unsafe or absolute `Content-Name` paths return `400`, an exceeded limit returns `413`, and a malformed or unsupported `Content-Type` returns `400` or `415`.

## Database schema and OpenAPI generation

The optional JSON file referenced by `database.schema`, for example `mock/database-schema.json`, customizes inferred schemas. It is read both during normal server startup and during OpenAPI generation:

```json
{
  "$info": {
    "title": "Movie Catalog API",
    "version": "1.0.0"
  },
  "$schema": {
    "movies": {
      "required": ["actors", "actors.genreIds", "actors.userId", "publisherIds", "title"],
      "formats": {
        "coverSrc": "uri"
      }
    },
    "users": {
      "required": ["bornAt", "fullName"],
      "formats": {
        "avatarSrc": "uri",
        "bornAt": "date"
      }
    }
  }
}
```

Schema configuration:

| Key | Purpose |
| --- | --- |
| `$info` | OpenAPI `info`; when present, non-empty `title` and `version` are required |
| `$schema.<resource>.name` | Explicit component name when automatic singularization is unsuitable or collides |
| `$schema.<resource>.required` | Required field paths; nested paths use dots, such as `actors.userId` |
| `$schema.<resource>.formats` | OpenAPI formats for inferred or explicit string fields, such as `date`, `date-time` or `uri` |
| `$schema.<resource>.properties` | Recursive OpenAPI-compatible field schemas merged with inference |

Set `openapi.path` in the server config, then generate an OpenAPI 3.0.3 file and exit:

```bash
deep-json-server --openapi --files server.config.js
```

The generator infers resources and field types from all database records. Every inferred field is optional by default, while the top-level `id` is always required in response schemas and is omitted from create and update request schemas. Add other required fields to `required`. A nested required path marks that nested property as required; it does not automatically make every parent path required, so list the parent separately when necessary.

Different value types are inferred independently and combined through `oneOf`. Configuration is validated before generation: `$info`, resource and schema names, and the structure of `properties` are validated, while paths from `required` and `formats` must exist in the resulting schema.

Use `properties` to describe fields that cannot be inferred, particularly for an empty resource. Explicit properties are merged with inferred properties:

```json
{
  "$schema": {
    "reviews": {
      "properties": {
        "rating": { "type": "integer", "minimum": 1, "maximum": 5 },
        "text": { "type": "string" }
      },
      "required": ["rating"]
    }
  }
}
```

An empty resource still receives a required string `id` property because IDs created by the server are strings. Generation stops with an actionable error when resources produce duplicate schema names or operation IDs; use an explicit `name` to resolve schema-name collisions. The output directory is created automatically, and the configured YAML file is replaced on every generation.

`$info` becomes the OpenAPI `info` object, while resource settings live under `$schema`. The OpenAPI `servers` entry is generated automatically from `server.host` and `server.port`, their `HOST` and `PORT` environment variable fallbacks, or the default `http://127.0.0.1:4001`.

Use `name` when a resource needs an explicit schema name instead of the automatically singularized name:

```json
{
  "$schema": {
    "equipment": {
      "name": "Equipment"
    }
  }
}
```

The generated document describes CRUD endpoints, pagination, sorting, deep filters, `_embed`, and both direct and reverse response relations inferred from `...Id` and `...Ids` fields. When `--files` is present, it also describes raw binary upload, download and deletion endpoints. A numeric database ID is described as `integer | string`, because a later `POST` creates a string ID in the same resource. The document can be used as input for tools such as RTK Query OpenAPI Codegen. OpenAPI is generated only when `--openapi` is passed; normal server startup does not rewrite the file.

During normal startup, request bodies are validated against the same inferred and configured schemas. `POST` and `PUT` enforce configured required fields; `PATCH` validates only fields that are actually supplied. `formats` and `properties` apply to all three methods. Unlisted additional object fields remain allowed. Invalid bodies return `400`.

## Scope and security

Deep JSON Server is intended for local development and automated tests. It has no authentication or authorization, allows CORS from every origin, persists accepted writes directly to the configured files and does not enforce referential integrity. Keep the default loopback host unless the surrounding environment provides its own access controls; do not expose the server or file routes to an untrusted network.

## Programmatic API

```js
import { createOpenApiDocument, createServer, generateOpenApi, startServer } from '@kollors/deep-json-server';

// Create an instance without opening a port, for example for tests.
const server = await createServer({
  databasePath: 'mock/database.json',
  filesDirectoryPath: 'mock/files',
  filesMetadataPath: 'mock/files/_database.json',
  logger: false,
  maxFileSize: 100 * 1024 * 1024,
  maxPageSize: 1000,
  schemaPath: 'mock/database-schema.json',
});

const response = await server.inject({ method: 'GET', url: '/movies' });

await server.close();

// Create an instance and start listening.
const listeningServer = await startServer({
  databasePath: 'mock/database.json',
  host: '127.0.0.1',
  port: 4001,
  schemaPath: 'mock/database-schema.json',
});

await listeningServer.close();

// Read the database and schema files, then write an OpenAPI YAML file.
await generateOpenApi({
  databasePath: 'mock/database.json',
  files: true,
  host: '127.0.0.1',
  outputPath: 'mock/openapi-schema.yaml',
  port: 4001,
  schemaPath: 'mock/database-schema.json',
});

// Build the same kind of OpenAPI document entirely in memory.
const document = createOpenApiDocument(
  { movies: [{ id: '1', title: 'The Godfather' }] },
  { $info: { title: 'Movie API', version: '1.0.0' } },
  { files: true, host: '127.0.0.1', port: 4001 },
);
```

Programmatic options:

| Option | Used by | Meaning |
| --- | --- | --- |
| `databasePath` | `createServer`, `startServer`, `generateOpenApi` | Required JSON database path |
| `schemaPath` | The same three functions | Optional database-schema path |
| `filesDirectoryPath`, `filesMetadataPath` | `createServer`, `startServer` | Optional pair enabling file routes |
| `files` | `generateOpenApi`, `createOpenApiDocument` | Whether file routes appear in OpenAPI |
| `host`, `port` | `startServer`, `generateOpenApi`, `createOpenApiDocument` | Listening address or generated `servers` URL |
| `logger` | `createServer`, `startServer` | Fastify logger settings; defaults to `true` |
| `maxPageSize`, `maxFileSize` | `createServer`, `startServer` | Runtime limits; defaults are 1000 records and 100 MiB |
| `outputPath` | `generateOpenApi` | Required generated YAML path |

`createServer()` returns a Fastify instance without opening a network port, which is useful with `server.inject()` in tests. `startServer()` also starts listening. `generateOpenApi()` reads files and writes YAML, while `createOpenApiDocument()` works with in-memory database and schema objects and does not write a file. These functions do not read `server.config.js`; pass their options explicitly. The package includes generated TypeScript declarations for all exported functions.
