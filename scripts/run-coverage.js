import { spawn } from 'node:child_process';

const testProcess = spawn(process.execPath, ['--test', '--experimental-test-coverage', '--test-coverage-lines=90', '--test-coverage-branches=80', '--test-coverage-functions=90'], {
  stdio: 'inherit',
});

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
