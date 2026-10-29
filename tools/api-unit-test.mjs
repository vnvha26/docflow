import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('../apps/api/', import.meta.url));
const testSource = new URL('../apps/api/test/auth.test.ts', import.meta.url);
if (!existsSync(testSource)) {
  console.log('Skipping local API unit tests: apps/api/test/ is not included in this checkout.');
} else {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { cwd: apiRoot, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.test.json']);
  run(['--test', '.test-dist/test/auth.test.js']);
}
