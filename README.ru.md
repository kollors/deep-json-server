# Deep JSON Server

[Русский](README.ru.md) | [English](README.md)

[GitHub](https://github.com/kollors/deep-json-server) | [npm](https://www.npmjs.com/package/@kollors/deep-json-server)

Небольшой JSON REST mock-сервер с CRUD, пагинацией, глубокой фильтрацией и рекурсивной загрузкой связей. База данных хранится в одном читаемом JSON-файле, а мягкие связи определяются по соглашениям о нейминге ключей: `countryId`, `genreIds`, `publisherIds` и так далее.

## Установка

Требуется Node.js 20 или новее.

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

Пример основан на каталоге фильмов. `Гангстерский фильм` демонстрирует связь с родительским жанром.

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

`POST` генерирует строковый ID, а `PUT` и `PATCH` сохраняют исходный тип ID. Все операции записи — `POST`, `PUT`, `PATCH` и `DELETE` — сохраняют изменения в JSON-файле. Файл базы должен существовать до запуска и содержать JSON-объект, ресурсы которого являются массивами. Служебные ключи верхнего уровня с префиксом `$`, например `$schema`, могут содержать значения других типов.

## Пагинация и сортировка

```http
GET /movies?_page=1&_perPage=10&_sort=-id,title
```

GET-запрос к коллекции всегда возвращает объект страницы. По умолчанию `_page` равен `1`, а `_perPage` — `10`:

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

Оба параметра пагинации должны быть положительными целыми числами. При некорректном значении сервер возвращает `400`, а не исправляет его автоматически.

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

В простых фильтрах распознаются JSON-примитивы: числа, `true`, `false` и `null`. Значения с ведущими нулями, например `001`, остаются строками. Неизвестные операторы, некорректные логические условия и отсутствующие в непустом ресурсе пути фильтра возвращают `400`.

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

Явное поле `...Id` или `...Ids` считается источником истины. Если в записи также сохранено устаревшее вложенное значение, `_embed` заменяет его актуальной связанной записью. Для поиска связей лениво создаются ID-индексы только используемых в текущем запросе ресурсов.

## Генерация OpenAPI

Создайте рядом с базой небольшой файл конфигурации, например `mock/database-schema.json`:

```json
{
  "$info": {
    "title": "API каталога фильмов",
    "version": "1.0.0"
  },
  "$schema": {
    "movies": {
      "required": ["actors", "actors.genreIds", "actors.userId", "publisherIds", "title"],
      "formats": {
        "coverSrc": "uri"
      }
    },
    "users": {
      "required": ["bornAt", "fullName"],
      "formats": {
        "avatarSrc": "uri",
        "bornAt": "date"
      }
    }
  }
}
```

Сгенерируйте OpenAPI 3.0.3 и завершите работу:

```bash
deep-json-server mock/database.json --generate mock/database-schema.json mock/openapi-schema.yaml --host 127.0.0.1 --port 4001
```

Генератор определяет ресурсы и типы полей по всем записям базы. По умолчанию все найденные поля необязательные, а поле `id` верхнего уровня, присутствующее в итоговой схеме ресурса, всегда обязательное. Остальные обязательные поля перечисляются в `required`; для вложенных полей используются пути через точку, например `actors.userId`. Объект `formats` добавляет форматы OpenAPI, например `date` и `uri`.

Разные типы значений определяются независимо и объединяются через `oneOf`. Перед генерацией проверяются `$info`, имена ресурсов и схем, а также структура `properties`; пути из `required` и `formats` должны существовать в итоговой схеме.

Используйте `properties`, чтобы описать поля, которые невозможно определить автоматически, особенно у пустого ресурса. Явно заданные свойства объединяются с найденными автоматически:

```json
{
  "$schema": {
    "reviews": {
      "properties": {
        "rating": { "type": "integer", "minimum": 1, "maximum": 5 },
        "text": { "type": "string" }
      },
      "required": ["rating"]
    }
  }
}
```

Пустой ресурс всё равно получает обязательное строковое поле `id`, поскольку сервер создаёт строковые ID. При совпадении имён схем или `operationId` генерация завершается понятной ошибкой; коллизию имён схем можно устранить с помощью явного `name`.

`$info` становится объектом `info` в OpenAPI, а настройки ресурсов находятся внутри `$schema`. Поле `servers` в OpenAPI формируется автоматически из параметров `--host` и `--port`, соответствующих переменных окружения `HOST` и `PORT` или адреса по умолчанию `http://127.0.0.1:4001`.

Используйте `name`, если ресурсу нужно явно задать имя схемы вместо автоматически полученного имени в единственном числе:

```json
{
  "$schema": {
    "equipment": {
      "name": "Equipment"
    }
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

await generateOpenApi({ databasePath: 'mock/database.json', host: '127.0.0.1', port: 4001, schemaPath: 'mock/database-schema.json', outputPath: 'mock/openapi-schema.yaml' });
```

`createServer()` удобен для тестов: он возвращает экземпляр Fastify, не открывая сетевой порт.
