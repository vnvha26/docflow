import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { StorageModule } from '../storage/storage.module';
import { MaintenanceService } from './maintenance.service';
import { RetentionService } from './retention.service';
import { TrashService } from './trash.service';

@Module({
  imports: [StorageModule, CryptoModule],
  providers: [RetentionService, MaintenanceService, TrashService],
  exports: [RetentionService, MaintenanceService, TrashService],
})
export class RetentionModule {}
