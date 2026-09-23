import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { createServer } from '../dist/index.js';
import { createHttpServer } from '../dist/src/server/http.js';

const temp = async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'deep-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

for (const callback of [false, true]) {
  test(`listen uses the requested Unix socket (callback=${callback})`, { skip: process.platform === 'win32' }, async (t) => {
    const socketPath = join(await temp(t), 'server.sock');
    const app = (await createServer({ storage: 'memory', database: { source: { notes: [] } }, server: { port: 0, logger: false } })).fastify();
    t.after(() => app.close());
    try {
      if (callback) await new Promise((resolve, reject) => app.listen({ path: socketPath }, (error) => (error ? reject(error) : resolve())));
      else await app.listen({ path: socketPath });
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      t.skip('The environment does not allow Unix sockets');
      return;
    }
    assert.equal(app.server.address(), socketPath);
    const body = await new Promise((resolve, reject) => {
      const req = request({ socketPath, path: '/notes' }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(JSON.parse(body)));
        response.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.deepEqual(body, { data: [], total: 0 });
  });
}

test('listen preserves Unix options and applies TCP defaults only to TCP calls', async (t) => {
  const calls = [];
  const create = (options) => {
    const app = Fastify(options);
    app.listen = (options, callback) => {
      calls.push(options);
      if (callback) callback(null, 'address');
      else return Promise.resolve('address');
    };
    return app;
  };
  const app = createHttpServer({ create, host: '127.0.0.1', port: 4001, logger: false, cors: false, corsHeaders: {} });
  t.after(() => app.close());
  const unix = { path: '/tmp/socket', readableAll: true };
  assert.equal(await app.listen(unix), 'address');
  await new Promise((resolve, reject) => app.listen(unix, (error) => (error ? reject(error) : resolve())));
  assert.deepEqual(calls, [unix, unix]);
  await app.listen({ port: 0 });
  await app.listen();
  await new Promise((resolve, reject) => app.listen((error) => (error ? reject(error) : resolve())));
  assert.deepEqual(calls.slice(2), [
    { host: '127.0.0.1', port: 0 },
    { host: '127.0.0.1', port: 4001 },
    { host: '127.0.0.1', port: 4001 },
  ]);
});
