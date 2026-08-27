import process from 'node:process';
import { generateOpenApi } from './openapi.js';
import { startServer } from './server.js';

const HELP = `Deep JSON Server

Использование:
  deep-json-server <database.json> [--host <host>] [--port <port>]
  deep-json-server <database.json> --generate <database-schema.json> <openapi-schema.yaml>

Параметры:
  --generate  Сгенерировать OpenAPI и завершить работу
  --host, -h  Адрес сервера (по умолчанию 127.0.0.1)
  --port, -p  Порт сервера (по умолчанию 4001)
  --help      Показать справку`;

const parseServerOptions = (args) => {
  const options = {};

  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];

    if (!['--host', '-h', '--port', '-p'].includes(option)) {
      throw new Error(`Неизвестный параметр: ${option}`);
    }

    if (value == null || value.startsWith('-')) {
      throw new Error(`Не указано значение параметра ${option}`);
    }

    options[['--host', '-h'].includes(option) ? 'host' : 'port'] = value;
  }

  return options;
};

export async function runCli(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    process.stdout.write(`${HELP}\n`);
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

    if (generateIndex !== 1 || schemaPath == null || outputPath == null || args.length !== 4) {
      throw new Error('Используйте: deep-json-server <database.json> --generate <database-schema.json> <openapi-schema.yaml>');
    }

    await generateOpenApi({ databasePath, outputPath, schemaPath });
    process.stdout.write(`OpenAPI-схема сохранена в ${outputPath}\n`);
    return;
  }

  const options = parseServerOptions(args);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 4001);

  await startServer({ databasePath, host, port });
}
