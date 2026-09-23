import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../dist/index.js';

const packagePath = new URL('../package.json', import.meta.url).pathname;
const packageSource = { name: 'test-api', version: '1.0.0', description: 'Test API' };
const setup = async (t, config) => {
  const facade = await createServer({
    ...config,
    ...((config.openapi ?? config.graphql) === undefined ? {} : { package: { source: config.storage === 'file' ? packagePath : packageSource } }),
    server: { logger: false, ...config.server },
  });
  const app = facade.fastify();
  t.after(() => app.close());
  await app.ready();
  return { app, facade };
};

test('listen preserves configured host when overriding only the port in promise and callback forms', async (t) => {
  for (const callback of [false, true]) {
    const { app } = await setup(t, { storage: 'memory', database: { source: { items: [] } }, server: { host: '127.0.0.2', port: 4001 } });
    const address = callback ? await new Promise((resolve, reject) => app.listen({ port: 0 }, (error, result) => (error ? reject(error) : resolve(result)))) : await app.listen({ port: 0 });
    assert.match(address, /^http:\/\/127\.0\.0\.2:/);
  }
});
