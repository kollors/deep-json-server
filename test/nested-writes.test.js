import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../dist/index.js';

const primary = { type: 'number', primary: true, generated: 'increment' };
const model = {
  Genre: {
    collection: 'genres',
    fields: {
      id: primary,
      name: { type: 'string', required: true },
      description: { type: 'string' },
      state: { type: 'string', default: 'new' },
      stamp: { type: 'string', readOnly: true, default: 'server' },
      token: { type: 'string', generated: 'uuid' },
    },
  },
  User: { collection: 'users', fields: { id: primary, name: { type: 'string', required: true }, role: { type: 'string', default: 'guest' }, password: { type: 'string', writeOnly: true } } },
  Movie: {
    collection: 'movies',
    fields: {
      id: primary,
      title: { type: 'string', required: true },
      description: { type: 'string' },
      genres: { type: 'Genre[]', source: 'genreIds' },
      users: { type: 'User[]', source: 'userIds' },
      owner: { type: 'User', source: 'ownerId', nullable: true },
      actors: { type: 'object[]' },
      'actors.user': { type: 'User', source: 'actors.userId', required: true },
      'actors.genres': { type: 'Genre[]', source: 'actors.genreIds', required: true },
    },
  },
};
const data = {
  genres: [
    { id: 1, name: 'one', description: 'keep', state: 'old', stamp: 'fixed', token: '01234567-89ab-4cde-8f01-234567890abc' },
    { id: 2, name: 'two' },
  ],
  users: [
    { id: 1, name: 'first', role: 'member', password: 'hidden' },
    { id: 2, name: 'second' },
  ],
  movies: [{ id: 1, title: 'original', description: 'movie description', genreIds: [1, 2], userIds: [1], ownerId: 1, actors: [{ userId: 1, genreIds: [1] }] }],
};
const setup = async (t, schema = model, initial = data, disk = false) => {
  let database = { schema, data: initial };
  if (disk) {
    const directory = await mkdtemp(join(tmpdir(), 'deep-nested-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'db.json');
    await writeFile(path, JSON.stringify(initial));
    database = { schema, path };
  }
  const facade = await createServer({ database, graphql: { enabled: !!schema }, server: { logger: false } });
  const app = facade.fastify();
  t.after(() => app.close());
  await app.ready();
  return { app, facade, path: database.path };
};
const url = (path, scope = [{ '*': true }]) => `${path}?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
const mutate = (app, method, body, path = '/movies/1', scope) => app.inject({ method, url: url(path, scope), payload: body });
const get = async (app, path) => {
  const response = await app.inject(path);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
};
const gql = (app, query, variables) => app.inject({ method: 'POST', url: '/graphql', payload: { query, variables } });

test('nested PATCH mixes references, updates and creates without storing relation objects', async (t) => {
  const { app } = await setup(t);
  const result = await mutate(app, 'PATCH', { genres: [1, { id: 2, name: 'updated' }, { name: 'created' }] }, '/movies/1', [{ '*': true, genres: [{ '*': true }] }]);
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().genreIds, [1, 2, 3]);
  assert.deepEqual(
    result.json().genres.data.map((record) => record.name),
    ['one', 'updated', 'created'],
  );
  assert.equal(result.json().title, 'original');
  assert.equal((await get(app, '/genres/1')).description, 'keep');
  const created = await get(app, '/genres/3');
  assert.equal(created.state, 'new');
  assert.equal(created.stamp, 'server');
  assert.match(created.token, /^[0-9a-f-]{36}$/);
  assert.equal((await get(app, '/movies/1')).genres, undefined);
});

test('PUT requires fields in relation objects while IDs only link; nested PUT replaces', async (t) => {
  const { app } = await setup(t);
  const before = await get(app, '/movies/1');
  const failed = await mutate(app, 'PUT', { title: 'replaced', users: [{ id: 1 }] });
  assert.equal(failed.statusCode, 400, failed.body);
  assert.match(failed.json().error, /name/);
  assert.deepEqual(await get(app, '/movies/1'), before);
  assert.equal((await mutate(app, 'PATCH', { users: [{ id: 1 }] })).statusCode, 200);
  assert.equal((await get(app, '/users/1')).name, 'first');
  const replaced = await mutate(app, 'PUT', { title: 'replaced', userIds: [1], genres: [{ id: 1, name: 'replacement' }, { name: 'new genre' }] });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().description, undefined);
  assert.equal(replaced.json().actors, undefined);
  assert.deepEqual(replaced.json().userIds, [1]);
  const genre = await get(app, '/genres/1');
  assert.equal(genre.name, 'replacement');
  assert.equal(genre.description, undefined);
  assert.equal(genre.state, 'new');
  assert.equal(genre.stamp, 'fixed');
  assert.equal(genre.token, data.genres[0].token);
  assert.equal((await get(app, '/users/1')).role, 'member');
  assert.equal((await get(app, '/genres/3')).name, 'new genre');
  assert.equal((await mutate(app, 'PUT', { title: 'references', users: [1] })).statusCode, 200);
  assert.equal((await get(app, '/users/1')).role, 'member');
});

test('nested source paths use the correct array element and accept single relations', async (t) => {
  const { app } = await setup(t);
  const result = await mutate(
    app,
    'PATCH',
    {
      actors: [
        { user: { id: 1, name: 'renamed' }, genres: [{ name: 'first new' }] },
        { userId: 2, genres: [{ id: 2, name: 'second updated' }] },
      ],
      owner: { name: 'new owner' },
    },
    '/movies/1',
    [{ '*': true, actors: [{ '*': true, user: [{ '*': true }], genres: [{ '*': true }] }], owner: [{ '*': true }] }],
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().actors.data[0].userId, 1);
  assert.deepEqual(result.json().actors.data[0].genreIds, [3]);
  assert.deepEqual(result.json().actors.data[1].genreIds, [2]);
  assert.equal(result.json().actors.data[1].user.name, 'second');
  assert.equal(result.json().ownerId, 3);
  assert.equal(result.json().owner.name, 'new owner');
  assert.equal(result.json().actors.data[0].user.password, undefined);
  const cleared = await mutate(app, 'PATCH', { owner: null, genres: [] });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().ownerId, null);
  assert.deepEqual(cleared.json().genreIds, []);
});

test('nested failures roll back every record and counter on disk', async (t) => {
  const { app, path } = await setup(t, model, data, true);
  const before = await readFile(path, 'utf8');
  for (const body of [
    { genres: [{ name: 'must roll back' }, 999] },
    { genres: [{ id: 1, name: 'must roll back' }, { name: 12 }] },
    { genres: [{ id: 1, stamp: 'forbidden' }] },
    { genreIds: [1], genres: [2] },
    { actors: [{ user: 1, userId: 2, genres: [1] }] },
    { genres: [1, 1] },
    { genres: ['1'] },
    { genres: [null] },
    { genres: null },
    { owner: [1] },
  ]) {
    const result = await mutate(app, 'PATCH', body);
    assert.ok([400, 404].includes(result.statusCode), result.body);
    assert.equal(await readFile(path, 'utf8'), before);
    await assert.rejects(() => readFile(`${path}.counters.json`), { code: 'ENOENT' });
  }
  const invalidScope = await mutate(app, 'PATCH', { genres: [{ name: 'must roll back' }] }, '/movies/1', [{ missing: true }]);
  assert.equal(invalidScope.statusCode, 400);
  assert.equal(await readFile(path, 'utf8'), before);
  const good = await mutate(app, 'PATCH', { genres: [{ name: 'saved' }] });
  assert.equal(good.statusCode, 200, good.body);
  assert.deepEqual(good.json().genreIds, [3]);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).genres.length, 3);
  assert.equal(JSON.parse(await readFile(`${path}.counters.json`, 'utf8'))['genres.id'], 3);
});

test('GraphQL nested input keeps PUT/PATCH semantics and creates records without keys', async (t) => {
  const { app, facade } = await setup(t);
  const update = await gql(app, 'mutation { movieUpdate(id:1,data:{genres:[{id:1},{name:"from graphql"}]}){genreIds genres{data{id name description}}} }');
  assert.equal(update.json().errors, undefined, update.body);
  assert.deepEqual(update.json().data.movieUpdate.genreIds, [1, 3]);
  assert.equal(update.json().data.movieUpdate.genres.data[0].description, 'keep');
  const failed = await gql(app, 'mutation { movieReplace(id:1,data:{title:"bad",users:[{id:1}]}){id} }');
  assert.ok(failed.json().errors, failed.body);
  assert.equal((await get(app, '/movies/1')).title, 'original');
  const replace = await gql(app, 'mutation { movieReplace(id:1,data:{title:"good",genres:[{id:1,name:"replaced"}],userIds:[1]}){title genres{data{id name description stamp}}} }');
  assert.equal(replace.json().errors, undefined, replace.body);
  assert.equal(replace.json().data.movieReplace.genres.data[0].description, null);
  assert.equal(replace.json().data.movieReplace.genres.data[0].stamp, 'fixed');
  const created = await gql(app, 'mutation { movieCreate(data:{title:"created",genres:[{name:"created together"}]}){id genres{data{name}}} }');
  assert.equal(created.json().errors, undefined, created.body);
  assert.equal(created.json().data.movieCreate.genres.data[0].name, 'created together');
  assert.match(await facade.graphql(), /input GenreNestedReplace/);
});

const reverseModel = (array = false, required = false) => ({
  Parent: { collection: 'parents', fields: { id: primary, name: { type: 'string', required: true }, children: { type: 'Child[]', target: array ? 'parentIds' : 'parentId' } } },
  Child: {
    collection: 'children',
    fields: { id: primary, name: { type: 'string', required: true }, [array ? 'parentIds' : 'parentId']: { type: array ? 'number[]' : 'number', required, nullable: !array } },
  },
});

test('reverse links attach new records and replace only the selected parent membership', async (t) => {
  const { app } = await setup(t, reverseModel(true), {
    parents: [
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
    ],
    children: [{ id: 1, name: 'child', parentIds: [2] }],
  });
  const result = await mutate(app, 'PATCH', { children: [1, { name: 'new child' }] }, '/parents/1', [{ children: [{ '*': true }] }]);
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual((await get(app, '/children/1')).parentIds, [2, 1]);
  assert.deepEqual((await get(app, '/children/2')).parentIds, [1]);
  assert.equal((await mutate(app, 'PATCH', { name: 'changed' }, '/parents/1')).statusCode, 200);
  assert.deepEqual((await get(app, '/children/1')).parentIds, [2, 1]);
  assert.equal((await mutate(app, 'PUT', { name: 'replaced' }, '/parents/1')).statusCode, 200);
  assert.deepEqual((await get(app, '/children/1')).parentIds, [2]);
  assert.deepEqual((await get(app, '/children/2')).parentIds, []);
  assert.equal((await get(app, '/children')).total, 2);
});

test('reverse scalar keys can be supplied by a nested parent creation', async (t) => {
  const { app } = await setup(t, reverseModel(false, true), { parents: [], children: [] });
  const result = await mutate(app, 'POST', { name: 'parent', children: [{ name: 'child' }] }, '/parents', [{ '*': true, children: [{ '*': true }] }]);
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.json().children.data[0].parentId, result.json().id);
  assert.equal((await mutate(app, 'PATCH', { children: [] }, '/parents/1')).statusCode, 200);
  assert.equal((await get(app, '/children/1')).parentId, null);
});

test('custom primary keys use the model key and require generated keys for nested creation', async (t) => {
  const schema = {
    Country: { collection: 'countries', fields: { code: { type: 'string', primary: true }, name: { type: 'string', required: true } } },
    User: { collection: 'users', fields: { id: primary, country: { type: 'Country', source: 'countryCode' } } },
  };
  const { app } = await setup(t, schema, { countries: [{ code: 'US', name: 'old' }], users: [{ id: 1, countryCode: 'US' }] });
  assert.equal((await mutate(app, 'PATCH', { country: { code: 'US', name: 'updated' } }, '/users/1')).statusCode, 200);
  assert.equal((await get(app, '/countries/US')).name, 'updated');
  assert.equal((await mutate(app, 'PATCH', { country: { name: 'missing key' } }, '/users/1')).statusCode, 400);
  assert.equal((await mutate(app, 'PATCH', { country: { code: 'unknown', name: 'new' } }, '/users/1')).statusCode, 404);
  assert.equal((await get(app, '/countries')).total, 1);
});

test('required and protected relation keys reject disconnects atomically', async (t) => {
  const requiredModel = structuredClone(model);
  requiredModel.Movie.fields.genres.required = true;
  const { app } = await setup(t, requiredModel);
  for (const [method, body] of [
    ['PATCH', { genres: [] }],
    ['PUT', { title: 'missing relation' }],
  ]) {
    assert.equal((await mutate(app, method, body)).statusCode, 400);
    assert.equal((await get(app, '/movies/1')).title, 'original');
  }
  const schema = {
    A: { collection: 'a', fields: { id: primary, locked: { type: 'number', readOnly: true }, other: { type: 'B', source: 'locked' } } },
    B: { collection: 'b', fields: { id: primary } },
  };
  const protectedServer = await setup(t, schema, { a: [{ id: 1, locked: 1 }], b: [{ id: 1 }, { id: 2 }] });
  const result = await mutate(protectedServer.app, 'PATCH', { other: 2 }, '/a/1');
  assert.equal(result.statusCode, 400, result.body);
  assert.equal((await get(protectedServer.app, '/a/1')).locked, 1);
  assert.deepEqual((await get(protectedServer.app, '/b')).data, [{ id: 1 }, { id: 2 }]);
});

test('reverse paths through arrays require an unambiguous target and preserve other links', async (t) => {
  const schema = structuredClone(model);
  schema.User.fields.movies = { type: 'Movie[]', target: 'actors.userId' };
  const initial = structuredClone(data);
  initial.users.push({ id: 3, name: 'third' });
  initial.movies[0].actors = [
    { userId: 1, genreIds: [1] },
    { userId: 2, genreIds: [2] },
  ];
  const { app } = await setup(t, schema, initial);
  const failed = await mutate(app, 'PATCH', { movies: [1] }, '/users/3');
  assert.equal(failed.statusCode, 400, failed.body);
  assert.match(failed.json().error, /Ambiguous target/);
  assert.deepEqual((await get(app, '/movies/1')).actors.data, initial.movies[0].actors);
  const result = await mutate(
    app,
    'PATCH',
    {
      movies: [
        {
          id: 1,
          actors: [
            { userId: 1, genreIds: [1] },
            { userId: 2, genreIds: [2] },
            { userId: 3, genres: [{ name: 'new' }] },
          ],
        },
      ],
    },
    '/users/3',
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal((await get(app, '/movies/1')).actors.data.length, 3);
  assert.equal((await mutate(app, 'PATCH', { movies: [] }, '/users/3')).statusCode, 400);
  assert.equal((await get(app, '/movies/1')).actors.data[2].userId, 3);
});

test('nested source bindings work below multiple levels of arrays', async (t) => {
  const schema = {
    Genre: model.Genre,
    Movie: {
      collection: 'movies',
      fields: { id: primary, groups: { type: 'object[]' }, 'groups.actors': { type: 'object[]' }, 'groups.actors.genres': { type: 'Genre[]', source: 'groups.actors.genreIds' } },
    },
  };
  const { app } = await setup(t, schema, { genres: [], movies: [{ id: 1 }] });
  const result = await mutate(app, 'PATCH', { groups: [{ actors: [{ genres: [{ name: 'a' }] }] }, { actors: [{ genres: [{ name: 'b' }] }, { genres: [{ name: 'c' }] }] }] });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(
    result.json().groups.data.map((group) => group.actors.data.map((actor) => actor.genreIds)),
    [[[1]], [[2], [3]]],
  );
  const failed = await mutate(app, 'PATCH', { groups: [{ actors: [{ genres: [1] }] }, { actors: [{ genreIds: [2], genres: [3] }] }] });
  assert.equal(failed.statusCode, 400, failed.body);
});

test('custom target keys reject ambiguous matches without modifying other records', async (t) => {
  const schema = {
    Owner: { collection: 'owners', fields: { id: primary, target: { type: 'Target', source: 'targetCode', target: 'code' } } },
    Target: { collection: 'targets', fields: { id: primary, code: { type: 'string', required: true }, name: { type: 'string' } } },
  };
  const { app } = await setup(t, schema, {
    owners: [{ id: 1 }],
    targets: [
      { id: 1, code: 'a' },
      { id: 2, code: 'b' },
      { id: 3, code: 'b' },
    ],
  });
  assert.equal((await mutate(app, 'PATCH', { target: { id: 1, name: 'updated' } }, '/owners/1')).statusCode, 200);
  assert.equal((await get(app, '/owners/1')).targetCode, 'a');
  const failed = await mutate(app, 'PATCH', { target: 2 }, '/owners/1');
  assert.equal(failed.statusCode, 409, failed.body);
  assert.equal((await get(app, '/owners/1')).targetCode, 'a');
});

test('nested GraphQL errors and excessive depth do not persist partial writes', async (t) => {
  const { app } = await setup(t);
  const failed = await gql(app, 'mutation { movieUpdate(id:1,data:{genres:[{name:"rolled back"},{id:999}]}){id} }');
  assert.equal(failed.json().errors[0].extensions.code, 'NOT_FOUND');
  assert.equal((await get(app, '/genres')).total, 2);
  const cyclicModel = { Node: { collection: 'nodes', fields: { id: primary, children: { type: 'Node[]', source: 'childIds' } } } };
  const cyclic = await setup(t, cyclicModel, { nodes: [{ id: 1 }] });
  const tooDeep = Array.from({ length: 34 }).reduce((node) => ({ children: [node] }), {});
  const response = await mutate(cyclic.app, 'PATCH', tooDeep, '/nodes/1');
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /too deep/);
  assert.equal((await get(cyclic.app, '/nodes')).total, 1);
  const ancestor = await mutate(cyclic.app, 'PATCH', { children: [{ id: 1, children: [] }] }, '/nodes/1');
  assert.equal(ancestor.statusCode, 409, ancestor.body);
  assert.equal((await mutate(cyclic.app, 'PATCH', { children: [1] }, '/nodes/1')).statusCode, 200);
});

test('OpenAPI validates nested create, update and replace shapes', async (t) => {
  const { Ajv } = await import('ajv');
  const { facade } = await setup(t);
  const document = await facade.openapi();
  const ajv = new Ajv({ strict: false });
  ajv.addSchema({ components: document.components }, 'nested-contract');
  const update = ajv.compile({ $ref: 'nested-contract#/components/schemas/MovieUpdate' });
  const replace = ajv.compile({ $ref: 'nested-contract#/components/schemas/MovieReplace' });
  assert.equal(update({ genres: [1, { id: 2 }, { name: 'new' }] }), true, JSON.stringify(update.errors));
  assert.equal(replace({ title: 'new', users: [{ id: 1 }] }), false);
  assert.equal(replace({ title: 'new', userIds: [1], genres: [{ id: 1, name: 'full' }, { name: 'new' }] }), true, JSON.stringify(replace.errors));
  assert.equal(update({ genres: [{ id: 1, stamp: 'protected' }] }), false);
  assert.equal(update({ genres: [{}] }), false);
  assert.equal(update({ genres: ['1'] }), false);
});
