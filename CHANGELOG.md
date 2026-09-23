# Changelog

## 1.0.0-rc.2

- Added root schema `api` to select REST, GraphQL, or both for database routes, and per-model `api` selection with matching formats. Authentication and file routes remain REST endpoints; OpenAPI includes only enabled REST routes.
- GraphQL-only server configurations no longer require package metadata. OpenAPI keeps authentication and file routes when no database model enables REST.
- Added installed-package coverage for per-model API selection and checks for code examples in both READMEs.

## 1.0.0-rc.1

First release candidate for the 1.0 API. This release includes schema-driven REST, GraphQL, OpenAPI export, authentication, record ownership, timestamps, soft deletion, and file storage. It also makes CLI and API error messages consistently English and checks TypeScript declarations from an installed package archive.

The 1.0 configuration, CLI flags, and REST query format differ from 0.9.0. Follow the [migration guide](MIGRATION.md) before upgrading an existing project. In particular, the REST `scope` wildcard includes scalar fields only; select arrays, objects, relations, and relation keys explicitly.

### Verification

- TypeScript source and contract checks, lint, and coverage-gated tests.
- Package installation smoke test for the CLI, REST, GraphQL, OpenAPI, and auth.
- TypeScript consumer test against the installed package declarations.
- CI matrix for Node.js 22, 24, and 26 on Linux.
