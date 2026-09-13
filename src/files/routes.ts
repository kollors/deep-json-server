import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHttpError } from '../core/http-errors.js';
import { type FileStore, type FileUpdate, getFileKey, getPathLocation, normalizeMimeType, validateDirectory, validateName } from './contract.js';
import { createFileMetadata, FILE_HEADERS, FILE_ROUTES, FILE_UPDATE_SCHEMA, getDownloadName, PATCH_BODY_LIMIT } from './http.js';

interface FilePathParams {
  '*': string;
}

/** Декодирует строку из URL-кодировки; отсутствие или повреждённая кодировка дают ошибку 400.
 * @example decodeHeader('a%20b', 'Name') → 'a b'; decodeHeader('%', 'Name') → ошибка.
 */
const decodeHeader = (value: unknown, name: string): string => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `Заголовок ${name} обязателен`);
  }

  try {
    return decodeURIComponent(value);
  } catch {
    throw createHttpError(400, `Заголовок ${name} содержит некорректное значение`);
  }
};

/** Декодирует и проверяет имя файла из заголовка.
 * @example getContentName('a%20b.txt') → 'a b.txt'.
 */
const getContentName = (value: unknown): string => validateName(decodeHeader(value, FILE_HEADERS.name.name), `Заголовок ${FILE_HEADERS.name.name}`);
/** Декодирует относительный каталог; отсутствующее значение заменяет пустой строкой.
 * @example getContentDirectory(undefined) → ''; getContentDirectory('my%20photos') → 'my photos'.
 */
const getContentDirectory = (value: unknown): string => (value == null ? '' : validateDirectory(decodeHeader(value, FILE_HEADERS.directory.name), `Заголовок ${FILE_HEADERS.directory.name}`));

/** Читает строковый логический флаг перезаписи; отсутствие означает false.
 * @example getContentOverride('true') → true; getContentOverride(undefined) → false; 'yes' → ошибка.
 */
const getContentOverride = (value: unknown): boolean => {
  if (value == null || value === 'false') {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  throw createHttpError(400, `Заголовок ${FILE_HEADERS.override.name} должен содержать true или false`);
};

/** Извлекает и проверяет путь из параметра маршрута.
 * @example При request.params = { '*': 'photos/a.jpg' } → 'photos/a.jpg'.
 */
const getRequestPath = (request: FastifyRequest): string => getFileKey(getPathLocation((request.params as FilePathParams)['*']));

/** Проверяет переданные имя и каталог и возвращает только заданные значения.
 * @example normalizeUpdate({ name: 'a.txt' }) → { name: 'a.txt' }.
 */
const normalizeUpdate = (body: FileUpdate): FileUpdate => ({
  ...(body.directory != null && { directory: validateDirectory(body.directory, 'Ключ body.directory') }),
  ...(body.name != null && { name: validateName(body.name, 'Ключ body.name') }),
});

/** Читает поток из хранилища и отправляет его с MIME-типом и заголовком скачивания или просмотра.
 * @example При disposition = 'inline' ответ содержит Content-Disposition: inline и байты файла.
 */
const sendFile = async (store: FileStore, path: string, reply: FastifyReply, disposition: 'attachment' | 'inline') => {
  const { file, stream } = await store.get(path);

  reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${getDownloadName(file.name)}`);
  reply.type(file.mimeType);

  return reply.send(stream);
};

/** Регистрирует обработчики загрузки, чтения, перемещения и удаления файлов.
 * @example После регистрации GET по существующему пути → поток файла; функция возвращает undefined.
 */
export const registerFileRoutes = (fastify: FastifyInstance, { getStore, maxFileSize }: { getStore: () => Promise<FileStore>; maxFileSize: number }): void => {
  fastify.register(async (fileServer) => {
    const store = await getStore();

    fileServer.register((uploadServer, _options, done) => {
      uploadServer.removeAllContentTypeParsers();
      uploadServer.addContentTypeParser('*', (_request, payload, parserDone) => parserDone(null, payload));

      uploadServer.post(FILE_ROUTES.storage, async (request, reply) => {
        const contentLength = Number(request.headers['content-length']);

        if (Number.isFinite(contentLength) && contentLength > maxFileSize) {
          throw createHttpError(413, `Размер файла не должен превышать ${maxFileSize} байт`);
        }

        const result = await store.upload({
          directory: getContentDirectory(request.headers[FILE_HEADERS.directory.key]),
          maxFileSize,
          mimeType: normalizeMimeType(request.headers['content-type']),
          name: getContentName(request.headers[FILE_HEADERS.name.key]),
          override: getContentOverride(request.headers[FILE_HEADERS.override.key]),
          stream: request.body as Readable,
        });

        return reply.code(result.created ? 201 : 200).send(createFileMetadata(result.file));
      });

      done();
    });

    fileServer.get(`${FILE_ROUTES.storage}/*`, async (request, reply) => sendFile(store, getRequestPath(request), reply, 'inline'));
    fileServer.get(`${FILE_ROUTES.download}/*`, async (request, reply) => sendFile(store, getRequestPath(request), reply, 'attachment'));

    fileServer.get(`${FILE_ROUTES.metadata}/*`, async (request) => createFileMetadata(await store.metadata(getRequestPath(request))));

    fileServer.patch(
      `${FILE_ROUTES.storage}/*`,
      {
        bodyLimit: PATCH_BODY_LIMIT,
        preValidation: async (request) => {
          if (normalizeMimeType(request.headers['content-type']) !== 'application/json') {
            throw createHttpError(415, 'Для изменения файла используйте Content-Type: application/json');
          }
        },
        schema: { body: FILE_UPDATE_SCHEMA },
      },
      async (request) => createFileMetadata(await store.update(getRequestPath(request), normalizeUpdate(request.body as FileUpdate))),
    );

    fileServer.delete(`${FILE_ROUTES.storage}/*`, async (request, reply) => {
      await store.remove(getRequestPath(request));

      return reply.code(204).send();
    });
  });
};
