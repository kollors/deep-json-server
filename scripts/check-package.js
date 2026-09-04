import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'deep-json-server-package-'));

try {
  const { stdout } = await execute('npm', ['pack', '--json', '--pack-destination', temporaryDirectory], { cwd: new URL('..', import.meta.url) });
  const [packageInfo] = JSON.parse(stdout);
  const paths = packageInfo.files.map(({ path }) => path);
  const archivePath = join(temporaryDirectory, packageInfo.filename);
  assert(paths.includes('dist/index.js'));
  assert(paths.includes('dist/index.d.ts'));
  assert(paths.includes('dist/bin/deep-json-server.js'));
  assert(paths.every((path) => !path.startsWith('src/') && !path.startsWith('types/')));

  await writeFile(join(temporaryDirectory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archivePath], { cwd: temporaryDirectory });
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import { createServer } from '@kollors/deep-json-server'; const server = await createServer({ database: { data: { items: [{ id: '1' }] } } }); await server.fastify().close();",
    ],
    {
      cwd: temporaryDirectory,
    },
  );
  await execute(join(temporaryDirectory, 'node_modules/.bin/deep-json-server'), ['--help'], { cwd: temporaryDirectory });
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
