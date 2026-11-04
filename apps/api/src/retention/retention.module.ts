import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { StorageModule } from '../storage/storage.module';
import { MaintenanceService } from './maintenance.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [StorageModule, CryptoModule],
  providers: [RetentionService, MaintenanceService],
  exports: [RetentionService, MaintenanceService],
})
export class RetentionModule {}
