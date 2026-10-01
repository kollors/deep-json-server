import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../dist/index.js';

const setup = async (t) => {
  const app = (
    await createServer({
      storage: 'memory',
      database: {
        schema: {
          models: {
            Item: {
              collection: 'items',
              fields: {
                id: { type: 'string', primary: true },
                profile: { type: 'object', nullable: true },
                'profile.name': { type: 'string' },
                'profile.meta': { type: 'object', nullable: true },
                'profile.meta.stamp': { type: 'string', readOnly: true, nullable: true },
                'profile.meta.name': { type: 'string' },
              },
            },
          },
        },
        source: {
          items: [
            { id: 'saved', profile: { name: 'old', meta: { stamp: 'fixed' } } },
            { id: 'null-stamp', profile: { meta: { stamp: null } } },
            { id: 'unprotected', profile: { name: 'editable', meta: { name: 'editable' } } },
          ],
        },
      },
      graphql: {},
      package: { source: { name: 'test-api', version: '1.0.0' } },
      server: { logger: false },
    })
  ).fastify();
  t.after(() => app.close());
  return app;
};
const url = (id) => `/items/${id}?${new URLSearchParams({ scope: JSON.stringify([{ profile: [{ name: true, meta: [{ stamp: true, name: true }] }] }]) })}`;

for (const method of ['PATCH', 'PUT']) {
  test(`${method} rejects null ancestors of saved read-only values and preserves the record`, async (t) => {
    const app = await setup(t);
    for (const id of ['saved', 'null-stamp']) {
      const before = (await app.inject(url(id))).json();
      for (const profile of [null, { meta: null }]) {
        const failed = await app.inject({ method, url: `/items/${id}`, payload: { profile } });
        assert.equal(failed.statusCode, 400, failed.body);
        assert.match(failed.json().error, /contains protected fields/);
        assert.deepEqual((await app.inject(url(id))).json(), before);
      }
    }
    const replaced = await app.inject({ method, url: url('saved'), payload: { profile: { name: 'new' } } });
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.deepEqual(replaced.json(), { profile: { name: 'new', meta: { stamp: 'fixed' } } });
    const cleared = await app.inject({ method, url: url('unprotected'), payload: { profile: null } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json(), { profile: null });
  });
}

test('GraphQL update and replace reject null ancestors of saved read-only fields', async (t) => {
  const app = await setup(t);
  const before = (await app.inject(url('saved'))).json();
  for (const operation of ['itemUpdate', 'itemReplace']) {
    for (const profile of ['null', '{meta:null}']) {
      const failed = await app.inject({ method: 'POST', url: '/graphql', payload: { query: `mutation{${operation}(id:"saved",data:{profile:${profile}}){id}}` } });
      assert.match(failed.json().errors[0].message, /contains protected fields/);
      assert.deepEqual((await app.inject(url('saved'))).json(), before);
    }
  }
});
