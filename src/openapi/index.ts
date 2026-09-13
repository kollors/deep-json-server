import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import { DEFAULT_HOST, DEFAULT_PORT } from '../core/constants.js';
import { isPortNumber } from '../core/utils.js';
import type { OpenapiDocument } from './types.js';

/** Строит HTTP-адрес, оборачивая IPv6 в квадратные скобки; нулевой порт даёт относительный адрес.
 * @example getServerUrl('::1', 80) → 'http://[::1]:80'; getServerUrl('localhost', 0) → '/'.
 */
const getServerUrl = (host: string, port: number): string => {
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error('Адрес сервера не должен быть пустым');
  }

  if (!isPortNumber(port)) {
    throw new Error('Порт должен быть целым числом от 0 до 65535');
  }

  if (port === 0) return '/';
  const serverHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${serverHost}:${port}`;
};

/** Копирует документ и задаёт адрес сервера, не меняя исходный объект.
 * @example При host = 'localhost', port = 80 поле servers → [{ url: 'http://localhost:80' }].
 */
export const createOpenapi = ({ document: sourceDocument, host = DEFAULT_HOST, port = DEFAULT_PORT }: { document: OpenapiDocument; host?: string; port?: number }): OpenapiDocument => {
  const document = structuredClone(sourceDocument);

  document.servers = [{ url: getServerUrl(host, port) }];

  return document;
};

/** Сохраняет документ в YAML, создавая родительские каталоги.
 * @example writeOpenapi(document, './out/api.yaml') → Promise<void>; результат записан в файл.
 */
export const writeOpenapi = async (document: OpenapiDocument, outputPath: string): Promise<void> => {
  const resolvedOutputPath = resolve(outputPath);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 }), 'utf8');
};
