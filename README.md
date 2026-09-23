# Deep JSON Server

[Русский](README.ru.md)

[Release notes](CHANGELOG.md) · [Migration from 0.9.0](MIGRATION.md)

A JSON mock server with REST, GraphQL, related records, file uploads and schema exports. Supports user login, owner and administrator permissions, record timestamps and soft deletion. Requires Node.js 22 or newer.

**Breaking changes in 1.0.0.** See the [migration guide](MIGRATION.md) when upgrading from 0.9.0. The REST `scope` wildcard selects only scalar fields that do not store relation keys. Arrays, objects, relations and their keys must be selected explicitly. With auth enabled, record permissions are available through the virtual `actions` field.

## Installation

```sh
npm install @kollors/deep-json-server@rc
```

To install this release candidate, use `@1.0.0-rc.2`.

## Quick start

Create two files in the same directory.

`database.json`:

```json
{
  "users": [
    { "id": "1", "fullName": "Mira Volkova" }
  ]
}
```

`server.config.js`:

```js
export default { storage: 'file', database: { source: './database.json' } };
```

```sh
npx deep-json-server server.config.js
```

The user list is available at `http://127.0.0.1:4001/users`.

Add a [model schema](#model-schema) to define relations and validation. See [queries](#queries-and-responses), [authentication](#authentication), [soft deletion](#record-dates-deletion-and-ownership), [files](#files) and the [programmatic API](#programmatic-api) for more.

## Configuration

With `storage: 'file'`, provide paths for every source and the schema. With `'memory'`, provide data directly. Use the same mode throughout the configuration. Add `auth` or `files` to enable those REST services. Add `graphql` to configure the GraphQL endpoint and `openapi` to serve the REST specification. `graphql: {}` and `openapi: {}` use default endpoint paths; add `target` to export a schema. GraphQL must also be enabled by root `api` in the model schema.

```js
export default {
  storage: 'file',
  database: { source: './database.json', schema: './schema.json' },
  auth: { source: './users.json', expiresIn: 3600 },
  files: { source: './uploads' },
  graphql: { target: './generated/schema.graphql' },
  openapi: { target: './generated/openapi.yaml' },
  package: { source: './package.json' },
  server: { host: '127.0.0.1', port: 4001 },
};
```

| Setting | Meaning |
|---|---|
| `storage` | Required: `file` or `memory`; applies to all sources and the schema |
| `database.source` | Database JSON path or collection object |
| `database.schema` | Schema JSON path or schema object; optional for REST |
| `auth.source` | Users JSON path or user array |
| `auth.expiresIn` | Session lifetime in seconds; default 3600 |
| `files.source` | Files directory or initial file array |
| `files.metadata` | For `file` only: metadata JSON path; defaults to `.files.json` inside `files.source` |
| `graphql.endpoint` | HTTP endpoint; default `/graphql` |
| `graphql.target` | GraphQL SDL export destination |
| `openapi.endpoint` | HTTP endpoint; default `/openapi.json` |
| `openapi.target` | OpenAPI export destination |
| `package.source` | Project `package.json`; required when `openapi` is configured |
| `server.host`, `server.port` | Defaults `127.0.0.1`, `4001`; CLI also reads `HOST`/`PORT` |
| `server.pageSize`, `server.maxPageSize` | Defaults 10 and 100; default size is capped by the maximum |
| `server.cors`, `server.logger` | Default `true`; logger also accepts Fastify logger options |
| `server.maxFileSize` | Default 100 MiB |

`package.source` follows the storage mode. With `storage: 'file'`, pass a path to `package.json`. With `storage: 'memory'`, pass its metadata directly: `{ name: 'example-api', version: '1.0.0', description: 'Example API' }`; `name` and `version` are required, while `description` is optional.

Relative paths resolve from the configuration file directory, or from the working directory with `createServer(config)`. In-memory data, including the schema and package metadata, is copied. Port `0` lets the system choose an available port.

To expose the database only through GraphQL while keeping authentication and files as REST endpoints documented by OpenAPI, use:

```js
export default {
  storage: 'file',
  database: { source: './database.json', schema: './schema.json' },
  auth: { source: './users.json' },
  files: { source: './uploads' },
  graphql: {},
  openapi: {},
  package: { source: './package.json' },
};
```

Set the root `api` in `schema.json`:

```json
{
  "api": ["graphql"],
  "models": {
    "Item": {
      "collection": "items",
      "fields": { "id": { "type": "string", "primary": true } }
    }
  }
}
```

Use `"api": ["rest"]` with `openapi: {}` for REST and its OpenAPI description, or `["rest", "graphql"]` with both sections for both database APIs. The `graphql` section is required exactly when the schema root includes `graphql`. OpenAPI describes database routes only when REST is enabled; authentication and file routes are included whenever their sections are configured.

### CLI

| Flag | Action |
|---|---|
| `--generate` | Export schemas, then start the server |
| `--generate-only` | Export schemas and exit |
| `--host <host>` | Server address |
| `--port <port>` | Server port |
| `--help, -h` | Help |
| `--version, -v` | Package version |

Address precedence: CLI → configuration → `HOST`/`PORT` → defaults. Without generation flags, only the server starts. `--generate` and `--generate-only` are mutually exclusive.

## Model schema

Examples: [database](examples/database.json), [model schema](examples/schema.json), [configuration](examples/server.config.js).

```json
{
  "api": ["rest", "graphql"],
  "models": {
    "Country": {
      "collection": "countries",
      "fields": {
        "id": {
          "type": "string",
          "primary": true,
          "generated": "uuid"
        },
        "name": {
          "type": "string",
          "required": true
        },
        "users": {
          "type": "User[]",
          "target": "countryId"
        }
      }
    },
    "User": {
      "collection": "users",
      "fields": {
        "id": {
          "type": "string",
          "primary": true,
          "generated": "uuid"
        },
        "fullName": {
          "type": "string",
          "required": true
        },
        "country": {
          "type": "Country",
          "source": "countryId"
        }
      }
    }
  }
}
```

Model definitions belong in `models`. The schema root accepts `models`, `api`, `timestamps` and `softDelete`. Root `api` selects database routes. When omitted, it defaults to REST and also GraphQL if the server config has a `graphql` section. A model can override the global timestamp and soft-deletion settings. A model's optional `api` array can narrow access to `['rest']`, `['graphql']`, both, or `[]` to hide it from both. A model cannot enable an API absent from root `api`. OpenAPI includes models with REST enabled. GraphQL generation needs at least one GraphQL model; REST OpenAPI generation needs at least one REST model. On a GraphQL-only server, OpenAPI can still describe configured auth and file routes. Related models must allow the same API. Model names must be valid identifiers; type and operation collisions cause errors. `and`, `or` and `not` are reserved filter names.

For example, with root `api: ['rest', 'graphql']`, a model set to `api: ['rest']` has REST routes and OpenAPI paths but no GraphQL operations; a model set to `api: ['graphql']` has GraphQL operations but no REST routes or OpenAPI paths.

An excluded model remains part of the database schema and its stored records are still validated. Its `api` setting controls how clients can access it.

| Capability | With schema | Without schema |
|---|---|---|
| REST CRUD | Model validation | JSON/body/identifier validation only |
| Relations | Explicit model fields | `countryId`, `genreIds`, etc. naming conventions |
| OpenAPI 3.0.3 export | Available | Error when requested |
| GraphQL SDL / API | Available | Error when requested |

Explicit schemas are strict: undeclared fields and collections are rejected, except storage keys inferred from relations. Existing data is validated on startup. Generation uses the model definitions.

Schemaless REST generates an `id` and preserves arbitrary JSON fields. Newly inferred relations are available to subsequent reads and writes without restarting the server. Filters and individual field selections use identifier-style names. `scope=[{"*":true}]` returns top-level JSON scalars; arrays and objects must be selected by name. Fields with mixed value types can be read explicitly, but filtering, ordering and paging heterogeneous lists require an explicit schema.

Each model requires `collection` (the database collection name, also used as its REST path when REST is enabled) and `fields` (field definitions). The model name (`User`) determines GraphQL type and operation names. `api` controls route availability; `timestamps` and `softDelete` override global settings for that model.

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

Each `enum` value must match the field type and its constraints. Use `nullable: true` to allow `null` for the field; do not include `null` in `enum`. Invalid values are rejected when the schema is loaded.

Each model requires exactly one primary key of type `string` or `number`, declared at the top level. The name is arbitrary: `id`, `username`, `code`. If `generated` is omitted, the client supplies the value on creation. Generated fields must be declared at the top level, are excluded from input types and cannot have `default`. Replacing a record preserves generated values and read-only fields, including nested objects. To protect fields inside an array, mark the entire array or its containing object as `readOnly`. Objects containing only server-managed fields are output-only.

For example, a `LocalUser` with primary key `username` and `password: {"type":"string","required":true,"writeOnly":true}` has `localUser(username: ...)` and `/localUsers/{username}`. A `writeOnly` field accepts input and is excluded from responses, `scope`, filters and ordering.

Objects used in GraphQL must have at least one field visible in responses; REST also accepts empty objects.

### Relations

```json
{
  "actors.genres": {
    "type": "Genre[]",
    "source": "actors.genreIds",
    "required": true
  }
}
```

`Genre` returns an object; `Genre[]` returns a list. `source` defaults to the current model's primary key, `target` to the target model's primary key. These defaults also apply to nested relations. Paths start at the root of their respective records: in this example, `actors.genreIds` contains the current actor's genre keys.

Relation keys are stored in the database and included among the record's own fields. Their types are inferred from the matched keys. A `source` field pointing to a target primary key can be omitted from the field declarations: the schema infers an array of keys for a list relation or a scalar key for a single relation. Declare the storage field explicitly when the mapping is ambiguous.

Reverse example: `User.movies = {"type":"Movie[]","target":"actors.userId"}`. A movie is returned once even if several actors match. A single relation that matches multiple records causes an error.

Every supplied direct relation key must point to an existing record. `required: true` on a relation requires at least one target before response filtering/pagination. Reverse relations using the primary key as `source` may be empty unless required. Missing single relations return `null`.

`onDelete` describes what happens **when a target record is deleted**:

- `restrict` (default): refuse deletion while a retained record refers to the target.
- `cascade`: delete the referring record. For `User.country`, deleting the country deletes its users. For `Movie.actors.user`, deleting the user removes matching actor elements and retains the movie.

Cascading deletion runs as one operation, including cyclic relations. A validation failure cancels the entire operation. `onDelete` rules also apply to explicitly declared reverse relations; account for both rules when defining both directions.

## Example database

```json
{
  "countries": [
    {
      "id": "1",
      "isArchived": false,
      "name": "Ardenia"
    },
    {
      "id": "2",
      "isArchived": false,
      "name": "Veloria"
    }
  ],
  "genres": [
    {
      "id": "1",
      "isArchived": false,
      "name": "Crime",
      "parentIds": []
    },
    {
      "id": "2",
      "isArchived": false,
      "name": "Gangster",
      "parentIds": ["1"]
    },
    {
      "id": "3",
      "isArchived": false,
      "name": "Drama",
      "parentIds": []
    },
    {
      "id": "4",
      "isArchived": false,
      "name": "Comedy",
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
      "description": "An heiress in a port city uncovers a plot involving two rival families.",
      "id": "1",
      "isArchived": false,
      "publisherIds": ["2"],
      "title": "Shadows of Ardenia"
    },
    {
      "actors": [],
      "coverSrc": "https://example.com/covers/northern-star.jpg",
      "description": "A night clerk at an old hotel gets drawn into the search for a missing painting.",
      "id": "2",
      "isArchived": false,
      "publisherIds": ["1"],
      "title": "Midnight at the Northern Star"
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

## Queries and responses

The movie, actor and genre examples use the full [example schema](examples/schema.json). Run them with the [example configuration](examples/server.config.js):

```sh
npx deep-json-server examples/server.config.js
```

Collections and lists of objects, including embedded `object[]` fields, return:

```json
{ "data": [], "total": 0 }
```

Primitive arrays are returned as plain arrays. Every object list accepts optional `where`, `order` and `pager`. Processing order is filter → sort → pagination. `total` is the filtered record count before pagination.

Use `page` and `pageSize` in `pager`. The default is the first page with the size from `server.pageSize`. Both values must be positive integers; `pageSize` is limited by `server.maxPageSize`. Out-of-range pages return empty `data` with the total matching record count in `total`.

`where` uses field operators `eq`, `ne`, `in`, string `contains`/`startsWith`/`endsWith`, and comparisons `gt`, `gte`, `lt`, `lte`. Conditions in the same object must all match. `and` and `or` take arrays of conditions; `not` takes one condition and can also be used inside a field filter. Arrays support `some`, `every`, `none`; primitive arrays also support `contains`, `in`. String `contains`, `startsWith` and `endsWith` ignore case; `eq`, `ne` and `in` compare exact values. A field condition is an object containing an operator, such as `{ "id": { "eq": "1" } }`.

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

`order` is an array of `{ "field": "fullName", "direction": "ASC" }` rules. `ASC` sorts in ascending order and `DESC` in descending order. Earlier rules have priority; equal values retain storage order. Null and missing values compare equally. REST uses dotted field paths; GraphQL uses generated enums (`profile_name` for `profile.name`). Ambiguous enum names cause a generation error. Sorting supports scalar fields of the current object, including nested fields. Related lists accept their own `order`.

### REST

When REST is enabled by root `api`, `GET /` lists only REST-enabled models: `{ "resources": ["users", "movies"] }`. A GraphQL-only server has no `GET /` database route. Each REST-enabled collection has these routes:

| Method | Path | Operation |
|---|---|---|
| GET | `/users` | `userList` |
| GET | `/users/{id}` | `user` |
| POST | `/users` | `userCreate` |
| PUT | `/users/{id}` | `userReplace` |
| PATCH | `/users/{id}` | `userUpdate` |
| DELETE | `/users/{id}` | `userDelete` |

The path parameter name follows the primary key. POST, PUT and PATCH accept a JSON record object. PUT replaces the record while retaining its key and server-managed fields. PATCH merges fields at the top level; supplied nested objects are replaced while preserving their read-only fields. Creation and replacement require all mandatory fields. Updates validate supplied values and the final record. Missing records return `404`; conflicts return `409`.

POST returns the created record with status `201`; PUT, PATCH and DELETE return the updated or deleted record with status `200`. REST errors use `{ "error": "Error description" }`.

### REST query parameters

REST record routes accept one query parameter, `scope`, containing a JSON array `[fields, arguments?]`. The first object selects fields; the optional second object supplies `where`, `order` and `pager` for a list. The same format applies to the root query, embedded objects and relations.

Select users and their movies with independent ordering and pagination:

```js
const scope = [
  {
    id: true,
    fullName: true,
    movies: [
      { id: true, title: true },
      { order: [{ field: 'title', direction: 'ASC' }], pager: { page: 1, pageSize: 5 } },
    ],
  },
  {
    where: { fullName: { contains: 'Mira' } },
    order: [{ field: 'fullName', direction: 'ASC' }],
    pager: { page: 1, pageSize: 20 },
  },
];
const params = new URLSearchParams({ scope: JSON.stringify(scope) });
const response = await fetch(`/users?${params}`);
```

Select scalars and primitive arrays with `true`, and objects or relations with their own scope arrays. Without arguments, the array contains only the fields object. `"*": true` includes only scalar fields of the current model that do not store relation keys. Arrays, objects, relations, their keys and `writeOnly` fields are not included by the wildcard. A relation key remains available through an explicit selection such as `{ "*": true, "countryId": true }`. Without a schema, a key is excluded from `*` only when the server can infer its relation from the name and an existing collection.

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

Omitting `scope` returns scalar fields, as with `[{"*":true}]`. An empty selection `[{}]` returns an object without fields. Lists retain the `{ data, total }` response structure.

Arguments are available only on lists. A list can instead use `{ "union": [scope, ...] }`: each part is a normal list scope, parts run in array order, and the first record for each primary key is kept. For embedded object arrays without primary keys, each source element is kept once, even if several parts select it. Distinct elements with equal contents remain separate. Single-record queries and mutation responses can set arguments on their embedded lists. Parameters are validated even on empty data; an invalid response selection rolls back record changes. Invalid scopes return `400`. The JSON length limit is 10,000 characters; selection depth is limited to 32 levels.

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
        { "id": "1" },
        { "id": "2", "name": "Updated genre" },
        { "name": "New genre" }
      ]
    }
  ]
}
```

| Relation value | Behavior |
|---|---|
| An object containing only a primary key | Link an existing record without changing it |
| An object with a primary key and other fields | PATCH updates supplied fields; PUT replaces the related record |
| An object without a primary key | Create a related record with defaults and a generated key |

The key name and type follow the target model. An object containing only a key still counts as an update: in PUT it must include the model's required fields. Replacement preserves primary keys, generated values and `readOnly` fields. In POST, nested objects with existing keys receive partial updates. A missing target is an error; creating a nested record without a key requires an autogenerated primary key.

A supplied list replaces the relation's membership. PATCH preserves omitted relations; PUT clears omitted writable links. `[]` clears a list and `null` clears a nullable single relation. Removing a link does not delete the related record. Required relations must remain populated.

Use either the relation field or its storage key in an object, for example `genres` or `genreIds`. Supplying both fields returns `400 INVALID_INPUT`, even when their key sets match:

```json
{
  "genreIds": ["1", "2"],
  "genres": ["1", "2"]
}
```

The server rejects both fields together and rolls back the operation. Relation fields accept objects only; use `genreIds` to change links without creating or updating related records. Reverse relations update the target key. If a target path crosses an array and the server cannot identify one element to attach, provide the array with the intended keys explicitly. Protected keys cannot be changed.

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

### GraphQL

Set `database.schema`, include `graphql` in the schema's root `api`, and add `graphql: {}` to the configuration:

```sh
npx deep-json-server server.config.js
```

Send requests to `/graphql` using POST with `Content-Type: application/json` and a body of `{ "query": "…", "variables": {} }`. Change the path through `graphql.endpoint`.

```graphql
query {
  userList(
    where: { fullName: { contains: "Mira" } }
    order: [{ field: fullName, direction: ASC }]
    pager: { page: 1, pageSize: 20 }
  ) {
    total
    data {
      id
      fullName
      movies(
        where: { title: { contains: "Shadows" } }
        order: [{ field: title, direction: ASC }]
        pager: { pageSize: 5 }
      ) {
        total
        data { id title }
      }
    }
  }
}
```

The query `user(id: ...)` returns one record or `null` if it is missing. Mutations are `userCreate(data: ...)`, `userReplace(id: ..., data: ...)`, `userUpdate(id: ..., data: ...)`, `userDelete(id: ...)`. For models containing only generated fields, the create mutation takes no `data` argument. Writes and validation follow the same rules as REST. Relations selected in a mutation result determine the response contents.

String primary keys use GraphQL `ID`; ordinary strings use `String`, numbers use `Float`, and pagination parameters use `Int`. Schema enums preserve valid string labels; other values receive `VALUE_0`, `VALUE_1`, etc. String lengths, formats and other model constraints are validated by the server during request execution. Introspection is available for exploring the schema. Selected list arguments are validated before executing mutations.

Errors include `extensions.code`: `INVALID_INPUT`, `INVALID_QUERY`, `NOT_FOUND`, `CONFLICT`, `UNAUTHENTICATED`, `FORBIDDEN` or `INTERNAL_ERROR`. GraphQL syntax and type errors appear in the standard `errors` array. Query depth is limited to 32 levels.

## OpenAPI and schema exports

Exports use OpenAPI 3.0.3. Add `openapi: {}`, `database.schema` and `package.source` to serve the specification at `/openapi.json`. Change the route with `openapi.endpoint`. Database paths appear only for REST-enabled models; a GraphQL-only database can still produce a document for configured auth and file routes. OpenAPI `info.title`, `info.version` and optional `info.description` come from the configured `package.json`. Open the document in Swagger UI or import it into an API client.

Set output paths to save schemas:

```js
export default {
  storage: 'file',
  database: { source: './database.json', schema: './schema.json' },
  openapi: { target: './generated/openapi.yaml' },
  graphql: { target: './generated/schema.graphql' },
  package: { source: './package.json' },
};
```

```bash
npx deep-json-server server.config.js --generate-only
npx deep-json-server server.config.js --generate
```

`--generate-only` exports and exits; `--generate` starts the server after exporting. Configuration sections select the formats. Each selected format requires its own `target`. The OpenAPI HTTP endpoint returns JSON; file exports from `writeOpenapi()` and the CLI are YAML. Missing sections, missing targets or generation errors fail the command before server startup.

Export does not open the database, user records or files. Every selected `target` is checked before writing and cannot overwrite the configuration, database, schema, users, counters or file metadata.

## Authentication

The `auth` section enables registration, login and permission checks for record changes in REST and GraphQL. Reads and all file operations remain public.

Define the first administrator in the initial data. For example, create `auth.json` with `setup-auth.mjs`:

```js
import { writeFile } from 'node:fs/promises';
import { hashPassword } from '@kollors/deep-json-server/auth';

const password = process.env.DJS_PASSWORD;
if (!password) throw new Error('Set DJS_PASSWORD');
await writeFile(
  './auth.json',
  JSON.stringify(
    [{ id: '1', username: 'admin', passwordHash: await hashPassword(password), isAdmin: true }],
    null,
    2,
  ),
  { flag: 'wx', mode: 0o600 },
);
```

Set `DJS_PASSWORD` and run `node setup-auth.mjs`. Add the file to your server configuration:

```js
export default {
  storage: 'file',
  database: { source: './database.json' },
  auth: { source: './auth.json', expiresIn: 3600 },
};
```

Start with `npx deep-json-server server.config.js`. Each initial user needs a unique string `id`, a unique `username` and a `passwordHash` created by the helper. `isAdmin` defaults to `false`. Passwords use salted scrypt hashes.

With `storage: 'memory'`, pass an array in `auth.source`:

```js
import { hashPassword } from '@kollors/deep-json-server/auth';

const password = process.env.DJS_PASSWORD;
if (!password) throw new Error('Set DJS_PASSWORD');

export default {
  storage: 'memory',
  database: { source: { items: [] } },
  auth: {
    source: [
      { id: '1', username: 'admin', passwordHash: await hashPassword(password), isAdmin: true },
    ],
  },
};
```

Auth users are stored separately from the database. In file mode, changes are saved to `auth.source`; in memory mode, they disappear on restart. The supplied user array is not modified. Restart the server after editing the file manually.

| REST request | JSON body | Response |
|---|---|---|
| `POST /auth/register` | `{ "username": "anna", "password": "…" }` | `201`: `{ id, username, isAdmin: false }` |
| `POST /auth/login` | `{ "username": "anna", "password": "…" }` | `{ accessToken, expiresIn, user: { id, username, isAdmin } }` |
| `GET /auth/me` | — | `{ id, username, isAdmin }` |
| `POST /auth/logout` | — | `{ success: true }` |
| `PATCH /auth/users/:id/password` | `{ "currentPassword": "…", "newPassword": "…" }` | `{ success: true }` |
| `PATCH /auth/users/:id/admin` | `{ "isAdmin": true }` | `{ id, username, isAdmin }` |

Registration and login are public. Send `Authorization: Bearer <accessToken>` for the other methods. Registration creates an ordinary user with a generated `id`; requests cannot include `id`, `passwordHash` or `isAdmin`. Usernames are case-sensitive and unique; duplicates return `409`. A username must contain a non-whitespace character and be at most 256 characters long. Passwords must contain 1–1024 characters. Values are not trimmed. Registration does not create a session: log in afterwards.

Users can change only their own password by supplying `currentPassword` and `newPassword`. Administrators follow the same rule for their own password. An administrator can change an ordinary user's password with just `newPassword`. Changing another administrator's password returns `403`. A successful password change ends all sessions of the target user, including the current session when changing your own password; log in again. An incorrect current password returns `401` without changing sessions.

Only administrators can change `isAdmin`. They can grant or remove another user's admin status. An administrator can remove their own status only if another administrator remains; otherwise the request returns `409`. This check accounts for concurrent requests. Existing tokens use the new permissions as soon as the change is saved, including for GraphQL mutations. An administrator may demote another administrator and then change their password as an ordinary user.

Invalid or expired tokens return `401`, insufficient permissions return `403`, and an absent user for an otherwise permitted operation returns `404`. Invalid request bodies return `400`. Login, registration and password changes may return `429` when too many password computations are running; login also limits active sessions. Sessions are kept in memory and disappear on restart. Logout revokes only the supplied token.

Every model record has a virtual `actions` object when auth is enabled. It is calculated for the current user and is never stored. In REST, request it explicitly through `scope`:

```json
[
  {
    "id": true,
    "actions": [{ "*": true }]
  }
]
```

The object contains `update`, `replace` and `delete`. An owner or administrator receives `true`; an anonymous or unrelated user receives `false`. Records without `createdById` are editable only by administrators. A missing token keeps reads public and returns false flags. A supplied invalid token returns `401` in REST or `UNAUTHENTICATED` in GraphQL.

GraphQL exposes the same field and requires its normal explicit selection:

```graphql
query {
  itemList {
    data {
      id
      actions {
        update
        replace
        delete
      }
    }
  }
}
```

`actions` is available on root and related model records, including mutation results. It cannot be written, filtered or ordered. Plain embedded objects and auth user responses do not receive it.

When `openapi` is configured, its document describes auth routes, optional Bearer authentication on record reads, required authentication on record changes and the `actions` response field. In Swagger UI, paste a token from login into **Authorize**. For schema exports, enable auth in the configuration and run `npx deep-json-server server.config.js --generate-only`; the users file is not read during generation. Auth methods are exposed through REST. GraphQL checks the same token when reading permissions or changing records. GraphQL and OpenAPI require `database.schema`.

## Record dates, deletion and ownership

Set defaults at the schema root. Here `Note` inherits soft deletion and disables timestamps:

```json
{
  "timestamps": true,
  "softDelete": true,
  "models": {
    "Note": {
      "collection": "notes",
      "timestamps": false,
      "fields": {
        "id": {
          "type": "string",
          "primary": true,
          "generated": "uuid"
        },
        "text": {
          "type": "string",
          "required": true
        }
      }
    }
  }
}
```

Precedence: model → schema root → `false`. Explicit `false` disables an inherited setting. Without a schema, timestamps and soft deletion are disabled.

| Field | Enabled by | Meaning |
|---|---|---|
| `createdAt`, `updatedAt` | `timestamps` | Creation and last update time |
| `deletedAt` | `softDelete` | Deletion time, or `null` for an active record |
| `createdById`, `updatedById` | `auth` | Creator/owner and last editor |
| `deletedById` | `auth` + `softDelete` | User who deleted the record, or `null` |

Dates are UTC ISO 8601 strings. New records receive the same creation and update time and, with auth, the authenticated user's ID as creator and editor. PUT/PATCH preserve the creator and creation time. DELETE updates the deletion fields and the enabled last-update fields. Existing records with unknown dates or authors expose `null`. These fields are read-only in REST and GraphQL; embedded plain objects do not receive their own audit fields. Previously stored audit values are retained when their features are disabled.

With soft deletion, DELETE retains the record in the database. Repeating DELETE on an already deleted record leaves its deletion details unchanged. Fetching by primary key returns deleted records too. A successful PUT/PATCH restores the record by clearing `deletedAt` and `deletedById`. An empty PATCH restores it without replacing other fields; PUT requires all mandatory fields.

Lists return active records by default. To select deleted records, specify `deletedAt` in `where`:

```json
[
  { "id": true, "deletedAt": true },
  { "where": { "deletedAt": { "ne": null } } }
]
```

Use `eq: null` for active records, `ne: null` for deleted records, or combine both with `or` for all records. The same filters work in GraphQL. An explicit `deletedAt` condition, including one inside `and`, `or` or `not`, replaces the default at that level. Relation filters and relation lists apply this rule independently. Singular relations hide deleted targets; primary-key queries can still retrieve them directly.

Cascade deletion follows `onDelete` and each affected model's `softDelete`. Restoring the record that initiated a cascade also restores records deleted by that operation, excluding those deleted earlier. Physically deleted records cannot be recovered. If a cascade removed an embedded object, restoration requires the affected object field to remain unchanged since deletion. A conflict or missing required relation rejects the whole operation.

Restoration metadata is stored with the records and survives restarts; include it when backing up the database. The internal `djsDeletion` field is reserved and is not exposed by either API.

With auth, any authenticated user can create records. Updating, deleting and restoring require ownership through `createdById` or `isAdmin: true`. Only administrators can change unowned records. Administrator edits preserve the original owner. The rules cover nested writes, changes to relation storage keys, cascades and restoration. Linking an existing record without changing it does not require owning it. Each mutation is atomic: denied changes leave all affected records unchanged.

REST returns 401 for an invalid or missing token and 403 for insufficient permissions. GraphQL applies the same rules to mutations and returns `UNAUTHENTICATED` or `FORBIDDEN`; obtain the token through REST login and send `Authorization: Bearer <token>`. GraphQL reads remain public, as do OPTIONS requests and every file operation.

## Files

Files are available through REST and appear in the OpenAPI document when `openapi` is configured. Add storage to the configuration:

```js
export default {
  storage: 'file',
  database: { source: './database.json' },
  files: { source: './uploads' },
};
```

Start the server:

```bash
npx deep-json-server server.config.js
```

For temporary tests, choose `storage: 'memory'` and pass an array in `files.source`. Each initial record contains `name`, `mimeType`, binary `content` as a `Uint8Array`, and an optional `directory`. Uploaded files then remain in memory until the process exits.

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

File names and every directory segment follow the same rules: no control characters, `<>:"/\\|?*`, trailing dots or spaces, or reserved Windows names such as `CON` and `NUL`. Use `/` between directory segments.

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

`PATCH` returns the updated metadata with status `200`; if a file already exists at the new path, the server returns `409`. `DELETE` returns `204` without a response body. A missing file returns `404` on every path-based operation. File paths in URLs are relative to `files.source`, and all returned URLs are relative to the server origin.

In disk mode, the binary is stored at `<files.source>/<directory>/<name>`. Metadata defaults to `<files.source>/.files.json`; set `files.metadata` for another location. Directories and the metadata file are created when needed.

Use one server process per disk database and file store. Stop it before editing stored files or metadata manually. Storage paths cannot contain symbolic links. Uploads and renames cannot overwrite the database, counters, schema, auth users, loaded configuration or metadata file.

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

The `openapi()` and `graphql()` methods return schemas and require `database.schema`. `fastify()` returns the server instance for configuration and startup. The database and enabled services initialize on `ready()`, `listen()` or the first `inject()`; initialization errors stop startup.

`createServer(config)` takes the same configuration object as the CLI. When `openapi` is configured, `package.source` is required. The `openapi()` and `graphql()` methods require their respective sections. They return schemas without writing files.

The returned Fastify instance accepts standard `listen()` options, including a Unix socket path. Calling `listen()` without options uses `server.host` and `server.port`.

The root import `@kollors/deep-json-server` also provides these functions. Server adapters load when enabled. Generators can be used independently:

```js
import { generateOpenapi, writeOpenapi } from '@kollors/deep-json-server/openapi';
import { generateGraphql, writeGraphql } from '@kollors/deep-json-server/graphql';

const document = await generateOpenapi('./schema.json', { files: true, packagePath: './package.json' });
const sdl = await generateGraphql('./schema.json');
await writeOpenapi(document, './generated/openapi.yaml');
await writeGraphql(sdl, './generated/schema.graphql');
```

Standalone generators accept a schema path or object without a server configuration. If root `api` is omitted, `generateOpenapi()` defaults it to REST and `generateGraphql()` to GraphQL. Explicit root and model `api` values still apply; the selected format must have an enabled model. Timestamps and soft deletion come from the schema. `{ auth: true }` adds ownership and `actions` fields; OpenAPI also describes auth routes and token requirements. `hashPassword()` is available from the root package.

`generateOpenapi()` requires `packagePath` and also accepts `host`, `port`, `pageSize` and `maxPageSize`. It reads OpenAPI metadata from that package. Pass a schema object instead of a path if preferred. Servers and generators use their own copy of the model. Pagination sizes must be positive integers; `pageSize` cannot exceed `maxPageSize`.

## Data storage

Updates run sequentially within one server instance and are validated on a copy of the data before saving. Use one server process per database file. `increment` counters are stored next to the database in `<database path>.counters.json`; keep that file with the database. Numbers are reserved before the data write, so a failed write can leave gaps but cannot reuse a reserved number.

## Development

The source code is organized into `rest`, `graphql`, `openapi`, `auth`, `files`, `cli` and `server`. Shared models, storage, queries and mutation rules live in `core`. The `server` module connects them; API generators load independently of the HTTP runtime.

```sh
npm ci
npm run verify
```

`npm run verify` checks types, code style, test coverage and installation from the package archive.

To publish a prerelease, update the version in `package.json`, `package-lock.json` and `src/core/constants.ts`, then push the commit to `main`. GitHub Actions creates its `v<version>` tag and publishes through trusted publishing to the `alpha`, `beta` or `rc` channel. Stable versions publish to `latest` from an explicitly pushed version tag.

License: MIT.
