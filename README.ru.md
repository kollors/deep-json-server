# Deep JSON Server

[Русский](README.ru.md) | [English](README.md)

[GitHub](https://github.com/kollors/deep-json-server) | [npm](https://www.npmjs.com/package/@kollors/deep-json-server)

Небольшой JSON REST mock-сервер с CRUD, пагинацией, глубокой фильтрацией и рекурсивной загрузкой связей. База данных хранится в одном читаемом JSON-файле, а мягкие связи определяются по соглашениям о нейминге ключей: `countryId`, `genreIds`, `publisherIds` и так далее.

## Установка

```bash
npm install --save-dev @kollors/deep-json-server
```

Добавьте команду в `package.json`:

```json
{
  "scripts": {
    "mock": "deep-json-server mock/database.json --port 4001",
    "openapi": "deep-json-server mock/database.json --generate mock/database-schema.json mock/openapi-schema.yaml"
  }
}
```

Запустите сервер:

```bash
npm run mock
```

По умолчанию сервер доступен по адресу `http://127.0.0.1:4001`. Адрес и порт можно задать через `--host` и `--port` либо переменные окружения `HOST` и `PORT`.

## Пример базы данных

Пример основан на каталоге фильмов. В нём намеренно нет сущности одежды. Используются реальные жанры фильмов, а `Гангстерский фильм` демонстрирует связь с родительским жанром.

```json
{
  "countries": [
    { "id": "1", "isArchived": false, "name": "Россия" },
    { "id": "2", "isArchived": false, "name": "США" }
  ],
  "genres": [
    { "id": "1", "isArchived": false, "name": "Криминал", "parentIds": [] },
    { "id": "2", "isArchived": false, "name": "Гангстерский фильм", "parentIds": ["1"] },
    { "id": "3", "isArchived": false, "name": "Драма", "parentIds": [] },
    { "id": "4", "isArchived": false, "name": "Комедия", "parentIds": [] }
  ],
  "movies": [
    {
      "actors": [
        { "genreIds": ["2", "3"], "id": "movie-1-actor-1", "userId": "1" },
        { "genreIds": ["3"], "id": "movie-1-actor-2", "userId": "2" }
      ],
      "coverSrc": "https://image.tmdb.org/t/p/w500/3bhkrj58Vtu7enYsRolD1fZdja1.jpg",
      "description": "История семьи Корлеоне и передачи власти от одного поколения другому.",
      "id": "1",
      "isArchived": false,
      "publisherIds": ["2"],
      "title": "Крёстный отец"
    },
    {
      "actors": [],
      "coverSrc": "https://image.tmdb.org/t/p/w500/eWdyYQreja6JGCzqHWXpWHDrrPo.jpg",
      "description": "Приключения консьержа и его юного помощника в знаменитом европейском отеле.",
      "id": "2",
      "isArchived": false,
      "publisherIds": ["1"],
      "title": "Отель «Гранд Будапешт»"
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
      "fullName": "Александр Петров",
      "id": "1",
      "isArchived": false
    },
    {
      "bornAt": "1984-09-05",
      "countryId": "1",
      "fullName": "Юлия Пересильд",
      "id": "2",
      "isArchived": false
    }
  ]
}
```

Каждый массив верхнего уровня становится REST-ресурсом:

```text
GET    /movies
GET    /movies/:id
POST   /movies
PUT    /movies/:id
PATCH  /movies/:id
DELETE /movies/:id
```

`POST` генерирует строковый ID. `PUT`, `PATCH` и `DELETE` сохраняют изменения в JSON-файле.

## Пагинация и сортировка

```http
GET /movies?_page=1&_perPage=10&_sort=-id,title
```

Без `_page` GET-запрос к коллекции возвращает массив. С `_page` возвращается объект:

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

Префикс `-` перед полем включает сортировку по убыванию.

## Фильтры

Передайте JSON-объект через `_where`:

```http
GET /movies?_where={"title":{"contains":"отец"}}
```

Можно фильтровать вложенные объекты и массивы на любой глубине. Условия внутри одного объекта по умолчанию объединяются через `AND`:

```json
{
  "actors": { "some": { "userId": { "eq": "1" } } },
  "title": { "contains": "отец" }
}
```

Доступны логические операторы:

```json
{
  "or": [
    { "title": { "contains": "отец" } },
    { "actors": { "some": { "userId": { "eq": "2" } } } }
  ]
}
```

Поддерживаются операторы полей: `contains`, `endsWith`, `eq`, `every`, `gt`, `gte`, `in`, `lt`, `lte`, `ne`, `none`, `not`, `some` и `startsWith`.

Также можно использовать простые query-параметры:

```http
GET /movies?title:contains=отец
```

## Связи

Используйте `_embed`, чтобы заменить ID связанными записями:

```http
GET /movies/1?_embed=actors.user.country&_embed=actors.genres&_embed=publishers
```

Ответ будет содержать актёров, пользователя и жанры каждого актёра, страну пользователя и издателей. Глубина вложения не ограничена:

```http
GET /movies/1?_embed=actors.user.country
GET /genres/2?_embed=parents.parents
```

Поддерживаются и обратные связи:

```http
GET /countries/1?_embed=users
```

Связи определяются по неймингу:

- `countryId` ссылается на `countries`;
- `userId` ссылается на `users`, если запрошена связь `user`;
- `genreIds` ссылается на `genres`;
- `publisherIds` ссылается на `publishers`;
- `parentIds` ссылается на тот же ресурс, если запрошена связь `_embed=parents`.

Это мягкие ссылки: сервер загружает их по запросу, но не проверяет ссылочную целостность при записи данных.

## Генерация OpenAPI

Создайте рядом с базой небольшой файл конфигурации, например `mock/database-schema.json`:

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

Сгенерируйте OpenAPI 3.0.3 и завершите работу:

```bash
deep-json-server mock/database.json --generate mock/database-schema.json mock/openapi-schema.yaml
```

Генератор определяет ресурсы и типы полей по всем записям базы. Поля, присутствующие в каждой записи, считаются обязательными, если они не перечислены в `optional`; `formats` добавляет форматы OpenAPI, например `date` и `uri`. Для вложенных полей используются пути через точку, например `actors.id`.

Используйте `name`, если ресурсу нужно явно задать имя схемы вместо автоматически полученного имени в единственном числе:

```json
{
  "equipment": {
    "name": "Equipment"
  }
}
```

В сгенерированном документе описаны CRUD, пагинация, сортировка, глубокие фильтры, `_embed` и связи в ответах, определённые по полям `...Id` и `...Ids`. Файл можно передать, например, в RTK Query OpenAPI Codegen. OpenAPI создаётся только с параметром `--generate`; обычный запуск сервера файл не перезаписывает.

## Программный API

```js
import { createServer, generateOpenApi, startServer } from '@kollors/deep-json-server';

const server = await createServer({ databasePath: 'mock/database.json', logger: false });

const response = await server.inject({ method: 'GET', url: '/movies' });

await server.close();

await startServer({ databasePath: 'mock/database.json', host: '127.0.0.1', port: 4001 });

await generateOpenApi({ databasePath: 'mock/database.json', schemaPath: 'mock/database-schema.json', outputPath: 'mock/openapi-schema.yaml' });
```

`createServer()` удобен для тестов: он возвращает экземпляр Fastify, не открывая сетевой порт.
