# Migrating from 0.9.0 to 1.0.0-rc.3

Version 1.0 changes configuration and request syntax. Update the server configuration and client requests together. Back up any file database, auth records, and file metadata before changing the running server.

## Configuration

Declare a storage mode and use `source` for each enabled component:

| 0.9.0 | 1.0.0-rc.3 |
|---|---|
| `database.path` | `storage: 'file'`, `database.source` |
| `database.data` | `storage: 'memory'`, `database.source` |
| `files.directory` | `files.source` in file mode |
| `files.data` | `files.source` in memory mode |
| `openapi.path` | `openapi.target` |

The `storage` mode applies to the database, schema, auth records, files, and package metadata. GraphQL and OpenAPI require a model schema; OpenAPI also requires `package.source`. The schema format has changed: define models under `models`, with a `collection`, fields, and one primary key per model. Use root `api` to enable REST, GraphQL, or both for the database; a model's optional `api` array can narrow that choice. Start with the [current schema example](examples/schema.json), then validate your existing records against it. The [configuration example](examples/server.config.js) shows all required paths.

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
