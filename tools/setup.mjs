import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const example = new URL('../apps/api/.env.example', import.meta.url);
const target = new URL('../apps/api/.env', import.meta.url);
let composeEnv = '';
try { composeEnv = await readFile(new URL('../.env', import.meta.url), 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = process.env.POSTGRES_PORT ?? composeEnv.match(/^POSTGRES_PORT=(\d+)\s*$/m)?.[1] ?? '5432';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('POSTGRES_PORT must be a valid port.');
const template = (await readFile(example, 'utf8')).replace('127.0.0.1:5432/', `127.0.0.1:${port}/`);
try {
  await writeFile(target, template.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomBytes(48).toString('base64url')}`), { flag: 'wx' });
  console.log('Created apps/api/.env with a random local JWT secret.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('apps/api/.env already exists; existing settings were kept.');
}
