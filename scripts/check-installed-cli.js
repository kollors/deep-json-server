import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function start(cli, config, cwd) {
  const child = spawn(process.execPath, [cli, config], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  };
  let output = '';
  let timeout;
  try {
    const address = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Installed CLI startup timed out: ${output}`)), 30000);
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Installed CLI exited during startup (${code ?? signal}): ${output}`)));
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) resolve(match[1]);
      });
    });
    return { address, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Exercise the installed executable, real HTTP, config-relative paths and crash recovery.
export async function checkInstalledCli(cli, directory) {
  const fixture = join(directory, 'CLI пробел #');
  await mkdir(fixture);
  const config = join(fixture, 'server.config.mjs');
  const database = join(fixture, 'каталог.json');
  await writeFile(database, '{"items":[]}');
  await writeFile(
    join(fixture, 'schema.json'),
    JSON.stringify({ models: { Item: { collection: 'items', fields: { id: { type: 'string', primary: true, generated: 'uuid' }, name: { type: 'string', required: true } } } } }),
  );
  await writeFile(config, `export default ${JSON.stringify({ storage: 'file', database: { source: 'каталог.json', schema: 'schema.json' }, graphql: {}, server: { host: '127.0.0.1', port: 0 } })};`);
  let running = await start(cli, config, directory);
  let id;
  try {
    const created = await fetch(`${running.address}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'installed CLI' }) });
    assert.equal(created.status, 201, await created.clone().text());
    id = (await created.json()).id;
    assert.equal(typeof id, 'string');
    const queried = await fetch(`${running.address}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ itemList { total data { name } } }' }),
    });
    assert.deepEqual((await queried.json()).data.itemList, { total: 1, data: [{ name: 'installed CLI' }] });
    assert.equal(JSON.parse(await readFile(join(fixture, 'каталог-lock.json'), 'utf8')).pid > 0, true);
  } finally {
    await running.stop();
  }
  running = await start(cli, config, directory);
  try {
    const restored = await fetch(`${running.address}/items/${id}`);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).name, 'installed CLI');
    const updated = await fetch(`${running.address}/items/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'after restart' }) });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal(JSON.parse(await readFile(database, 'utf8')).items[0].name, 'after restart');
    const deleted = await fetch(`${running.address}/items/${id}`, { method: 'DELETE' });
    assert.ok(deleted.ok, await deleted.text());
    assert.deepEqual(JSON.parse(await readFile(database, 'utf8')).items, []);
  } finally {
    await running.stop();
  }
}
