import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { canonicalEntryPath, canonicalPath, validateExportPaths } from '../core/paths.js';
import { isObject, isSystemError } from '../core/utils.js';

/** Имя одного файла блокировки рядом с источником: /data/catalog.json → /data/catalog-lock.json. */
export const databaseLockPath = (path: string): string => join(dirname(path), `${basename(path, extname(path))}-lock.json`);

const LOCK_TYPE = 'deep-json-server-lock';
const LOCK_PREFIX = `{"type":"${LOCK_TYPE}",`;
const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;
const missing = (error: unknown): boolean => isSystemError(error) && error.code === 'ENOENT';

/** Разрешает старые метаданные и незавершённую запись, но не перезаписывает посторонний JSON. */
function isLockContent(content: string): boolean {
  if (!content) return true;
  try {
    const value: unknown = JSON.parse(content);
    return isObject(value) && value.type === LOCK_TYPE;
  } catch {
    return LOCK_PREFIX.startsWith(content) || content.startsWith(LOCK_PREFIX);
  }
}

/** Удерживает системную блокировку дескриптора; после аварии ОС освобождает её автоматически. */
async function acquireLock(path: string, source: string): Promise<() => Promise<void>> {
  // Нативный модуль нужен только дисковым серверам, а не генераторам схем или memory storage.
  const { tryLock } = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number, offset?: number, length?: number): boolean };
  const busy = () => new Error(`Storage is already in use by another server: ${source}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = await open(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    let retained = false;
    try {
      const identity = await handle.stat();
      if (!identity.isFile() || identity.nlink > 1) throw new Error(`Storage lock must be a regular file without hard links: ${path}`);
      // LockFileEx запрещает чтение заблокированных байтов другим дескриптором: на Windows
      // блокируем байт за метаданными, чтобы JSON владельца оставался доступен для чтения.
      if (!(process.platform === 'win32' ? tryLock(handle.fd, 4096, 1) : tryLock(handle.fd))) throw busy();
      // Предыдущий владелец мог удалить файл после нашего open(), но до tryLock().
      // Старый inode не защищает новый путь: в таком случае открываем файл заново.
      const current = await lstat(path).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      });
      if (!current || !sameFile(identity, current)) continue;
      if (current.size > 4096 || !isLockContent(await handle.readFile('utf8'))) throw new Error(`Storage lock path contains an unrelated file: ${path}`);
      const content = Buffer.from(`${JSON.stringify({ type: LOCK_TYPE, pid: process.pid, token: randomUUID() })}\n`);
      await handle.truncate(0);
      for (let offset = 0; offset < content.length; ) {
        const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
        if (!bytesWritten) throw new Error(`Cannot write storage lock: ${path}`);
        offset += bytesWritten;
      }
      let closing: Promise<void> | undefined;
      retained = true;
      return () =>
        (closing ??= (async () => {
          try {
            const current = await lstat(path).catch((error: unknown) => {
              if (missing(error)) return undefined;
              throw error;
            });
            if (current) {
              if (!sameFile(identity, current)) throw new Error(`Storage lock was changed: ${path}`);
              // Не снимаем блокировку до unlink; конкуренты проверяют inode после захвата.
              await unlink(path);
            }
          } finally {
            await handle.close();
          }
        })());
    } finally {
      if (!retained) await handle.close();
    }
  }
  throw busy();
}

/** Блокирует все записываемые источники и освобождает уже полученные блокировки при ошибке. */
export async function acquireStorageLocks(sources: string[], inputs: string[] = sources): Promise<{ paths: string[]; release: () => Promise<void> }> {
  const entries = await Promise.all(sources.map(async (source) => [await canonicalEntryPath(source), await canonicalPath(source)]));
  const owners = new Map<string, string>();
  for (const entry of entries) for (const source of entry) owners.set(databaseLockPath(source), source);
  const paths = [...owners.keys()].sort();
  await validateExportPaths(paths, [...sources, ...inputs]);
  const releases: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const release = () =>
    (closing ??= (async () => {
      const results = await Promise.allSettled(releases.reverse().map((close) => close()));
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Cannot release storage locks');
    })());
  try {
    for (const path of paths) releases.push(await acquireLock(path, owners.get(path) as string));
  } catch (error) {
    await release();
    throw error;
  }
  return { paths, release };
}

/** Блокирует дисковую базу, включая путь ссылки, который заменяется атомарной записью. */
export async function acquireDatabaseLock(databasePath: string): Promise<() => Promise<void>> {
  return (await acquireStorageLocks([databasePath])).release;
}
