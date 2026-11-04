import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { WorkerModule } from './worker/worker.module';
import { WorkerRunner } from './worker/worker.runner';

loadDotenv({ path: resolve(__dirname, '../.env'), quiet: true });

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { abortOnError: false });
  const runner = app.get(WorkerRunner);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => runner.stop());
  await runner.run();
  await app.close();
  process.exit(process.exitCode ?? 0);
}

void main().catch(() => {
  console.error('Không thể khởi động worker. Kiểm tra biến môi trường, kết nối PostgreSQL và migration.');
  process.exitCode = 1;
});
