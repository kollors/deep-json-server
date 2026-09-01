import process from 'node:process';
import { readServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_PORT } from './constants.js';
import { generateOpenApi } from './openapi/index.js';
import { startServer } from './server.js';

const HELP_TEXT = `Deep JSON Server

Использование:
  deep-json-server [--openapi] [--files] <server.config.js>

Параметры:
  --openapi  Сгенерировать OpenAPI и завершить работу
  --files    Добавить файловые маршруты в сервер или OpenAPI
  --help     Показать справку`;

const parseArguments = (args) => {
  const flags = { files: false, openapi: false };
  let configPath;

  args.forEach((argument) => {
    if (argument === '--files') {
      flags.files = true;
    } else if (argument === '--openapi') {
      flags.openapi = true;
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

  return { configPath, ...flags };
};

const validateModeConfig = (config, { files, openapi }) => {
  if (openapi && config.openapiPath == null) {
    throw new Error('Для --openapi укажите ключ config.openapi.path');
  }

  if (files && config.filesDirectoryPath == null) {
    throw new Error('Для --files укажите ключ config.files.directory');
  }

  if (files && config.filesMetadataPath == null) {
    throw new Error('Для --files укажите ключ config.files.metadata');
  }
};

export async function runCli(args = process.argv.slice(2), services = { generateOpenApi, startServer }) {
  if (args.includes('--help')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const { configPath, files, openapi } = parseArguments(args);
  const config = await readServerConfig(configPath);
  const host = config.host ?? process.env.HOST ?? DEFAULT_HOST;
  const port = config.port ?? Number(process.env.PORT ?? DEFAULT_PORT);

  validateModeConfig(config, { files, openapi });

  if (openapi) {
    await services.generateOpenApi({
      databasePath: config.databasePath,
      files,
      host,
      outputPath: config.openapiPath,
      port,
      schemaPath: config.schemaPath,
    });
    process.stdout.write(`OpenAPI-схема сохранена в ${config.openapiPath}\n`);
    return;
  }

  await services.startServer({
    databasePath: config.databasePath,
    filesDirectoryPath: files ? config.filesDirectoryPath : undefined,
    filesMetadataPath: files ? config.filesMetadataPath : undefined,
    host,
    port,
    schemaPath: config.schemaPath,
  });
}
