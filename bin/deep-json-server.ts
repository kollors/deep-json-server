#!/usr/bin/env node

import process from 'node:process';
import { runCli } from '../src/cli.js';

try {
  await runCli();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
