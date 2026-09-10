import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { publicationTag } from './publish-package.js';

export function releasePlan(version, refType, refName, existingTag = false) {
  const tag = `v${version}`;
  const channel = publicationTag(version);
  if (refType === 'tag') {
    if (refName !== tag) throw new Error('Release tag does not match package version');
    return { publish: true, createTag: false, tag };
  }
  const publish = refName === 'main' && channel === 'alpha' && !existingTag;
  return { publish, createTag: publish, tag };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tag = `v${version}`;
  const existing = process.env.GITHUB_REF_TYPE === 'tag' ? false : execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' }).trim() !== '';
  const plan = releasePlan(version, process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME, existing);
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\ncreate_tag=${plan.createTag}\ntag=${plan.tag}\n`);
}
