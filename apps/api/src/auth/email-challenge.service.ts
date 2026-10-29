import {
  BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailChallenge, EmailChallengePurpose, Prisma } from '@prisma/client';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { API_CONFIG, ApiConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { normalizeEmail, RegisterDto, ResetPasswordDto, VerifyEmailDto } from './auth.dto';
import { ChallengeResponse, IssuedAuth, PUBLIC_USER_SELECT, PublicUser } from './auth.types';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';

const OTP_TTL_MS = 10 * 60_000;
const RESEND_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;
const INVALID_CODE = 'Mã xác minh không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu mã mới.';
const CHALLENGE_MESSAGE = 'Nếu email phù hợp với yêu cầu, mã xác minh sẽ được gửi đến hộp thư của bạn. Mã có hiệu lực trong 10 phút.';

type Outcome<T> = { ok: true; value: T } | { ok: false; reason: 'invalid' | 'cooldown'; retryAfter?: number };
interface Delivery { challenge: EmailChallenge; code: string; send: boolean }

export async function lockAuthEmail(transaction: Prisma.TransactionClient, email: string): Promise<void> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'auth-email:' + email}, 0))`;
}

export function hashEmailCode(secret: string, id: string, purpose: EmailChallengePurpose, email: string, code: string): string {
  return createHmac('sha256', secret).update(`${id}:${purpose}:${email}:${code}`).digest('hex');
}

@Injectable()
export class EmailChallengeService {
  private readonly logger = new Logger(EmailChallengeService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private value<T>(outcome: Outcome<T>): T {
    // Throw only after Prisma has committed. In particular, failed OTP attempts
    // must survive the HTTP error instead of being rolled back with the transaction.
    if (outcome.ok) return outcome.value;
    if (outcome.reason === 'cooldown') {
      throw new HttpException({
        statusCode: 429, message: 'Vui lòng chờ trước khi yêu cầu mã mới.', retryAfter: outcome.retryAfter ?? 60,
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
    throw new BadRequestException(INVALID_CODE);
  }

  private response(challenge: EmailChallenge): ChallengeResponse {
    return {
      challengeId: challenge.id, email: challenge.email,
      expiresIn: 600, resendAfter: 60, message: CHALLENGE_MESSAGE,
    };
  }

  private async cooldown(transaction: Prisma.TransactionClient, email: string, purpose: EmailChallengePurpose): Promise<number> {
    const previous = await transaction.emailChallenge.findFirst({
      where: { email, purpose }, orderBy: { createdAt: 'desc' },
      select: { resendAvailableAt: true },
    });
    return previous ? Math.max(0, Math.ceil((previous.resendAvailableAt.getTime() - Date.now()) / 1000)) : 0;
  }

  private async issue(
    transaction: Prisma.TransactionClient,
    data: { email: string; purpose: EmailChallengePurpose; userId?: string | null; passwordHash?: string | null; displayName?: string | null },
  ): Promise<Delivery> {
    const now = new Date();
    await transaction.emailChallenge.updateMany({
      where: { email: data.email, purpose: data.purpose, consumedAt: null },
      data: { consumedAt: now, passwordHash: null },
    });
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challenge = await transaction.emailChallenge.create({
      data: {
        ...data, id,
        codeHash: hashEmailCode(this.config.jwtSecret, id, data.purpose, data.email, code),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        resendAvailableAt: new Date(now.getTime() + RESEND_DELAY_MS),
      },
    });
    return { challenge, code, send: data.purpose === 'REGISTER' || Boolean(data.userId) };
  }

  private async deliver(delivery: Delivery): Promise<ChallengeResponse> {
    if (delivery.send) {
      try {
        await this.mail.sendCode(delivery.challenge.email, delivery.challenge.purpose, delivery.code);
      } catch {
        this.logger.warn('Không thể gửi email xác minh. Kiểm tra dịch vụ SMTP.');
        if (delivery.challenge.purpose === 'REGISTER') {
          await this.prisma.emailChallenge.updateMany({
            where: { id: delivery.challenge.id, consumedAt: null },
            data: { consumedAt: new Date(), passwordHash: null },
          });
          throw new ServiceUnavailableException('Chưa thể gửi mã xác minh. Vui lòng thử lại sau.');
        }
        // Keep resets active and return the same response as an unknown email.
        // Consuming only failed real deliveries would reveal account existence
        // through resend. The unknown code still has the normal TTL/attempt cap.
      }
    }
    return this.response(delivery.challenge);
  }

  private dispatchDelivery(delivery: Delivery): Promise<ChallengeResponse> {
    if (delivery.challenge.purpose === 'REGISTER') return this.deliver(delivery);
    // Local delivery is process-local. The row/HMAC is already committed, and
    // resend can retry if the app stops. SMTP latency must not reveal whether
    // a reset email belongs to an account, so it never delays the HTTP response.
    void this.deliver(delivery).catch(() => {
      this.logger.warn('Không thể hoàn tất gửi email xác minh. Vui lòng yêu cầu gửi lại.');
    });
    return Promise.resolve(this.response(delivery.challenge));
  }

  async register(input: RegisterDto): Promise<ChallengeResponse> {
    const email = normalizeEmail(input.email);
    const passwordHash = await this.passwords.hash(input.password);
    const outcome = await this.prisma.$transaction<Outcome<Delivery>>(async (transaction) => {
      await lockAuthEmail(transaction, email);
      if (await transaction.user.findUnique({ where: { email }, select: { id: true } })) {
        throw new ConflictException('Email này đã được đăng ký.');
      }
      const retryAfter = await this.cooldown(transaction, email, 'REGISTER');
      if (retryAfter > 0) return { ok: false, reason: 'cooldown', retryAfter };
      return { ok: true, value: await this.issue(transaction, {
        email, purpose: 'REGISTER', passwordHash, displayName: input.displayName?.trim() || null,
      }) };
    });
    return this.deliver(this.value(outcome));
  }

  async forgotPassword(inputEmail: string): Promise<ChallengeResponse> {
    const started = Date.now();
    try {
      const email = normalizeEmail(inputEmail);
      const outcome = await this.prisma.$transaction<Outcome<Delivery>>(async (transaction) => {
        await lockAuthEmail(transaction, email);
        const retryAfter = await this.cooldown(transaction, email, 'RESET_PASSWORD');
        if (retryAfter > 0) return { ok: false, reason: 'cooldown', retryAfter };
        const user = await transaction.user.findUnique({ where: { email }, select: { id: true } });
        return { ok: true, value: await this.issue(transaction, {
          email, purpose: 'RESET_PASSWORD', userId: user?.id ?? null,
        }) };
      });
      return await this.dispatchDelivery(this.value(outcome));
    } finally {
      await delay(Math.max(0, 300 - (Date.now() - started)));
    }
  }

  private active(challenge: EmailChallenge | null, purpose?: EmailChallengePurpose): challenge is EmailChallenge {
    return Boolean(challenge && (!purpose || challenge.purpose === purpose)
      && !challenge.consumedAt && challenge.expiresAt.getTime() > Date.now() && challenge.attempts < MAX_ATTEMPTS);
  }

  private async readLocked(transaction: Prisma.TransactionClient, id: string): Promise<EmailChallenge | null> {
    const initial = await transaction.emailChallenge.findUnique({ where: { id } });
    if (!initial) return null;
    await lockAuthEmail(transaction, initial.email);
    return transaction.emailChallenge.findUnique({ where: { id } });
  }

  private async checkCode(transaction: Prisma.TransactionClient, challenge: EmailChallenge, code: string): Promise<boolean> {
    const expected = hashEmailCode(this.config.jwtSecret, challenge.id, challenge.purpose, challenge.email, code);
    if (timingSafeEqual(Buffer.from(challenge.codeHash, 'hex'), Buffer.from(expected, 'hex'))) return true;
    await transaction.emailChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }

  async verifyRegistration(
    input: VerifyEmailDto,
    createSession: (user: PublicUser, transaction: Prisma.TransactionClient) => Promise<IssuedAuth>,
  ): Promise<IssuedAuth> {
    const outcome = await this.prisma.$transaction<Outcome<IssuedAuth>>(async (transaction) => {
      const challenge = await this.readLocked(transaction, input.challengeId);
      if (!this.active(challenge, 'REGISTER') || !challenge.passwordHash) return { ok: false, reason: 'invalid' };
      if (!await this.checkCode(transaction, challenge, input.code)) return { ok: false, reason: 'invalid' };
      if (await transaction.user.findUnique({ where: { email: challenge.email }, select: { id: true } })) {
        return { ok: false, reason: 'invalid' };
      }
      const user = await transaction.user.create({
        data: {
          email: challenge.email, passwordHash: challenge.passwordHash, displayName: challenge.displayName,
          emailVerifiedAt: new Date(),
        },
        select: PUBLIC_USER_SELECT,
      });
      await transaction.emailChallenge.updateMany({
        where: { email: challenge.email, purpose: 'REGISTER', consumedAt: null },
        data: { consumedAt: new Date(), passwordHash: null },
      });
      return { ok: true, value: await createSession(user, transaction) };
    });
    return this.value(outcome);
  }

  async resend(id: string): Promise<ChallengeResponse> {
    const started = Date.now();
    try {
      const outcome = await this.prisma.$transaction<Outcome<Delivery>>(async (transaction) => {
        const challenge = await this.readLocked(transaction, id);
        // Expired or attempt-locked codes can be replaced after the cooldown.
        // Consumed IDs (already verified or superseded) can never be revived.
        if (!challenge || challenge.consumedAt) return { ok: false, reason: 'invalid' };
        const retryAfter = await this.cooldown(transaction, challenge.email, challenge.purpose);
        if (retryAfter > 0) return { ok: false, reason: 'cooldown', retryAfter };
        return { ok: true, value: await this.issue(transaction, {
          email: challenge.email, purpose: challenge.purpose, userId: challenge.userId,
          passwordHash: challenge.passwordHash, displayName: challenge.displayName,
        }) };
      });
      return await this.dispatchDelivery(this.value(outcome));
    } finally {
      await delay(Math.max(0, 300 - (Date.now() - started)));
    }
  }

  async resetPassword(input: ResetPasswordDto): Promise<{ message: string }> {
    const outcome = await this.prisma.$transaction<Outcome<{ message: string }>>(async (transaction) => {
      const challenge = await this.readLocked(transaction, input.challengeId);
      if (!this.active(challenge, 'RESET_PASSWORD')) return { ok: false, reason: 'invalid' };
      if (!await this.checkCode(transaction, challenge, input.code)) return { ok: false, reason: 'invalid' };
      const user = challenge.userId
        ? await transaction.user.findUnique({ where: { id: challenge.userId }, select: { id: true, email: true } })
        : null;
      if (!user || user.email !== challenge.email) return { ok: false, reason: 'invalid' };
      const passwordHash = await this.passwords.hash(input.password);
      const now = new Date();
      await transaction.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: now, emailVerifiedAt: now, revision: { increment: 1 } },
      });
      await transaction.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      await transaction.emailChallenge.updateMany({
        where: { email: challenge.email, purpose: 'RESET_PASSWORD', consumedAt: null },
        data: { consumedAt: now },
      });
      return { ok: true, value: { message: 'Mật khẩu đã được đặt lại. Vui lòng đăng nhập bằng mật khẩu mới.' } };
    });
    return this.value(outcome);
  }
}
