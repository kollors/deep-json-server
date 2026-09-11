import process from 'node:process';
import { normalizeServerConfig, readServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_PORT, VERSION } from './constants.js';
import { resolveFeatures, type ServerFeatures } from './features.js';
import { generateGraphql, generateOpenapi, writeGraphql, writeOpenapi } from './schema.js';
import { createServer } from './server.js';

const HELP_TEXT = `Deep JSON Server

Usage:
  deep-json-server [options] <server.config.js>
  deep-json-server generate <openapi|graphql|openapi,graphql> <server.config.js>

  --files         Enable file routes
  --graphql       Enable the GraphQL endpoint
  --openapi       Enable the OpenAPI endpoint
  --host <host>   Server address
  --port <port>   Server port
  --help, -h      Show help
  --version, -v   Show version

Files are enabled when configured. Generate writes schemas to the configured paths.`;
export async function runCli(args = process.argv.slice(2), services: { createServer: typeof createServer } = { createServer }): Promise<void> {
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
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!['--files', '--graphql', '--openapi', '--host', '--port'].includes(arg) || seen.has(arg)) throw new Error(`Неизвестный параметр или повтор: ${arg}`);
    seen.add(arg);
    if (arg === '--host' || arg === '--port') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`Укажите значение ${arg}`);
      if (arg === '--host') host = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error('Invalid --port');
        port = Number(value);
      }
    } else features[arg.slice(2) as keyof ServerFeatures] = true;
  }
  const generate = positional[0] === 'generate';
  const configPath = positional[generate ? 2 : 0];
  if (!configPath) throw new Error('Укажите путь к файлу конфигурации');
  if (positional.length !== (generate ? 3 : 1)) throw new Error('Можно указать только один файл конфигурации');
  const formats = generate ? positional[1].split(',') : [];
  if (generate && (formats.some((format) => !['openapi', 'graphql'].includes(format)) || new Set(formats).size !== formats.length)) throw new Error('Invalid generation format');
  if (generate && (features.graphql || features.openapi)) throw new Error('Endpoint flags are only available when starting the server');
  const source = await readServerConfig(configPath);
  const config = normalizeServerConfig({
    ...source,
    server: { ...source.server, host: host ?? source.server.host ?? process.env.HOST ?? DEFAULT_HOST, port: port ?? source.server.port ?? Number(process.env.PORT ?? DEFAULT_PORT) },
  });
  const enabled = resolveFeatures(config, features);
  if (generate) {
    if (!config.database.schema) throw new Error('Generation requires an explicit model schema');
    // Validate all destinations before writing either document.
    for (const format of formats) if (!config[format as 'openapi' | 'graphql'].path) throw new Error(`Укажите config.${format}.path`);
    const openapi = formats.includes('openapi')
      ? await generateOpenapi(config.database.schema, {
          files: enabled.files,
          host: config.server.host,
          port: config.server.port,
          pageSize: config.server.pageSize ?? Math.min(10, config.server.maxPageSize ?? 100),
          maxPageSize: config.server.maxPageSize,
          info: config.openapi.info,
        })
      : undefined;
    const graphql = formats.includes('graphql') ? await generateGraphql(config.database.schema) : undefined;
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
  const server = (await services.createServer(config, enabled)).fastify();
  await server.listen();
  server.log.info('Deep JSON Server started');
}
