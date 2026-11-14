import { Global, Module } from '@nestjs/common';

export const API_CONFIG = Symbol('API_CONFIG');

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  pass?: string;
}

export interface StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  createBucket: boolean;
}

export interface Kek { id: string; key: Buffer }

export interface FilesConfig {
  keks: Kek[];
  trashTtlMs: number;
  encryptedQuotaBytes: number;
}

export interface WorkerConfig {
  pollMs: number;
  maintenanceMs: number;
}

export interface ApiConfig {
  databaseUrl: string;
  jwtSecret: string;
  webOrigin: string;
  port: number;
  production: boolean;
  mail?: MailConfig;
  storage: StorageConfig;
  files: FilesConfig;
  worker: WorkerConfig;
}

const KEK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseKeks(value: string | undefined): Kek[] {
  if (!value?.trim() || /replace-with/.test(value)) throw new Error('FILE_KEKS chưa được cấu hình; chạy npm run setup để tạo khóa mã hóa tệp cục bộ.');
  const keks = value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator);
    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (separator < 1 || !KEK_ID.test(id) || key.length !== 32 || key.toString('base64') !== entry.slice(separator + 1)) {
      throw new Error('FILE_KEKS phải có dạng id:<32 byte base64>, ngăn cách bằng dấu phẩy.');
    }
    return { id, key };
  });
  if (new Set(keks.map((kek) => kek.id)).size !== keks.length) throw new Error('FILE_KEKS có id bị trùng.');
  return keks;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} phải là số dương.`);
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv): ApiConfig {
  if (!env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL chưa được cấu hình.');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || /replace-this|change-me|your-secret/i.test(env.JWT_SECRET)) {
    throw new Error('JWT_SECRET phải là khóa riêng có ít nhất 32 ký tự; chạy npm run setup để tạo khóa cục bộ.');
  }
  const webOrigin = env.WEB_ORIGIN ?? 'http://127.0.0.1:5173';
  try {
    const parsed = new URL(webOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== webOrigin) throw new Error();
  } catch {
    throw new Error('WEB_ORIGIN phải là một origin HTTP/HTTPS, không có đường dẫn.');
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT không hợp lệ.');
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SMTP_HOST?.trim() || !env.MAIL_FROM?.trim())) {
    throw new Error('Production cần cấu hình SMTP_HOST và MAIL_FROM.');
  }
  if (env.SMTP_SECURE !== undefined && !['true', 'false'].includes(env.SMTP_SECURE)) {
    throw new Error('SMTP_SECURE phải là true hoặc false.');
  }
  const smtpPort = Number(env.SMTP_PORT ?? (production ? 587 : 1025));
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error('SMTP_PORT không hợp lệ.');
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) throw new Error('SMTP_USER và SMTP_PASS phải được cấu hình cùng nhau.');
  const from = env.MAIL_FROM?.trim() || 'DocFlow <no-reply@docflow.local>';
  if (/[\r\n]/.test(from) || !from.includes('@')) throw new Error('MAIL_FROM không hợp lệ.');
  const storage: StorageConfig = {
    endpoint: env.S3_ENDPOINT?.trim() || (production ? undefined : 'http://127.0.0.1:9000'),
    region: env.S3_REGION?.trim() || 'us-east-1',
    bucket: env.S3_BUCKET?.trim() || 'docflow',
    accessKeyId: env.S3_ACCESS_KEY?.trim() || (production ? '' : 'docflow'),
    secretAccessKey: env.S3_SECRET_KEY?.trim() || (production ? '' : 'docflow_local_only'),
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
    createBucket: !production,
  };
  if (production && (!storage.accessKeyId || !storage.secretAccessKey || !env.S3_BUCKET?.trim())) {
    throw new Error('Production cần cấu hình S3_BUCKET, S3_ACCESS_KEY và S3_SECRET_KEY.');
  }
  if (storage.endpoint) {
    try { new URL(storage.endpoint); } catch { throw new Error('S3_ENDPOINT phải là URL hợp lệ.'); }
  }
  const files: FilesConfig = {
    keks: parseKeks(env.FILE_KEKS),
    trashTtlMs: positiveNumber(env.TRASH_DAYS, 30, 'TRASH_DAYS') * 86_400_000,
    encryptedQuotaBytes: Math.floor(positiveNumber(env.ENCRYPTED_QUOTA_MB, 1024, 'ENCRYPTED_QUOTA_MB') * 1024 * 1024),
  };
  const worker: WorkerConfig = {
    pollMs: positiveNumber(env.WORKER_POLL_MS, 2_000, 'WORKER_POLL_MS'),
    maintenanceMs: positiveNumber(env.WORKER_MAINTENANCE_MS, 5 * 60_000, 'WORKER_MAINTENANCE_MS'),
  };
  return {
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.JWT_SECRET,
    webOrigin,
    port,
    production,
    mail: {
      host: env.SMTP_HOST?.trim() || '127.0.0.1', port: smtpPort,
      secure: env.SMTP_SECURE === 'true', from,
      ...(env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : {}),
    },
    storage,
    files,
    worker,
  };
}

@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: () => readConfig(process.env) }],
  exports: [API_CONFIG],
})
export class SettingsModule {}
