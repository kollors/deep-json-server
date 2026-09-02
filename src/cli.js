import process from 'node:process';
import { readServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_PORT } from './constants.js';
import { createServer } from './server.js';

const HELP_TEXT = `Deep JSON Server

Использование:
  deep-json-server [--files] [--openapi | --openapi-only] <server.config.js>

Параметры:
  --files         Добавить файловые маршруты в сервер и OpenAPI
  --openapi       Сгенерировать OpenAPI и запустить сервер
  --openapi-only  Сгенерировать OpenAPI и завершить работу
  --help          Показать справку`;

const parseArguments = (args) => {
  const options = { files: false, openapiMode: 'none' };
  let configPath;

  args.forEach((argument) => {
    if (argument === '--files') {
      options.files = true;
    } else if (argument === '--openapi') {
      if (options.openapiMode !== 'none') {
        throw new Error('Параметры --openapi и --openapi-only нельзя использовать одновременно');
      }

      options.openapiMode = 'generate';
    } else if (argument === '--openapi-only') {
      if (options.openapiMode !== 'none') {
        throw new Error('Параметры --openapi и --openapi-only нельзя использовать одновременно');
      }

      options.openapiMode = 'only';
    } else if (argument.startsWith('-')) {
      throw new Error(`Неизвестный параметр: ${argument}`);
    } else if (configPath == null) {
      configPath = argument;
    } else {
      throw new Error('Можно указать только один файл конфигурации');
    }
  });

  if (configPath == null) {
    throw new Error('Укажите путь к файлу конфигурации');
  }

  return { configPath, ...options };
};

const validateModeConfig = (config, { files, openapiMode }) => {
  if (openapiMode !== 'none' && config.openapi.path == null) {
    throw new Error(`Для --openapi${openapiMode === 'only' ? '-only' : ''} укажите ключ config.openapi.path`);
  }

  if (files && config.files == null) {
    throw new Error('Для --files укажите секцию config.files');
  }
};

export async function runCli(args = process.argv.slice(2), services = { createServer }) {
  if (args.includes('--help')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const { configPath, files, openapiMode } = parseArguments(args);
  const config = await readServerConfig(configPath);
  const host = config.server.host ?? process.env.HOST ?? DEFAULT_HOST;
  const port = config.server.port ?? Number(process.env.PORT ?? DEFAULT_PORT);

  validateModeConfig(config, { files, openapiMode });

  const runtimeConfig = { ...config, server: { ...config.server, host, port } };
  const server = await services.createServer(runtimeConfig, { files });

  if (openapiMode !== 'none') {
    await server.openapi();
    process.stdout.write(`OpenAPI-схема сохранена в ${config.openapi.path}\n`);
  }

  if (openapiMode === 'only') {
    return;
  }

  const fastify = server.fastify();

  await fastify.listen({ host, port });
  fastify.log.info({ database: 'path' in config.database ? config.database.path : 'memory' }, 'Deep JSON Server запущен');
}
