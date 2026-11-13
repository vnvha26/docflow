import { Module } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { AuthModule } from './auth/auth.module';
import { SettingsModule } from './config';
import { DatabaseModule } from './database/database.module';
import { DocumentsModule } from './documents/documents.module';
import { FoldersModule } from './folders/folders.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { TrashModule } from './trash/trash.module';

@Module({
  imports: [SettingsModule, DatabaseModule, JobsModule, AuthModule, AccountModule, DocumentsModule, FoldersModule, TrashModule],
  controllers: [HealthController],
})
export class AppModule {}
