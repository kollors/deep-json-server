import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function writeGraphql(sdl: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${sdl}\n`, 'utf8');
}
