import process from 'node:process';
import { DEFAULT_HOST, DEFAULT_PORT } from './constants.js';
import { generateOpenApi } from './openapi/index.js';
import { startServer } from './server.js';

const HELP_TEXT = `Deep JSON Server

Использование:
  deep-json-server <database.json> [--schema <database-schema.json>] [--host <host>] [--port <port>]
  deep-json-server <database.json> --generate <database-schema.json> <openapi-schema.yaml> [--host <host>] [--port <port>]

Параметры:
  --generate  Сгенерировать OpenAPI и завершить работу
  --host, -h  Адрес сервера (по умолчанию 127.0.0.1)
  --port, -p  Порт сервера (по умолчанию 4001)
  --schema    Проверять запросы записи по указанной схеме
  --help      Показать справку`;

const parseOptions = (args, allowedOptions) => {
  const options = {};

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];

    if (!allowedOptions.includes(option)) {
      throw new Error(`Неизвестный параметр: ${option}`);
    }

    if (value == null || value.startsWith('-')) {
      throw new Error(`Не указано значение параметра ${option}`);
    }

    const optionName = ['--host', '-h'].includes(option) ? 'host' : ['--port', '-p'].includes(option) ? 'port' : 'schemaPath';

    options[optionName] = value;
  }

  return options;
};

export async function runCli(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const [databasePath] = args;

  if (databasePath == null || databasePath.startsWith('-')) {
    throw new Error('Укажите путь к JSON-базе данных');
  }

  const generateIndex = args.indexOf('--generate');

  if (generateIndex !== -1) {
    const schemaPath = args[generateIndex + 1];
    const outputPath = args[generateIndex + 2];

    if (generateIndex !== 1 || schemaPath == null || outputPath == null) {
      throw new Error('Используйте: deep-json-server <database.json> --generate <database-schema.json> <openapi-schema.yaml> [--host <host>] [--port <port>]');
    }

    const options = parseOptions(args.slice(4), ['--host', '-h', '--port', '-p']);
    const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
    const port = Number(options.port ?? process.env.PORT ?? DEFAULT_PORT);

    await generateOpenApi({ databasePath, host, outputPath, port, schemaPath });
    process.stdout.write(`OpenAPI-схема сохранена в ${outputPath}\n`);
    return;
  }

  const options = parseOptions(args.slice(1), ['--host', '-h', '--port', '-p', '--schema']);
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
  const port = Number(options.port ?? process.env.PORT ?? DEFAULT_PORT);

  await startServer({ databasePath, host, port, schemaPath: options.schemaPath });
}
