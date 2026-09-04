# Deep JSON Server

[English](README.md) | [Русский](README.ru.md)

[GitHub](https://github.com/kollors/deep-json-server) | [npm](https://www.npmjs.com/package/@kollors/deep-json-server)

A small REST API mock server with CRUD, pagination, nested data filtering, relation embedding through `_embed`, binary files, and OpenAPI generation. Data can be stored in JSON files or memory, and relations are inferred from field names such as `countryId`, `genreIds`, and `publisherIds`.

## Installation

Node.js 22 or newer is required.

```bash
npm install --save-dev @kollors/deep-json-server
```

## Quick start

Create the database file `mock/database.json` before startup:

```json
{
  "movies": [
    { "id": "1", "title": "Shadows of Ardenia" }
  ]
}
```

Create the ESM module `server.config.js` next to `package.json`:

```js
export default {
  database: {
    path: 'mock/database.json',
  },
};
```

Start the server:

```bash
npx deep-json-server server.config.js
```

The API is available at `http://127.0.0.1:4001` by default. For example, `GET http://127.0.0.1:4001/movies` returns this page:

```json
{
  "data": [{ "id": "1", "title": "Shadows of Ardenia" }],
  "total": 1
}
```

## Configuration and startup

Create the ESM module `server.config.js`. The example below shows settings for every feature:

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
    cors: true,
    host: '127.0.0.1',
    logger: true,
    maxFileSize: 100 * 1024 * 1024,
    maxPageSize: 1000,
    port: 4001,
  },
};
```

Configuration keys:

| Key | Condition | Purpose |
| --- | --- | --- |
| `database.path` | Exactly one of `path` or `data` is required | Existing JSON database file |
| `database.data` | Exactly one of `path` or `data` is required | Database object stored in memory |
| `database.schema` | No | Path to JSON overrides or an object with request-validation and OpenAPI settings |
| `files.directory` | Together with `files.metadata` | Directory for binary contents on disk |
| `files.metadata` | Together with `files.directory` | JSON file containing file metadata on disk |
| `files.data` | Instead of the `directory` and `metadata` pair | In-memory files with `Uint8Array` contents |
| `openapi.path` | Required by the `--openapi` and `--openapi-only` CLI flags | Generated OpenAPI YAML file; the programmatic API can return a document without this path |
| `server.cors` | No | Enables permissive CORS headers and `OPTIONS` routes; defaults to `true` |
| `server.host` | No | Host used by the CLI, `server.openapi()`, and argument-less `server.fastify().listen()`; defaults to `127.0.0.1` |
| `server.logger` | No | Fastify logger settings; defaults to `true` |
| `server.maxFileSize` | No | Maximum uploaded-file size in bytes when file routes are enabled; defaults to 100 MiB |
| `server.maxPageSize` | No | Maximum allowed `_perPage` in the API and OpenAPI; defaults to `1000` |
| `server.port` | No | Port used by the CLI, `server.openapi()`, and argument-less `server.fastify().listen()`; defaults to `4001` |

`server.port` must be an integer from `0` to `65535`. The value `0` lets Fastify select an available port at runtime, but cannot be used to generate an OpenAPI server URL, which requires a port from `1` to `65535`. Both `server.maxFileSize` and `server.maxPageSize` must be positive integers.

All relative paths are resolved from the directory containing `server.config.js`, not from the current working directory. Unknown keys, empty paths and invalid value types are rejected before startup. The config is executable JavaScript, so it can read environment variables, import other modules and calculate values before exporting the object. A `.js` config with `export default` requires an ESM project (`"type": "module"`); in a CommonJS project, use the same contents in `server.config.mjs`.

The same config may keep everything in memory. `database.path` and `database.data` are mutually exclusive; `database.schema` accepts either a path or an object. Likewise, `files.data` cannot be combined with `files.directory` or `files.metadata`:

```js
export default {
  database: {
    data: { movies: [{ id: '1', title: 'Shadows of Ardenia' }] },
    schema: { $info: { title: 'Movie API', version: '1.0.0' } },
  },
  files: {
    data: [{ content: new Uint8Array([1, 2, 3]), directory: 'examples', mimeType: 'application/octet-stream', name: 'example.bin' }],
  },
};
```

In-memory values are cloned during initialization. CRUD and file operations therefore do not mutate the exported config object, and their results disappear when the process exits.

Add the commands you need to `package.json`. Here, `mock:openapi:files` updates OpenAPI first and then keeps the server running with file routes:

```json
{
  "scripts": {
    "mock": "deep-json-server server.config.js",
    "mock:files": "deep-json-server --files server.config.js",
    "mock:openapi:files": "deep-json-server --files --openapi server.config.js",
    "openapi": "deep-json-server --openapi-only server.config.js",
    "openapi:files": "deep-json-server --files --openapi-only server.config.js"
  }
}
```

CLI modes:

| Command | Behavior |
| --- | --- |
| `deep-json-server server.config.js` | Starts the CRUD server without file routes |
| `deep-json-server --files server.config.js` | Starts the CRUD server with file routes |
| `deep-json-server --openapi server.config.js` | Generates OpenAPI and starts the CRUD server |
| `deep-json-server --files --openapi server.config.js` | Generates OpenAPI with file routes and starts the server with them |
| `deep-json-server --openapi-only server.config.js` | Generates OpenAPI and exits |
| `deep-json-server --files --openapi-only server.config.js` | Generates OpenAPI with file routes and exits |

`--files` is independent: without it, file routes are neither registered nor added to OpenAPI, even when the config contains a `files` section. The `--openapi` and `--openapi-only` flags are mutually exclusive. Run `deep-json-server --help` to print the CLI summary.

## Example database

Below is an example movie catalog with sample data. `Gangster` is linked to its parent genre, `Crime`.

```json
{
  "countries": [
    { "id": "1", "isArchived": false, "name": "Ardenia" },
    { "id": "2", "isArchived": false, "name": "Veloria" }
  ],
  "genres": [
    { "id": "1", "isArchived": false, "name": "Crime", "parentIds": [] },
    { "id": "2", "isArchived": false, "name": "Gangster", "parentIds": ["1"] },
    { "id": "3", "isArchived": false, "name": "Drama", "parentIds": [] },
    { "id": "4", "isArchived": false, "name": "Comedy", "parentIds": [] }
  ],
  "movies": [
    {
      "actors": [
        { "genreIds": ["2", "3"], "id": "movie-1-actor-1", "userId": "1" },
        { "genreIds": ["3"], "id": "movie-1-actor-2", "userId": "2" }
      ],
      "coverSrc": "https://example.com/covers/shadows-of-ardenia.jpg",
      "description": "The heir to a port city uncovers a conspiracy between two rival families.",
      "id": "1",
      "isArchived": false,
      "publisherIds": ["2"],
      "title": "Shadows of Ardenia"
    },
    {
      "actors": [],
      "coverSrc": "https://example.com/covers/northern-star.jpg",
      "description": "A night manager at an old hotel is drawn into the search for a missing painting.",
      "id": "2",
      "isArchived": false,
      "publisherIds": ["1"],
      "title": "Midnight at the Northern Star"
    }
  ],
  "publishers": [
    { "id": "1", "isArchived": false, "name": "Northlight Studio" },
    { "id": "2", "isArchived": false, "name": "Aurora Pictures" }
  ],
  "users": [
    {
      "bornAt": "1988-03-14",
      "countryId": "1",
      "fullName": "Mira Volkova",
      "id": "1",
      "isArchived": false
    },
    {
      "bornAt": "1991-11-02",
      "countryId": "2",
      "fullName": "Leon Vetrov",
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

`POST` generates a string ID. `PUT` completely replaces the selected record, while `PATCH` updates only supplied fields; both preserve the existing ID and its type. An `id` supplied in any request body cannot override the server-controlled ID. All write operations — `POST`, `PUT`, `PATCH` and `DELETE` — are serialized; disk storage persists them in JSON, while memory storage retains them until the process exits.

The database file must exist before startup. Resource names may contain Latin letters, numbers, `_` and `-`, and must start with a letter. Every resource is an array of JSON objects. Every record must have a non-empty string or finite numeric `id`; IDs must be unique within a resource when compared as strings, so `1` and `"1"` cannot coexist. All nested values must be JSON-compatible: finite numbers, strings, booleans, `null`, arrays, and plain objects. The server rereads the file before every resource GET and write operation, so valid edits to existing resources become visible immediately. Resource names and routes are discovered at startup; restart the server after adding, removing, or renaming a top-level resource.

Successful writes return the created, replaced, updated or deleted record. Errors use an appropriate HTTP status and this JSON shape:

```json
{ "error": "..." }
```

## Pagination and sorting

```http
GET /movies?_page=1&_perPage=10&_sort=-id,title
```

A collection GET always returns the current page data and the total number of records after filtering. `_page` defaults to `1`, and `_perPage` defaults to `10`:

```json
{
  "data": [],
  "total": 0
}
```

`data` contains only the records on the requested page. `total` is the number of all records matching the filter before pagination is applied. When needed, a client can calculate the last page as `Math.max(1, Math.ceil(total / pageSize))`.

Both pagination parameters must be positive integers. `_perPage` cannot exceed `1000` by default; change the limit through `server.maxPageSize` in the config passed to either the CLI or `createServer()`. Invalid values return `400` instead of being silently corrected. A page beyond the last page returns an empty `data` array while preserving the actual `total` value.

`_sort` accepts comma-separated field paths. Rules are applied from left to right; prefix a field with `-` for descending order. Dot paths can address nested object fields, including fields added by `_embed`, for example `GET /users?_embed=country&_sort=country.name,-id`. Unknown or unsafe sort fields return `400`.

## Filters

Pass a JSON object through `_where`:

```http
GET /movies?_where={"title":{"contains":"ardenia"}}
```

Nested objects and arrays can be filtered at any depth. Conditions in one object use `AND` by default:

```json
{
  "actors": { "some": { "userId": { "eq": "1" } } },
  "title": { "contains": "ardenia" }
}
```

Use `and`, `or` and `not` for explicit logical groups:

```json
{
  "and": [
    {
      "or": [
        { "title": { "contains": "ardenia" } },
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
GET /movies?title:contains=ardenia
```

Simple filter values recognize JSON primitives: numbers, `true`, `false` and `null`. Values with leading zeroes, such as `001`, remain strings. Unknown operators, invalid logical conditions and filter paths that do not exist in a non-empty resource return `400`.

Different simple query filters are combined with `AND`. Repeating the same equality filter selects any of its values, so `GET /movies?id=1&id=2` is equivalent to `GET /movies?id:in=1,2`. For an `in` filter, values are separated with commas. On an array field, `in` means that at least one field element matches at least one supplied value. `every` returns `true` for an empty array, while `some` returns `false`.

If `_where` is present, it is the complete filter and other simple filter parameters are ignored. The examples show readable JSON; an HTTP client must URL-encode `_where` when constructing the URL manually, for example with `encodeURIComponent(JSON.stringify(where))`.

Filtering is performed after `_embed`. This means a filter can address fields added by an embedded relation when the same request includes that `_embed`; stored `...Id` and `...Ids` fields can always be filtered directly.

## Relationships

Use `_embed` to add related records to the response:

```http
GET /movies/1?_embed=actors.user.country&_embed=actors.genres&_embed=publishers
```

The response contains actors, each actor's user and genres, the user's country, and publishers. Original ID fields remain in the response, and the database file is not modified. The server imposes no fixed depth limit, but every required level must be written explicitly in the finite `_embed` path:

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

Reverse relations use the source resource name. For example, `_embed=users` on a country finds users whose nested data contains the corresponding `countryId`. Relations are resolved when requested, but referential integrity is not enforced when data is written.

Explicit `...Id` and `...Ids` fields determine relations. If a record also contains an outdated embedded value, `_embed` replaces that response property with the current related record. A missing related record becomes `null` for a single relation or is omitted from the resulting array for a collection relation. Per-request ID indexes are created only for resources used by the current relation lookup.

## Files

Add `files.directory` and `files.metadata` to the server config, then pass `--files` to enable raw binary uploads:

```bash
deep-json-server --files server.config.js
```

For temporary tests, use `files.data` instead. Each initial record contains `name`, `mimeType`, binary `content` as a `Uint8Array`, and an optional `directory`. Uploaded files then remain in memory until the process exits.

Upload one file directly as the request body. `Content-Name` contains the URI-encoded file name, `Content-Type` contains its MIME type, and the optional `Content-Directory` contains the URI-encoded relative directory:

```http
POST /_files/storage
Content-Name: shadows-of-ardenia.jpg
Content-Directory: posters
Content-Type: image/jpeg

<binary body>
```

A new file returns status `201` and its computed metadata:

```json
{
  "directory": "posters",
  "downloadUrl": "/_files/download/posters/shadows-of-ardenia.jpg",
  "metadataUrl": "/_files/metadata/posters/shadows-of-ardenia.jpg",
  "mimeType": "image/jpeg",
  "name": "shadows-of-ardenia.jpg",
  "size": 182340,
  "url": "/_files/storage/posters/shadows-of-ardenia.jpg"
}
```

The combination of `directory` and `name` identifies a file. Uploading to an existing path returns `409`. Pass `Content-Override: true` to replace it; a successful replacement returns `200`. The server supports these file routes:

```text
POST   /_files/storage      Upload or replace a file
GET    /_files/storage/*    Return file contents inline
PATCH  /_files/storage/*    Rename or move a file
DELETE /_files/storage/*    Delete a file

GET    /_files/metadata/*   Return file metadata as JSON
GET    /_files/download/*   Download a file as an attachment
```

Rename, move, or perform both operations with a JSON body. At least one field is required:

```http
PATCH /_files/storage/posters/shadows-of-ardenia.jpg
Content-Type: application/json

{
  "directory": "archive/posters",
  "name": "ardenia-shadows.jpg"
}
```

`PATCH` returns the updated metadata with status `200`; if a file already exists at the new path, the server returns `409`. `DELETE` returns `204` without a response body. A missing file returns `404` on every path-based operation. File paths in URLs are relative to `files.directory`, and all returned URLs are relative to the server origin.

In disk mode, the binary is stored at `<files.directory>/<directory>/<name>`. The metadata file contains only `directory`, `mimeType`, and `name`; `size` is read from the actual file, while response URLs are computed. The server creates directories automatically and keeps validated metadata in memory while running. Use a disk-backed database and file storage from only one server process at a time, and do not edit stored files or metadata until that process stops. Paths below `files.directory` may not contain symbolic links, and file names are restricted to values that are portable across supported operating systems. The metadata file may be absent initially and is created on the first upload. Metadata created by versions before this path-based API is not compatible with the new format.

The upload is raw binary rather than `multipart/form-data`, so `XMLHttpRequest.upload.onprogress` can report progress while the browser sends a `File` directly with `xhr.send(file)`. The default maximum size is 100 MiB and can be changed through `server.maxFileSize`. Missing or unsafe headers and paths return `400`, an exceeded limit returns `413`, and a missing, malformed, or Fastify-unsupported `Content-Type` returns `400` or `415`, depending on which validation stage rejects it.

## Database schema and OpenAPI generation

The optional path or object in `database.schema` customizes inferred schemas. This is a Deep JSON Server configuration format, not a standard JSON Schema document: `$schema` is an object containing resource settings. For example, `mock/database-schema.json` may contain:

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

`formats` is shorthand for assigning `format` to an existing string field. `properties` can fully describe a field—including its `type`, `format`, constraints, and nested properties—or add a field that is absent from the data. If both mechanisms assign a format to the same field, the value from `formats` is applied last.

Set `openapi.path` in the server config, then generate an OpenAPI 3.0.3 file and exit:

```bash
deep-json-server --openapi-only server.config.js
```

To include file routes in the document, configure the `files` section and add `--files`: `deep-json-server --files --openapi-only server.config.js`.

The generator infers resources and field types from all database records. Every inferred field is optional by default, while the top-level `id` is always required in response schemas and is omitted from create and update request schemas. Add other required fields to `required`. A nested required path marks that nested property as required; it does not automatically make every parent path required, so list the parent separately when necessary.

Different non-overlapping value types are inferred independently and combined through `oneOf`; mixed integers and decimal numbers are represented by one `number` schema. Configuration is validated before generation: `$info`, resource and component names, supported `properties` keywords and their value types are checked, while paths from `required` and `formats` must exist in the resulting schema. Explicit component names may contain ASCII letters, digits, dots, underscores, and hyphens.

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

`$info` becomes the OpenAPI `info` object, while resource settings live under `$schema`. In the CLI, the OpenAPI `servers` entry uses `server.host` and `server.port`, then the `HOST` and `PORT` environment-variable fallbacks, and finally `http://127.0.0.1:4001`. A direct `createServer()` call does not read those environment variables automatically: `server.openapi()` uses the config values or the same default URL.

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

The generated document describes CRUD endpoints, pagination, sorting, nested data filters, `_embed`, and both direct and reverse response relations inferred from `...Id` and `...Ids` fields. When `--files` is present, it also describes raw binary upload, download and deletion endpoints for arbitrary media types. A numeric database ID is described as `integer | string`, because a later `POST` creates a string ID in the same resource. Generation rejects duplicate schema names, operation IDs, and invalid schema overrides before producing a document. The document can be used as input for tools such as RTK Query OpenAPI Codegen. OpenAPI is generated only with `--openapi` or `--openapi-only`; normal server startup does not rewrite the file.

During normal startup, request bodies are validated against the same inferred and configured schemas. `POST` and `PUT` enforce configured required fields; `PATCH` validates only fields that are actually supplied. `formats` and `properties` apply to all three methods. Unlisted additional object fields remain allowed. Invalid bodies return `400`.

## Programmatic API

```js
import { createServer } from '@kollors/deep-json-server';

const config = {
  database: {
    path: 'mock/database.json',
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
    cors: true,
    host: '127.0.0.1',
    logger: false,
    maxFileSize: 100 * 1024 * 1024,
    maxPageSize: 1000,
    port: 4001,
  },
};

// Make a request without opening a network port—useful in automated tests.
const server = await createServer(config);
const fastify = server.fastify();
const response = await fastify.inject({ method: 'GET', url: '/movies' });

console.log(response.json());

// Return the document and write it to config.openapi.path.
const document = await server.openapi();

await fastify.close();

// Start a network server. With no arguments, listen uses server.host and server.port.
const runningServer = await createServer(config);
const runningFastify = runningServer.fastify();

await runningFastify.listen();

// Later, during application shutdown:
await runningFastify.close();

// Keep the database, schema, and files entirely in memory.
const memoryServer = await createServer({
  database: {
    data: { movies: [{ id: '1', title: 'Shadows of Ardenia' }] },
    schema: { $info: { title: 'Movie API', version: '1.0.0' } },
  },
  files: {
    data: [{ content: new Uint8Array([1, 2, 3]), directory: 'examples', mimeType: 'application/octet-stream', name: 'example.bin' }],
  },
});

const memoryFastify = memoryServer.fastify();
const memoryResponse = await memoryFastify.inject({ method: 'GET', url: '/movies/1' });

console.log(memoryResponse.json());

await memoryFastify.close();
```

`createServer()` accepts exactly the same config shape as `server.config.js`. It loads and clones the database, schema, and file storage, then returns an object with two methods:

| Method | Purpose |
| --- | --- |
| `server.fastify()` | Lazily creates and caches the real Fastify instance; every native method remains available, and argument-less `listen()` uses `server.host` and `server.port` |
| `server.openapi()` | Returns an OpenAPI document and also writes it when `openapi.path` is configured |

File routes are enabled programmatically when a `files` section is present. The second argument has the shape `{ files?: boolean }`: pass `{ files: false }` to keep a configured store disabled, or `{ files: true }` to require a `files` section and enable the routes. `server.openapi()` uses the same file-route setting as `server.fastify()`.

An argument-less `server.fastify().listen()` uses `server.host` and `server.port`, falling back to `127.0.0.1:4001`. Explicit `listen(options)` values take precedence. Relative paths passed directly to `createServer()` resolve from the current working directory; paths loaded from `server.config.js` resolve from the config directory. The package includes generated TypeScript declarations for the returned object and every config variant.

## Scope and security

Deep JSON Server is intended for local development and automated tests. It has no authentication or authorization, allows CORS from every origin by default, persists accepted writes when disk storage is configured and does not enforce referential integrity. Set `server.cors` to `false` to disable the built-in CORS headers and `OPTIONS` routes. Keep the default loopback host unless the surrounding environment provides its own access controls; do not expose the server or file routes to an untrusted network.
