# Changelog

## 1.0.0

First stable release of the 1.0 API, based on RC9. There are no API or stored-data format changes from RC9.

- Define models, validation and paired relations in one schema for REST, GraphQL and OpenAPI.
- Select fields, filter, sort and paginate root and nested lists with REST `scope` or GraphQL.
- Enable authentication, owner and administrator permissions, persistent file-backed sessions, timestamps and soft deletion through configuration.
- Upload, download, rename and delete files using disk or memory storage. Native OS locks prevent competing servers from writing to shared disk stores and recover after crashes.
- Verify types, lint, test coverage, dependency security and installed-package behavior on Linux, Windows and macOS with Node.js 22, 24 and 26.

The configuration, CLI and REST query format differ from 0.9.0. Follow the [migration guide](MIGRATION.md) or [Russian guide](MIGRATION.ru.md), and stop old server processes before upgrading.

## 1.0.0-rc.9

- Update vulnerable Fastify, fast-uri and brace-expansion versions within compatible ranges.
- Check runtime dependencies with `npm audit` before the full verification and publication pipeline. RC9 includes all RC8 storage, auth, query and cross-platform fixes.

## 1.0.0-rc.8

- Persist hashed auth sessions with users in file storage so valid tokens survive restarts, with atomic logout and password-change revocation.
- Replace the lock directory with one readable `<source-name>-lock.json` file and native OS locking. Lock the database, auth store, upload root and file metadata; recover after crashes and reject competing writers.
- Protect configured files and their symlink targets from upload, deletion and schema export. Reject malformed Unicode file paths before changing storage.
- Preserve protected nested fields when a nullable ancestor is cleared, and infer relations across numeric seed IDs and generated string IDs.
- Use `key` for the primary-key argument of GraphQL update/replace mutations when the primary field is named `data`.
- Bound REST and GraphQL selection, expansion, query work and response size; document that GraphQL result errors do not undo committed mutations.
- Derive the CLI version from package metadata and verify the installed CLI over HTTP, including paths with spaces and Unicode and persistence after a crash.
- Run type checks, lint, coverage and installed-package checks on Linux, Windows and macOS with Node.js 22, 24 and 26. Publish only after the full matrix succeeds for the selected commit.

When upgrading from an earlier RC, stop all old server processes before starting RC8: the lock protocol has changed. Existing auth files without `sessions` remain valid. Regenerate GraphQL clients if a model uses `data` as its primary field.

## 1.0.0-rc.7

- Treat nested objects containing only a primary key as references in POST, PUT and PATCH, preserving the target's fields and audit values. Actual changes, including inverse key changes, still require ownership.
- Allow key-only references in GraphQL replace inputs and OpenAPI request schemas; validate required fields when a nested object creates or changes a record.
- Infer array storage keys for `keyOn: "current"` list relations targeting non-primary fields, preserving explicitly declared key types.
- Expand the migration guide from 0.9.0 in English and Russian, document API defaults, and remove the archive flag from examples.

## 1.0.0-rc.6

- Require both sides of every explicit model relation and `keyOn: "current" | "related"` to identify where its key is stored.
- Infer relation key paths from the direct relation field and the related model's primary key; reject missing, ambiguous, and inconsistent inverse declarations.
- Keep automatically inferred keys internal to API responses and schemas, and avoid default deletion restrictions from mandatory inverse views.
- Preserve links stored in other records when a `PUT` omits their `related` inverse field; explicitly supplied inverse fields still replace their links.

## 1.0.0-rc.5

- Make `required` on list relations consistent with stored arrays: empty lists are valid, while list relations backed by an array of source keys still require that array to be present. Computed lists may be empty.

## 1.0.0-rc.4

- Prevent concurrent servers from writing to the same file-backed database and recover its lock after a process crash, using built-in Node.js APIs.
- Make range filters and sorting use the same comparison rules across REST and GraphQL.
- Execute key examples from both READMEs during tests to keep the documented behavior current.
- Add a database benchmark script for memory and file storage; runtime query behavior is unchanged by the benchmark.

## 1.0.0-rc.3

- Keep relation keys inferred from `source` in stored records while hiding them from REST, GraphQL, and OpenAPI unless declared explicitly in model `fields`.
- Clarify relation key selection with and without a model schema in both READMEs.

## 1.0.0-rc.2

- Add root schema `api` to select REST, GraphQL, or both for database routes, and per-model `api` selection with matching formats. Authentication and file routes remain REST endpoints; OpenAPI includes only enabled REST routes.
- Remove the package metadata requirement for GraphQL-only server configurations. Keep authentication and file routes in OpenAPI when no database model enables REST.
- Add installed-package coverage for per-model API selection and checks for code examples in both READMEs.

## 1.0.0-rc.1

First release candidate for the 1.0 API. This release includes schema-driven REST, GraphQL, OpenAPI export, authentication, record ownership, timestamps, soft deletion, and file storage. It also makes CLI and API error messages consistently English and checks TypeScript declarations from an installed package archive.

The 1.0 configuration, CLI flags, and REST query format differ from 0.9.0. Follow the [migration guide](MIGRATION.md) before upgrading an existing project. In particular, the REST `scope` wildcard includes scalar fields only; select arrays, objects, relations, and relation keys explicitly.

### Verification

- TypeScript source and contract checks, lint, and coverage-gated tests.
- Package installation smoke test for the CLI, REST, GraphQL, OpenAPI, and auth.
- TypeScript consumer test against the installed package declarations.
- CI matrix for Node.js 22, 24, and 26 on Linux.
