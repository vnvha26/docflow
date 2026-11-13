import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RetentionModule } from '../retention/retention.module';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';

@Module({
  imports: [AuthModule, RetentionModule],
  controllers: [FoldersController],
  providers: [FoldersService],
})
export class FoldersModule {}
