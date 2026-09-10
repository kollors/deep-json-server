# Deep JSON Server

[Русский](README.ru.md)

A JSON-backed mock server with REST, GraphQL, nested queries, binary files and schema exports. Requires Node.js 22 or newer.

**1.0.0-alpha.1 is a breaking prerelease.** The old `$schema`/`$info` model format and `_where`, `_sort`, `_embed`, `_page`, `_perPage` query parameters are no longer supported.

## Installation

```sh
npm install @kollors/deep-json-server@alpha
```

The `alpha` npm channel is separate from `latest`. Install an exact version with `@1.0.0-alpha.1`.

## Quick start

`server.config.js`:

```js
export default {
  database: { path: './database.json', schema: './schema.json' },
  graphql: { enabled: true, path: './generated/schema.graphql' },
  openapi: { path: './generated/openapi.yaml' },
  server: { host: '127.0.0.1', port: 4001, pageSize: 10, maxPageSize: 100 },
};
```

```sh
npx deep-json-server server.config.js
npx deep-json-server --openapi-only --graphql-only server.config.js
```

The second command exports both schemas without listening on a port. Starting the server alone does not write schema files.

Complete catalog examples: [database](examples/database.json), [model schema](examples/schema.json), [configuration](examples/server.config.js).

## Configuration

| Setting | Meaning |
|---|---|
| `database.path` / `database.data` | Exactly one: JSON file or in-memory collection object |
| `database.schema` | Model object or JSON schema-file path; optional for REST |
| `openapi.path` | YAML export destination |
| `openapi.info` | Optional `title`, `version`, `description` |
| `graphql.enabled` | Enable GraphQL HTTP endpoint; default `false` |
| `graphql.endpoint` | Endpoint path; default `/graphql` |
| `graphql.path` | GraphQL SDL export destination |
| `server.host`, `server.port` | Defaults `127.0.0.1`, `4001`; CLI also reads `HOST`/`PORT` |
| `server.pageSize`, `server.maxPageSize` | Defaults 10 and 100; default size is capped by the maximum |
| `server.cors`, `server.logger` | Default `true`; logger also accepts Fastify logger options |
| `server.maxFileSize` | Default 100 MiB |
| `files.data` | In-memory binary files |
| `files.directory`, `files.metadata` | Disk storage directory and metadata JSON file; both required |

Configuration-file paths resolve relative to that file. Direct `createServer()` paths resolve relative to the working directory. In-memory input is copied.

CLI flags:

| Flag | Action |
|---|---|
| `--files` | Enable binary-file routes |
| `--graphql` | Enable GraphQL endpoint |
| `--openapi` | Export OpenAPI and start |
| `--openapi-only` | Export OpenAPI without starting |
| `--graphql-schema` | Export GraphQL SDL and start |
| `--graphql-only` | Export GraphQL SDL without starting |
| `--help` | Show usage |

Both exporters can be combined. Any `--*-only` flag prevents startup. CLI file routes require `--files`; programmatic use enables them when `files` is configured unless overridden through the second `createServer()` argument.

## Model schema

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

Explicit schemas are strict: undeclared fields and collections are rejected, except storage keys inferred from relations. Existing data is validated on startup. Schemas can be exported for empty collections or an empty database object. REST without a schema retains the standard generated `id` behavior.

### Fields

Types: `string`, `number`, `boolean`, `object`, or a model name. Append `[]` for an array. No `integer`, `relation`, `items`, or multidimensional type strings. Nested fields use full dotted paths, for example `actors.fullName`. Objects inside arrays may contain their own arrays.

| Properties | Meaning |
|---|---|
| `type` | Required type |
| `description`, `example` | Documentation and example value |
| `required`, `nullable` | Defaults `false`; presence and explicit null are separate |
| `default` | Value when omitted on create/replace; PATCH does not insert defaults |
| `enum` | Allowed values; for arrays, allowed element values |
| `primary` | Root primary key; mandatory, unique, non-null and immutable |
| `generated` | `uuid` for strings, `increment` for numbers; server supplies the value |
| `readOnly`, `writeOnly` | Output-only or input-only; mutually exclusive |
| `minLength`, `maxLength`, `pattern` | String constraints |
| `format` | `date`, `date-time`, `email`, `uri`, `uuid` |
| `minimum`, `maximum` | Inclusive numeric bounds |
| `source`, `target`, `onDelete` | Relation metadata |

String/numeric constraints on `string[]`/`number[]` apply to every element. `required`/`nullable` apply to the entire array, and `default`/`example` contain a complete array. Array elements are non-null. There are no item-count or uniqueness constraints. A required ordinary array may be empty.

Primary keys can be named `username`, `code`, etc.; exactly one root string/number primary key is required. Without `generated`, the client supplies it during creation. Generated fields are root fields, absent from create/replace/update input; they cannot have `default`. Replace preserves generated and read-only root values.

For example, a `LocalUser` with primary `username` and `password: {"type":"string","required":true,"writeOnly":true}` has `localUser(username: ...)` and `/localUsers/{username}`. `writeOnly` excludes passwords from responses, scope, filters and ordering. It does not implement hashing or authentication.

### Relations

```json
"actors.genres": {
  "type": "Genre[]",
  "source": "actors.genreIds",
  "required": true
}
```

`Genre` produces an object; `Genre[]` produces a list. `source` defaults to the current model's primary key, `target` to the target model's primary key. Both paths are rooted at their respective records. Within `actors`, `actors.genreIds` reads the current actor's IDs. An omitted `source` still means the root model key, not `actors.id`.

Storage keys remain in the database and are included among own fields. Their types can be inferred from the target key. For an undeclared source pointing to a target primary key, a list relation implies an array of keys; a single relation implies a scalar key. Declare storage fields explicitly when the mapping is ambiguous. Generation never guesses from the first database record.

Reverse example: `User.movies = {"type":"Movie[]","target":"actors.userId"}`. A movie is returned once even if several actors match. A single relation resolving to multiple targets is invalid.

Every supplied direct reference must resolve. `required: true` on a relation requires at least one target before response filtering/pagination. Reverse views with a primary source may be empty unless required. Missing single relations return `null`.

`onDelete` describes what happens **when a target record is deleted**:

- `restrict` (default): refuse deletion while a surviving owner refers to the target.
- `cascade`: delete the referring owner. For `User.country`, deleting the country deletes its users. For `Movie.actors.user`, deleting the user removes matching actor elements and retains the movie.

Deletion computes the cascade closure, handles cycles, checks restrictions and validates remaining data before committing. A failure cancels the complete operation. Policies also apply to explicitly declared reverse relation views; configure both directions deliberately when both are present.

## Queries and responses

Collections and lists of objects, including embedded `object[]` fields, return:

```json
{ "data": [], "total": 0 }
```

Primitive arrays remain plain arrays. Every object list accepts optional `where`, `order`, `pager`. Processing order is filter → sort → pagination. `total` is the filtered count before pagination. Page numbers start at 1; default pagination applies even when omitted. Exceeding `maxPageSize`, fractional values and nonpositive values are errors. Out-of-range pages return empty `data` with the correct `total`.

`where` uses field operators `eq`, `ne`, `in`, string `contains`/`startsWith`/`endsWith`, and comparisons `gt`, `gte`, `lt`, `lte`. Logical composition uses `and`, `or`, `not`. Arrays support `some`, `every`, `none`; primitive arrays also support `contains`, `in`. String matching is case-insensitive. Field filters use operator objects, not shorthand scalar values.

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

Root filters choose parents. Filters inside a selected relation only trim that relation; they do not remove the parent. Each parent's child list is processed independently. Filtering does not require a relation to be included in the response.

`order` is an array of `{ "field": "fullName", "direction": "ASC" }` rules. Earlier rules have priority; complete ties retain storage order. Null and missing values compare equally. REST uses dotted field paths; GraphQL uses generated enums (`profile_name` for `profile.name`). Ambiguous enum names cause a generation error. Sorting parents by a relation or an array is unsupported; sorting inside the relation is supported.

### REST

| Method | Path | Operation |
|---|---|---|
| GET | `/users` | `userList` |
| GET | `/users/{id}` | `user` |
| POST | `/users` | `userCreate` |
| PUT | `/users/{id}` | `userReplace` |
| PATCH | `/users/{id}` | `userUpdate` |
| DELETE | `/users/{id}` | `userDelete` |

The path key name follows the primary key. POST/PUT/PATCH receive raw record objects. PUT replaces the record while retaining its key and server-owned root values. PATCH shallowly merges supplied fields; supplied nested objects are full replacements. Create/replace enforce required fields. Update validates supplied values and the final record. Missing targets return 404; conflicts return 409. DELETE returns the deleted record.

Query parameters `where`, `order`, `pager`, `nested` contain JSON. `scope` is a selection string. Example shown before URL encoding:

```text
GET /users?where={"fullName":{"contains":"Мира"}}&order=[{"field":"fullName","direction":"ASC"}]&pager={"page":1,"pageSize":20}
```

Construct encoded URLs with `URLSearchParams`:

```js
const params = new URLSearchParams({
  scope: 'id,fullName,movies(id,title)',
  nested: JSON.stringify({ movies: { order: [{ field: 'title', direction: 'ASC' }], pager: { page: 1, pageSize: 5 } } }),
});
const response = await fetch(`/users?${params}`);
```

`scope=*,actors(user(id,fullName),genres(*))` selects own fields and explicit relations. `*` selects only own fields of the current object, including inferred storage keys and excluding `writeOnly`. It never recursively expands relations. Without scope, own fields are selected. Wrappers `data`/`total` remain present.

`nested` maps full response paths to list options:

```json
{
  "actors": { "pager": { "pageSize": 5 } },
  "actors.genres": {
    "where": { "id": { "in": ["2", "3"] } },
    "order": [{ "field": "name", "direction": "ASC" }]
  }
}
```

A nested path must be selected by scope and must address an object list. Single-record routes and mutations accept `scope` and `nested`; root list parameters only apply to collection GET. Invalid names and unsafe paths return 400.

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

Single queries are `user(id: ...)`, with no `ById`; missing records yield null. Mutation names are `userCreate(data: ...)`, `userReplace(id: ..., data: ...)`, `userUpdate(id: ..., data: ...)`, `userDelete(id: ...)`. A generated-only model creates records without a `data` argument. Mutations use the same validation and storage operations as REST. Selecting relations in mutation results shapes the response only.

String primary keys use GraphQL `ID`; ordinary strings use `String`, numbers use `Float`, pagination uses `Int`. Schema enums preserve valid string labels; other values receive `VALUE_0`, `VALUE_1`, etc. Schema constraints such as string length and formats are enforced by the shared runtime validator; SDL alone cannot express all constraints. Introspection and ordinary query/mutation execution are supported; this release does not add subscriptions or bulk mutations.


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

## Programmatic API

```js
import { createServer } from '@kollors/deep-json-server';
import config from './server.config.js';

const facade = await createServer(config);
const openapi = await facade.openapi();
const sdl = await facade.graphql();
const server = facade.fastify();
await server.listen();
// await server.close();
```

Accessors are lazy; exporting schemas does not listen or initialize disk file storage. Override runtime features with `createServer(config, { files: false, graphql: true })`.

## Storage and development

Updates are serialized within one server instance and validated on a draft before persistence. Use one writer per database file. Increment counters are stored next to the database in `<database path>.counters.json`; keep that file with the database. Numbers are reserved before the data write, so a failed write can leave gaps but cannot reuse a reserved number. UUID generation uses Node's built-in crypto API.

This is a mock server; there is no authentication or password hashing. File routes keep their independent storage and validation.

```sh
npm ci
npm run verify
```

Verification runs type checking, lint, coverage gates and installation checks against the packed package. A new alpha version in `package.json` pushed to `main` creates its version tag and publishes through GitHub Actions trusted publishing to npm `alpha`. An existing tag skips automatic publication. Explicit version-tag pushes also publish; stable versions use `latest`. The publishing script rejects mismatched Git tags.

License: MIT.
