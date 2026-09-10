import process from 'node:process';
import { readServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_PORT } from './constants.js';
import { createServer } from './server.js';

const HELP_TEXT = `Deep JSON Server

Usage:
  deep-json-server [--files] [--graphql] [--openapi | --openapi-only] [--graphql-schema | --graphql-only] <server.config.js>

  --files           Enable binary file routes
  --graphql         Enable the GraphQL endpoint
  --openapi         Export OpenAPI and start the server
  --openapi-only    Export OpenAPI without starting the server
  --graphql-schema Export GraphQL SDL and start the server
  --graphql-only   Export GraphQL SDL without starting the server
  --help            Show help

Both exporters can be combined; any --*-only flag prevents server startup.`;
export async function runCli(args = process.argv.slice(2), services: { createServer: typeof createServer } = { createServer }): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  const flags = new Set<string>();
  let configPath: string | undefined;
  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (!['--files', '--graphql', '--openapi', '--openapi-only', '--graphql-schema', '--graphql-only'].includes(arg) || flags.has(arg)) throw new Error(`Неизвестный параметр или повтор: ${arg}`);
      flags.add(arg);
    } else if (configPath === undefined) configPath = arg;
    else throw new Error('Можно указать только один файл конфигурации');
  }
  if (!configPath) throw new Error('Укажите путь к файлу конфигурации');
  if ((flags.has('--openapi') && flags.has('--openapi-only')) || (flags.has('--graphql-schema') && flags.has('--graphql-only')))
    throw new Error('Режимы одного экспортера нельзя использовать одновременно');
  const config = await readServerConfig(configPath);
  const openapi = flags.has('--openapi') || flags.has('--openapi-only');
  const graphql = flags.has('--graphql-schema') || flags.has('--graphql-only');
  if (openapi && !config.openapi.path) throw new Error('Укажите config.openapi.path');
  if (graphql && !config.graphql.path) throw new Error('Укажите config.graphql.path');
  if (flags.has('--files') && !config.files) throw new Error('Укажите config.files');
  const runtimeConfig = { ...config, server: { ...config.server, host: config.server.host ?? process.env.HOST ?? DEFAULT_HOST, port: config.server.port ?? Number(process.env.PORT ?? DEFAULT_PORT) } };
  const only = flags.has('--openapi-only') || flags.has('--graphql-only');
  const facade = await services.createServer(runtimeConfig, { files: flags.has('--files'), graphql: only ? false : flags.has('--graphql') || config.graphql.enabled === true });
  if (openapi) {
    await facade.openapi();
    process.stdout.write(`OpenAPI: ${config.openapi.path}\n`);
  }
  if (graphql) {
    await facade.graphql();
    process.stdout.write(`GraphQL: ${config.graphql.path}\n`);
  }
  if (only) return;
  const server = facade.fastify();
  await server.listen();
  server.log.info('Deep JSON Server started');
}
