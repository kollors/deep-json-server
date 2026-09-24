import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../dist/index.js';

test('a second server cannot open the same database and a crashed owner leaves a recoverable lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deep-json-lock-'));
  const databasePath = join(directory, 'database.json');
  await writeFile(databasePath, JSON.stringify({ items: [] }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const script = `
    import { createServer } from './dist/index.js';
    const facade = await createServer({ storage: 'file', database: { source: process.argv[1] }, server: { logger: false } });
    await facade.fastify().ready();
    process.send('READY');
    setInterval(() => {}, 1000000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, databasePath], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const started = await new Promise((resolve, reject) => {
    child.once('message', (message) => resolve(String(message)));
    child.once('exit', (code) => reject(new Error(`Lock owner exited before startup: ${code}`)));
    child.once('error', reject);
  });
  assert.match(started, /READY/);

  const blocked = (await createServer({ storage: 'file', database: { source: databasePath }, server: { logger: false } })).fastify();
  await assert.rejects(() => blocked.ready(), /already in use/);
  await blocked.close();
  assert.deepEqual(JSON.parse(await readFile(databasePath, 'utf8')), { items: [] });

  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const restarted = (await createServer({ storage: 'file', database: { source: databasePath }, server: { logger: false } })).fastify();
  await restarted.ready();
  assert.equal((await restarted.inject('/items')).statusCode, 200);
  await restarted.close();
});
