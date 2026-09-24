# Migrating from 0.9.0 to 1.0.0-rc.6

Version 1.0 changes configuration and request syntax. Update the server configuration and client requests together. Back up any file database, auth records, and file metadata before changing the running server.

## Configuration

Declare a storage mode and use `source` for each enabled component:

| 0.9.0 | 1.0.0-rc.6 |
|---|---|
| `database.path` | `storage: 'file'`, `database.source` |
| `database.data` | `storage: 'memory'`, `database.source` |
| `files.directory` | `files.source` in file mode |
| `files.data` | `files.source` in memory mode |
| `openapi.path` | `openapi.target` |

The `storage` mode applies to the database, schema, auth records, files, and package metadata. GraphQL and OpenAPI require a model schema; OpenAPI also requires `package.source`. The schema format has changed: define models under `models`, with a `collection`, fields, and one primary key per model. Use root `api` to enable REST, GraphQL, or both for the database; a model's optional `api` array can narrow that choice. Start with the [current schema example](examples/schema.json), then validate your existing records against it. The [configuration example](examples/server.config.js) shows all required paths.

## Relation declarations

Current schemas require each explicit relation in both models and `keyOn` on each relation field. Use `current` where the stored key lives and `related` on the inverse. For example, `User.country = {"type":"Country","keyOn":"current"}` pairs with `Country.users = {"type":"User[]","keyOn":"related"}`. The server infers `User.countryId` referencing the primary key of `Country`, even if `countryId` is omitted from `fields`; existing records still keep their stored keys.

Previously, a relation could be declared on only one side, and `source` defaulted to the current model's primary key. Add the inverse declaration and review any relation that relied on that default. A list such as `Genre.parents` now infers `parentIds` from the relation name, while `Genre.children` with `keyOn: "related"` reads the same key. Keep explicit `source` or `target` for custom key paths. If multiple relations connect the same two models, specify the inverse `target` to pair each one unambiguously. Missing or ambiguous pairs now fail during schema loading.

Omitting a `related` inverse field from `PUT` leaves its links unchanged, because their keys are stored in other records. Supply the inverse field explicitly when replacing those links, for example `"users": []` to detach all users from a country.

## CLI

Adding a `files`, `graphql`, or `openapi` section enables that feature. The old `--files`, `--openapi`, and `--openapi-only` flags are gone. Use `--generate` to export configured schemas and start the server, or `--generate-only` to export and exit. Each exported format needs a `target` path.

## REST queries

REST now accepts a JSON `scope` query parameter. Replace `_where`, `_sort`, `_page`, `_perPage`, `_embed`, and simple field filters with `scope`. For example:

```js
const scope = [
  { id: true, title: true, publishers: [{ id: true, name: true }] },
  { where: { title: { contains: 'Ardenia' } }, order: [{ field: 'title', direction: 'ASC' }], pager: { page: 1, pageSize: 10 } },
];
const url = `/movies?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
```

Without an explicit `scope`, the response contains scalar fields only. `"*": true` also selects only scalar fields that do not store relation keys. Select arrays, objects, relations, and declared relation keys explicitly. Relation keys omitted from `fields` remain in the database but are unavailable in REST, GraphQL, and OpenAPI. Related lists can have their own filters, order, and pagination. Review clients that expect embedded relations or relation keys in default responses.

## Records and auth

Explicit models validate fields and relations more strictly than the 0.9 schemaless server. Existing records with undeclared fields or dangling direct relation keys may fail validation at startup or on write. Test the migrated database before replacing the production file.

Authentication is optional and enabled by an `auth` section. When enabled, creating records requires login; changing existing records requires ownership or administrator access. Record timestamps and soft deletion are configured in the model schema. The [README](README.md) describes the current behavior and API endpoints.
