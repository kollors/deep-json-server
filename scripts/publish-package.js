import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function publicationTag(version) {
  const match = /^\d+\.\d+\.\d+(?:-(alpha|beta|rc)\.\d+)?$/.exec(version);
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  return match[1] ?? 'latest';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Release tag does not match package version');
  const result = spawnSync('npm', ['publish', '--tag', publicationTag(version), '--provenance'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
