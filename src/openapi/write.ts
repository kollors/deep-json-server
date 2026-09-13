import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { OpenapiDocument } from './types.js';

/** Сохраняет документ в YAML, создавая родительские каталоги.
 * @example writeOpenapi(document, './out/api.yaml') → Promise<void>; результат записан в файл.
 */
export const writeOpenapi = async (document: OpenapiDocument, outputPath: string): Promise<void> => {
  const resolvedOutputPath = resolve(outputPath);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 }), 'utf8');
};
