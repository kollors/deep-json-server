import { spawn } from 'node:child_process';

const nodeMajorVersion = Number(process.versions.node.split('.')[0]);
const thresholdArguments = nodeMajorVersion >= 22 ? ['--test-coverage-lines=90', '--test-coverage-branches=80', '--test-coverage-functions=90'] : [];
const testProcess = spawn(process.execPath, ['--test', '--experimental-test-coverage', ...thresholdArguments], { stdio: 'inherit' });

testProcess.on('error', (error) => {
  throw error;
});

testProcess.on('exit', (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
