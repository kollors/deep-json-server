import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pluralize from 'pluralize';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Проверяет собственные ключи объекта; при неизвестном ключе выбрасывает исключение.
 * @example assertKnownKeys({ x: 1 }, new Set(['x']), 'data') → undefined; { y: 1 } → ошибка.
 */
export const assertKnownKeys = (value: object, keys: Set<string>, path: string): void => {
  const unknownKey = Object.keys(value).find((key) => !keys.has(key));

  if (unknownKey != null) {
    throw new Error(`Неизвестный ключ ${path}.${unknownKey}`);
  }
};

/** Создаёт очередь асинхронных действий. Следующее действие запускается после завершения предыдущего, даже если оно завершилось ошибкой.
 * @example const run = createSerialQueue(); await run(() => 2) → 2.
 */
export const createSerialQueue = () => {
  let queue: Promise<unknown> = Promise.resolve();

  return <T>(operation: () => Promise<T> | T): Promise<T> => {
    const pendingOperation = queue.then(operation);

    // После ошибки разрешаем запуск следующей операции.
    queue = pendingOperation.catch(() => undefined);

    return pendingOperation;
  };
};

/** Генерирует случайную строку и повторяет генерацию, пока проверка считает её занятой.
 * @example createUniqueId(() => false) → строка из 11 символов; значение меняется при каждом вызове.
 */
export const createUniqueId = (isUsed: (id: string) => boolean): string => {
  let id: string;

  do {
    id = randomBytes(8).toString('base64url');
  } while (isUsed(id));

  return id;
};

/** Проверяет, что значение является ненулевым объектом, кроме массива. Экземпляры классов тоже подходят.
 * @example isObject({ x: 1 }) → true; isObject(null) → false; isObject([]) → false.
 */
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Исключает имена свойств, через которые можно изменить прототип объекта.
 * @example isSafeKey('name') → true; isSafeKey('__proto__') → false.
 */
export const isSafeKey = (key: string): boolean => !UNSAFE_KEYS.has(key);
/** Распознаёт экземпляр Error с полем code; наличие поля не гарантирует конкретный код.
 * @example isSystemError(Object.assign(new Error(), { code: 'ENOENT' })) → true.
 */
export const isSystemError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && 'code' in error;

/** Рекурсивно сравнивает JSON-значения; порядок ключей объекта не важен, порядок элементов массива важен.
 * @example isEqual({ a: [1] }, { a: [1] }) → true; isEqual([1, 2], [2, 1]) → false.
 */
export const isEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => isEqual(value, right[index]));
  }

  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    return leftKeys.length === rightKeys.length && leftKeys.every((key) => isSafeKey(key) && Object.hasOwn(right, key) && isEqual(left[key], right[key]));
  }

  return false;
};

/** Проверяет непустой путь и делает его абсолютным относительно рабочего каталога.
 * @example При рабочем каталоге /tmp: resolveDatabasePath('data.json') → '/tmp/data.json'.
 */
export const resolveDatabasePath = (databasePath: string): string => {
  if (typeof databasePath !== 'string' || databasePath === '') {
    throw new Error('Укажите путь к JSON-базе данных');
  }

  return resolve(databasePath);
};

/** Возвращает единственное число английского существительного.
 * @example singularize('people') → 'person'; singularize('movies') → 'movie'.
 */
export const singularize = (value: string): string => pluralize.singular(value);

/** Разбивает строку по символам вне латинских букв и цифр и объединяет части с заглавной буквы.
 * @example toPascalCase('user-profile') → 'UserProfile'; toPascalCase('') → ''.
 */
export const toPascalCase = (value: string): string =>
  value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(capitalize)
    .join('');

/** Проверяет, что все собственные перечислимые ключи входят в разрешённый список.
 * @example hasOnlyKeys({ name: 'Анна' }, ['name']) → true; hasOnlyKeys({ age: 2 }, ['name']) → false.
 */
export const hasOnlyKeys = (value: object, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

/** Возвращает сообщение исключения или строковое представление другого значения.
 * @example errorMessage(new Error('Нет файла')) → 'Нет файла'; errorMessage(404) → '404'.
 */
export const errorMessage = (value: unknown): string => (value instanceof Error ? value.message : String(value));

/** Переводит первый символ в верхний регистр, сохраняя остальные символы.
 * @example capitalize('helloWorld') → 'HelloWorld'; capitalize('') → ''.
 */
export const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** Проверяет целый номер порта; ноль допустим для автоматического выбора.
 * @example isPortNumber(4001) → true; isPortNumber(65536) → false; isPortNumber('80') → false.
 */
export const isPortNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535;
