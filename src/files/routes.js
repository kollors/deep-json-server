import { createHttpError } from '../utils.js';
import { createFileMetadata, FILE_UPDATE_SCHEMA, getDownloadName, getFileKey, getPathLocation, normalizeMimeType, PATCH_BODY_LIMIT, validateDirectory, validateName } from './contract.js';

const decodeHeader = (value, name) => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `Заголовок ${name} обязателен`);
  }

  try {
    return decodeURIComponent(value);
  } catch {
    throw createHttpError(400, `Заголовок ${name} содержит некорректное значение`);
  }
};

const getContentName = (value) => validateName(decodeHeader(value, 'Content-Name'), 'Заголовок Content-Name');
const getContentDirectory = (value) => (value == null ? '' : validateDirectory(decodeHeader(value, 'Content-Directory'), 'Заголовок Content-Directory'));

const getContentOverride = (value) => {
  if (value == null || value === 'false') {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  throw createHttpError(400, 'Заголовок Content-Override должен содержать true или false');
};

const getRequestPath = (request) => getFileKey(getPathLocation(request.params['*']));

const normalizeUpdate = (body) => ({
  ...(body.directory != null && { directory: validateDirectory(body.directory, 'Ключ body.directory') }),
  ...(body.name != null && { name: validateName(body.name, 'Ключ body.name') }),
});

const sendFile = async (store, path, reply, disposition) => {
  const { file, stream } = await store.get(path);

  reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${getDownloadName(file.name)}`);
  reply.type(file.mimeType);

  return reply.send(stream);
};

export const registerFileRoutes = (fastify, { getStore, maxFileSize }) => {
  fastify.register(async (fileServer) => {
    const store = await getStore();

    fileServer.register((uploadServer, _options, done) => {
      uploadServer.removeAllContentTypeParsers();
      uploadServer.addContentTypeParser('*', (_request, payload, parserDone) => parserDone(null, payload));

      uploadServer.post('/_files/storage', async (request, reply) => {
        const contentLength = Number(request.headers['content-length']);

        if (Number.isFinite(contentLength) && contentLength > maxFileSize) {
          throw createHttpError(413, `Размер файла не должен превышать ${maxFileSize} байт`);
        }

        const result = await store.upload({
          directory: getContentDirectory(request.headers['content-directory']),
          maxFileSize,
          mimeType: normalizeMimeType(request.headers['content-type']),
          name: getContentName(request.headers['content-name']),
          override: getContentOverride(request.headers['content-override']),
          stream: request.body,
        });

        return reply.code(result.created ? 201 : 200).send(createFileMetadata(result.file));
      });

      done();
    });

    fileServer.get('/_files/storage/*', async (request, reply) => sendFile(store, getRequestPath(request), reply, 'inline'));
    fileServer.get('/_files/download/*', async (request, reply) => sendFile(store, getRequestPath(request), reply, 'attachment'));

    fileServer.get('/_files/metadata/*', async (request) => createFileMetadata(await store.metadata(getRequestPath(request))));

    fileServer.patch(
      '/_files/storage/*',
      {
        bodyLimit: PATCH_BODY_LIMIT,
        preValidation: async (request) => {
          if (normalizeMimeType(request.headers['content-type']) !== 'application/json') {
            throw createHttpError(415, 'Для изменения файла используйте Content-Type: application/json');
          }
        },
        schema: { body: FILE_UPDATE_SCHEMA },
      },
      async (request) => createFileMetadata(await store.update(getRequestPath(request), normalizeUpdate(request.body))),
    );

    fileServer.delete('/_files/storage/*', async (request, reply) => {
      await store.remove(getRequestPath(request));

      return reply.code(204).send();
    });
  });
};
