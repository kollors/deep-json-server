#!/usr/bin/env node

import process from 'node:process';
import { runCli } from '../src/cli.js';

try {
  await runCli();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
