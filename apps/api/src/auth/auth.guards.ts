import {
  CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus,
  Inject, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { API_CONFIG, ApiConfig } from '../config';
import { AuthRequest } from './auth.types';
import { AuthService } from './auth.service';

export function bearerToken(request: Request): string | undefined {
  const authorization = request.get('authorization');
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1];
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = bearerToken(request);
    if (!token) throw new UnauthorizedException('Vui lòng đăng nhập để tiếp tục.');
    request.auth = await this.auth.authenticate(token);
    return true;
  }
}

@Injectable()
export class AuthOriginGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const origin = request.get('origin');
    if ((origin !== undefined && origin !== this.config.webOrigin)
      || request.get('sec-fetch-site') === 'cross-site') {
      throw new ForbiddenException('Nguồn gửi yêu cầu không được phép.');
    }
    return true;
  }
}

interface RateBucket { count: number; expiresAt: number }

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, RateBucket>();
  private lastCleanup = 0;

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    if (request.method !== 'POST') return true;
    const action = request.path.split('/').filter(Boolean).at(-1);
    const rule = ['register', 'forgot-password', 'resend-code'].includes(action ?? '') ? { limit: 10, window: 15 * 60_000 }
      : ['login', 'verify-email', 'reset-password'].includes(action ?? '') ? { limit: 20, window: 15 * 60_000 }
        : { limit: 60, window: 60_000 };
    const now = Date.now();
    if (now - this.lastCleanup > 60_000) {
      for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key);
      this.lastCleanup = now;
    }
    // Express trust proxy is disabled; untrusted X-Forwarded-For cannot reset limits.
    const key = `${request.ip ?? request.socket.remoteAddress ?? 'unknown'}:${action}`;
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      if (this.buckets.size >= 10_000 && !bucket) {
        throw new HttpException('Hệ thống đang bận. Vui lòng thử lại sau.', HttpStatus.TOO_MANY_REQUESTS);
      }
      bucket = { count: 0, expiresAt: now + rule.window };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= rule.limit) {
      http.getResponse<Response>().setHeader('Retry-After', String(Math.ceil((bucket.expiresAt - now) / 1000)));
      throw new HttpException('Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau.', HttpStatus.TOO_MANY_REQUESTS);
    }
    bucket.count++;
    return true;
  }
}
