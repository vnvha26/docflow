import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RetentionModule } from '../retention/retention.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [AuthModule, RetentionModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
