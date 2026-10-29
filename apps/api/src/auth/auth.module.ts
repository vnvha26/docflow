import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { AuthController } from './auth.controller';
import { AccessTokenGuard, AuthOriginGuard, AuthRateLimitGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { EmailChallengeService } from './email-challenge.service';
import { MailService } from './mail.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [PrismaService, PasswordService, MailService, EmailChallengeService, AuthService, AccessTokenGuard, AuthOriginGuard, AuthRateLimitGuard],
  exports: [AuthService, AccessTokenGuard],
})
export class AuthModule {}
