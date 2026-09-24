// Run after `npm run build`: node scripts/benchmark-database.js
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from '../dist/index.js';

const schema = {
  models: {
    Item: {
      collection: 'items',
      fields: { id: { type: 'string', primary: true }, name: { type: 'string' }, status: { type: 'number' } },
    },
  },
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor(sorted.length / 2)].toFixed(1));
};

async function sample(operation, count) {
  const durations = [];
  for (let index = 0; index < count + 2; index++) {
    const start = performance.now();
    const response = await operation(index);
    if (response.statusCode !== 200) throw new Error(`Request failed: ${response.body}`);
    if (index >= 2) durations.push(performance.now() - start);
  }
  return median(durations);
}

for (const size of [1000, 10000, 50000]) {
  const rows = Array.from({ length: size }, (_, index) => ({ id: String(index), name: `Item ${index}`, status: index }));
  for (const storage of ['memory', 'file']) {
    const directory = storage === 'file' ? await mkdtemp(join(tmpdir(), 'deep-json-benchmark-')) : undefined;
    const databasePath = directory && join(directory, 'database.json');
    const schemaPath = directory && join(directory, 'schema.json');
    let app;
    try {
      if (databasePath && schemaPath) {
        await writeFile(databasePath, JSON.stringify({ items: rows }));
        await writeFile(schemaPath, JSON.stringify(schema));
      }
      const facade = await createServer({
        storage,
        database: { source: databasePath ?? { items: rows }, schema: schemaPath ?? schema },
        server: { logger: false },
      });
      app = facade.fastify();
      await app.ready();
      const getMs = await sample(() => app.inject('/items'), 7);
      const patchMs = await sample((index) => app.inject({ method: 'PATCH', url: '/items/0', payload: { status: size + index } }), 5);
      const bytes = databasePath ? (await stat(databasePath)).size : Buffer.byteLength(JSON.stringify({ items: rows }));
      process.stdout.write(`${JSON.stringify({ records: size, storage, bytes, getMs, patchMs })}\n`);
    } finally {
      await app?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
