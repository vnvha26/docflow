import {
  Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiConflictResponse, ApiCookieAuth,
  ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CookieOptions, Response } from 'express';
import { API_CONFIG, ApiConfig } from '../config';
import { ChallengeIdDto, EmptyAuthDto, ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto, VerifyEmailDto } from './auth.dto';
import { AccessTokenGuard, AuthOriginGuard, AuthRateLimitGuard, bearerToken } from './auth.guards';
import { AuthService } from './auth.service';
import { AuthRequest, AuthResponse, ChallengeResponse, IssuedAuth, PublicSession, PublicUser, REFRESH_COOKIE } from './auth.types';

const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' },
    displayName: { type: 'string', nullable: true }, timezone: { type: 'string' },
    privacyLevel: { type: 'string', enum: ['STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS', 'ENCRYPTED_COPY'] },
  },
  required: ['id', 'email', 'displayName', 'timezone', 'privacyLevel'],
};
const authSchema = {
  type: 'object',
  properties: {
    accessToken: { type: 'string' }, expiresIn: { type: 'integer', example: 900 }, user: userSchema,
  },
  required: ['accessToken', 'expiresIn', 'user'],
};
const challengeSchema = {
  type: 'object',
  properties: {
    challengeId: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' },
    expiresIn: { type: 'integer', example: 600 }, resendAfter: { type: 'integer', example: 60 },
    message: { type: 'string' },
  },
  required: ['challengeId', 'email', 'expiresIn', 'resendAfter', 'message'],
};
const sessionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' }, userAgent: { type: 'string', nullable: true },
    isCurrent: { type: 'boolean' },
  },
  required: ['id', 'createdAt', 'expiresAt', 'userAgent', 'isCurrent'],
};

@ApiTags('Authentication')
@Controller('auth')
@UseGuards(AuthOriginGuard, AuthRateLimitGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.config.production, sameSite: 'lax', path: '/api/auth' };
  }

  private issue(result: IssuedAuth, response: Response): AuthResponse {
    response.cookie(REFRESH_COOKIE, result.refreshToken, {
      ...this.cookieOptions(), maxAge: Math.max(0, result.refreshExpiresAt.getTime() - Date.now()),
    });
    return result.body;
  }

  @Post('register')
  @HttpCode(202)
  @ApiOperation({ summary: 'Gửi mã OTP đăng ký đến email. Chưa tạo tài khoản hoặc phiên đăng nhập.' })
  @ApiAcceptedResponse({ schema: challengeSchema })
  @ApiConflictResponse({ description: 'Email đã đăng ký.' })
  register(@Body() body: RegisterDto): Promise<ChallengeResponse> {
    return this.auth.register(body);
  }

  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({ summary: 'Xác minh OTP, tạo tài khoản và đăng nhập. Mỗi mã có tối đa 5 lần thử.' })
  @ApiOkResponse({ schema: authSchema })
  async verifyEmail(
    @Body() body: VerifyEmailDto,
    @Res({ passthrough: true }) response: Response,
    @Req() request?: AuthRequest,
  ): Promise<AuthResponse> {
    return this.issue(await this.auth.verifyEmail(body, request?.get('user-agent')), response);
  }

  @Post('resend-code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Gửi mã mới sau 60 giây; mã và challengeId trước đó bị vô hiệu.' })
  @ApiOkResponse({ schema: challengeSchema })
  resendCode(@Body() body: ChallengeIdDto): Promise<ChallengeResponse> {
    return this.auth.resendCode(body.challengeId);
  }

  @Post('forgot-password')
  @HttpCode(202)
  @ApiOperation({ summary: 'Yêu cầu mã đặt lại mật khẩu; phản hồi không tiết lộ email có tài khoản hay không.' })
  @ApiAcceptedResponse({ schema: challengeSchema })
  forgotPassword(@Body() body: ForgotPasswordDto): Promise<ChallengeResponse> {
    return this.auth.forgotPassword(body.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đổi mật khẩu bằng OTP và thu hồi toàn bộ phiên. Cần đăng nhập lại.' })
  @ApiOkResponse({ schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } })
  resetPassword(@Body() body: ResetPasswordDto): Promise<{ message: string }> {
    return this.auth.resetPassword(body);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đăng nhập bằng email và mật khẩu.' })
  @ApiOkResponse({ schema: authSchema })
  @ApiUnauthorizedResponse({ description: 'Email hoặc mật khẩu không đúng.' })
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
    @Req() request: AuthRequest,
  ): Promise<AuthResponse> {
    return this.issue(await this.auth.login(body, request.get('user-agent')), response);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiBody({ required: false, schema: { type: 'object', additionalProperties: false } })
  @ApiOperation({ summary: 'Đổi refresh token một lần, giữ thời hạn phiên 30 ngày từ lúc đăng nhập.' })
  @ApiOkResponse({ schema: authSchema })
  @ApiUnauthorizedResponse({ description: 'Phiên không hợp lệ, hết hạn hoặc token đã được đổi.' })
  async refresh(
    @Body() _body: EmptyAuthDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    return this.issue(await this.auth.refresh(request.cookies?.[REFRESH_COOKIE]), response);
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lấy người dùng hiện tại; kiểm tra phiên chưa bị thu hồi.' })
  @ApiOkResponse({ schema: userSchema })
  me(@Req() request: AuthRequest): PublicUser {
    return request.auth!.user;
  }

  @Get('sessions')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Liệt kê các phiên đang hoạt động của tài khoản.' })
  @ApiOkResponse({ schema: { type: 'array', items: sessionSchema } })
  @ApiUnauthorizedResponse()
  sessions(@Req() request: AuthRequest): Promise<PublicSession[]> {
    const { user, sessionId } = request.auth!;
    return this.auth.listSessions(user.id, sessionId);
  }

  @Post('sessions/:id/revoke')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Thu hồi một phiên khác của cùng tài khoản.' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Không tìm thấy phiên khác đang hoạt động của tài khoản.' })
  @ApiUnauthorizedResponse()
  revokeSession(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest): Promise<void> {
    const { user, sessionId } = request.auth!;
    return this.auth.revokeSession(user.id, sessionId, id);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiBody({ required: false, schema: { type: 'object', additionalProperties: false } })
  @ApiOperation({ summary: 'Thu hồi phiên và xóa cookie; gọi lại vẫn thành công.' })
  @ApiNoContentResponse()
  async logout(
    @Body() _body: EmptyAuthDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    try {
      await this.auth.logout(request.cookies?.[REFRESH_COOKIE], bearerToken(request));
    } finally {
      response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    }
  }
}
