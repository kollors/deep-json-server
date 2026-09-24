import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../dist/index.js';
import { loadModel } from '../dist/src/core/model.js';

const primary = { type: 'string', primary: true };

test('paired relations infer one shared key in both directions', async (t) => {
  const schema = {
    models: {
      Country: { collection: 'countries', fields: { id: primary, name: { type: 'string' }, users: { type: 'User[]', keyOn: 'related' } } },
      User: { collection: 'users', fields: { id: primary, country: { type: 'Country', keyOn: 'current' } } },
    },
  };
  const model = await loadModel(schema);
  assert.equal(model.byName.get('User').fields.country.source, 'countryId');
  assert.equal(model.byName.get('User').fields.country.target, 'id');
  assert.equal(model.byName.get('Country').fields.users.source, 'id');
  assert.equal(model.byName.get('Country').fields.users.target, 'countryId');
  assert.equal(model.byName.get('User').fields.countryId.implicit, true);
  const facade = await createServer({ storage: 'memory', database: { schema, source: { countries: [{ id: 'c', name: 'Before' }], users: [{ id: 'u', countryId: 'c' }] } }, server: { logger: false } });
  const app = facade.fastify();
  t.after(() => app.close());
  const user = await app.inject(`/users/u?${new URLSearchParams({ scope: JSON.stringify([{ country: [{ id: true }] }]) })}`);
  assert.deepEqual(user.json(), { country: { id: 'c' } });
  const country = await app.inject(`/countries/c?${new URLSearchParams({ scope: JSON.stringify([{ users: [{ id: true }] }]) })}`);
  assert.deepEqual(country.json(), { users: { data: [{ id: 'u' }], total: 1 } });
  assert.equal((await app.inject({ method: 'PUT', url: '/countries/c', payload: { name: 'After' } })).statusCode, 200);
  assert.deepEqual((await app.inject(`/countries/c?${new URLSearchParams({ scope: JSON.stringify([{ users: [{ id: true }] }]) })}`)).json().users.data, [{ id: 'u' }]);
  assert.equal((await app.inject({ method: 'DELETE', url: '/users/u' })).statusCode, 200);
  assert.equal((await app.inject('/countries/c')).statusCode, 200);
});

test('custom primary keys, list keys, and self relations infer paths from direct fields', async () => {
  const schema = {
    models: {
      Publisher: { collection: 'publishers', fields: { ref: { type: 'string', primary: true }, movies: { type: 'Movie[]', keyOn: 'related' } } },
      Movie: { collection: 'movies', fields: { id: primary, publishers: { type: 'Publisher[]', keyOn: 'current' } } },
      Genre: { collection: 'genres', fields: { id: primary, parents: { type: 'Genre[]', keyOn: 'current' }, children: { type: 'Genre[]', keyOn: 'related' } } },
    },
  };
  const model = await loadModel(schema);
  assert.equal(model.byName.get('Movie').fields.publishers.source, 'publisherRefs');
  assert.equal(model.byName.get('Publisher').fields.movies.target, 'publisherRefs');
  assert.equal(model.byName.get('Genre').fields.parents.source, 'parentIds');
  assert.equal(model.byName.get('Genre').fields.children.target, 'parentIds');
  assert.equal(model.byName.get('Genre').fields.parentIds.type, 'string[]');
});

test('a custom target field changes the inferred source suffix', async () => {
  const model = await loadModel({
    models: {
      Country: { collection: 'countries', fields: { id: primary, banana: { type: 'string' }, users: { type: 'User[]', keyOn: 'related', source: 'banana' } } },
      User: { collection: 'users', fields: { id: primary, country: { type: 'Country', keyOn: 'current', target: 'banana' } } },
    },
  });
  assert.equal(model.byName.get('User').fields.country.source, 'countryBanana');
  assert.equal(model.byName.get('Country').fields.users.target, 'countryBanana');
});

test('missing, ambiguous, and inconsistent relation pairs are rejected', async () => {
  const user = { collection: 'users', fields: { id: primary, country: { type: 'Country', keyOn: 'current' } } };
  const country = { collection: 'countries', fields: { id: primary } };
  await assert.rejects(() => loadModel({ models: { User: user, Country: country } }), /matching related relation/);
  await assert.rejects(() => loadModel({ models: { User: { ...user, fields: { ...user.fields, country: { type: 'Country' } } }, Country: country } }), /keyOn is required/);
  await assert.rejects(() => loadModel({ models: { User: user, Country: { ...country, fields: { ...country.fields, users: { type: 'User[]', keyOn: 'current' } } } } }), /matching related relation/);
  await assert.rejects(
    () => loadModel({ models: { User: user, Country: { ...country, fields: { ...country.fields, users: { type: 'User[]', keyOn: 'related', target: 'wrongId' } } } } }),
    /matching related relation/,
  );
  await assert.rejects(
    () =>
      loadModel({
        models: {
          User: { ...user, fields: { ...user.fields, birthCountry: { type: 'Country', keyOn: 'current' }, residenceCountry: { type: 'Country', keyOn: 'current' } } },
          Country: { ...country, fields: { ...country.fields, users: { type: 'User[]', keyOn: 'related' } } },
        },
      }),
    /matching (current|related) relation/,
  );
});

test('explicit key paths pair multiple relations to the same model', async () => {
  const schema = {
    models: {
      User: {
        collection: 'users',
        fields: {
          id: primary,
          birthCountry: { type: 'Country', keyOn: 'current' },
          residenceCountry: { type: 'Country', keyOn: 'current' },
        },
      },
      Country: {
        collection: 'countries',
        fields: {
          id: primary,
          birthUsers: { type: 'User[]', keyOn: 'related', target: 'birthCountryId' },
          residenceUsers: { type: 'User[]', keyOn: 'related', target: 'residenceCountryId' },
        },
      },
    },
  };
  const model = await loadModel(schema);
  assert.equal(model.byName.get('Country').fields.birthUsers.target, 'birthCountryId');
  assert.equal(model.byName.get('Country').fields.residenceUsers.target, 'residenceCountryId');
});
