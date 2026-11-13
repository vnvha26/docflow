import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RetentionModule } from '../retention/retention.module';
import { TrashController } from './trash.controller';

@Module({
  imports: [AuthModule, RetentionModule],
  controllers: [TrashController],
})
export class TrashModule {}
