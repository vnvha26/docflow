import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { API_CONFIG, ApiConfig } from '../config';
import { PrismaService } from '../database/prisma.service';
import { ChangePasswordDto, LoginDto, normalizeEmail, RegisterDto, ResetPasswordDto, VerifyEmailDto } from './auth.dto';
import { EmailChallengeService, lockAuthEmail } from './email-challenge.service';
import { PasswordService } from './password.service';
import {
  ACCESS_TTL_SECONDS, AccessClaims, AuthResponse, ChallengeResponse, IssuedAuth, PUBLIC_USER_SELECT, PublicSession, PublicUser,
  REFRESH_TTL_MS, TOKEN_AUDIENCE, TOKEN_ISSUER,
} from './auth.types';

const INVALID_LOGIN = 'Email hoặc mật khẩu không đúng.';
const INVALID_SESSION = 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.';
const WRONG_CURRENT_PASSWORD = 'Mật khẩu hiện tại không đúng.';
const SAME_PASSWORD = 'Mật khẩu mới phải khác mật khẩu hiện tại.';

// 400 + fieldErrors (not 401): the web client treats 401 as an expired access token.
function fieldError(field: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, message, fieldErrors: { [field]: message } });
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isRefreshToken(token: unknown): token is string {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(EmailChallengeService) private readonly challenges: EmailChallengeService,
  ) {}

  register(input: RegisterDto): Promise<ChallengeResponse> {
    return this.challenges.register(input);
  }

  verifyEmail(input: VerifyEmailDto, userAgent?: string): Promise<IssuedAuth> {
    return this.challenges.verifyRegistration(input, (user, transaction) => this.createSession(user, transaction, userAgent));
  }

  resendCode(id: string): Promise<ChallengeResponse> {
    return this.challenges.resend(id);
  }

  forgotPassword(email: string): Promise<ChallengeResponse> {
    return this.challenges.forgotPassword(email);
  }

  resetPassword(input: ResetPasswordDto): Promise<{ message: string }> {
    return this.challenges.resetPassword(input);
  }

  async login(input: LoginDto, userAgent?: string): Promise<IssuedAuth> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(input.email) },
      select: { ...PUBLIC_USER_SELECT, passwordHash: true, emailVerifiedAt: true },
    });
    // Missing users still pay for Argon2 verification, limiting timing-based enumeration.
    const verifiedHash = user?.passwordHash ?? this.passwords.dummyHash;
    const matches = await this.passwords.verify(verifiedHash, input.password);
    if (!user || !matches || !user.emailVerifiedAt) throw new UnauthorizedException(INVALID_LOGIN);
    return this.prisma.$transaction(async (transaction) => {
      await lockAuthEmail(transaction, user.email);
      // A password reset may finish while Argon2 is running. Recheck under the
      // same email lock before creating a session from the password we verified.
      const current = await transaction.user.findUnique({
        where: { id: user.id }, select: { ...PUBLIC_USER_SELECT, passwordHash: true, emailVerifiedAt: true },
      });
      if (!current || current.passwordHash !== verifiedHash || !current.emailVerifiedAt) {
        throw new UnauthorizedException(INVALID_LOGIN);
      }
      const { passwordHash: _passwordHash, emailVerifiedAt: _verifiedAt, ...publicUser } = current;
      return this.createSession(publicUser, transaction, userAgent);
    });
  }

  /**
   * A5: verify the current password, store the new hash and revoke every existing
   * session (this one included). The caller gets a fresh session so this device
   * stays signed in while all other devices must log in again.
   */
  async changePassword(userId: string, sessionId: string, input: ChangePasswordDto, userAgent?: string): Promise<IssuedAuth> {
    if (input.currentPassword === input.newPassword) throw fieldError('newPassword', SAME_PASSWORD);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true } });
    if (!user) throw new UnauthorizedException(INVALID_SESSION);
    if (!await this.passwords.verify(user.passwordHash, input.currentPassword)) {
      throw fieldError('currentPassword', WRONG_CURRENT_PASSWORD);
    }
    // Argon2 runs outside the transaction so the email lock is held only briefly.
    const passwordHash = await this.passwords.hash(input.newPassword);
    return this.prisma.$transaction(async (transaction) => {
      await lockAuthEmail(transaction, user.email);
      const now = new Date();
      const own = await transaction.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      // A reset or another password change revoked this session while Argon2 was running.
      if (own.count !== 1) throw new UnauthorizedException(INVALID_SESSION);
      const current = await transaction.user.findUnique({
        where: { id: userId }, select: { ...PUBLIC_USER_SELECT, passwordHash: true },
      });
      if (!current || current.passwordHash !== user.passwordHash) {
        throw new ConflictException('Mật khẩu vừa được thay đổi ở nơi khác. Vui lòng đăng nhập lại.');
      }
      await transaction.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      // Outstanding reset codes were issued for the old password; they must not outlive it.
      await transaction.emailChallenge.updateMany({
        where: { email: current.email, purpose: 'RESET_PASSWORD', consumedAt: null },
        data: { consumedAt: now },
      });
      await transaction.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: now, revision: { increment: 1 } },
      });
      const { passwordHash: _passwordHash, ...publicUser } = current;
      return this.createSession(publicUser, transaction, userAgent);
    });
  }

  private async createSession(user: PublicUser, db: Pick<Prisma.TransactionClient, 'session'>, userAgent?: string): Promise<IssuedAuth> {
    const refreshToken = randomBytes(32).toString('hex');
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const session = await db.session.create({
      data: {
        userId: user.id, refreshTokenHash: hashRefreshToken(refreshToken), expiresAt: refreshExpiresAt,
        userAgent: userAgent?.trim().slice(0, 255) || null,
      },
      select: { id: true },
    });
    return {
      body: await this.response(user, session.id),
      refreshToken,
      refreshExpiresAt,
    };
  }

  private async response(user: PublicUser, sessionId: string): Promise<AuthResponse> {
    const accessToken = await this.jwt.signAsync({ sid: sessionId }, {
      secret: this.config.jwtSecret,
      subject: user.id,
      algorithm: 'HS256',
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      expiresIn: ACCESS_TTL_SECONDS,
    });
    return { accessToken, expiresIn: ACCESS_TTL_SECONDS, user };
  }

  async refresh(token: unknown): Promise<IssuedAuth> {
    if (!isRefreshToken(token)) throw new UnauthorizedException(INVALID_SESSION);
    const oldHash = hashRefreshToken(token);
    const now = new Date();
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: oldHash },
      include: { user: { select: { ...PUBLIC_USER_SELECT, emailVerifiedAt: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= now || !session.user.emailVerifiedAt) {
      throw new UnauthorizedException(INVALID_SESSION);
    }
    const refreshToken = randomBytes(32).toString('hex');
    const { emailVerifiedAt: _verifiedAt, ...publicUser } = session.user;
    const body = await this.response(publicUser, session.id);
    // Compare-and-swap: concurrent requests may read the same row, but only one
    // can replace the old hash. A losing request never gets a new token or cookie.
    const changed = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: oldHash, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { refreshTokenHash: hashRefreshToken(refreshToken), lastUsedAt: now },
    });
    if (changed.count !== 1) throw new UnauthorizedException(INVALID_SESSION);
    return { body, refreshToken, refreshExpiresAt: session.expiresAt };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const claims = await this.jwt.verifyAsync<AccessClaims>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
      });
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuid.test(claims.sub ?? '') || !uuid.test(claims.sid ?? '')) throw new Error('claims');
      return { sub: claims.sub, sid: claims.sid };
    } catch {
      throw new UnauthorizedException(INVALID_SESSION);
    }
  }

  async authenticate(token: string): Promise<{ user: PublicUser; sessionId: string }> {
    const claims = await this.verifyAccessToken(token);
    const session = await this.prisma.session.findFirst({
      where: { id: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, user: { select: { ...PUBLIC_USER_SELECT, emailVerifiedAt: true } } },
    });
    if (!session || !session.user.emailVerifiedAt) throw new UnauthorizedException(INVALID_SESSION);
    const { emailVerifiedAt: _verifiedAt, ...publicUser } = session.user;
    return { user: publicUser, sessionId: session.id };
  }

  async listSessions(userId: string, currentSessionId: string): Promise<PublicSession[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, createdAt: true, expiresAt: true, userAgent: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const result = sessions.map((session) => ({ ...session, isCurrent: session.id === currentSessionId }));
    return result.sort((first, second) => Number(second.isCurrent) - Number(first.isCurrent));
  }

  async revokeSession(userId: string, currentSessionId: string, sessionId: string): Promise<void> {
    const now = new Date();
    const changed = await this.prisma.session.updateMany({
      where: { id: { equals: sessionId, not: currentSessionId }, userId, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    if (changed.count === 0) throw new NotFoundException('Không tìm thấy phiên đăng nhập khác đang hoạt động.');
  }

  async logout(refreshToken: unknown, accessToken?: string): Promise<void> {
    let claims: AccessClaims | undefined;
    if (accessToken) {
      try {
        claims = await this.verifyAccessToken(accessToken);
      } catch {
        // An expired access token must not prevent cookie-based logout.
      }
    }
    const alternatives = [];
    if (isRefreshToken(refreshToken)) alternatives.push({ refreshTokenHash: hashRefreshToken(refreshToken) });
    if (claims) alternatives.push({ id: claims.sid, userId: claims.sub });
    if (!alternatives.length) return;
    await this.prisma.session.updateMany({
      where: { revokedAt: null, OR: alternatives },
      data: { revokedAt: new Date() },
    });
  }
}
