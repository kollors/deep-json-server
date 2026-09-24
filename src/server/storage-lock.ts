import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { canonicalPath } from '../core/paths.js';
import { isSystemError } from '../core/utils.js';

const INCOMPLETE_LOCK_GRACE_MS = 2000;
export const databaseLockPath = (path: string): string => `${path}.deep-json-server.lock`;

interface LockOwner {
  pid: number;
  token: string;
}

const missing = (error: unknown): boolean => isSystemError(error) && error.code === 'ENOENT';

async function ownerOf(path: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value === 'object' && value !== null && 'pid' in value && 'token' in value && Number.isSafeInteger(value.pid) && typeof value.token === 'string') return value as LockOwner;
  } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

function processExists(pid: number): boolean {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ESRCH') return false;
    if (isSystemError(error) && error.code === 'EPERM') return true;
    throw error;
  }
}

async function removeOwnedLock(directory: string, token: string): Promise<void> {
  const ownerPath = `${directory}/owner.json`;
  const owner = await ownerOf(ownerPath);
  if (!owner) {
    try {
      await stat(directory);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
  }
  if (owner?.token !== token) throw new Error(`Database lock was changed: ${directory}`);
  await unlink(ownerPath);
  await rmdir(directory);
}

/** Удерживает блокировку дисковой базы до закрытия сервера и восстанавливает её после остановки процесса. */
export async function acquireDatabaseLock(databasePath: string): Promise<() => Promise<void>> {
  const path = await canonicalPath(databasePath);
  const directory = databaseLockPath(path);
  const recovery = `${directory}.recovery`;
  const ownerPath = `${directory}/owner.json`;
  const busy = () => new Error(`Database is already in use by another server: ${path}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(directory);
      const token = randomUUID();
      try {
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
        try {
          await stat(recovery);
          await removeOwnedLock(directory, token);
          continue;
        } catch (error) {
          if (!missing(error)) throw error;
        }
        return () => removeOwnedLock(directory, token);
      } catch (error) {
        if ((await ownerOf(ownerPath))?.token === token) await removeOwnedLock(directory, token);
        else await rmdir(directory).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isSystemError(error) || error.code !== 'EEXIST') throw error;
    }

    const owner = await ownerOf(ownerPath);
    if (owner && processExists(owner.pid)) throw busy();
    if (!owner && Date.now() - (await stat(directory)).mtimeMs < INCOMPLETE_LOCK_GRACE_MS) throw busy();
    try {
      await mkdir(recovery);
    } catch (error) {
      if (isSystemError(error) && error.code === 'EEXIST') throw busy();
      throw error;
    }
    try {
      const current = await ownerOf(ownerPath);
      if (current && processExists(current.pid)) throw busy();
      if (current) await unlink(ownerPath);
      await rmdir(directory);
    } finally {
      await rmdir(recovery);
    }
  }
  throw busy();
}
