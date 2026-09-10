import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

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
