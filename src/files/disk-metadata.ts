import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isSystemError } from '../core/utils.js';
import { getFileKey, normalizeStoredFileMetadata, type StoredFileMetadata } from './contract.js';

/** Читает массив метаданных и индексирует его по относительному пути файла.
 * @example Отсутствующий файл → пустой Map; две одинаковые записи → ошибка.
 */
export async function readDiskMetadata(metadataPath: string): Promise<Map<string, StoredFileMetadata>> {
  let source: unknown;
  try {
    source = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') return new Map();
    throw error;
  }
  if (!Array.isArray(source)) throw new Error(`Файл метаданных ${metadataPath} должен содержать JSON-массив`);
  const files = new Map<string, StoredFileMetadata>();
  source.forEach((value, index) => {
    const file = normalizeStoredFileMetadata(value, `Запись ${index} в файле метаданных ${metadataPath}`);
    const path = getFileKey(file);
    if (files.has(path)) throw new Error(`Файл метаданных ${metadataPath} содержит повторяющийся путь «${path}»`);
    files.set(path, file);
  });
  return files;
}

/** Атомарно заменяет файл метаданных через соседний временный файл.
 * @example Map с одной записью → JSON-массив в metadataPath.
 */
export async function writeDiskMetadata(metadataPath: string, files: Map<string, StoredFileMetadata>): Promise<void> {
  const temporaryPath = `${metadataPath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify([...files.values()], null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, metadataPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
