import 'reflect-metadata';
import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { API_CONFIG, ApiConfig } from './config';
import { SafeExceptionFilter } from './common/http-exception.filter';

loadDotenv({ path: resolve(__dirname, '../.env'), quiet: true });

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { abortOnError: false });
  const config = app.get<ApiConfig>(API_CONFIG);
  app.set('trust proxy', false);
  app.disable('x-powered-by');
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.use(cookieParser());
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.path.startsWith('/api/auth') || request.path.startsWith('/api/account')) response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
    exceptionFactory: (errors: ValidationError[]) => {
      const fieldErrors: Record<string, string> = {};
      for (const error of errors) fieldErrors[error.property] = Object.values(error.constraints ?? {})[0] ?? 'Giá trị không hợp lệ.';
      return new BadRequestException({
        statusCode: 400, message: Object.values(fieldErrors), fieldErrors,
      });
    },
  }));
  app.useGlobalFilters(new SafeExceptionFilter());
  const swaggerConfig = new DocumentBuilder()
    .setTitle('DocFlow API')
    .setDescription('Đăng ký, đăng nhập và quản lý phiên. Gửi cookie với credentials: include; access token hết hạn sau 15 phút.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addCookieAuth('docflow_refresh', { type: 'apiKey', in: 'cookie' }, 'docflow_refresh')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig), {
    swaggerOptions: { persistAuthorization: false }, customSiteTitle: 'DocFlow API',
  });
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
}

void bootstrap().catch(() => {
  console.error('Không thể khởi động API. Kiểm tra biến môi trường, kết nối PostgreSQL và migration.');
  process.exitCode = 1;
});
