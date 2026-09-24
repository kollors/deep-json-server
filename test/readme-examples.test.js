import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createServer } from '../dist/index.js';
import { loadModel } from '../dist/src/core/model.js';
import { normalizeServerConfig } from '../dist/src/server/config.js';

const example = (markdown, name, language) => {
  const marker = `<!-- tested-example: ${name} -->`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `Missing ${name} example`);
  const block = /^```([^\n]+)\n([\s\S]*?)^```/m.exec(markdown.slice(start + marker.length).trimStart());
  assert.equal(block?.[1], language, `Invalid ${name} example`);
  return block[2];
};

for (const filename of ['README.md', 'README.ru.md']) {
  test(`${filename} examples parse and use supported configuration`, async () => {
    const markdown = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8');
    const blocks = [...markdown.matchAll(/^```(json|js)\n([\s\S]*?)^```/gm)];
    let schemas = 0;
    let configs = 0;
    for (const block of blocks) {
      const [, language, code] = block;
      const line = markdown.slice(0, block.index).split('\n').length;
      const label = `${filename}:${line}`;
      if (language === 'json') {
        const value = JSON.parse(code);
        if (value && !Array.isArray(value) && 'models' in value) {
          await loadModel(value);
          schemas++;
        }
      } else {
        const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: code, encoding: 'utf8' });
        assert.equal(checked.status, 0, `${label}: ${checked.stderr}`);
        if (code.startsWith('export default ')) {
          const expression = code
            .replace(/^export default\s+/, '')
            .trim()
            .replace(/;$/, '');
          normalizeServerConfig(runInNewContext(`(${expression})`));
          configs++;
        }
      }
    }
    assert.ok(schemas > 0, `${filename} has no checked schema examples`);
    assert.ok(configs > 0, `${filename} has no checked configuration examples`);
  });
}

for (const filename of ['README.md', 'README.ru.md']) {
  test(`${filename} REST and GraphQL request examples run against the example database`, async (t) => {
    const markdown = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8');
    const data = JSON.parse(await readFile(new URL('../examples/database.json', import.meta.url), 'utf8'));
    const schema = JSON.parse(await readFile(new URL('../examples/schema.json', import.meta.url), 'utf8'));
    const facade = await createServer({ storage: 'memory', database: { source: data, schema }, graphql: {}, server: { logger: false } });
    const app = facade.fastify();
    t.after(() => app.close());
    await app.ready();

    const script = example(markdown, 'rest-user-list', 'js');
    const response = await runInNewContext(`(async () => { ${script}\nreturn response; })()`, {
      URLSearchParams,
      fetch: (url) => app.inject(url),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 1);
    assert.equal(response.json().data[0].fullName, 'Mira Volkova');

    const scope = JSON.parse(example(markdown, 'rest-movie-scope', 'json'));
    const movie = await app.inject(`/movies/1?scope=${encodeURIComponent(JSON.stringify(scope))}`);
    assert.equal(movie.statusCode, 200);
    assert.equal(movie.json().actors.data[0].user.fullName, 'Mira Volkova');
    assert.deepEqual(
      movie.json().actors.data[0].genres.data.map(({ name }) => name),
      ['Drama', 'Gangster'],
    );

    const query = example(markdown, 'graphql-user-list', 'graphql');
    const graph = await app.inject({ method: 'POST', url: '/graphql', payload: { query } });
    assert.equal(graph.statusCode, 200);
    assert.equal(graph.json().errors, undefined);
    assert.equal(graph.json().data.userList.total, 1);
    assert.equal(graph.json().data.userList.data[0].movies.data[0].title, 'Shadows of Ardenia');
  });

  test(`${filename} schema examples enforce hidden keys and GraphQL-only routing`, async (t) => {
    const markdown = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8');
    const schema = JSON.parse(example(markdown, 'implicit-relation-schema', 'json'));
    const facade = await createServer({
      storage: 'memory',
      database: { source: { countries: [{ id: '1', name: 'Ardenia' }], users: [{ id: '1', fullName: 'Mira Volkova', countryId: '1' }] }, schema },
      graphql: {},
      openapi: {},
      package: { source: { name: 'readme-example', version: '1.0.0' } },
      server: { logger: false },
    });
    const app = facade.fastify();
    t.after(() => app.close());
    await app.ready();

    const rest = await app.inject('/users/1?scope=%5B%7B%22country%22%3A%5B%7B%22name%22%3Atrue%7D%5D%7D%5D');
    assert.deepEqual(rest.json(), { country: { name: 'Ardenia' } });
    assert.equal((await app.inject('/users/1?scope=%5B%7B%22countryId%22%3Atrue%7D%5D')).statusCode, 400);
    const graph = await app.inject({ method: 'POST', url: '/graphql', payload: { query: '{__type(name:"User"){fields{name}}}' } });
    assert.equal(
      graph.json().data.__type.fields.some(({ name }) => name === 'countryId'),
      false,
    );
    const openapi = (await app.inject('/openapi.json')).json();
    assert.equal(Object.hasOwn(openapi.components.schemas.User.properties, 'countryId'), false);

    const graphOnly = JSON.parse(example(markdown, 'graphql-only-schema', 'json'));
    const secondFacade = await createServer({
      storage: 'memory',
      database: { source: { items: [] }, schema: graphOnly },
      graphql: {},
      openapi: {},
      auth: { source: [] },
      files: { source: [] },
      package: { source: { name: 'readme-example', version: '1.0.0' } },
      server: { logger: false },
    });
    const second = secondFacade.fastify();
    t.after(() => second.close());
    await second.ready();
    assert.equal((await second.inject('/items')).statusCode, 404);
    const paths = (await second.inject('/openapi.json')).json().paths;
    assert.equal(Object.hasOwn(paths, '/items'), false);
    assert.equal(Object.hasOwn(paths, '/auth/login'), true);
    assert.equal(Object.hasOwn(paths, '/_files/storage'), true);
    assert.equal((await second.inject({ method: 'POST', url: '/graphql', payload: { query: '{itemList{total}}' } })).json().data.itemList.total, 0);
  });
}
