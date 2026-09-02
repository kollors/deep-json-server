import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import { DEFAULT_HOST, DEFAULT_PORT } from '../constants.js';
import { buildOpenapiDocument } from './document.js';

const getServerUrl = (host, port) => {
  const serverPort = Number(port);

  if (typeof host !== 'string' || host === '') {
    throw new Error('Адрес сервера не должен быть пустым');
  }

  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
    throw new Error('Порт должен быть целым числом от 1 до 65535');
  }

  const serverHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${serverHost}:${serverPort}`;
};

export const createOpenapi = ({ database, files, host = DEFAULT_HOST, maxPageSize, port = DEFAULT_PORT, schema }) => {
  const document = buildOpenapiDocument({ database, files, maxPageSize, schema });

  document.servers = [{ url: getServerUrl(host, port) }];

  return document;
};

export const writeOpenapi = async (document, outputPath) => {
  const resolvedOutputPath = resolve(outputPath);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 }), 'utf8');
};
