# Deep JSON Server

[English](README.md) | [Русский](README.ru.md)

[GitHub](https://github.com/kollors/deep-json-server) | [npm](https://www.npmjs.com/package/@kollors/deep-json-server)

A small JSON REST mock server with CRUD, pagination, deep filters and recursive relationship embedding. It keeps the database in one readable JSON file and infers soft relations from conventional keys such as `countryId`, `genreIds` and `publisherIds`.

## Installation

```bash
npm install --save-dev @kollors/deep-json-server
```

Add a script to `package.json`:

```json
{
  "scripts": {
    "mock": "deep-json-server mock/database.json --port 4001",
    "openapi": "deep-json-server mock/database.json --generate mock/database-schema.json mock/openapi-schema.yaml"
  }
}
```

Then run:

```bash
npm run mock
```

The default address is `http://127.0.0.1:4001`. You can also pass `--host` and `--port`, or set the `HOST` and `PORT` environment variables.

## Example database

This example is based on a movie catalog. The genre names are real film genres, while `Gangster film` demonstrates a self-referencing subgenre.

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

`POST` generates a string ID. `PUT`, `PATCH` and `DELETE` persist their changes in the JSON file.

## Pagination and sorting

```http
GET /movies?_page=1&_perPage=10&_sort=-id,title
```

Without `_page`, a GET collection returns an array. With `_page`, it returns:

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

Prefix a sort field with `-` for descending order.

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

Logical operators are also available:

```json
{
  "or": [
    { "title": { "contains": "father" } },
    { "actors": { "some": { "userId": { "eq": "2" } } } }
  ]
}
```

Supported field operators: `contains`, `endsWith`, `eq`, `every`, `gt`, `gte`, `in`, `lt`, `lte`, `ne`, `none`, `not`, `some` and `startsWith`.

Simple query parameters are supported too:

```http
GET /movies?title:contains=father
```

## Relationships

Use `_embed` to replace IDs with related records:

```http
GET /movies/1?_embed=actors.user.country&_embed=actors.genres&_embed=publishers
```

The response contains actors, each actor's user and genres, the user's country, and publishers. Embedding can follow any number of levels:

```http
GET /movies/1?_embed=actors.user.country
GET /genres/2?_embed=parents.parents
```

Reverse relationships work as well:

```http
GET /countries/1?_embed=users
```

Relations are inferred by convention:

- `countryId` points to `countries`;
- `userId` points to `users` when the requested relation is `user`;
- `genreIds` points to `genres`;
- `publisherIds` points to `publishers`;
- `parentIds` points back to the current resource when `_embed=parents` is requested.

They are soft references: the server resolves them when requested but does not enforce referential integrity when data is written.

## OpenAPI generation

Create a small configuration file next to the database, for example `mock/database-schema.json`:

```json
{
  "movies": {
    "optional": ["description"],
    "formats": {
      "coverSrc": "uri"
    }
  },
  "users": {
    "formats": {
      "avatarSrc": "uri",
      "bornAt": "date"
    }
  }
}
```

Generate an OpenAPI 3.0.3 file and exit:

```bash
deep-json-server mock/database.json --generate mock/database-schema.json mock/openapi-schema.yaml
```

The generator infers resources and field types from all database records. Fields present in every record are required unless listed in `optional`; `formats` adds OpenAPI formats such as `date` and `uri`. Nested fields use dot paths, for example `actors.id`.

Use `name` when a resource needs an explicit schema name instead of the automatically singularized name:

```json
{
  "equipment": {
    "name": "Equipment"
  }
}
```

The generated document describes CRUD endpoints, pagination, sorting, deep filters, `_embed`, and response relations inferred from `...Id` and `...Ids` fields. It can be used as input for tools such as RTK Query OpenAPI Codegen. OpenAPI is generated only when `--generate` is passed; normal server startup does not rewrite the file.

## Programmatic API

```js
import { createServer, generateOpenApi, startServer } from '@kollors/deep-json-server';

const server = await createServer({ databasePath: 'mock/database.json', logger: false });

const response = await server.inject({ method: 'GET', url: '/movies' });

await server.close();

await startServer({ databasePath: 'mock/database.json', host: '127.0.0.1', port: 4001 });

await generateOpenApi({ databasePath: 'mock/database.json', schemaPath: 'mock/database-schema.json', outputPath: 'mock/openapi-schema.yaml' });
```

`createServer()` is useful for tests because it returns a Fastify instance without opening a network port.
