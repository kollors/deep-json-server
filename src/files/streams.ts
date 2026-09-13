import { Transform, type TransformCallback } from 'node:stream';
import { domainError } from '../core/errors.js';

/** Создаёт преобразующий поток, который считает байты и отклоняет превышение лимита.
 * @example Лимит 3 и поток 'abcd' → ошибка; поток 'abc' проходит без изменения.
 */
export const createSizeLimiter = (maxFileSize: number, onSize: (size: number) => void): Transform => {
  let size = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      size += chunk.length;

      if (size > maxFileSize) {
        callback(domainError('PAYLOAD_TOO_LARGE', `Размер файла не должен превышать ${maxFileSize} байт`));
        return;
      }

      onSize(size);
      callback(null, chunk);
    },
  });
};
