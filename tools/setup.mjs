import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const example = new URL('../apps/api/.env.example', import.meta.url);
const target = new URL('../apps/api/.env', import.meta.url);
let composeEnv = '';
try { composeEnv = await readFile(new URL('../.env', import.meta.url), 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = process.env.POSTGRES_PORT ?? composeEnv.match(/^POSTGRES_PORT=(\d+)\s*$/m)?.[1] ?? '5432';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('POSTGRES_PORT must be a valid port.');
const minioPort = process.env.MINIO_API_PORT ?? composeEnv.match(/^MINIO_API_PORT=(\d+)\s*$/m)?.[1] ?? '9000';
const fileKeks = () => `FILE_KEKS=local-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}:${randomBytes(32).toString('base64')}`;
const template = (await readFile(example, 'utf8'))
  .replace('127.0.0.1:5432/', `127.0.0.1:${port}/`)
  .replace('http://127.0.0.1:9000', `http://127.0.0.1:${minioPort}`)
  .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomBytes(48).toString('base64url')}`)
  .replace(/^FILE_KEKS=.*$/m, fileKeks());
try {
  await writeFile(target, template, { flag: 'wx' });
  console.log('Created apps/api/.env with a random local JWT secret and file encryption key.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  let current = await readFile(target, 'utf8');
  const missing = template.split(/\r?\n/).filter((line) => {
    const name = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    return name && name !== 'JWT_SECRET' && !new RegExp(`^${name}=`, 'm').test(current);
  });
  if (missing.length) {
    current = `${current.replace(/\s*$/, '\n')}${missing.join('\n')}\n`;
    await writeFile(target, current);
    console.log(`apps/api/.env already exists; added ${missing.map((line) => line.split('=')[0]).join(', ')}.`);
  } else console.log('apps/api/.env already exists; existing settings were kept.');
}
