import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../dist/index.js';
import { validateDirectory } from '../dist/src/files/contract.js';

test('portable directory segments use the same validation for initial files and HTTP uploads', async (t) => {
  for (const path of ['CON', 'photos/bad:name', 'trailing.', 'line\nbreak', 'a/NUL.txt']) assert.throws(() => validateDirectory(path, 'directory'));
  assert.equal(validateDirectory('photos/2026', 'directory'), 'photos/2026');
  const app = (await createServer({ storage: 'memory', database: { source: { items: [] } }, files: { source: [] }, server: { logger: false } })).fastify();
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/_files/storage', headers: { 'content-name': 'a.txt', 'content-directory': 'photos/CON', 'content-type': 'text/plain' }, payload: 'test' });
  assert.equal(response.statusCode, 400, response.body);
});
