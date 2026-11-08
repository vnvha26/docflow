import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { RetentionModule } from '../retention/retention.module';
import { StorageModule } from '../storage/storage.module';
import { ParseService } from './parse.service';

@Module({
  imports: [StorageModule, CryptoModule, RetentionModule],
  providers: [ParseService],
  exports: [ParseService],
})
export class ParsingModule {}
