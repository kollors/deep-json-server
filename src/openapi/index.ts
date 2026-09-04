import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import { DEFAULT_HOST, DEFAULT_PORT } from '../constants.js';
import type { DatabaseData, JsonObject, OpenapiDocument } from '../types.js';
import { buildOpenapiDocument } from './document.js';

const getServerUrl = (host: string, port: number): string => {
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

export const createOpenapi = ({
  database,
  files,
  host = DEFAULT_HOST,
  maxPageSize,
  port = DEFAULT_PORT,
  schema,
}: {
  database: DatabaseData;
  files: boolean;
  host?: string;
  maxPageSize: number;
  port?: number;
  schema: JsonObject;
}): OpenapiDocument => {
  const document = buildOpenapiDocument({ database, files, maxPageSize, schema });

  document.servers = [{ url: getServerUrl(host, port) }];

  return document;
};

export const writeOpenapi = async (document: OpenapiDocument, outputPath: string): Promise<void> => {
  const resolvedOutputPath = resolve(outputPath);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 }), 'utf8');
};
