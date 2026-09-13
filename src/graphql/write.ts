import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Сохраняет текст схемы в UTF-8 с завершающим переводом строки, создавая каталоги.
 * @example writeGraphql('type Query { ok: Boolean }', 'out/schema.graphql') → Promise<void>; файл заканчивается переводом строки.
 */
export async function writeGraphql(sdl: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${sdl}\n`, 'utf8');
}
