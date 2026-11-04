import { Module } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { AuthModule } from './auth/auth.module';
import { SettingsModule } from './config';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [SettingsModule, DatabaseModule, AuthModule, AccountModule],
  controllers: [HealthController],
})
export class AppModule {}
