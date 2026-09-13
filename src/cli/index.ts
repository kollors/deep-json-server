import process from 'node:process';
import { DEFAULT_HOST, DEFAULT_PORT, VERSION } from '../core/constants.js';
import { inputPaths, validateExportPaths } from '../core/paths.js';
import { isObject } from '../core/utils.js';
import { generateGraphql, writeGraphql } from '../graphql/lazy.js';
import { generateOpenapi, writeOpenapi } from '../openapi/lazy.js';
import { configure, configureGeneration, readConfigModule } from '../server/config.js';
import { createConfiguredServer } from '../server/create.js';
import { resolveFeatures, type ServerFeatures } from '../server/features.js';

const HELP_TEXT = `Deep JSON Server

Usage:
  deep-json-server [options] <server.config.js>
  deep-json-server generate <openapi|graphql|openapi,graphql> <server.config.js>

  --timestamps    Track record creation and update times
  --soft-delete   Mark deleted records instead of removing them
  --files         Enable file routes
  --graphql       Enable the GraphQL endpoint
  --openapi       Enable the OpenAPI endpoint
  --host <host>   Server address
  --port <port>   Server port
  --help, -h      Show help
  --version, -v   Show version

Files are enabled when configured. Generate writes schemas to the configured paths.`;
/** Разбирает аргументы командной строки и запускает сервер либо экспорт; справку и версию пишет в stdout.
 * @example runCli(['--help']) → Promise<void> и текст справки без запуска сервера.
 */
export async function runCli(args = process.argv.slice(2), services: { createServer: typeof createConfiguredServer } = { createServer: createConfiguredServer }): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const positional: string[] = [];
  const seen = new Set<string>();
  const features: ServerFeatures = {};
  const recordFlags: { timestamps?: boolean; softDelete?: boolean } = {};
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!['--files', '--graphql', '--openapi', '--timestamps', '--soft-delete', '--host', '--port'].includes(arg) || seen.has(arg)) throw new Error(`Неизвестный параметр или повтор: ${arg}`);
    seen.add(arg);
    if (arg === '--host' || arg === '--port') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`Укажите значение ${arg}`);
      if (arg === '--host') host = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error('Invalid --port');
        port = Number(value);
      }
    } else if (arg === '--timestamps') recordFlags.timestamps = true;
    else if (arg === '--soft-delete') recordFlags.softDelete = true;
    else features[arg.slice(2) as keyof ServerFeatures] = true;
  }
  const generate = positional[0] === 'generate';
  const configPath = positional[generate ? 2 : 0];
  if (!configPath) throw new Error('Укажите путь к файлу конфигурации');
  if (positional.length !== (generate ? 3 : 1)) throw new Error('Можно указать только один файл конфигурации');
  const formats = generate ? positional[1].split(',') : [];
  if (generate && (formats.some((format) => !['openapi', 'graphql'].includes(format)) || new Set(formats).size !== formats.length)) throw new Error('Invalid generation format');
  if (generate && (features.graphql || features.openapi)) throw new Error('Endpoint flags are only available when starting the server');
  const source = await readConfigModule(configPath);
  const serverOptions = generate && !formats.includes('openapi') ? {} : (source.config.server ?? {});
  if (!isObject(serverOptions)) throw new Error('config.server must be an object');
  const overrides = { host: host ?? serverOptions.host ?? process.env.HOST ?? DEFAULT_HOST, port: port ?? serverOptions.port ?? Number(process.env.PORT ?? DEFAULT_PORT) };
  const config = generate
    ? configureGeneration(source.config, formats, source.directory, source.path, { ...overrides, files: features.files, ...recordFlags } as {
        host: string;
        port: number;
        files?: boolean;
        timestamps?: boolean;
        softDelete?: boolean;
      })
    : configure(
        {
          ...source.config,
          ...(Object.keys(recordFlags).length ? { database: { ...(isObject(source.config.database) ? source.config.database : {}), ...recordFlags } } : {}),
          server: { ...serverOptions, ...overrides },
        },
        source.directory,
        source.path,
      );
  if (generate) {
    if (!config.database.schema) throw new Error('Generation requires an explicit model schema');
    const destinations = formats.map((format) => {
      const path = config[format as 'openapi' | 'graphql'].path;
      if (!path) throw new Error(`Укажите config.${format}.path`);
      return path;
    });
    await validateExportPaths(destinations, inputPaths(source.config, source.directory, source.path));
    const openapi = formats.includes('openapi')
      ? await generateOpenapi(config.database.schema, {
          files: config.files != null,
          auth: config.auth != null,
          timestamps: config.database.timestamps,
          softDelete: config.database.softDelete,
          host: config.server.host,
          port: config.server.port,
          pageSize: config.server.pageSize,
          maxPageSize: config.server.maxPageSize,
          info: config.openapi.info,
        })
      : undefined;
    const graphql = formats.includes('graphql')
      ? await generateGraphql(config.database.schema, { auth: config.auth != null, timestamps: config.database.timestamps, softDelete: config.database.softDelete })
      : undefined;
    if (openapi) {
      await writeOpenapi(openapi, config.openapi.path!);
      process.stdout.write(`OpenAPI: ${config.openapi.path}\n`);
    }
    if (graphql) {
      await writeGraphql(graphql, config.graphql.path!);
      process.stdout.write(`GraphQL: ${config.graphql.path}\n`);
    }
    return;
  }
  const server = (await services.createServer(config, resolveFeatures(config, features))).fastify();
  await server.listen();
  server.log.info('Deep JSON Server started');
}
