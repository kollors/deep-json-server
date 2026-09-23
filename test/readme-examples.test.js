import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { loadModel } from '../dist/src/core/model.js';
import { normalizeServerConfig } from '../dist/src/server/config.js';

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
