import { chmod } from 'node:fs/promises';

await chmod(new URL('../dist/bin/deep-json-server.js', import.meta.url), 0o755);
