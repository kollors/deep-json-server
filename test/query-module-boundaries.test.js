import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('query helpers do not load model file readers or validators', () => {
  const url = new URL('../dist/src/core/query/execute.js', import.meta.url).href;
  const script = `
    import { registerHooks } from 'node:module';
    const seen = new Set();
    const hook = registerHooks({ resolve(name, context, next) { seen.add(name); return next(name, context); } });
    await import(${JSON.stringify(url)});
    hook.deregister();
    process.stdout.write(JSON.stringify([...seen]));
  `;
  const dependencies = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  for (const name of ['ajv', 'ajv-formats', 'node:fs/promises', 'fastify', 'graphql', 'mercurius']) assert.equal(dependencies.includes(name), false, name);
});
