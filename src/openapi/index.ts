import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import { DEFAULT_HOST, DEFAULT_PORT } from '../constants.js';
import type { OpenapiDocument } from '../types.js';

const getServerUrl = (host: string, port: number): string => {
  const serverPort = port;

  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error('Адрес сервера не должен быть пустым');
  }

  if (!Number.isInteger(serverPort) || serverPort < 0 || serverPort > 65_535) {
    throw new Error('Порт должен быть целым числом от 0 до 65535');
  }

  if (serverPort === 0) return '/';
  const serverHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${serverHost}:${serverPort}`;
};

export const createOpenapi = ({ document: sourceDocument, host = DEFAULT_HOST, port = DEFAULT_PORT }: { document: OpenapiDocument; host?: string; port?: number }): OpenapiDocument => {
  const document = structuredClone(sourceDocument);

  document.servers = [{ url: getServerUrl(host, port) }];

  return document;
};

export const writeOpenapi = async (document: OpenapiDocument, outputPath: string): Promise<void> => {
  const resolvedOutputPath = resolve(outputPath);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 }), 'utf8');
};
