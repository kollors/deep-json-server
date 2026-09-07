import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createServer } from '../dist/index.js';

const withMemoryServer = async (data, schema, run, serverOptions = {}) => {
  const facade = await createServer({ database: { data, schema }, server: { ...serverOptions, logger: false } });
  const server = facade.fastify();

  try {
    await server.ready();
    await run(server, facade);
  } finally {
    await server.close();
  }
};

test('persists disk CRUD when NODE_ENV is test', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-env-'));
  const databasePath = join(directory, 'database.json');

  try {
    await writeFile(databasePath, JSON.stringify({ items: [] }));
    await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict';
          const { createServer } = await import(process.argv[1]);
          const facade = await createServer({ database: { path: process.argv[2] }, server: { logger: false } });
          const server = facade.fastify();
          try {
            const created = await server.inject({ method: 'POST', url: '/items', payload: { name: 'new' } });
            assert.equal(created.statusCode, 201);
            const url = '/items/' + created.json().id;
            assert.equal((await server.inject(url)).json().name, 'new');
            const patched = await server.inject({ method: 'PATCH', url, payload: { name: 'updated' } });
            assert.equal(patched.statusCode, 200);
            assert.equal((await server.inject(url)).json().name, 'updated');
            assert.equal((await server.inject({ method: 'DELETE', url })).statusCode, 200);
            assert.equal((await server.inject(url)).statusCode, 404);
            assert.equal((await server.inject({ method: 'POST', url: '/items', payload: { name: 'persisted' } })).statusCode, 201);
          } finally {
            await server.close();
          }
        `,
        new URL('../dist/index.js', import.meta.url).href,
        databasePath,
      ],
      { env: { ...process.env, NODE_ENV: 'test' } },
    );
    const stored = JSON.parse(await readFile(databasePath, 'utf8'));

    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].name, 'persisted');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('PATCH never inserts defaults while POST and PUT retain them', async () => {
  const schema = {
    $schema: {
      items: {
        properties: {
          entries: { items: { properties: { status: { default: 'draft', type: 'string' } }, type: 'object' }, type: 'array' },
          profile: { allOf: [{ properties: { status: { default: 'draft', type: 'string' } }, type: 'object' }] },
          status: { default: 'draft', type: 'string' },
        },
      },
    },
  };

  await withMemoryServer({ items: [{ id: '1', name: 'old', status: 'published' }] }, schema, async (server, facade) => {
    const updated = await server.inject({ method: 'PATCH', payload: { name: 'changed' }, url: '/items/1' });

    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().status, 'published');

    const nested = await server.inject({ method: 'PATCH', payload: { entries: [{}], profile: {} }, url: '/items/1' });

    assert.equal(nested.statusCode, 200, nested.body);
    assert.deepEqual(nested.json().entries, [{}]);
    assert.deepEqual(nested.json().profile, {});

    for (const method of ['POST', 'PUT']) {
      const response = await server.inject({ method, payload: { entries: [{}], profile: {} }, url: method === 'POST' ? '/items' : '/items/1' });

      assert.equal(response.statusCode, method === 'POST' ? 201 : 200, response.body);
      assert.equal(response.json().status, 'draft');
      assert.deepEqual(response.json().entries, [{ status: 'draft' }]);
      assert.deepEqual(response.json().profile, { status: 'draft' });
    }

    assert.equal((await facade.openapi()).components.schemas.ItemUpdate.properties.status.default, 'draft');
  });
});

test('overlapping embed paths merge regardless of order and leave stored data unchanged', async () => {
  const data = {
    countries: [{ id: 'c', name: 'Country' }],
    posts: [
      { actors: [{ userId: 'u' }], id: 'p', userId: 'u' },
      { id: 'many', userIds: ['u'] },
    ],
    roles: [{ id: 'r', name: 'Role' }],
    users: [{ countryId: 'c', id: 'u', roleId: 'r' }],
  };
  const expected = { ...data.users[0], country: data.countries[0], role: data.roles[0] };

  await withMemoryServer(data, undefined, async (server) => {
    for (const embed of ['user.country,user.role', 'user.role,user.country', 'user.country,user,user.role,user.country']) {
      assert.deepEqual((await server.inject(`/posts/p?_embed=${embed}`)).json().user, expected);
      assert.deepEqual((await server.inject(`/posts?_embed=${embed}`)).json().data[0].user, expected);
    }

    assert.deepEqual((await server.inject('/posts/many?_embed=users.country,users.role,users')).json().users, [expected]);
    assert.deepEqual((await server.inject('/posts/p?_embed=actors.user.country,actors.user.role')).json().actors, [{ user: expected, userId: 'u' }]);
    assert.deepEqual((await server.inject('/countries/c?_embed=users.role,users.posts,users')).json().users, [{ ...data.users[0], posts: data.posts, role: data.roles[0] }]);
    assert.deepEqual((await server.inject('/posts/p')).json(), data.posts[0]);
    assert.deepEqual((await server.inject('/users/u')).json(), data.users[0]);
  });
});

test('validates null and mixed inferred types without coercing JSON values', async () => {
  const cases = [
    { invalid: ['', 0, false, {}, []], values: [null] },
    { invalid: [false, {}, []], values: ['1', 1, null] },
    { invalid: ['1', null, {}, []], values: [true, false, 0, 1] },
    { invalid: [1, false], values: [['one'], 'two', null, { name: 'three' }] },
  ];

  for (const { invalid, values } of cases) {
    const data = { items: values.map((value, index) => ({ id: String(index), value })) };

    await withMemoryServer(data, undefined, async (server, facade) => {
      assert.equal((await facade.openapi()).openapi, '3.0.3');

      for (const method of ['POST', 'PUT', 'PATCH']) {
        const url = method === 'POST' ? '/items' : '/items/0';

        for (const value of values) {
          const response = await server.inject({ method, payload: { value }, url });

          assert.equal(response.statusCode, method === 'POST' ? 201 : 200, response.body);
          assert.deepEqual(response.json().value, value);
        }

        for (const value of invalid) {
          const response = await server.inject({ method, payload: { value }, url });

          assert.equal(response.statusCode, 400, response.body);
        }
      }
    });
  }
});

test('combines nested explicit required with shorthand and enforces replacement objects in PATCH', async () => {
  const schema = {
    $schema: {
      items: {
        properties: { profile: { properties: { email: { type: 'string' }, name: { type: 'string' } }, required: ['name'], type: 'object' } },
        required: ['profile', 'profile.email'],
      },
    },
  };

  await withMemoryServer({ items: [{ id: '1', profile: { email: 'old', name: 'old' } }] }, schema, async (server, facade) => {
    const document = await facade.openapi();

    assert.deepEqual(document.components.schemas.ItemCreate.properties.profile.required, ['name', 'email']);
    assert.deepEqual(document.components.schemas.ItemUpdate.properties.profile.required, ['name', 'email']);
    assert.equal(document.components.schemas.ItemUpdate.required, undefined);

    for (const method of ['POST', 'PUT', 'PATCH']) {
      const url = method === 'POST' ? '/items' : '/items/1';

      for (const profile of [{}, { email: 'new' }, { name: 'new' }]) {
        assert.equal((await server.inject({ method, payload: { profile }, url })).statusCode, 400);
      }

      assert.equal((await server.inject({ method, payload: {}, url })).statusCode, method === 'PATCH' ? 200 : 400);
      const valid = await server.inject({ method, payload: { profile: { email: 'new', name: 'new' } }, url });

      assert.equal(valid.statusCode, method === 'POST' ? 201 : 200, valid.body);
    }
  });
});

test('caps only the default page size and documents the same value', async () => {
  for (const maxPageSize of [1, 5, 25]) {
    const data = { items: Array.from({ length: 12 }, (_, index) => ({ id: String(index) })) };

    await withMemoryServer(
      data,
      undefined,
      async (server, facade) => {
        const response = await server.inject('/items');

        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().data.length, Math.min(10, maxPageSize));
        assert.equal(response.json().total, 12);
        assert.equal((await facade.openapi()).components.parameters.PerPage.schema.default, Math.min(10, maxPageSize));
        assert.equal((await server.inject(`/items?_perPage=${maxPageSize + 1}`)).statusCode, 400);
      },
      { maxPageSize },
    );
  }
});

test('keeps one contract across HTTP changes and returns isolated OpenAPI documents', async () => {
  for (const data of [{ items: [] }, { items: [{ count: 1, id: '1' }] }]) {
    const facade = await createServer({ database: { data }, server: { logger: false } });
    const initial = await facade.openapi();
    const returned = await facade.openapi();

    returned.components.schemas.ItemCreate.properties.count = { type: 'boolean' };
    const server = facade.fastify();

    try {
      await server.ready();
      const created = await server.inject({ method: 'POST', payload: { count: 2 }, url: '/items' });

      assert.equal(created.statusCode, 201);
      assert.deepEqual(await facade.openapi(), initial);
      const invalid = await server.inject({ method: 'POST', payload: { count: 'text' }, url: '/items' });

      assert.equal(invalid.statusCode, data.items.length === 0 ? 201 : 400);
      assert.equal((await server.inject({ method: 'DELETE', url: `/items/${created.json().id}` })).statusCode, 200);
      assert.deepEqual(await facade.openapi(), initial);
    } finally {
      await server.close();
    }
  }
});

test('reloads disk data while requiring a new server to infer a new contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-server-contract-'));
  const databasePath = join(directory, 'database.json');
  let server;

  try {
    await writeFile(databasePath, JSON.stringify({ items: [{ count: 1, id: '1' }] }));
    const config = { database: { path: databasePath }, server: { logger: false } };
    const facade = await createServer(config);

    server = facade.fastify();
    await server.ready();
    const initial = await facade.openapi();

    await writeFile(databasePath, JSON.stringify({ items: [{ count: 'changed', id: '1' }] }));
    assert.equal((await server.inject('/items/1')).json().count, 'changed');
    assert.deepEqual(await facade.openapi(), initial);
    assert.equal((await server.inject({ method: 'POST', payload: { count: 'changed' }, url: '/items' })).statusCode, 400);
    const fresh = await createServer(config);

    assert.equal((await fresh.openapi()).components.schemas.ItemCreate.properties.count.type, 'string');
  } finally {
    await server?.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test('traverses every positive composition, nested arrays and sibling properties', async () => {
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    const schema = {
      $schema: {
        items: {
          formats: { 'details.entries.date': 'date', 'details.name': 'email' },
          properties: {
            details: {
              [keyword]: [
                {
                  properties: { entries: { items: { properties: { date: { type: 'string' }, userId: { type: 'string' } }, type: 'object' }, type: 'array' }, name: { type: 'string' } },
                  required: ['entries'],
                  type: 'object',
                },
              ],
              properties: { label: { type: 'string' } },
              type: 'object',
            },
          },
          required: ['details', 'details.name', 'details.label', 'details.entries.date'],
        },
      },
    };

    await withMemoryServer({ items: [], users: [{ id: 'u' }] }, schema, async (server, facade) => {
      const document = await facade.openapi();
      const details = document.components.schemas.Item.properties.details;

      assert.deepEqual(details.required, ['label']);
      assert.deepEqual(details[keyword][0].required, ['entries', 'name']);
      assert.equal(details[keyword][0].properties.name.format, 'email');
      assert.equal(details[keyword][0].properties.entries.items.properties.date.format, 'date');
      assert.deepEqual(details[keyword][0].properties.entries.items.properties.user, { $ref: '#/components/schemas/User' });
      assert.deepEqual(document.components.schemas.User.properties.items, { items: { $ref: '#/components/schemas/Item' }, type: 'array' });

      const valid = { entries: [{ date: '2026-09-07', userId: 'u' }], label: 'label', name: 'a@example.com' };

      for (const value of [
        { ...valid, name: 'invalid' },
        { ...valid, entries: [{}] },
        { entries: valid.entries, name: valid.name },
        { label: valid.label, name: valid.name },
      ]) {
        const response = await server.inject({ method: 'POST', payload: { details: value }, url: '/items' });

        assert.equal(response.statusCode, 400, response.body);
      }

      const response = await server.inject({ method: 'POST', payload: { details: valid }, url: '/items' });

      assert.equal(response.statusCode, 201, response.body);
      assert.deepEqual(response.json().details, valid);
    });
  }
});

test('preserves composition alternatives when applying required and formats', async () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    const schema = {
      $schema: {
        items: {
          formats: { 'value.email': 'email' },
          properties: { value: { [keyword]: [{ properties: { email: { type: 'string' } }, type: 'object' }, { type: 'integer' }] } },
          required: ['value.email'],
        },
      },
    };

    await withMemoryServer({ items: [] }, schema, async (server) => {
      for (const value of [1, { email: 'a@example.com' }]) {
        assert.equal((await server.inject({ method: 'POST', payload: { value }, url: '/items' })).statusCode, 201);
      }

      for (const value of [{}, { email: 'invalid' }]) {
        assert.equal((await server.inject({ method: 'POST', payload: { value }, url: '/items' })).statusCode, 400);
      }
    });
  }
});

test('reverse embedding preserves order and deduplicates repeated references per record', async () => {
  const posts = Array.from({ length: 2000 }, (_, index) => ({ id: String(index), nested: { userId: 'u' }, userIds: ['u', 'u'] }));

  await withMemoryServer({ posts, users: [{ id: 'u' }] }, undefined, async (server) => {
    const response = await server.inject('/users/u?_embed=posts');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().posts.map(({ id }) => id),
      posts.map(({ id }) => id),
    );
  });
});
