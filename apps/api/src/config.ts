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

export interface ApiConfig {
  databaseUrl: string;
  jwtSecret: string;
  webOrigin: string;
  port: number;
  production: boolean;
  mail?: MailConfig;
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
  };
}

@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: () => readConfig(process.env) }],
  exports: [API_CONFIG],
})
export class SettingsModule {}
