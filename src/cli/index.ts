import process from 'node:process';
import { DEFAULT_HOST, DEFAULT_PORT, VERSION } from '../core/constants.js';
import { inputPaths, validateExportPaths } from '../core/paths.js';
import { isObject } from '../core/utils.js';
import { writeGraphql } from '../graphql/entry.js';
import { writeOpenapi } from '../openapi/entry.js';
import { configure, type NormalizedServerConfig, readConfigModule } from '../server/config.js';
import { createConfiguredServer } from '../server/create.js';
import { configuredModel } from '../server/model.js';

const HELP_TEXT = `Deep JSON Server

Usage:
  deep-json-server [options] <server.config.js>

  --generate       Export configured schemas, then start the server
  --generate-only  Export configured schemas and exit
  --host <host>    Server address
  --port <port>    Server port
  --help, -h       Show help
  --version, -v    Show version

Modules and export formats are selected by configuration sections.
Generate flags are mutually exclusive and require output paths.`;

/** Проверяет все назначения, строит обе схемы и только затем сохраняет файлы.
 * @example Секции openapi и graphql с path → два файла; нет path → ошибка до записи.
 */
async function generate(config: NormalizedServerConfig, source: Record<string, unknown>, directory: string, sourcePath: string): Promise<void> {
  if (!config.openapi && !config.graphql) throw new Error('Generation requires an openapi or graphql section');
  const outputs: string[] = [];
  for (const format of ['openapi', 'graphql'] as const) {
    if (!config[format]) continue;
    const path = config[format].path;
    if (!path) throw new Error(`Укажите config.${format}.path`);
    outputs.push(path);
  }
  await validateExportPaths(outputs, inputPaths(source, directory, sourcePath));
  const model = await configuredModel(config);
  const openapi = config.openapi
    ? (await import('../openapi/generate.js')).openapiFromModel(model, {
        files: config.files !== undefined,
        auth: config.auth !== undefined,
        host: config.server.host,
        port: config.server.port,
        pageSize: config.server.pageSize,
        maxPageSize: config.server.maxPageSize,
        info: config.openapi.info,
      })
    : undefined;
  const graphql = config.graphql ? (await import('../graphql/generate.js')).graphqlFromModel(model) : undefined;
  if (openapi && config.openapi?.path) {
    await writeOpenapi(openapi, config.openapi.path);
    process.stdout.write(`OpenAPI: ${config.openapi.path}\n`);
  }
  if (graphql && config.graphql?.path) {
    await writeGraphql(graphql, config.graphql.path);
    process.stdout.write(`GraphQL: ${config.graphql.path}\n`);
  }
}
/** Разбирает флаги, выполняет экспорт по секциям конфигурации и при необходимости запускает сервер.
 * @example runCli(['--generate-only', 'config.mjs']) → файлы схем без открытия порта.
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
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!['--generate', '--generate-only', '--host', '--port'].includes(arg) || seen.has(arg)) throw new Error(`Неизвестный параметр или повтор: ${arg}`);
    seen.add(arg);
    if (arg === '--host' || arg === '--port') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`Укажите значение ${arg}`);
      if (arg === '--host') host = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error('Invalid --port');
        port = Number(value);
      }
    }
  }
  if (seen.has('--generate') && seen.has('--generate-only')) throw new Error('--generate and --generate-only are mutually exclusive');
  if (!positional.length) throw new Error('Укажите путь к файлу конфигурации');
  if (positional.length !== 1) throw new Error('Можно указать только один файл конфигурации');
  const source = await readConfigModule(positional[0]);
  const server = source.config.server ?? {};
  if (!isObject(server)) throw new Error('config.server must be an object');
  const config = configure(
    {
      ...source.config,
      server: { ...server, host: host ?? server.host ?? process.env.HOST ?? DEFAULT_HOST, port: port ?? server.port ?? Number(process.env.PORT ?? DEFAULT_PORT) },
    },
    source.directory,
    source.path,
  );
  if (seen.has('--generate') || seen.has('--generate-only')) await generate(config, source.config, source.directory, source.path);
  if (seen.has('--generate-only')) return;
  const app = (await services.createServer(config)).fastify();
  await app.listen();
  app.log.info('Deep JSON Server started');
}
