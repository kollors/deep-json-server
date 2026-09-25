# Migrating from 0.9.0 to 1.0.0-rc.7

[Русский](MIGRATION.ru.md) · [Current README](README.md)

This guide compares `v0.9.0` with `1.0.0-rc.7` and also covers the relation changes since RC6. Update configuration and clients together. Node.js 22 or newer is still required. Back up the database, config, schema, uploaded files and metadata before migrating.

## 1. Choose whether you need a schema

For REST without schema validation or exports, the smallest configuration change is:

```js
// 0.9.0
export default { database: { path: './database.json' } };
```

```js
// 1.0.0-rc.7
export default { storage: 'file', database: { source: './database.json' } };
```

This keeps schemaless REST and relations inferred from stored `...Id` / `...Ids` names. The query and response changes below still apply. OpenAPI and GraphQL now require an explicit model schema; generators no longer infer field definitions from database records.

## 2. Convert configuration

| 0.9.0 | 1.0.0-rc.7 |
|---|---|
| `database.path` | `storage: 'file'` and `database.source` |
| `database.data` | `storage: 'memory'` and `database.source` |
| `database.schema` with `$info` / `$schema` | Same config key, new schema format with `models` |
| `files.directory` / `files.data` | `files.source` |
| `files.metadata` | Keep the existing path to preserve file metadata |
| `openapi.path` | `openapi.target` |
| Schema `$info` | `package.source`: `name`, `version`, optional `description` |
| Default `server.maxPageSize: 1000` | Default `100`; set `1000` explicitly to retain the old limit |

`storage` is required and applies to every source, including the schema and package metadata. File mode requires paths; memory mode requires objects/arrays. Mixed file and memory components are no longer supported. Export `target` values remain file paths in either mode.

A file-based configuration that exports OpenAPI becomes:

```js
export default {
  storage: 'file',
  database: { source: './database.json', schema: './schema.json' },
  files: { source: './files', metadata: './files/_database.json' },
  openapi: { target: './generated/openapi.yaml' },
  package: { source: './package.json' },
  server: { maxPageSize: 1000 },
};
```

Create `schema.json` as described below. `package.source` is required when `openapi` is configured: package `name` becomes OpenAPI `info.title`, with `version` and optional `description`. Other old `$info` properties have no configuration equivalent. In memory mode, use `package: { source: { name: 'example-api', version: '1.0.0' } }`.

Keep an existing `files.metadata` path explicitly. Omitting it selects `<files.source>/.files.json`, which does not import an old `_database.json`. The metadata format from 0.9.0 and the `/_files/*` routes remain compatible; raw upload headers and `DELETE` returning `204` also remain unchanged.

Relative paths still resolve from the config directory in the CLI, and from the working directory in `createServer(config)`.

## 3. Replace schema overrides with complete models

In 0.9.0, `$schema` supplemented field types inferred from data. It was not the current model/relation format. Each collection now needs a model with `collection`, `fields`, and exactly one top-level primary key of type `string` or `number`.

| Old override | New definition |
|---|---|
| `$schema.users.name` | Model name under `models`, for example `User` |
| `$schema.users.required: ['fullName']` | `fields.fullName.required: true` |
| `$schema.users.formats.bornAt: 'date'` | `fields.bornAt: { type: 'string', format: 'date' }` |
| Recursive `properties` and `items` | Typed fields, `[]` for arrays, dotted paths for children |
| Inferred generated string `id` | Explicit `{ type: 'string', primary: true, generated: 'uuid' }` |

Define every stored field, not just former overrides. For example, declare `actors` as `object[]` and `actors.fullName` as `string`. Additional fields and collections are rejected with an explicit schema, except inferred relation storage keys. Existing records are validated when the HTTP server initializes.

There is no general replacement for mixed-type `oneOf` fields or an `integer`-only field constraint. Normalize those fields to a supported type before adopting the schema, or keep schemaless REST. Model names must be identifiers; old custom component names containing dots or hyphens must change.

### Complete example with a paired relation

For existing users containing `id`, `fullName`, and `countryId`, and countries containing `id` and `name`:

```json
{
  "api": ["rest"],
  "models": {
    "User": {
      "collection": "users",
      "fields": {
        "id": { "type": "string", "primary": true, "generated": "uuid" },
        "fullName": { "type": "string", "required": true },
        "countryId": { "type": "string" },
        "country": { "type": "Country", "keyOn": "current" }
      }
    },
    "Country": {
      "collection": "countries",
      "fields": {
        "id": { "type": "string", "primary": true, "generated": "uuid" },
        "name": { "type": "string", "required": true },
        "users": { "type": "User[]", "keyOn": "related" }
      }
    }
  }
}
```

Every explicit relation needs both declarations and a `keyOn` value. `current` stores the foreign key; `related` reads that key in the other model. No second copy of the key or stored `users` array is needed.

- Direct `target` defaults to the related model's primary key. Direct `source` uses the relation field name and target key: `country` → `countryId`, `publishers` → `publisherIds`. A custom primary key `ref` produces `publisherRefs`.
- Inverse paths swap the direct paths. For `Country.users`, `source` is `id` and `target` is `countryId`.
- Self-relations pair `Genre.parents: { type: 'Genre[]', keyOn: 'current' }` with `Genre.children: { type: 'Genre[]', keyOn: 'related' }`; both use stored `Genre.parentIds`.
- Multiple relations between the same models require disambiguation: inverse `Country.birthUsers` uses `target: 'birthCountryId'`, and `Country.residenceUsers` uses `target: 'residenceCountryId'`. Ambiguous or missing pairs fail schema loading.
- Declare existing keys explicitly, as above, if clients read, filter, sort or write them. Inferred keys remain in storage but are hidden from both APIs and OpenAPI, even when selected by name.
- RC7 also infers source arrays for lists targeting **non-primary** fields. For example, `publishers` with `keyOn: 'current'` and `target: 'code'` infers `publisherCodes: { type: 'string[]' }` when `Publisher.code` is a string. Explicitly declare the key if it must be exposed in the API. If RC6 stored this automatically inferred key as a scalar, convert existing values to arrays, for example `"A"` to `["A"]`, before upgrading. An explicitly declared scalar key retains its type.

Repair dangling direct references before startup. Writes now validate references; deleting a referenced target is restricted by default. Choose `onDelete: 'cascade'` deliberately where deleting a target should delete referring records. An inverse with no explicit `onDelete` does not add its own restriction.

### Preserve IDs and custom fields

Do not regenerate IDs while converting the schema. Existing string IDs remain valid with `generated: 'uuid'`; only new values use UUIDs. If a collection mixes numeric and string IDs, normalize them and all referencing keys to one type before enabling an explicit schema.

`generated` is not implied by `primary`. Without it, clients must supply the primary key on create. With it, clients must omit generated fields; sending them is rejected instead of ignored as in 0.9.0.

Old application fields must be declared or deliberately removed from copied data. A custom archive flag does not automatically become soft deletion. Enabling lifecycle or auth features reserves their system field names, so rename conflicting application fields first.

## 4. Select APIs and update startup commands

If root `api` is omitted, the server uses `['rest']`, or `['rest', 'graphql']` when `graphql` is configured. To expose the database only through GraphQL, set `api: ['graphql']` and add `graphql: {}`. A model inherits root `api` or narrows it; model `api: []` hides that model. Root `api: []` is invalid. Related models must enable the same APIs.

The `graphql` section and root GraphQL flag must be enabled together. Auth and files remain REST services and appear only in OpenAPI. OpenAPI can describe these services on a GraphQL-only database server.

| Old CLI | New CLI |
|---|---|
| `--files` | Remove the flag; the `files` section enables routes |
| `--openapi` | `--generate` |
| `--openapi-only` | `--generate-only` |

Unlike the old CLI, normal startup now enables configured file routes. Remove `files` if they should be disabled. `openapi: {}` serves `/openapi.json`; `graphql: {}` serves `/graphql`. To export files, set a `target` for **each** configured format; generation flags export all configured formats. Normal startup does not write exports.

## 5. Migrate REST queries and response readers

The only record query parameter is now URL-encoded JSON `scope: [fields, arguments?]`.

| 0.9.0 parameter | New scope entry |
|---|---|
| `_where` or simple `fullName:contains=mi` | Second object: `where: { fullName: { contains: 'mi' } }` |
| `_sort=-id,fullName` | `order: [{ field: 'id', direction: 'DESC' }, { field: 'fullName', direction: 'ASC' }]` |
| `_page=1&_perPage=10` | `pager: { page: 1, pageSize: 10 }` |
| `_embed=country` | First object: `country: [{ id: true, name: true }]` |

Example against the paired schema above:

```js
const scope = [
  { id: true, fullName: true, countryId: true, country: [{ id: true, name: true }] },
  {
    where: { fullName: { contains: 'mi' } },
    order: [{ field: 'fullName', direction: 'ASC' }],
    pager: { page: 1, pageSize: 10 },
  },
];
const url = `/users?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
```

Update response readers as well:

- Missing `scope` and `{ '*': true }` select only scalars that do not store relation keys. Arrays, objects, relations and declared storage keys need explicit selection. `writeOnly` fields cannot be selected.
- Collections still return `{ data, total }`. Embedded **object and relation lists now also return `{ data, total }`**, rather than plain arrays. Primitive arrays remain arrays. A single relation returns an object or `null`.
- Every object list is paginated, including nested lists: default page size `10`, maximum `100`. Embedded lists were previously returned in full. Give each list the necessary `pager` and load further pages when needed.
- Relation filters work without selecting that relation. Sorting the parent by a related field, such as old `_sort=country.name`, is not supported; sort the related list with its own `order`, or store a sortable value on the parent.
- String comparisons `gt/gte/lt/lte` now use case-insensitive, numeric-aware ordering. Review clients relying on the old lexical comparisons.
- Scope JSON is limited to 10,000 characters and 32 selection levels. Unknown fields/operators are rejected even on empty data.

## 6. Check write behavior and optional auth

`PATCH` merges top-level fields; a supplied nested plain object replaces that object while preserving protected fields. `PUT` replaces writable fields, preserving primary, generated, read-only and system values. Required fields must be supplied for creation/replacement unless they have defaults.

Relation values are objects, for example `country: { id: '1' }`, not scalar IDs. **Starting with RC7, an object containing only the primary key is a reference in POST, PUT and PATCH.** It preserves the target's fields, dates and author values. Adding other fields invokes an update: PUT replaces the target and requires its mandatory fields; POST/PATCH update supplied fields. Changing an inverse relation still requires permission for every record whose stored key changes. Declared storage keys, such as `countryId`, can also change links directly. Do not send the relation and its storage key in the same object.

**When upgrading from RC6:** key-only objects no longer update the target, change its audit values or require ownership of an unchanged target. If an existing client intends to update or replace the target, include the fields to change. Declared storage keys remain available for link-only writes.

Omitted inverse (`keyOn: 'related'`) relations survive PUT. Explicit `users: []` changes users' foreign keys to detach them; it can fail if those keys are required or the caller lacks permission. Nested changes are atomic, and modifying a shared target affects every record referring to it.

Auth, timestamps and soft deletion are new, optional features. To first preserve unauthenticated writes and physical deletion, omit `auth` and leave `timestamps` / `softDelete` disabled (their defaults).

If enabling auth, create a separate auth user store and migrate ownership deliberately. Old records without `createdById` can be changed only by administrators. The ownership field is server-managed through the API; prepare ownership in the copied database before startup if ordinary users must edit existing records. Auth does not close read endpoints or file operations. Sessions are in memory and end when the server restarts.

With `softDelete`, DELETE retains records, lists hide deleted records by default, direct primary-key reads can retrieve them, and successful PUT/PATCH restores them. There is no automatic conversion of an old application archive flag. See the [lifecycle rules](README.md#record-dates-deletion-and-ownership) before enabling this feature.

## 7. Update programmatic consumers

`createServer(config)` now takes exactly one argument. Remove the old second `{ files: false }` argument and omit `files` from the config to disable the feature.

`facade.openapi()` and `facade.graphql()` return documents without writing `target`. They require their respective config sections; OpenAPI also needs package metadata and a schema. Use CLI generation flags or explicit writers:

```js
import { createServer } from '@kollors/deep-json-server';
import { writeOpenapi } from '@kollors/deep-json-server/openapi';
import config from './server.config.js';

const facade = await createServer(config);
await writeOpenapi(await facade.openapi(), './generated/openapi.yaml');
const app = facade.fastify();
await app.ready(); // Initializes and validates the database without opening a port.
await app.close();
```

Schema generation alone does not validate existing database records. Call `ready()`, `inject()` or `listen()` to initialize HTTP and check data. Regenerate clients from the new OpenAPI/GraphQL documents after changing models and queries.

## 8. Validate the cutover and keep rollback data

1. Pin the chosen RC version and migrate a **copy** of the 0.9.0 files. Run generation, then initialize the HTTP server to validate data too.
2. Check representative reads: defaults, explicit foreign keys, nested lists, filters and pagination. Check create, PATCH, PUT, link changes and deletion using disposable copied records.
3. If enabling auth, test an owner, an administrator and an ordinary non-owner against old records. Confirm uploaded files remain accessible through the retained metadata path.
4. Stop the old server before switching. Run one process per database/file store; current versions lock the disk database. Stop the process before manual edits.
5. Keep the original package version, config, schema, data and file metadata together for rollback. Restore them together; do not point 0.9.0 at data already modified by the new server. Include new increment counters (`<database>.counters.json`) and soft-delete restoration metadata in subsequent backups when used.
