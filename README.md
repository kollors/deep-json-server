# Deep JSON Server

[Русский](README.ru.md)

A JSON-backed mock server with REST, GraphQL, nested queries, binary files and schema exports. Requires Node.js 22 or newer.

**1.0.0-alpha.5 is a prerelease.** REST queries use `scope=[fields, arguments?]` at every level. When upgrading from an earlier version, update query parameters using the examples below; upgrading from 0.x also requires the new model schema.

## Installation

```sh
npm install @kollors/deep-json-server@alpha
```

To install a specific version, use `@1.0.0-alpha.5`.

## Quick start

Create two files in the same directory.

`database.json`:

```json
{
  "users": [
    { "id": "1", "fullName": "Мира Волкова" }
  ]
}
```

`server.config.js`:

```js
export default {
  database: { path: './database.json' },
};
```

```sh
npx deep-json-server server.config.js
```

The user list is available at `http://127.0.0.1:4001/users`.

## Configuration

| Setting | Meaning |
|---|---|
| `database.path` / `database.data` | Exactly one: JSON file or in-memory collection object |
| `database.schema` | Model object or JSON schema-file path; optional for REST |
| `openapi.enabled` | Enable the specification endpoint; default `false` |
| `openapi.endpoint` | Specification path; default `/openapi.json` |
| `openapi.path` | YAML export destination |
| `openapi.info` | Optional metadata object: required `title` and `version`, optional `description` |
| `graphql.enabled` | Enable GraphQL HTTP endpoint; default `false` |
| `graphql.endpoint` | Endpoint path; default `/graphql` |
| `graphql.path` | GraphQL SDL export destination |
| `server.host`, `server.port` | Defaults `127.0.0.1`, `4001`; CLI also reads `HOST`/`PORT` |
| `server.pageSize`, `server.maxPageSize` | Defaults 10 and 100; default size is capped by the maximum |
| `server.cors`, `server.logger` | Default `true`; logger also accepts Fastify logger options |
| `server.maxFileSize` | Default 100 MiB |
| `files.data` | In-memory binary files |
| `files.directory`, `files.metadata` | Disk storage directory and metadata JSON file; both required |

Relative paths resolve from the configuration file's directory. When passing a configuration object to `createServer()`, paths resolve from the working directory. The server works with a copy of in-memory input and metadata.

Set `server.port` to `0` to let the operating system choose an available port. The OpenAPI endpoint uses a relative server URL.

| CLI flag | Action |
|---|---|
| `--files` | Enable file routes |
| `--graphql` | Enable the GraphQL API |
| `--openapi` | Enable the OpenAPI endpoint |
| `--host <host>` | Server address |
| `--port <port>` | Server port |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show package version |

Setting priority: CLI → configuration → `HOST`/`PORT` → defaults. File routes are enabled when `files` is configured.

To generate schemas, specify the format and configuration file:

```sh
npx deep-json-server generate openapi server.config.js
npx deep-json-server generate graphql server.config.js
npx deep-json-server generate openapi,graphql server.config.js
```

The command reads `database.schema` and writes schemas to `openapi.path` and `graphql.path`. A configuration for generation only can contain:

```js
export default {
  database: { schema: './schema.json' },
  openapi: { path: './generated/openapi.yaml' },
  graphql: { path: './generated/schema.graphql' },
};
```

Each format needs its own output file. The command rejects destinations that would overwrite the configuration, database, schema or file metadata.

## Model schema

Examples: [database](examples/database.json), [model schema](examples/schema.json), [configuration](examples/server.config.js).

```json
{
  "Country": {
    "collection": "countries",
    "api": ["openapi", "graphql"],
    "fields": {
      "id": { "type": "string", "primary": true, "generated": "uuid" },
      "name": { "type": "string", "required": true },
      "users": { "type": "User[]", "target": "countryId" }
    }
  },
  "User": {
    "collection": "users",
    "api": ["openapi", "graphql"],
    "fields": {
      "id": { "type": "string", "primary": true, "generated": "uuid" },
      "fullName": { "type": "string", "required": true },
      "country": { "type": "Country", "source": "countryId" }
    }
  }
}
```

`api` defaults to `["openapi", "graphql"]`. `[]` excludes the model from both exports and GraphQL, while REST remains available. Related models must enable the same export format. Names must be valid identifiers and generated type/operation names must not collide. `and`, `or`, `not` are reserved filter names.

| Capability | With schema | Without schema |
|---|---|---|
| REST CRUD | Model validation | JSON/body/identifier validation only |
| Relations | Explicit model fields | `countryId`, `genreIds`, etc. naming conventions |
| OpenAPI 3.0.3 export | Available | Error when requested |
| GraphQL SDL / API | Available | Error when requested |

Explicit schemas are strict: undeclared fields and collections are rejected, except storage keys inferred from relations. Existing data is validated on startup. Generation uses the model definitions.

Schemaless REST generates an `id` and preserves arbitrary JSON fields. Filters and individual field selections use identifier-style names; other fields are returned through `scope=[{"*":true}]`. Fields with mixed value types can be read, but filtering, ordering and paging heterogeneous lists require an explicit schema.

### Fields

The `type` property accepts `string`, `number`, `boolean`, `object`, or a model name. Append `[]` for an array: `string[]`, `object[]`, `Genre[]`. Use dotted paths for nested fields, such as `actors.fullName`.

| Properties | Meaning |
|---|---|
| `type` | Required type |
| `description`, `example` | Documentation and example value |
| `required`, `nullable` | Defaults `false`; presence and explicit null are separate |
| `default` | Value when omitted on create/replace; PATCH does not insert defaults |
| `enum` | Allowed strings, numbers or booleans; for arrays, allowed element values |
| `primary` | Root primary key; mandatory, unique, non-null and immutable |
| `generated` | `uuid` for strings, `increment` for numbers; server supplies the value |
| `readOnly`, `writeOnly` | Output-only or input-only; mutually exclusive |
| `minLength`, `maxLength`, `pattern` | String constraints |
| `format` | `date`, `date-time`, `email`, `uri`, `uuid` |
| `minimum`, `maximum` | Inclusive numeric bounds |
| `source`, `target`, `onDelete` | Relation metadata |

String and numeric constraints on `string[]`/`number[]` apply to every element. `required` and `nullable` apply to the entire array; `default` and `example` contain a complete array. Elements must match the array's type and be non-null. `required` requires the field to be present; an ordinary array may still be empty.

Each model requires exactly one primary key of type `string` or `number`, declared at the top level. The name is arbitrary: `id`, `username`, `code`. If `generated` is omitted, the client supplies the value on creation. Generated fields must be declared at the top level, are excluded from input types and cannot have `default`. Replacing a record preserves generated values and read-only fields, including nested objects. To protect fields inside an array, mark the entire array or its containing object as `readOnly`. Objects containing only server-managed fields are output-only.

For example, a `LocalUser` with primary key `username` and `password: {"type":"string","required":true,"writeOnly":true}` has `localUser(username: ...)` and `/localUsers/{username}`. A `writeOnly` field accepts input and is excluded from responses, `scope`, filters and ordering.

Objects used in GraphQL must have at least one field visible in responses; REST also accepts empty objects.

### Relations

```json
"actors.genres": {
  "type": "Genre[]",
  "source": "actors.genreIds",
  "required": true
}
```

`Genre` returns an object; `Genre[]` returns a list. `source` defaults to the current model's primary key, `target` to the target model's primary key. These defaults also apply to nested relations. Paths start at the root of their respective records: in this example, `actors.genreIds` contains the current actor's genre keys.

Relation keys are stored in the database and included among the record's own fields. Their types are inferred from the matched keys. A `source` field pointing to a target primary key can be omitted from the field declarations: the schema infers an array of keys for a list relation or a scalar key for a single relation. Declare the storage field explicitly when the mapping is ambiguous.

Reverse example: `User.movies = {"type":"Movie[]","target":"actors.userId"}`. A movie is returned once even if several actors match. A single relation resolving to multiple targets is invalid.

Every supplied direct relation key must point to an existing record. `required: true` on a relation requires at least one target before response filtering/pagination. Reverse relations using the primary key as `source` may be empty unless required. Missing single relations return `null`.

`onDelete` describes what happens **when a target record is deleted**:

- `restrict` (default): refuse deletion while a surviving owner refers to the target.
- `cascade`: delete the referring owner. For `User.country`, deleting the country deletes its users. For `Movie.actors.user`, deleting the user removes matching actor elements and retains the movie.

Cascading deletion runs as one operation, including cyclic relations. A validation failure cancels the entire operation. `onDelete` rules also apply to explicitly declared reverse relations; account for both rules when defining both directions.

## Queries and responses

Collections and lists of objects, including embedded `object[]` fields, return:

```json
{ "data": [], "total": 0 }
```

Primitive arrays are returned as plain arrays. Every object list accepts optional `where`, `order` and `pager`. Processing order is filter → sort → pagination. `total` is the filtered record count before pagination.

Use `page` and `pageSize` in `pager`. The default is the first page with the size from `server.pageSize`. Both values must be positive integers; `pageSize` is limited by `server.maxPageSize`. Out-of-range pages return empty `data` with the total matching record count in `total`.

`where` uses field operators `eq`, `ne`, `in`, string `contains`/`startsWith`/`endsWith`, and comparisons `gt`, `gte`, `lt`, `lte`. Combine conditions with `and`, `or`, `not`. Arrays support `some`, `every`, `none`; primitive arrays also support `contains`, `in`. String matching is case-insensitive. A field condition is an object containing an operator, such as `{ "id": { "eq": "1" } }`.

```json
{
  "movies": {
    "some": {
      "actors": {
        "some": {
          "genres": { "some": { "id": { "in": ["2", "3"] } } }
        }
      }
    }
  }
}
```

Root `where` selects records from the main collection. `where` inside a relation filters its elements while retaining the parent record. Each nested list is processed independently. Filtering by a relation works independently of its inclusion in the response.

`order` is an array of `{ "field": "fullName", "direction": "ASC" }` rules. Earlier rules have priority; equal values retain storage order. Null and missing values compare equally. REST uses dotted field paths; GraphQL uses generated enums (`profile_name` for `profile.name`). Ambiguous enum names cause a generation error. Sorting supports scalar fields of the current object, including nested fields. Related lists accept their own `order`.

### REST

| Method | Path | Operation |
|---|---|---|
| GET | `/users` | `userList` |
| GET | `/users/{id}` | `user` |
| POST | `/users` | `userCreate` |
| PUT | `/users/{id}` | `userReplace` |
| PATCH | `/users/{id}` | `userUpdate` |
| DELETE | `/users/{id}` | `userDelete` |

The path parameter name follows the primary key. POST, PUT and PATCH accept a JSON record object. PUT replaces the record while retaining its key and server-managed fields. PATCH merges fields at the top level; supplied nested objects are replaced while preserving their read-only fields. Creation and replacement require all mandatory fields. Updates validate supplied values and the final record. Missing records return `404`; conflicts return `409`. DELETE returns the deleted record.

### Nested writes

Storage keys such as `genreIds: ["1"]` only set a relation. Relation fields also accept records to create or update:

```http
PATCH /movies/1
Content-Type: application/json

{
  "actors": [
    {
      "userId": "1",
      "genres": [
        "1",
        { "id": "2", "name": "Updated genre" },
        { "name": "New genre" }
      ]
    }
  ]
}
```

| Relation value | Behavior |
|---|---|
| A key, such as `"1"` | Link an existing record without changing it |
| An object with a primary key | PATCH updates supplied fields; PUT replaces the related record |
| An object without a primary key | Create a related record with defaults and a generated key |

The key name and type follow the target model. An object containing only a key still counts as an update: in PUT it must include the model's required fields. Replacement preserves primary keys, generated values and `readOnly` fields. In POST, nested objects with existing keys receive partial updates. A missing target is an error; creating a nested record without a key requires an autogenerated primary key.

A supplied list replaces the relation's membership. PATCH preserves omitted relations; PUT clears omitted writable links. `[]` clears a list and `null` clears a nullable single relation. Removing a link does not delete the related record. Required relations must remain populated.

Use either the relation field or its storage key in an object, for example `genres` or `genreIds`. Reverse relations update the target key. If a target path crosses an array and the server cannot identify one element to attach, provide the array with the intended keys explicitly. Protected keys cannot be changed.

All nested changes belong to the main record's transaction. A validation error, missing record or invalid response selection rolls back the entire operation. Updating a shared record affects every record linked to it.

GraphQL accepts typed objects in relation fields. To change only the links in a replace mutation, use storage keys such as `genreIds`. For example:

```graphql
mutation {
  movieUpdate(id: "1", data: {
    actors: [{
      userId: "1"
      genres: [{ id: "2", name: "Updated genre" }, { name: "New genre" }]
    }]
  }) {
    actors { data { genres { data { id name } } } }
  }
}
```

### REST query parameters

REST accepts one query parameter, `scope`, containing a JSON array `[fields, arguments?]`. The first object selects fields; the optional second object supplies `where`, `order` and `pager` for a list. The same format applies to the root query, embedded objects and relations.

Select users and their movies with independent ordering and pagination:

```js
const scope = [
  {
    id: true,
    fullName: true,
    movies: [
      { id: true, title: true },
      {
        order: [{ field: 'title', direction: 'ASC' }],
        pager: { page: 1, pageSize: 5 },
      },
    ],
  },
  {
    where: { fullName: { contains: 'Мира' } },
    order: [{ field: 'fullName', direction: 'ASC' }],
    pager: { page: 1, pageSize: 20 },
  },
];
const params = new URLSearchParams({ scope: JSON.stringify(scope) });
const response = await fetch(`/users?${params}`);
```

Select ordinary fields with `true` and objects or relations with their own scope arrays. Without arguments, the array contains only the fields object. `"*": true` includes own fields and stored keys, except `writeOnly` fields; select relations explicitly.

For example, select a movie's own fields, its actors' users and sorted genres:

```json
[
  {
    "*": true,
    "actors": [
      {
        "user": [{ "id": true, "fullName": true }],
        "genres": [
          { "*": true },
          { "order": [{ "field": "name", "direction": "ASC" }] }
        ]
      }
    ]
  }
]
```

Omitting `scope` returns own fields, as with `[{"*":true}]`. An empty selection `[{}]` returns an object without fields. Lists retain the `{ data, total }` response structure.

Arguments are available only on lists. Single-record queries and mutation responses can set arguments on their embedded lists. Parameters are validated even on empty data; an invalid response selection rolls back record changes. Invalid scopes return `400`. The JSON length limit is 10,000 characters; selection depth is limited to 32 levels.

OpenAPI remains at version 3.0.3. It cannot define a separate schema for each array position: the documentation describes the elements, and the server strictly validates their order.

### GraphQL

```graphql
query {
  userList(
    order: [{ field: fullName, direction: ASC }]
    pager: { page: 1, pageSize: 20 }
  ) {
    total
    data {
      id
      fullName
      movies(order: [{ field: title, direction: ASC }], pager: { pageSize: 5 }) {
        total
        data { id title }
      }
    }
  }
}
```

The query `user(id: ...)` returns one record or `null` if it is missing. Mutations are `userCreate(data: ...)`, `userReplace(id: ..., data: ...)`, `userUpdate(id: ..., data: ...)`, `userDelete(id: ...)`. For models containing only generated fields, the create mutation takes no `data` argument. Writes and validation follow the same rules as REST. Relations selected in a mutation result determine the response contents.

String primary keys use GraphQL `ID`; ordinary strings use `String`, numbers use `Float`, and pagination parameters use `Int`. Schema enums preserve valid string labels; other values receive `VALUE_0`, `VALUE_1`, etc. String lengths, formats and other model constraints are validated by the server during request execution. Introspection is available for exploring the schema. Selected list arguments are validated before executing mutations. Errors include `extensions.code`: `INVALID_INPUT`, `INVALID_QUERY`, `NOT_FOUND`, `CONFLICT` or `INTERNAL_ERROR`.

## Example database

```json
{
  "countries": [
    {
      "id": "1",
      "isArchived": false,
      "name": "Ардения"
    },
    {
      "id": "2",
      "isArchived": false,
      "name": "Велория"
    }
  ],
  "genres": [
    {
      "id": "1",
      "isArchived": false,
      "name": "Криминал",
      "parentIds": []
    },
    {
      "id": "2",
      "isArchived": false,
      "name": "Гангстер",
      "parentIds": ["1"]
    },
    {
      "id": "3",
      "isArchived": false,
      "name": "Драма",
      "parentIds": []
    },
    {
      "id": "4",
      "isArchived": false,
      "name": "Комедия",
      "parentIds": []
    }
  ],
  "movies": [
    {
      "actors": [
        {
          "genreIds": ["2", "3"],
          "id": "movie-1-actor-1",
          "userId": "1"
        },
        {
          "genreIds": ["3"],
          "id": "movie-1-actor-2",
          "userId": "2"
        }
      ],
      "coverSrc": "https://example.com/covers/shadows-of-ardenia.jpg",
      "description": "Наследница портового города раскрывает заговор двух соперничающих семей.",
      "id": "1",
      "isArchived": false,
      "publisherIds": ["2"],
      "title": "Тени Ардении"
    },
    {
      "actors": [],
      "coverSrc": "https://example.com/covers/northern-star.jpg",
      "description": "Ночной администратор старого отеля случайно становится участником поисков пропавшей картины.",
      "id": "2",
      "isArchived": false,
      "publisherIds": ["1"],
      "title": "Полночь в «Северной звезде»"
    }
  ],
  "publishers": [
    {
      "id": "1",
      "isArchived": false,
      "name": "Northlight Studio"
    },
    {
      "id": "2",
      "isArchived": false,
      "name": "Aurora Pictures"
    }
  ],
  "users": [
    {
      "bornAt": "1988-03-14",
      "countryId": "1",
      "fullName": "Мира Волкова",
      "id": "1",
      "isArchived": false
    },
    {
      "bornAt": "1991-11-02",
      "countryId": "2",
      "fullName": "Леон Ветров",
      "id": "2",
      "isArchived": false
    }
  ]
}
```

## Files

Add `files.directory` and `files.metadata` to the configuration and start the server:

```bash
deep-json-server server.config.js
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

In disk mode, the binary is stored at `<files.directory>/<directory>/<name>`. Metadata stores `directory`, `mimeType` and `name`; the server reads the size from the file and builds its URLs. Directories and the metadata file are created when needed.

Use one server process per disk database and file store. Stop it before editing stored files or metadata manually. Storage paths cannot contain symbolic links. Uploads and renames cannot overwrite the database, counters, schema, loaded configuration or metadata file.

Send the file as a binary request body. In a browser, use `xhr.send(file)` and track progress through `XMLHttpRequest.upload.onprogress`. The default maximum size is 100 MiB and can be changed through `server.maxFileSize`. Missing or unsafe headers and paths return `400`, an exceeded limit returns `413`, and a missing, malformed, or Fastify-unsupported `Content-Type` returns `400` or `415`, depending on which validation stage rejects it.

## Programmatic API

```js
import { createServer } from '@kollors/deep-json-server/server';
import config from './server.config.js';

const facade = await createServer(config);
const server = facade.fastify();
await server.listen();
// await server.close();
```

The `openapi()` and `graphql()` methods return schemas and require `database.schema`. `fastify()` returns the server instance for configuration and startup. The database and enabled services initialize on `ready()`, `listen()` or the first `inject()`; initialization errors stop startup. Override server features with `createServer(config, { files: false, graphql: true, openapi: true })`.

The root import `@kollors/deep-json-server` also provides these functions. Server adapters load when enabled. Generators can be used independently:

```js
import { generateOpenapi, writeOpenapi } from '@kollors/deep-json-server/openapi';
import { generateGraphql, writeGraphql } from '@kollors/deep-json-server/graphql';

const document = await generateOpenapi('./schema.json', { files: true });
const sdl = await generateGraphql('./schema.json');
await writeOpenapi(document, './generated/openapi.yaml');
await writeGraphql(sdl, './generated/schema.graphql');
```

`generateOpenapi()` also accepts `host`, `port`, `pageSize`, `maxPageSize` and `info`. Pass a schema object instead of a path if preferred. Servers and generators use their own copy of the model. Pagination sizes must be positive integers; `pageSize` cannot exceed `maxPageSize`.

## Storage and development

Updates run sequentially within one server instance and are validated on a copy of the data before saving. Use one server process per database file. `increment` counters are stored next to the database in `<database path>.counters.json`; keep that file with the database. Numbers are reserved before the data write, so a failed write can leave gaps but cannot reuse a reserved number.

The server is intended for mocking APIs. Implement authentication and password hashing in your application if needed.

```sh
npm ci
npm run verify
```

The command checks types, code style, test coverage and installation from the package archive.

To publish a new alpha, update the version in `package.json`, `package-lock.json` and `src/constants.ts`, then push to `main`. GitHub Actions creates the version tag and publishes to npm `alpha` through trusted publishing. Already published versions are skipped. If the tag exists but publication failed, a retry uses that tag and verifies that the package files match it. Pushing a version tag also triggers publication; stable versions publish to `latest`.

License: MIT.
