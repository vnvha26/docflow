import {
  CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, PayloadTooLargeException, ServiceUnavailableException,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthRequest } from '../auth/auth.types';
import { MAX_UPLOAD_BYTES, TOO_LARGE_MESSAGE } from './documents.types';

const MAX_IN_FLIGHT = 4;
const PER_USER = { limit: 60, windowMs: 15 * 60_000 };
const MULTIPART_OVERHEAD = 64 * 1024;

@Injectable()
export class UploadGuard implements CanActivate {
  private inFlight = 0;
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthRequest>();
    const response = http.getResponse<Response>();
    const declared = Number(request.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) {
      throw new PayloadTooLargeException(TOO_LARGE_MESSAGE);
    }
    const userId = request.auth!.user.id;
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key);
    const bucket = this.buckets.get(userId) ?? { count: 0, expiresAt: now + PER_USER.windowMs };
    if (bucket.count >= PER_USER.limit) {
      response.setHeader('Retry-After', String(Math.ceil((bucket.expiresAt - now) / 1000)));
      throw new HttpException('Bạn đã tải lên quá nhiều tệp. Vui lòng thử lại sau.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (this.inFlight >= MAX_IN_FLIGHT) throw new ServiceUnavailableException('Hệ thống đang bận xử lý tệp. Vui lòng thử lại sau ít phút.');
    bucket.count++;
    this.buckets.set(userId, bucket);
    this.inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; this.inFlight--; } };
    response.once('finish', release);
    response.once('close', release);
    return true;
  }
}
