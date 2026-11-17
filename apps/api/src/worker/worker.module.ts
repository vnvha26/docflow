import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { SettingsModule } from '../config';
import { CryptoModule } from '../crypto/crypto.module';
import { DatabaseModule } from '../database/database.module';
import { JobsModule } from '../jobs/jobs.module';
import { ParsingModule } from '../parsing/parsing.module';
import { RetentionModule } from '../retention/retention.module';
import { WorkerRunner } from './worker.runner';

@Module({
  imports: [SettingsModule, DatabaseModule, JobsModule, CryptoModule, RetentionModule, ParsingModule, AiModule],
  providers: [WorkerRunner],
})
export class WorkerModule {}
