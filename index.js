#!/usr/bin/env node

import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCli } from './src/cli.js';

export { createOpenApiDocument, generateOpenApi } from './src/openapi.js';
export { createServer, startServer } from './src/server.js';

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
