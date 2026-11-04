import { spawn } from 'node:child_process';

// npm_execpath avoids Windows shell shims and keeps the same npm as the caller.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Start DocFlow with npm run dev.');

const children = [['apps/api', 'dev'], ['apps/api', 'dev:worker'], ['apps/web', 'dev']].map(([workspace, script]) =>
  spawn(process.execPath, [npm, 'run', script, '--workspace', workspace], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
