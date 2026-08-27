#!/usr/bin/env node

import process from 'node:process';
import { runCli } from './src/cli.js';
import { isMainModule } from './src/utils.js';

export { createOpenApiDocument, generateOpenApi } from './src/openapi.js';
export { createServer, startServer } from './src/server.js';

if (isMainModule(process.argv[1], import.meta.url)) {
  await runCli();
}
