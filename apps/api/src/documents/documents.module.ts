import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { RetentionModule } from '../retention/retention.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { UploadGuard } from './upload.guard';

@Module({
  imports: [AuthModule, CryptoModule, StorageModule, RetentionModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, UploadGuard],
})
export class DocumentsModule {}
