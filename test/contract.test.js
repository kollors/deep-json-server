import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../dist/index.js';

const database = JSON.parse(await readFile(new URL('../examples/database.json', import.meta.url), 'utf8'));
const schema = JSON.parse(await readFile(new URL('../examples/schema.json', import.meta.url), 'utf8'));
const url = (path, query = {}) => `${path}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))}`;
const setup = async (t, data = database, model = schema, options = {}) => {
  const facade = await createServer({ database: { data, schema: model }, graphql: { enabled: model !== undefined }, server: { logger: false, ...options } });
  const server = facade.fastify();
  t.after(() => server.close());
  return { facade, server };
};
const request = async (server, path, query = {}) => {
  const r = await server.inject(url(path, query));
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const gql = async (server, query, variables) => {
  const r = await server.inject({ method: 'POST', url: '/graphql', payload: { query, variables } });
  assert.equal(r.statusCode, 200, r.body);
  const result = r.json();
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result.data;
};
const simple = (fields) => ({ Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, ...fields } } });

test('REST scope, nested lists, relation filters and GraphQL return the same catalog', async (t) => {
  const { server } = await setup(t);
  const scope = [
    {
      id: true,
      fullName: true,
      movies: [
        {
          id: true,
          title: true,
          actors: [
            {
              user: [{ id: true, fullName: true }],
              genres: [
                { id: true, name: true },
                { where: { id: { in: ['3'] } }, pager: { pageSize: 1 } },
              ],
            },
          ],
        },
        { order: [{ field: 'title', direction: 'ASC' }] },
      ],
    },
    { order: [{ field: 'fullName', direction: 'DESC' }], pager: { page: 1, pageSize: 1 } },
  ];
  const rest = await request(server, '/users', { scope });
  const graph = await gql(
    server,
    '{ userList(order:[{field:fullName,direction:DESC}],pager:{page:1,pageSize:1}) { total data { id fullName movies(order:[{field:title,direction:ASC}]) {total data {id title actors {total data {user {id fullName} genres(where:{id:{in:["3"]}},pager:{pageSize:1}) {total data {id name}}}}}}}}}',
  );
  assert.deepEqual(rest, graph.userList);
  const filtered = await request(server, '/users', { scope: [{ id: true }, { where: { movies: { some: { actors: { some: { genres: { some: { id: { eq: '2' } } } } } } } } }] });
  assert.equal(filtered.total, 2);
  const none = await request(server, '/users', { scope: [{ id: true, movies: [{ id: true }, { where: { title: { contains: 'missing' } } }] }] });
  assert.equal(none.total, 2);
  assert.equal(none.data[0].movies.total, 0);
  const single = await request(server, '/users/1', { scope: [{ id: true, movies: [{ title: true }, { pager: { page: 9, pageSize: 1 } }] }] });
  assert.equal(single.movies.total, 1);
  assert.deepEqual(single.movies.data, []);
});

test('wildcard includes raw keys and excludes all computed relations', async (t) => {
  const { server } = await setup(t);
  const movie = await request(server, '/movies/1', { scope: [{ '*': true }] });
  assert.deepEqual(movie.publisherIds, ['2']);
  assert.equal(movie.publishers, undefined);
  assert.equal(movie.actors.data[0].user, undefined);
  assert.equal(movie.actors.data[0].userId, '1');
  const nested = await request(server, '/movies/1', { scope: [{ actors: [{ genres: [{ '*': true }] }] }] });
  assert.deepEqual(
    nested.actors.data.map((a) => a.genres.data.map((g) => g.id)),
    [['2', '3'], ['3']],
  );
  assert.deepEqual(Object.keys(nested), ['actors']);
  assert.equal(nested.actors.data[0].genres.data[0].parents, undefined);
  const parents = await request(server, '/genres/2', { scope: [{ parents: [{ id: true, children: [{ id: true }] }] }] });
  assert.equal(parents.parents.data[0].children.data[0].id, '2');
});

test('schemaless REST accepts new fields, infers relations, and rejects exporters', async (t) => {
  const facade = await createServer({ database: { data: { users: [{ id: '1' }], movies: [{ id: 'a', userId: '1', title: 'A' }] } }, server: { logger: false } });
  const server = facade.fastify();
  t.after(() => server.close());
  await assert.rejects(() => facade.openapi(), /explicit/);
  await assert.rejects(() => facade.graphql(), /explicit/);
  assert.equal((await request(server, '/users/1', { scope: [{ movies: [{ title: true }] }] })).movies.total, 1);
  let r = await server.inject({ method: 'POST', url: '/users', payload: { anything: { nested: 42 }, tags: [true, false] } });
  assert.equal(r.statusCode, 201, r.body);
  const key = r.json().id;
  assert.deepEqual(r.json().anything, { nested: 42 });
  assert.deepEqual(r.json().tags, [true, false]);
  r = await server.inject({ method: 'PATCH', url: `/users/${key}`, payload: { newField: 'free' } });
  assert.equal(r.statusCode, 200, r.body);
  r = await server.inject({ method: 'DELETE', url: `/users/${key}` });
  assert.equal(r.statusCode, 200);
  for (const payload of [[], null, 'text'])
    assert.equal((await server.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) })).statusCode, 400);
  assert.equal((await server.inject({ method: 'POST', url: '/users', payload: { id: 'manual' } })).statusCode, 400);
});

test('rejects invalid scope, nested, filter, ordering and pager even on empty collections', async (t) => {
  const { server } = await setup(
    t,
    { items: [] },
    simple({
      name: { type: 'string' },
      score: { type: 'number' },
      flags: { type: 'boolean[]' },
      meta: { type: 'object' },
      'meta.value': { type: 'number' },
      rows: { type: 'object[]' },
      'rows.name': { type: 'string' },
      secret: { type: 'string', writeOnly: true },
    }),
  );
  const queries = [
    { _page: '1' },
    { _where: '{}' },
    { relations: '{}' },
    { scope: [{ '*': true }, { where: [] }] },
    { scope: [{ '*': true }, { where: { unknown: { eq: 'x' } } }] },
    { scope: [{ '*': true }, { where: { name: { bad: 'x' } } }] },
    { scope: [{ '*': true }, { where: { score: { contains: 1 } } }] },
    { scope: [{ '*': true }, { where: { score: { eq: '1' } } }] },
    { scope: [{ '*': true }, { where: { name: 'x' } }] },
    { scope: [{ '*': true }, { where: { or: [] } }] },
    { scope: [{ '*': true }, { where: { and: {} } }] },
    { scope: [{ '*': true }, { where: { not: [] } }] },
    { scope: [{ '*': true }, { where: { name: { not: 1 } } }] },
    { scope: [{ '*': true }, { where: { flags: { eq: [] } } }] },
    { scope: [{ '*': true }, { where: { rows: { eq: {} } } }] },
    { scope: [{ '*': true }, { where: { meta: { other: { eq: 1 } } } }] },
    { scope: [{ '*': true }, { where: { secret: { eq: 'x' } } }] },
    { scope: [{ '*': true }, { where: { name: { startsWith: null } } }] },
    { scope: [{ '*': true }, { where: { name: { in: 'a' } } }] },
    { scope: [{ '*': true }, { order: 'name' }] },
    { scope: [{ '*': true }, { order: [{ field: 'name', direction: 'up' }] }] },
    { scope: [{ '*': true }, { order: [{ field: 'missing', direction: 'ASC' }] }] },
    { scope: [{ '*': true }, { order: [{ field: 'rows.name', direction: 'ASC' }] }] },
    { scope: [{ '*': true }, { order: [{ field: 'meta', direction: 'ASC' }] }] },
    { scope: [{ '*': true }, { order: [{ field: 'secret', direction: 'ASC' }] }] },
    { scope: [{ '*': true }, { order: [{ field: 'name', direction: 'ASC', bad: 1 }] }] },
    { scope: [{ '*': true }, { pager: [] }] },
    { scope: [{ '*': true }, { pager: { page: 0 } }] },
    { scope: [{ '*': true }, { pager: { pageSize: 101 } }] },
    { scope: [{ '*': true }, { pager: { page: 1.2 } }] },
    { scope: [{ '*': true }, { pager: { page: '1' } }] },
    { scope: [{ '*': true }, { pager: { perPage: 1 } }] },
    { nested: [] },
    { nested: { name: {} } },
    { nested: { rows: { bad: 1 } } },
    { nested: { rows: { pager: { page: -1 } } } },
    { nested: { rows: {} }, scope: [{ id: true }] },
    { scope: [{ id: [{ name: true }] }] },
    { scope: [{ secret: true }] },
    { scope: [{ missing: true }] },
    { scope: [{ id: false }] },
    { scope: [{ rows: null }] },
    { scope: [{ rows: [] }] },
    { scope: [{ rows: [{ name: 1 }] }] },
    { scope: [{ id: 'true' }] },
    { scope: [{ '*': [{}] }] },
    { scope: [{ '*': false }] },
    { scope: [{ 'meta.value': true }] },
    { scope: [{ constructor: true }] },
    { scope: [{ rows: [{ prototype: true }] }] },
    { scope: JSON.parse('{"__proto__":true}') },
    { scope: [] },
    { scope: true },
    { scope: null },
    { scope: 'id,rows(name)' },
    { scope: '"id"' },
    { scope: '' },
  ];
  for (const q of queries) {
    const r = await server.inject(url('/items', q));
    assert.equal(r.statusCode, 400, `${JSON.stringify(q)}: ${r.body}`);
  }
  for (const path of ['/items?where={', url('/items', { scope: [{ id: true }] }) + '&scope=%7B%7D', '/items?where={}&where={}']) assert.equal((await server.inject(path)).statusCode, 400, path);
  assert.equal((await server.inject('/items/missing?where={}')).statusCode, 400);
  assert.deepEqual(await request(server, '/items', { scope: [{ '*': true }, { where: { and: [] }, order: [{ field: 'meta.value', direction: 'ASC' }] }] }), { data: [], total: 0 });
});

test('typed operators, stable multi-order, optional values and array predicates', async (t) => {
  const model = simple({
    name: { type: 'string', nullable: true },
    rank: { type: 'number' },
    active: { type: 'boolean' },
    tags: { type: 'string[]' },
    profile: { type: 'object' },
    'profile.score': { type: 'number' },
  });
  const data = {
    items: [
      { id: 'a', name: null, rank: 2, active: false, tags: [], profile: { score: 2 } },
      { id: 'b', rank: 1, active: true, tags: ['alpha', 'beta'], profile: { score: 1 } },
      { id: 'c', name: 'Alpha', rank: 3, active: true, tags: ['beta'], profile: { score: 1 } },
      { id: 'd', name: 'alphabet', rank: 4, active: false, tags: ['alpha'], profile: { score: 3 } },
    ],
  };
  const { server } = await setup(t, data, model);
  const cases = [
    [{ name: { contains: 'ALP' } }, 2],
    [{ name: { startsWith: 'alph', endsWith: 'bet' } }, 1],
    [{ rank: { gt: 1, gte: 2, lt: 4, lte: 3, ne: 0 } }, 2],
    [{ rank: { in: [1, 4] } }, 2],
    [{ active: { eq: true } }, 2],
    [{ tags: { contains: 'beta' } }, 2],
    [{ tags: { in: ['alpha'] } }, 2],
    [{ tags: { some: { startsWith: 'a' } } }, 2],
    [{ tags: { every: { eq: 'beta' } } }, 2],
    [{ tags: { none: { eq: 'beta' } } }, 2],
    [{ tags: { not: { some: { eq: 'beta' } } } }, 2],
    [{ name: { not: { eq: 'Alpha' } } }, 3],
    [{ or: [{ rank: { eq: 1 } }, { rank: { eq: 2 } }], not: { active: { eq: true } } }, 1],
    [{ profile: { score: { lte: 1 } } }, 2],
  ];
  for (const [where, total] of cases) assert.equal((await request(server, '/items', { scope: [{ '*': true }, { where }] })).total, total, JSON.stringify(where));
  const sorted = await request(server, '/items', {
    scope: [
      { '*': true },
      {
        order: [
          { field: 'name', direction: 'ASC' },
          { field: 'rank', direction: 'ASC' },
        ],
      },
    ],
  });
  assert.deepEqual(
    sorted.data.map((v) => v.id),
    ['c', 'd', 'b', 'a'],
  );
  assert.deepEqual(
    (await request(server, '/items', { scope: [{ '*': true }, { order: [{ field: 'profile.score', direction: 'ASC' }] }] })).data.map((v) => v.id),
    ['b', 'c', 'a', 'd'],
  );
  const graph = await gql(server, '{itemList(where:{tags:{some:{eq:"beta"}}},order:[{field:profile_score,direction:DESC}]){total data{id tags profile{score}}}}');
  assert.equal(graph.itemList.total, 2);
});

test('manual username key, writeOnly and defaults behave consistently across both APIs', async (t) => {
  const model = {
    LocalUser: {
      collection: 'localUsers',
      fields: {
        username: { type: 'string', primary: true, minLength: 3 },
        password: { type: 'string', required: true, writeOnly: true },
        displayName: { type: 'string', default: 'Guest' },
        active: { type: 'boolean', default: true },
        status: { type: 'string', enum: ['new', 'verified'], default: 'new' },
        profile: { type: 'object' },
        'profile.name': { type: 'string', required: true },
        'profile.age': { type: 'number', minimum: 0 },
        token: { type: 'string', generated: 'uuid' },
        serverNote: { type: 'string', readOnly: true, default: 'server' },
      },
    },
  };
  const { server, facade } = await setup(t, { localUsers: [] }, model);
  const created = await gql(server, 'mutation { localUserCreate(data:{username:"ivan",password:"secret"}){username displayName active status token serverNote}}');
  assert.equal(created.localUserCreate.username, 'ivan');
  assert.equal(created.localUserCreate.displayName, 'Guest');
  assert.equal(created.localUserCreate.status, 'new');
  assert.match(created.localUserCreate.token, /^[0-9a-f-]{36}$/);
  const r = await request(server, '/localUsers/ivan');
  assert.equal(r.password, undefined);
  assert.equal(r.username, 'ivan');
  const duplicate = await server.inject({ method: 'POST', url: '/localUsers', payload: { username: 'ivan', password: 'x' } });
  assert.equal(duplicate.statusCode, 409);
  for (const payload of [{ username: 'other' }, { password: null }, { unknown: 1 }, { token: 'hack' }, { serverNote: 'hack' }, { profile: { age: 2 } }])
    assert.equal((await server.inject({ method: 'PATCH', url: '/localUsers/ivan', payload })).statusCode, 400, JSON.stringify(payload));
  assert.equal((await server.inject({ method: 'PATCH', url: '/localUsers/ivan', payload: { displayName: 'New' } })).statusCode, 200);
  const replaced = await gql(server, 'mutation {localUserReplace(username:"ivan",data:{password:"changed"}){username displayName token}}');
  assert.equal(replaced.localUserReplace.displayName, 'Guest');
  assert.equal(replaced.localUserReplace.token, created.localUserCreate.token);
  const changed = await gql(server, 'mutation {localUserUpdate(username:"ivan",data:{status:verified,profile:{name:"x",age:1.5}}){status profile{name age}}}');
  assert.equal(changed.localUserUpdate.profile.age, 1.5);
  const errors = (await server.inject({ method: 'POST', url: '/graphql', payload: { query: '{localUser(username:"ivan"){password}}' } })).json();
  assert.ok(errors.errors);
  const sdl = await facade.graphql();
  assert.match(sdl, /username: ID!/);
  assert.doesNotMatch(sdl.split('type LocalUser {')[1].split('}')[0], /password/);
  const deleted = await gql(server, 'mutation{localUserDelete(username:"ivan"){username}}');
  assert.equal(deleted.localUserDelete.username, 'ivan');
  assert.equal((await gql(server, '{localUser(username:"ivan"){username}}')).localUser, null);
  const missing = (await server.inject({ method: 'POST', url: '/graphql', payload: { query: 'mutation{localUserDelete(username:"ivan"){username}}' } })).json();
  assert.ok(missing.errors);
});

test('field constraints apply per array item and PATCH does not insert defaults', async (t) => {
  const fields = {
    name: { type: 'string', required: true, minLength: 2, maxLength: 5, pattern: '^[a-z]+$' },
    tags: { type: 'string[]', minLength: 2, maxLength: 4, enum: ['ab', 'cd'] },
    scores: { type: 'number[]', minimum: 0, maximum: 10 },
    enabled: { type: 'boolean', default: true },
    date: { type: 'string', format: 'date' },
    site: { type: 'string', format: 'uri' },
    nullable: { type: 'string', nullable: true },
    rows: { type: 'object[]' },
    'rows.name': { type: 'string', required: true },
  };
  const { server } = await setup(t, { items: [{ id: '1', name: 'ok' }] }, simple(fields));
  const patch = await server.inject({ method: 'PATCH', url: '/items/1', payload: { name: 'new' } });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().enabled, undefined);
  const invalid = [
    { name: 'x' },
    { name: 'TOO' },
    { name: 'toolong' },
    { name: 3 },
    { name: 'ok', tags: ['x'] },
    { name: 'ok', tags: ['zz'] },
    { name: 'ok', scores: [-1] },
    { name: 'ok', scores: [11] },
    { name: 'ok', date: '2026-99-00' },
    { name: 'ok', site: 'nope' },
    { name: 'ok', rows: [{}] },
    { name: 'ok', tags: [null] },
  ];
  for (const payload of invalid) {
    const r = await server.inject({ method: 'POST', url: '/items', payload });
    assert.equal(r.statusCode, 400, r.body);
  }
  const valid = { name: 'yes', tags: ['ab', 'ab', 'cd'], scores: [0, 1.5, 10], date: '2026-09-10', site: 'https://example.com', nullable: null, rows: [{ name: 'nested' }] };
  const r = await server.inject({ method: 'POST', url: '/items', payload: valid });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().enabled, true);
  assert.equal(r.json().rows.total, 1);
  const graph = await gql(server, 'mutation {itemCreate(data:{name:"ok",tags:[ab,cd],scores:[1.5],rows:[{name:"nested"}]}){id tags scores rows{data{name}total}}}');
  assert.deepEqual(graph.itemCreate.tags, ['ab', 'cd']);
  const replace = await server.inject({ method: 'PUT', url: '/items/1', payload: { name: 'ok' } });
  assert.equal(replace.json().enabled, true);
});

test('required and dangling relations are validated without data coercion', async (t) => {
  const model = {
    Country: { collection: 'countries', fields: { code: { type: 'number', primary: true } } },
    User: { collection: 'users', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, country: { type: 'Country', source: 'countryCode', required: true } } },
  };
  const { server } = await setup(t, { countries: [{ code: 1 }], users: [] }, model);
  for (const payload of [{}, { countryCode: 2 }, { countryCode: '1' }, { countryCode: null }]) {
    const r = await server.inject({ method: 'POST', url: '/users', payload });
    assert.equal(r.statusCode, 400, r.body);
  }
  const good = await server.inject({ method: 'POST', url: url('/users', { scope: [{ id: true, country: [{ code: true }] }] }), payload: { countryCode: 1 } });
  assert.equal(good.statusCode, 201, good.body);
  assert.equal(good.json().country.code, 1);
  assert.equal((await server.inject({ method: 'DELETE', url: '/countries/1' })).statusCode, 409);
  assert.equal((await server.inject({ method: 'PUT', url: `/users/${good.json().id}`, payload: {} })).statusCode, 400);
  assert.equal((await request(server, `/users/${good.json().id}`)).countryCode, 1);
});

test('cascade removes referring roots and embedded actors, and rolls back restrictions', async (t) => {
  const model = {
    Country: { collection: 'countries', fields: { id: { type: 'string', primary: true } } },
    User: { collection: 'users', fields: { id: { type: 'string', primary: true }, country: { type: 'Country', source: 'countryId', onDelete: 'cascade' } } },
    Movie: {
      collection: 'movies',
      fields: { id: { type: 'string', primary: true }, actors: { type: 'object[]', required: true }, 'actors.user': { type: 'User', source: 'actors.userId', onDelete: 'cascade', required: true } },
    },
  };
  const data = { countries: [{ id: '1' }], users: [{ id: 'u', countryId: '1' }], movies: [{ id: 'm', actors: [{ userId: 'u' }] }] };
  const { server } = await setup(t, data, model);
  let r = await server.inject({ method: 'DELETE', url: '/countries/1' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await request(server, '/users')).total, 0);
  assert.equal((await request(server, '/movies/m')).actors.total, 0);
  const restricted = structuredClone(model);
  restricted.Movie.fields['actors.user'].onDelete = 'restrict';
  const second = await setup(t, data, restricted);
  r = await second.server.inject({ method: 'DELETE', url: '/countries/1' });
  assert.equal(r.statusCode, 409);
  assert.equal((await request(second.server, '/countries')).total, 1);
  assert.equal((await request(second.server, '/users')).total, 1);
  assert.equal((await request(second.server, '/movies/m')).actors.total, 1);
});

test('cascade cycles terminate and preserve all-or-nothing behavior', async (t) => {
  const model = { Item: { collection: 'items', fields: { id: { type: 'string', primary: true }, parent: { type: 'Item', source: 'parentId', onDelete: 'cascade' } } } };
  const { server } = await setup(
    t,
    {
      items: [
        { id: '1', parentId: '2' },
        { id: '2', parentId: '1' },
      ],
    },
    model,
  );
  const r = await server.inject({ method: 'DELETE', url: '/items/1' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await request(server, '/items')).total, 0);
});

test('increment reserves existing numbers across deletion, restart and concurrent creates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-alpha-counter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'db.json');
  await writeFile(path, JSON.stringify({ items: [{ id: 12 }] }));
  const model = { Item: { collection: 'items', fields: { id: { type: 'number', primary: true, generated: 'increment' }, name: { type: 'string' } } } };
  let facade = await createServer({ database: { path, schema: model }, server: { logger: false } });
  let server = facade.fastify();
  assert.equal((await server.inject({ method: 'DELETE', url: '/items/12' })).statusCode, 200);
  await server.close();
  facade = await createServer({ database: { path, schema: model }, server: { logger: false }, graphql: { enabled: true } });
  server = facade.fastify();
  t.after(() => server.close());
  const responses = await Promise.all(Array.from({ length: 10 }, () => server.inject({ method: 'POST', url: '/items', payload: { name: 'x' } })));
  responses.forEach((r) => {
    assert.equal(r.statusCode, 201, r.body);
  });
  assert.deepEqual(
    responses.map((r) => r.json().id),
    [13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
  );
  const graph = await gql(server, 'mutation{itemCreate(data:{name:"g"}){id name}}');
  assert.equal(graph.itemCreate.id, 23);
  assert.equal((await gql(server, '{item(id:23){name}}')).item.name, 'g');
  assert.equal(JSON.parse(await readFile(`${path}.counters.json`, 'utf8'))['items.id'], 23);
});

test('pagination defaults, bounds, discovery, and immutable configuration', async (t) => {
  const data = { items: Array.from({ length: 8 }, (_, i) => ({ id: String(i) })) };
  const original = structuredClone(data);
  const { server } = await setup(t, data, simple({}), { maxPageSize: 3 });
  assert.equal((await request(server, '/items')).data.length, 3);
  assert.equal((await request(server, '/items', { scope: [{ '*': true }, { pager: { page: 4 } }] })).total, 8);
  assert.deepEqual((await request(server, '/items', { scope: [{ '*': true }, { pager: { page: 4 } }] })).data, []);
  assert.deepEqual((await server.inject('/')).json(), { resources: ['items'] });
  assert.equal((await server.inject({ method: 'OPTIONS', url: '/items' })).statusCode, 204);
  assert.equal((await server.inject({ method: 'OPTIONS', url: '/' })).statusCode, 204);
  const r = await server.inject({ method: 'POST', url: '/items', payload: {} });
  assert.equal(r.statusCode, 201, r.body);
  assert.deepEqual(data, original);
});

test('prototype property names cannot leak inherited values into scope or filters', async (t) => {
  const { server } = await setup(t, { items: [{ id: '1' }, { id: '2', toString: 'safe' }] }, simple({ toString: { type: 'string' } }));
  const rows = await request(server, '/items');
  assert.equal(Object.hasOwn(rows.data[0], 'toString'), false);
  assert.equal(rows.data[1].toString, 'safe');
  assert.equal((await request(server, '/items', { scope: [{ id: true, toString: true }, { where: { toString: { eq: 'safe' } } }] })).total, 1);
  assert.equal((await server.inject(url('/items', { scope: [{ valueOf: true }] }))).statusCode, 400);
});

test('schemaless heterogeneous values are preserved rather than coerced to object shapes', async (t) => {
  const facade = await createServer({
    database: {
      data: {
        items: [
          { id: '1', value: 'text', mixed: [{ a: 1 }, 2] },
          { id: '2', value: { a: 1 }, mixed: [{ a: 2 }] },
        ],
      },
    },
    server: { logger: false },
  });
  const server = facade.fastify();
  t.after(() => server.close());
  const rows = await request(server, '/items');
  assert.equal(rows.data[0].value, 'text');
  assert.deepEqual(rows.data[0].mixed, [{ a: 1 }, 2]);
  assert.deepEqual(rows.data[1].value, { a: 1 });
});

test('cascade does not restrict surviving roots through already removed embedded ancestors', async (t) => {
  const model = {
    User: { collection: 'users', fields: { id: { type: 'string', primary: true } } },
    Movie: {
      collection: 'movies',
      fields: {
        id: { type: 'string', primary: true },
        actors: { type: 'object[]' },
        'actors.user': { type: 'User', source: 'actors.userId', onDelete: 'cascade' },
        'actors.details': { type: 'object' },
        'actors.details.user': { type: 'User', source: 'actors.details.userId' },
      },
    },
  };
  const { server } = await setup(t, { users: [{ id: 'u' }], movies: [{ id: 'm', actors: [{ userId: 'u', details: { userId: 'u' } }] }] }, model);
  const r = await server.inject({ method: 'DELETE', url: '/users/u' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await request(server, '/movies/m')).actors.total, 0);
});

test('JSON scope supports explicit relations, wildcard overrides and empty selections', async (t) => {
  const { server } = await setup(t);
  const selected = await request(server, '/movies/1', { scope: [{ '*': true, actors: [{ user: [{ '*': true }], genres: [{ name: true }] }] }] });
  assert.equal(selected.id, '1');
  assert.equal(selected.publishers, undefined);
  assert.equal(selected.actors.data[0].user.fullName, database.users[0].fullName);
  assert.equal(selected.actors.data[0].user.movies, undefined);
  assert.deepEqual(Object.keys(selected.actors.data[0]), ['user', 'genres']);
  assert.deepEqual(Object.keys(selected.actors.data[0].genres.data[0]), ['name']);
  assert.deepEqual(await request(server, '/users/1', { scope: [{}] }), {});
  const empty = await request(server, '/users', { scope: [{}] });
  assert.equal(empty.total, database.users.length);
  assert.deepEqual(
    empty.data,
    database.users.map(() => ({})),
  );
  const actors = await request(server, '/movies/1', { scope: [{ actors: [{}, { pager: { pageSize: 1 } }] }] });
  assert.deepEqual(actors.actors.data, [{}]);
  assert.equal(actors.actors.total, 2);
  const ownActors = await request(server, '/movies/1', { scope: [{ actors: [{ '*': true }, { pager: { pageSize: 1 } }] }] });
  assert.equal(ownActors.actors.data.length, 1);
  assert.equal(ownActors.actors.data[0].user, undefined);
  assert.equal((await server.inject(url('/movies/1', { nested: { 'actors.genres': {} }, scope: [{ actors: [{ '*': true }] }] }))).statusCode, 400);
});

test('JSON scope applies to every mutation and cannot expose writeOnly fields', async (t) => {
  const { server } = await setup(t, { items: [] }, simple({ name: { type: 'string', required: true }, secret: { type: 'string', writeOnly: true } }));
  const created = await server.inject({ method: 'POST', url: url('/items', { scope: [{ '*': true }] }), payload: { name: 'first', secret: 'hidden' } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().secret, undefined);
  const path = `/items/${created.json().id}`;
  for (const method of ['PUT', 'PATCH']) {
    const result = await server.inject({ method, url: url(path, { scope: [{ name: true }] }), payload: { name: method, secret: 'hidden' } });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { name: method });
  }
  assert.equal((await server.inject(url(path, { scope: [{ '*': true, secret: true }] }))).statusCode, 400);
  const failed = await server.inject({ method: 'DELETE', url: url(path, { scope: [{ name: false }] }) });
  assert.equal(failed.statusCode, 400);
  assert.equal((await request(server, path)).name, 'PATCH');
  const removed = await server.inject({ method: 'DELETE', url: url(path, { scope: [{}] }) });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), {});
  assert.equal((await request(server, '/items')).total, 0);
});

test('JSON scope retains size and depth limits', async (t) => {
  const { server } = await setup(t, { items: [] }, simple({ peers: { type: 'Item[]', source: 'id' } }));
  for (const [size, status] of [
    [10000, 200],
    [10001, 400],
  ]) {
    const response = await server.inject(url('/items', { scope: '[{"id":true}]'.padEnd(size, ' ') }));
    assert.equal(response.statusCode, status, response.body);
  }
  const nested = (depth) => Array.from({ length: depth }).reduce((scope) => [{ peers: scope }], [{ id: true }]);
  assert.equal((await server.inject(url('/items', { scope: nested(32) }))).statusCode, 200);
  const response = await server.inject(url('/items', { scope: nested(33) }));
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /too deep/);
});
